import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BLOCK_ON_DRIFT, stopMode } from "../lib/stop.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-default-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state"), HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), LOCALAPPDATA: path.join(root, "local") };
  const run = (entry, args = [], input = {}) => spawnSync(process.execPath, [path.resolve("bin", entry), ...args], {
    cwd: root, env, input: JSON.stringify({ cwd: root, ...input }), encoding: "utf8",
  });
  const cli = args => {
    const result = run("skel.mjs", args);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  return { root, run, cli, env };
}

test("Stop mode defaults and both entrypoints reject conflicting flags", t => {
  assert.equal(BLOCK_ON_DRIFT, true);
  assert.equal(stopMode(), true);
  assert.equal(stopMode(["--block"]), true);
  assert.equal(stopMode(["--notify-only"]), false);
  assert.throws(() => stopMode(["--block", "--notify-only"]), /mutually exclusive/);
  assert.throws(() => stopMode(["--notify-onyl"]), /unknown Stop hook flag/);
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
  for (const [entry, args] of [["skel-stop.mjs", []], ["skel.mjs", ["stop-hook"]]]) {
    const output = JSON.parse(run(entry, args).stdout);
    assert.ok(output.systemMessage);
    assert.equal(output.decision, undefined, "omitted continuation state only notifies");
  }
  for (const active of [null, 0, "false", {}, []]) {
    for (const entry of ["skel-stop.mjs", "skel.mjs"]) {
      const output = stop([], active, entry);
      assert.ok(output.systemMessage);
      assert.equal(output.decision, undefined, "unknown continuation state only notifies");
      assert.equal(output.reason, undefined);
    }
  }
  const first = stop();
  assert.equal(first.decision, "block");
  assert.match(first.reason, /Resolve this/);
  assert.match(first.reason, /Edit[\s\S]*ask the human or deny[\s\S]*whole-file[\s\S]*uncommitted fence fills/);
  for (const output of [stop([], true), stop(["--notify-only"]), stop(["--notify-only"], true), stop(["--notify-only"], false, "skel.mjs")]) {
    assert.ok(output.systemMessage);
    assert.equal(output.decision, undefined);
    assert.equal(output.hookSpecificOutput, undefined);
  }
  assert.equal(stop(["--block"]).decision, undefined, "explicit block does not repeat unchanged drift");

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
  const installedSkill = fs.readFileSync(path.join(root, ".claude", "skills", "skeleton-fill", "SKILL.md"), "utf8");
  assert.match(installedSkill, /default requests one corrective continuation/);
  assert.doesNotMatch(installedSkill, /By default its drift report is shown to the human only/);
  assert.match(installed.stdout, /conflicting Stop hook modes/);
  settings = read();
  assert.equal(ours(settings).length, 1);
  assert.match(ours(settings)[0], / --block$/);
  assert.ok(commands(settings).includes(userCommand));
  assert.ok(commands(settings).includes(chainedCommand));
});

test("approval-record faults notify without forcing a corrective turn", t => {
  const { root, run, cli } = fixture(t);
  cli(["init", "broken approval"]);
  fs.writeFileSync(path.join(root, "code.js"), "// SKEL[1] value\nconst value=1;\n// /SKEL[1]\n");
  cli(["approve"]);
  const store = path.join(root, "config", "skel");
  const name = fs.readdirSync(store).find(name => name.endsWith(".snapshot.json"));
  assert.ok(name);
  const record = path.join(store, name);
  const original = fs.readFileSync(record, "utf8");
  const stale = JSON.parse(original);
  stale.approvedAt -= 1;
  for (const [label, content] of [["missing", null], ["corrupt", "{"], ["stale", JSON.stringify(stale)]]) {
    if (content === null) fs.rmSync(record); else fs.writeFileSync(record, content);
    for (const [entry, args] of [["skel-stop.mjs", []], ["skel.mjs", ["stop-hook"]]]) {
      const result = run(entry, [...args, "--block"], { stop_hook_active: false });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.match(output.systemMessage, /no record|different approval/, label);
      assert.equal(output.decision, undefined, label);
      assert.equal(output.reason, undefined, label);
    }
    fs.writeFileSync(record, original);
  }
});


