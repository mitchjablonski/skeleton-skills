import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BLOCK_ON_DRIFT, stopMode } from "../lib/stop.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-default-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, XDG_CONFIG_HOME: path.join(root, "config") };
  const run = (entry, args = [], input = {}) => spawnSync(process.execPath, [path.resolve("bin", entry), ...args], {
    cwd: root, env, input: JSON.stringify({ cwd: root, ...input }), encoding: "utf8",
  });
  const cli = args => {
    const result = run("skel.mjs", args);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  return { root, run, cli };
}

test("Stop mode defaults and both entrypoints reject conflicting flags", t => {
  assert.equal(BLOCK_ON_DRIFT, true);
  assert.equal(stopMode(), true);
  assert.equal(stopMode(["--block"]), true);
  assert.equal(stopMode(["--notify-only"]), false);
  assert.throws(() => stopMode(["--block", "--notify-only"]), /mutually exclusive/);
  const { run } = fixture(t);
  for (const [entry, prefix] of [["skel-stop.mjs", []], ["skel.mjs", ["stop-hook"]]]) {
    const result = run(entry, [...prefix, "--block", "--notify-only"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mutually exclusive/);
    assert.equal(result.stdout, "");
  }
});

test("real approval: clean silent, notices preserved, drift corrects once, both entrypoints opt out", t => {
  const { root, run, cli } = fixture(t);
  const stop = (args = [], active = false, entry = "skel-stop.mjs") => {
    const result = run(entry, entry === "skel.mjs" ? ["stop-hook", ...args] : args, { stop_hook_active: active });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  cli(["init", "stop defaults"]);
  const file = path.join(root, "code.js");
  const source = '// outside\n// SKEL[1] value\nconst value=1;\n// /SKEL[1]\n';
  fs.writeFileSync(file, source);
  cli(["approve"]);
  assert.equal(stop(), null);
  const blocked = run("skel-config-hook.mjs", [], { source: "local_settings", file_path: "settings.local.json" });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  const notice = stop();
  assert.match(notice.systemMessage, /historical notice/);
  assert.equal(notice.decision, undefined);
  run("skel-config-hook.mjs", [], { source: "policy_settings" });
  assert.equal(stop(), null);
  fs.writeFileSync(file, source.replace('// outside', '// drift'));
  const first = stop();
  assert.equal(first.decision, "block");
  assert.match(first.reason, /Resolve this/);
  for (const output of [stop([], true), stop(["--notify-only"]), stop(["--notify-only"], true), stop(["--notify-only"], false, "skel.mjs")]) {
    assert.ok(output.systemMessage);
    assert.equal(output.decision, undefined);
    assert.equal(output.hookSpecificOutput, undefined);
  }
  assert.equal(stop(["--block"]).decision, "block");
});

test("install keeps notify-only across reinstalls and moved clones; conflicting modes preserve user hooks", t => {
  const { root, cli } = fixture(t);
  const settingsFile = path.join(root, ".claude", "settings.local.json");
  const read = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const write = settings => fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const commands = settings => settings.hooks.Stop.flatMap(group => group.hooks.map(hook => hook.command));
  const ours = settings => commands(settings).filter(command => /skel-stop\.mjs/.test(command) && !command.includes("&&"));
  cli(["install", root]);
  let settings = read();
  const stop = settings.hooks.Stop.flatMap(group => group.hooks).find(hook => /skel-stop\.mjs/.test(hook.command));
  stop.command += " --notify-only";
  write(settings);
  cli(["install", root]);
  settings = read();
  assert.equal(ours(settings).length, 1);
  assert.match(ours(settings)[0], / --notify-only$/);
  const moved = settings.hooks.Stop.flatMap(group => group.hooks).find(hook => /skel-stop\.mjs/.test(hook.command));
  moved.command = 'node "/old/clone/bin/skel-stop.mjs" --notify-only';
  write(settings);
  cli(["install", root]);
  settings = read();
  assert.equal(ours(settings).length, 1);
  assert.match(ours(settings)[0], / --notify-only$/);
  assert.doesNotMatch(ours(settings)[0], /old\/clone/);
  const userCommand = 'node "/user/custom.mjs"';
  const chainedCommand = 'node "/old/clone/bin/skel-stop.mjs" --notify-only && echo user';
  settings.hooks.Stop.push({ hooks: [
    { type: "command", command: 'node "/other/clone/bin/skel-stop.mjs" --block' },
    { type: "command", command: userCommand },
    { type: "command", command: chainedCommand },
  ] });
  write(settings);
  const installed = cli(["install", root]);
  assert.match(installed.stdout, /conflicting Stop hook modes/);
  settings = read();
  assert.equal(ours(settings).length, 1);
  assert.match(ours(settings)[0], / --block$/);
  assert.ok(commands(settings).includes(userCommand));
  assert.ok(commands(settings).includes(chainedCommand));
});
