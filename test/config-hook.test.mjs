import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDecision } from "../lib/config-hook.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function state(root, text) {
  fs.mkdirSync(path.join(root, ".skeleton"), { recursive: true });
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), text);
}
test("configuration guard allows absent/scaffold/done, blocks fill and corrupt state", t => {
  const root = fixture(t);
  assert.equal(configDecision({ cwd: root }), null);
  for (const phase of ["scaffold", "done"]) {
    state(root, JSON.stringify({ phase }));
    assert.equal(configDecision({ cwd: root }), null);
  }
  for (const text of ['{"phase":"fill"}', '{', '{}']) {
    state(root, text);
    assert.equal(configDecision({ cwd: root }).decision, "block");
  }
  assert.equal(configDecision({ cwd: root, source: "policy_settings" }), null);
});
test("nested scaffold cannot hide outer fill; malformed input uses project fallback", t => {
  const root = fixture(t), child = path.join(root, "child");
  state(root, '{"phase":"fill"}'); state(child, '{"phase":"scaffold"}');
  assert.equal(configDecision({ cwd: child }).decision, "block");
  for (const entry of ["skel-hook.mjs", "skel-config-hook.mjs"]) {
    const result = spawnSync(process.execPath, [path.resolve("bin", entry)], { input: '{', encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: child } });
    assert.match(result.stderr, /skel/);
    const output = JSON.parse(result.stdout);
    assert.equal(entry === "skel-hook.mjs" ? output.hookSpecificOutput.permissionDecision : output.decision, entry === "skel-hook.mjs" ? "deny" : "block");
  }
});
test("PreToolUse faults stay open outside fill, and corrupt enrolled state denies valid input", t => {
  const root = fixture(t);
  const run = input => spawnSync(process.execPath, [path.resolve("bin/skel-hook.mjs")], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(run('{').stdout, "");
  state(root, '{"phase":"scaffold"}');
  assert.equal(run('{').stdout, "");
  state(root, '{');
  const result = run(JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: "x" } }));
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.stderr, /cannot be read/);
});

test("install/reinstall/uninstall owns only standalone ConfigChange commands", t => {
  const root = fixture(t), project = path.join(root, "project"), cfg = path.join(root, "config");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  const settingsPath = path.join(project, ".claude/settings.local.json");
  const chained = { hooks: [{ type: "command", command: 'node "/other/bin/skel-config-hook.mjs" && echo mine' }] };
  const empty = { hooks: [] };
  const user = { matcher: "skills", hooks: [{ type: "command", command: "echo user" }] };
  const old = { matcher: "local_settings", hooks: [{ type: "command", command: 'node "/old/bin/skel-config-hook.mjs"' }, { type: "command", command: "echo shared" }] };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { ConfigChange: [chained, empty, user, old] } }));
  const run = cmd => {
    const out = spawnSync(process.execPath, [path.resolve("bin/skel.mjs"), cmd, project], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: cfg } });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  };
  let settings = run("install");
  assert.equal(settings.hooks.ConfigChange.length, 5);
  assert.deepEqual(settings.hooks.ConfigChange.slice(0, 3), [chained, empty, user]);
  assert.deepEqual(settings.hooks.ConfigChange[3], { ...old, hooks: [{ type: "command", command: "echo shared" }] });
  const guard = settings.hooks.ConfigChange[4];
  assert.equal(guard.matcher, "user_settings|project_settings|local_settings");
  assert.match(guard.hooks[0].command, /skel-config-hook\.mjs"$/);
  settings = run("install");
  assert.equal(settings.hooks.ConfigChange.length, 5, "idempotent");
  settings = run("uninstall");
  assert.deepEqual(settings.hooks.ConfigChange, [chained, empty, user, { ...old, hooks: [{ type: "command", command: "echo shared" }] }]);
});
test("valid input gate exception denies using session enrollment even with outside cwd", t => {
  const root = fixture(t), outside = fixture(t);
  state(root, '{"phase":"fill"}');
  const hookUrl = new URL("../lib/hook.mjs", import.meta.url).href;
  for (const thrown of ['new Error("gate broke")', 'null']) {
    const code = `import { runHook } from ${JSON.stringify(hookUrl)}; await runHook({ loadGate: async () => { throw ${thrown}; } });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { input: JSON.stringify({ cwd: outside, tool_name: "Bash", tool_input: { command: "skel approve" } }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(result.stderr, /gate broke|null/);
  }
  assert.equal(configDecision({ cwd: outside }, root).decision, "block");
});
test("corrupt session state denies valid outside calls and corrupt outer overrides nested fill", t => {
  const root = fixture(t), outside = fixture(t), child = path.join(root, "child");
  state(root, '{'); state(child, '{"phase":"fill"}');
  assert.match(configDecision({ cwd: child }, outside).reason, /cannot be read/);
  for (const cwd of [outside, child]) {
    const result = spawnSync(process.execPath, [path.resolve("bin/skel-hook.mjs")], { input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command: "echo hi" } }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
});
test("dangling state path is unreadable enrollment", t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".skeleton"));
  try { fs.symlinkSync(path.join(root, "missing"), path.join(root, ".skeleton/state.json")); }
  catch (err) { if (["EPERM", "EACCES"].includes(err.code)) return t.skip("file symlinks require platform privilege"); throw err; }
  assert.equal(configDecision({ cwd: root }, root).decision, "block");
});

test("malformed ConfigChange settings are refused before installer writes", t => {
  const root = fixture(t), settingsPath = path.join(root, ".claude/settings.local.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = JSON.stringify({ hooks: { ConfigChange: {} } });
  fs.writeFileSync(settingsPath, original);
  for (const cmd of ["install", "uninstall"]) {
    const result = spawnSync(process.execPath, [path.resolve("bin/skel.mjs"), cmd, root], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /hooks.ConfigChange/);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
    assert.equal(fs.existsSync(path.join(root, ".claude/skills")), false);
  }
});