function approvedFixture(t) {
  const f = fixture(t);
  f.cli(["init", "one nudge"]);
  f.file = path.join(f.root, "code.js");
  f.source = '// outside\n// SKEL[1] value\nconst value=1;\n// /SKEL[1]\n// after\n';
  fs.writeFileSync(f.file, f.source);
  f.cli(["approve"]);
  const settings = { XDG_CONFIG_HOME: path.join(f.root, "config") };
  // Identify metadata from the actual approved record, without using ambient HOME.
  const suffix = fs.readdirSync(path.join(settings.XDG_CONFIG_HOME, "skel")).find(n => n.endsWith(".snapshot.json")).replace(".snapshot.json", "");
  f.cache = path.join(settings.XDG_CONFIG_HOME, "skel", suffix + ".stop-notice.json");
  f.record = path.join(settings.XDG_CONFIG_HOME, "skel", suffix + ".snapshot.json");
  f.stop = (input = {}, args = []) => {
    const result = f.run("skel-stop.mjs", args, { stop_hook_active: false, ...input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  return f;
}

test("unchanged drift nudges once across prompts and sessions; changed drift, clean and new approval re-arm", t => {
  const f = approvedFixture(t);
  const stateBefore = fs.readFileSync(path.join(f.root, ".skeleton/state.json"), "utf8");
  const baselineBefore = fs.readFileSync(f.record, "utf8");
  const a = f.source.replace("// outside", "// drift A");
  const b = f.source.replace("// outside", "// drift B");
  fs.writeFileSync(f.file, a);
  assert.equal(f.stop({ session_id: "prompt-one" }).decision, "block");
  assert.equal(f.stop({ session_id: "prompt-two" }).decision, undefined);
  assert.equal(f.stop({ session_id: "different-session" }, ["--block"]).decision, undefined);
  const metadata = JSON.parse(fs.readFileSync(f.cache, "utf8"));
  assert.deepEqual(Object.keys(metadata).sort(), ["approval", "drift", "format"]);
  assert.equal(metadata.format, 1);
  assert.match(metadata.approval, /^[0-9a-f]{64}$/);
  assert.match(metadata.drift, /^[0-9a-f]{64}$/);
  assert.ok(fs.statSync(f.cache).size < 256);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.cache).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.record, "utf8"), baselineBefore);
  assert.equal(fs.readFileSync(path.join(f.root, ".skeleton/state.json"), "utf8"), stateBefore);
  fs.writeFileSync(f.file, b);
  assert.equal(f.stop().decision, "block", "changed exterior gets a fresh nudge");
  assert.equal(f.stop().decision, undefined);
  fs.writeFileSync(f.file, f.source);
  assert.equal(f.stop(), null);
  assert.equal(fs.existsSync(f.cache), false);
  fs.writeFileSync(f.file, b);
  assert.equal(f.stop().decision, "block", "clean then same drift re-arms");
  f.cli(["reshape"]);
  fs.writeFileSync(f.file, f.source);
  f.cli(["approve"]);
  fs.writeFileSync(f.file, b);
  assert.equal(f.stop().decision, "block", "new approval re-arms even the same exterior hash");
  assert.equal(fs.existsSync(f.cache + ".lock"), false);
});

test("fence-body edits and shifted exterior line offsets do not repeat an unchanged nudge", t => {
  const f = approvedFixture(t);
  const drifted = f.source.replace("// after", "// after drift");
  fs.writeFileSync(f.file, drifted);
  const first = f.stop();
  assert.equal(first.decision, "block");
  const metadata = fs.readFileSync(f.cache, "utf8");
  fs.writeFileSync(f.file, drifted.replace("const value=1;", "const value=2;\nconst more=3;\nconst filled=4;"));
  const shifted = f.stop();
  assert.equal(shifted.decision, undefined);
  assert.notEqual(shifted.systemMessage, first.systemMessage, "the report's current line number moved");
  assert.equal(fs.readFileSync(f.cache, "utf8"), metadata, "identity ignores legitimate fence contents and offsets");
  fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace("// after drift", "// changed exterior again"));
  assert.equal(f.stop().decision, "block");
});

test("notify-only and nonfalse continuation flags do not consume the first eligible nudge", t => {
  const f = approvedFixture(t);
  fs.writeFileSync(f.file, f.source.replace("// outside", "// drift"));
  for (const flag of [true, null, 0, "false", {}, []]) {
    assert.equal(f.stop({ stop_hook_active: flag }).decision, undefined);
    assert.equal(fs.existsSync(f.cache), false);
  }
  const omitted = f.run("skel-stop.mjs", [], {});
  assert.equal(JSON.parse(omitted.stdout).decision, undefined);
  assert.equal(f.stop({}, ["--notify-only"]).decision, undefined);
  for (const [entry, args] of [["skel-stop.mjs", ["--notify-onyl"]], ["skel.mjs", ["stop-hook", "--notify-onyl"]]]) {
    const rejected = f.run(entry, args, { stop_hook_active: false });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /unknown Stop hook flag/);
    assert.equal(rejected.stdout, "");
  }
  assert.equal(fs.existsSync(f.cache), false);
  assert.equal(f.stop().decision, "block");
});

