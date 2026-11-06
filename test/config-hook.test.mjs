import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDecision } from "../lib/config-hook.mjs";

// Stores live in the state dir and migrate from the old config dir: keep every path out of the real ones.
const isolatedHomes = fs.mkdtempSync(path.join(os.tmpdir(), "skel-suite-homes-"));
process.env.XDG_CONFIG_HOME = path.join(isolatedHomes, "config");
process.env.LOCALAPPDATA = path.join(isolatedHomes, "localappdata");
process.on("exit", () => { try { fs.rmSync(isolatedHomes, { recursive: true, force: true }); } catch {} });
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const isolatedXdgStateHome = fs.mkdtempSync(path.join(os.tmpdir(), "skel-config-suite-"));
process.env.XDG_STATE_HOME = isolatedXdgStateHome;
after(() => {
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
  fs.rmSync(isolatedXdgStateHome, { recursive: true, force: true, maxRetries: 5 });
});

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
  for (const text of ['{"phase":"fill"}', '{']) {
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
  assert.match(result.stderr, /malformed JSON: .*state\.json/);
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
    const out = spawnSync(process.execPath, [path.resolve("bin/skel.mjs"), ...cmd.split(" "), project], { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: cfg } });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  };
  let settings = run("install --legacy");
  assert.equal(settings.hooks.ConfigChange.length, 5);
  assert.deepEqual(settings.hooks.ConfigChange.slice(0, 3), [chained, empty, user]);
  assert.deepEqual(settings.hooks.ConfigChange[3], { ...old, hooks: [{ type: "command", command: "echo shared" }] });
  const guard = settings.hooks.ConfigChange[4];
  assert.equal(guard.matcher, "user_settings|project_settings|local_settings");
  assert.match(guard.hooks[0].command, /skel-config-hook\.mjs"$/);
  settings = run("install --legacy");
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
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { input: JSON.stringify({ cwd: outside, tool_name: "Edit", tool_input: { file_path: path.join(root, "x.js"), old_string: "x", new_string: "y" } }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(result.stderr, /gate broke|null/);
  }
  assert.equal(configDecision({ cwd: outside }, root).decision, "block");
});
test("corrupt session state denies valid outside calls and corrupt outer overrides nested fill", t => {
  const root = fixture(t), outside = fixture(t), child = path.join(root, "child");
  state(root, '{'); state(child, '{"phase":"fill"}');
  assert.match(configDecision({ cwd: child }, root).reason, /malformed JSON: .*state\.json/);
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
    const result = spawnSync(process.execPath, [path.resolve("bin/skel.mjs"), cmd, root], { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: path.join(root, "config") } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /hooks.ConfigChange/);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
    assert.equal(fs.existsSync(path.join(root, ".claude/skills")), false);
  }
});
test("cwd fill owns nested corrupt decoy but outside corrupt owner denies", t => {
  const root = fixture(t), outside = fixture(t), child = path.join(root, "child");
  state(root, JSON.stringify({ phase: "fill", activeStep: "1", files: [] }));
  state(child, '{'); state(outside, '{');
  const source = '// SKEL[1] value\nconst value = 1;\n// /SKEL[1]\n';
  fs.writeFileSync(path.join(child, "code.js"), source);
  fs.writeFileSync(path.join(outside, "code.js"), source);
  const run = file => spawnSync(process.execPath, [path.resolve("bin/skel-hook.mjs")], { input: JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: file, old_string: "const value = 1;", new_string: "const value = 2;" } }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const owned = run(path.join(child, "code.js"));
  assert.equal(owned.stderr, "");
  assert.equal(owned.stdout, "");
  assert.equal(JSON.parse(run(path.join(outside, "code.js")).stdout).hookSpecificOutput.permissionDecision, "deny");
});
test("scope ignores malformed ancestors, repair asks, odd target paths stay harmless", t => {
  const parent = fixture(t), root = path.join(parent, "project"); fs.mkdirSync(root);
  state(parent, '{');
  const run = tool_input => spawnSync(process.execPath, [path.resolve("bin/skel-hook.mjs")], { input: JSON.stringify({ cwd: root, tool_name: tool_input.command ? "Bash" : "Edit", tool_input }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(run({ command: "echo ok" }).stdout, "");
  fs.writeFileSync(path.join(root, "plain"), "x");
  assert.equal(run({ file_path: path.join(root, "plain", "child.js") }).stdout, "");
  state(root, '{');
  const denied = JSON.parse(run({ command: "echo ok" }).stdout).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny"); assert.ok(denied.permissionDecisionReason.includes(path.join(root, ".skeleton", "state.json")));
  assert.equal(JSON.parse(run({ command: "skel init --force" }).stdout).hookSpecificOutput.permissionDecision, "ask");
});
test("blocked configuration notice persists, appears at Stop outside fill, and clears", t => {
  const root = fixture(t), config = path.join(root, "config");
  state(root, '{"phase":"fill"}');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, XDG_STATE_HOME: config };
  const run = (entry, input) => spawnSync(process.execPath, [path.resolve("bin", entry)], { input: JSON.stringify(input), encoding: "utf8", env });
  const event = { cwd: root, source: "local_settings", file_path: "settings.local.json", content: "SECRET-MUST-NOT-STORE" };
  const blocked = run("skel-config-hook.mjs", event);
  assert.equal(blocked.stderr, "");
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  state(root, '{"phase":"scaffold"}');
  const notice = JSON.parse(run("skel-stop.mjs", { cwd: root }).stdout).systemMessage;
  assert.match(notice, /historical notice/); assert.match(notice, /settings.local.json/); assert.doesNotMatch(notice, /SECRET-MUST/);
  assert.equal(run("skel-config-hook.mjs", event).stdout, "");
  assert.equal(run("skel-stop.mjs", { cwd: root }).stdout, "");
});
test("ignored malformed ancestors never own a sibling target with real fill", t => {
  const parent = fixture(t), cwd = path.join(parent, "session"), target = path.join(parent, "actual");
  fs.mkdirSync(cwd); state(target, '{"phase":"fill","activeStep":null}');
  fs.writeFileSync(path.join(target, "code.js"), "// SKEL[1] value\nconst x = 1;\n// /SKEL[1]\n");
  for (const invalid of ['{', 'null', '{"phase":"foreign"}']) {
    state(parent, invalid);
    const result = spawnSync(process.execPath, [path.resolve("bin/skel-hook.mjs")], { input: JSON.stringify({ cwd, tool_name: "Edit", tool_input: { file_path: path.join(target, "code.js"), old_string: "1", new_string: "2" } }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "ask");
  }
});
test("approved external owner with broken state denies descendant target and permits repair", t => {
  const root = fixture(t), session = fixture(t), config = path.join(session, "config");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: session, XDG_STATE_HOME: config };
  const cli = args => {
    const r = spawnSync(process.execPath, [path.resolve("bin/skel.mjs"), ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r;
  };
  cli(["init", "external"]);
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src/x.js");
  fs.writeFileSync(file, '// SKEL[1] x\nconst x = 1;\n// /SKEL[1]\n');
  cli(["approve"]);
  const run = input => spawnSync(process.execPath, [path.resolve("bin/skel-hook.mjs")], { input: JSON.stringify(input), encoding: "utf8", env });
  for (const broken of ['{', '{}', 'directory-replaced']) {
    if (broken === "directory-replaced") {
      fs.rmSync(path.join(root, ".skeleton"), { recursive: true });
      fs.writeFileSync(path.join(root, ".skeleton"), "foreign file");
    } else state(root, broken);
    const denied = run({ cwd: session, tool_name: "Edit", tool_input: { file_path: file, old_string: "1", new_string: "2" } });
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(JSON.parse(run({ cwd: root, tool_name: "Bash", tool_input: { command: "skel init --force" } }).stdout).hookSpecificOutput.permissionDecision, "ask");
  }
});