test("malformed, unwritable and busy delivery caches only notify and never consume a claim", t => {
  const f = approvedFixture(t);
  fs.writeFileSync(f.file, f.source.replace("// outside", "// drift"));
  fs.writeFileSync(f.cache, "{");
  assert.equal(f.stop().decision, undefined);
  assert.equal(fs.readFileSync(f.cache, "utf8"), "{", "do not silently rewrite corrupt metadata");
  fs.writeFileSync(f.cache, " ".repeat(257));
  assert.equal(f.stop().decision, undefined, "oversized delivery metadata is never parsed");
  fs.rmSync(f.cache);
  fs.mkdirSync(f.cache);
  assert.equal(f.stop().decision, undefined, "cache file is not writable as a regular record");
  fs.rmdirSync(f.cache);
  fs.writeFileSync(f.cache + ".lock", '{"pid":1}');
  assert.equal(f.stop().decision, undefined, "busy or stranded lock never forces a continuation");
  assert.equal(fs.existsSync(f.cache), false);
  fs.rmSync(f.cache + ".lock");
  assert.equal(f.stop().decision, "block", "none of those failures consumed the claim");
});

test("concurrent Stop processes claim one unchanged drift at most once", async t => {
  const f = approvedFixture(t);
  fs.writeFileSync(f.file, f.source.replace("// outside", "// concurrent drift"));
  const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("bin/skel-stop.mjs")], {
      cwd: f.root, env: { ...process.env, CLAUDE_PROJECT_DIR: f.root, XDG_CONFIG_HOME: path.join(f.root, "config") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("error", reject);
    child.on("exit", code => {
      try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({ cwd: f.root, stop_hook_active: false }));
  })));
  assert.equal(outputs.filter(x => x.decision === "block").length, 1);
  assert.ok(outputs.every(x => x.systemMessage.includes("concurrent drift")));
});


test("a clean absent delivery cache needs no metadata writes", t => {
  const f = fixture(t);
  const module = new URL("../lib/stop-notice.mjs", import.meta.url).href;
  const code = [
    'import fs from "node:fs";',
    'import { clearStopNotice } from ' + JSON.stringify(module) + ';',
    'let writes = 0;',
    'for (const method of ["mkdirSync", "openSync", "writeFileSync", "renameSync", "rmSync"]) {',
    '  fs[method] = () => { writes++; throw new Error("unexpected metadata write"); };',
    '}',
    'console.log(JSON.stringify({ cleared: clearStopNotice(' + JSON.stringify(f.root) + '), writes }));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: f.root, env: f.env, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cleared: true, writes: 0 });
  assert.equal(fs.existsSync(path.join(f.root, "config")), false);
});

test("successful reapproval re-arms when a frozen clock repeats the same approval identity; failed approval does not", t => {
  const f = approvedFixture(t);
  const clock = path.join(f.root, "frozen-clock.mjs");
  fs.writeFileSync(clock, "Date.now = () => 1730000000000;\n");
  const frozen = args => spawnSync(process.execPath, ["--import", pathToFileURL(clock).href, path.resolve("bin/skel.mjs"), ...args], {
    cwd: f.root, env: f.env, encoding: "utf8",
  });
  const success = args => {
    const result = frozen(args);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  success(["reshape"]);
  success(["approve"]);
  const first = JSON.parse(fs.readFileSync(f.record, "utf8"));
  const drifted = f.source.replace("// outside", "// frozen drift");
  fs.writeFileSync(f.file, drifted);
  assert.equal(f.stop().decision, "block");
  const claim = fs.readFileSync(f.cache, "utf8");
  assert.equal(frozen(["approve"]).status, 1, "already filling is a failed approval");
  assert.equal(fs.readFileSync(f.cache, "utf8"), claim);
  success(["reshape"]);
  fs.writeFileSync(f.file, "// SKEL[1] unfinished\n");
  assert.equal(frozen(["approve"]).status, 1, "marker failure cannot reset delivery");
  assert.equal(fs.readFileSync(f.cache, "utf8"), claim);
  fs.writeFileSync(f.file, f.source);
  success(["approve"]);
  const second = JSON.parse(fs.readFileSync(f.record, "utf8"));
  assert.equal(second.approvedAt, first.approvedAt, "actual subprocess clock was frozen");
  assert.equal(second.version, first.version, "the same baseline repeats its version");
  assert.deepEqual(second.files, first.files);
  assert.equal(fs.existsSync(f.cache), false, "successful approval explicitly resets delivery");
  fs.writeFileSync(f.file, drifted);
  assert.equal(f.stop().decision, "block", "the identical drift gets its new-approval nudge");
});

test("delivery helper faults preserve drift notification and successful CLI approval", t => {
  const f = fixture(t);
  const clone = path.join(f.root, "node_modules", "test-checkout");
  fs.mkdirSync(clone, { recursive: true });
  for (const dir of ["bin", "lib"]) fs.cpSync(path.resolve(dir), path.join(clone, dir), { recursive: true });
  fs.copyFileSync(path.resolve("package.json"), path.join(clone, "package.json"));
  fs.writeFileSync(path.join(clone, "lib/stop-notice.mjs"), "this is not valid JavaScript {{{");
  const cli = args => {
    const result = spawnSync(process.execPath, [path.join(clone, "bin/skel.mjs"), ...args], {
      cwd: f.root, env: f.env, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  cli(["init", "cache failure is advisory"]);
  fs.writeFileSync(path.join(f.root, "code.js"), "// SKEL[1] value\nconst x = 1;\n// /SKEL[1]\n");
  assert.match(cli(["approve"]).stdout, /skeleton approved/);

  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, ".skeleton/state.json"), "utf8")).phase, "fill");
  const file = path.join(f.root, "code.js");
  const baseline = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, "// auxiliary drift\n");
  const helper = path.join(clone, "lib/stop-notice.mjs");
  const stop = () => spawnSync(process.execPath, [path.join(clone, "bin/skel-stop.mjs")], {
    cwd: f.root, env: f.env, input: JSON.stringify({ cwd: f.root, stop_hook_active: false }), encoding: "utf8",
  });
  for (const [label, code] of [
    ["syntax error", "not JavaScript {{{"],
    ["missing module", null],
    ["top-level failure", 'throw new Error("delivery import failed");'],
    ["missing exports", "export const unused = true;"],
    ["claim throws", 'export const claimStopNotice = () => { throw new Error("claim"); };'],
    ["truthy contract", 'export const claimStopNotice = () => "true";'],
    ["fulfilled Promise contract", "export const claimStopNotice = () => Promise.resolve(true);"],
    ["rejected Promise contract", 'export const claimStopNotice = () => Promise.reject(new Error("claim"));'],
  ]) {
    if (code === null) fs.rmSync(helper); else fs.writeFileSync(helper, code);
    const result = stop();
    assert.equal(result.status, 0, label + ": " + result.stderr);
    assert.equal(result.stderr, "", label);
    const report = JSON.parse(result.stdout);
    assert.match(report.systemMessage, /auxiliary drift/, label);
    assert.equal(report.decision, undefined, label);
    assert.equal(report.reason, undefined, label);
  }
  fs.writeFileSync(helper, 'export const clearStopNotice = () => Promise.reject(new Error("clear"));');
  fs.writeFileSync(file, baseline);
  const clean = stop();
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, "");
  cli(["reshape"]);
  assert.match(cli(["approve"]).stdout, /skeleton approved/, "rejected advisory clear cannot break approval");
});


test("an already-notified unchanged drift reads its cache without metadata writes", t => {
  const f = approvedFixture(t);
  fs.writeFileSync(f.file, f.source.replace("// outside", "// read-only repeat"));
  assert.equal(f.stop().decision, "block");
  const before = fs.readFileSync(f.cache, "utf8");
  const module = new URL("../lib/stop-notice.mjs", import.meta.url).href;
  const code = [
    'import fs from "node:fs";',
    'import { claimStopNotice } from ' + JSON.stringify(module) + ';',
    'const snap = JSON.parse(fs.readFileSync(' + JSON.stringify(f.record) + ', "utf8"));',
    'const drift = JSON.parse(fs.readFileSync(' + JSON.stringify(f.cache) + ', "utf8")).drift;',
    'let writes = 0;',
    'for (const method of ["mkdirSync", "openSync", "writeFileSync", "renameSync", "rmSync"]) {',
    '  fs[method] = () => { writes++; throw new Error("unexpected metadata write"); };',
    '}',
    'console.log(JSON.stringify({ claimed: claimStopNotice(' + JSON.stringify(f.root) + ', snap, drift), writes }));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: f.root, env: f.env, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { claimed: false, writes: 0 });
  assert.equal(fs.readFileSync(f.cache, "utf8"), before);
});
