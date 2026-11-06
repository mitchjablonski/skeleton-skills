import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approvalReceiptStatus, storePath } from "../lib/state.mjs";
import { configDecision } from "../lib/config-hook.mjs";
import { spawnSync } from "node:child_process";
import { enrollment } from "../lib/config-hook.mjs";
import { configNoticePath, recordConfigNotice, takeConfigNotice, readConfigNotice } from "../lib/config-notice.mjs";

// Stores live in the state dir and migrate from the old config dir: keep every path out of the real ones.
const isolatedHomes = fs.mkdtempSync(path.join(os.tmpdir(), "skel-suite-homes-"));
process.env.XDG_CONFIG_HOME = path.join(isolatedHomes, "config");
process.env.LOCALAPPDATA = path.join(isolatedHomes, "localappdata");
process.env.XDG_STATE_HOME = path.join(isolatedHomes, "state");
process.on("exit", () => { try { fs.rmSync(isolatedHomes, { recursive: true, force: true }); } catch {} });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-notice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, "config");
  t.after(() => { if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; });
  return root;
}
test("broken config store cannot enroll absent skeleton, real bad state stays protected", t => {
  const root = fixture(t);
  fs.writeFileSync(process.env.XDG_STATE_HOME, "not a directory");
  assert.equal(enrollment(root).protected, false);
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), '{');
  assert.equal(enrollment(root).protected, true);
});

test("mode-000 config storage cannot enroll a project with no skeleton", { skip: process.platform === "win32" }, t => {
  const root = fixture(t);
  const config = process.env.XDG_STATE_HOME;
  fs.mkdirSync(config);
  fs.chmodSync(config, 0);
  try {
    let denied = false;
    try { fs.readdirSync(config); } catch (err) { denied = err.code === "EACCES"; }
    if (!denied) return t.skip("effective user can read mode-000 directories");
    assert.equal(enrollment(root).protected, false);
    fs.mkdirSync(path.join(root, ".skeleton"));
    fs.writeFileSync(path.join(root, ".skeleton/state.json"), "{");
    assert.equal(enrollment(root).protected, true);
  } finally {
    fs.chmodSync(config, 0o700);
  }
});

test("empty approval storage skips project realpaths and is indexed once per hook", t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(process.env.XDG_STATE_HOME, "skel"), { recursive: true });
  const realpath = fs.realpathSync.native;
  const readdir = fs.readdirSync;
  let resolves = 0, listings = 0;
  fs.realpathSync.native = (...args) => { resolves++; return realpath(...args); };
  fs.readdirSync = (...args) => { listings++; return readdir(...args); };
  try {
    const cache = new Map();
    assert.equal(approvalReceiptStatus(root, cache), "absent");
    assert.equal(approvalReceiptStatus(path.join(root, "uninitialized-child"), cache), "absent");
    assert.equal(resolves, 0);
    assert.equal(listings, 2, "once per store dir, the state dir and the old one");
  } finally {
    fs.realpathSync.native = realpath;
    fs.readdirSync = readdir;
  }
});
test("notice consumed once per session, status remains, next block resets delivery", t => {
  const root = fixture(t);
  recordConfigNotice(root, { source: "local_settings", file_path: "settings.json" });
  assert.ok(takeConfigNotice(root, "session-a"));
  assert.equal(takeConfigNotice(root, "session-a"), null);
  assert.ok(readConfigNotice(root));
  assert.ok(takeConfigNotice(root, "session-b"));
  recordConfigNotice(root, { source: "project_settings" });
  assert.ok(takeConfigNotice(root, "session-a"));
});

test("done preserves a blocked-settings notice until the active fill ends", t => {
  const root = fixture(t);
  const bin = fileURLToPath(new URL("../bin/skel.mjs", import.meta.url));
  const stop = fileURLToPath(new URL("../bin/skel-stop.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const run = args => {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(["init", "notice retention"]);
  const file = path.join(root, "code.js");
  fs.writeFileSync(file, 'export function value() {\n// SKEL[1] value\nthrow new Error("SKEL_TODO");\n// /SKEL[1]\n}\n');
  run(["approve"]);
  run(["next"]);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('throw new Error("SKEL_TODO");', "return 1;"));
  recordConfigNotice(root, { source: "local_settings", file_path: "settings.local.json" });
  run(["done"]);
  const status = JSON.parse(run(["status", "--json"]));
  assert.equal(status.phase, "fill");
  assert.match(status.configNotice, /historical notice/);
  const stopped = spawnSync(process.execPath, [stop], { cwd: root, env, encoding: "utf8", input: JSON.stringify({ cwd: root, session_id: "same-turn" }) });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(JSON.parse(stopped.stdout).systemMessage, /settings change was blocked/);
  run(["reshape"]);
  assert.equal(readConfigNotice(root), null);
});
test("phase repair asks when gate import fails; storage error still blocks reload", t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), '{"phase":"fill"}');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const module = new URL("../lib/hook.mjs", import.meta.url).href;
  const code = `import {runHook} from ${JSON.stringify(module)}; await runHook({loadGate:async()=>{throw new Error("fault")}});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, input: JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command: "skel reshape" } }), encoding: "utf8" });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "ask");
  fs.writeFileSync(process.env.XDG_STATE_HOME, "not a directory");
  const blocked = spawnSync(process.execPath, [path.resolve("bin/skel-config-hook.mjs")], { env, input: JSON.stringify({ cwd: root, source: "local_settings" }), encoding: "utf8" });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.match(blocked.stderr, /notice/);
});

test("status reports blocked reloads even with corrupt state, without a stack trace", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-status-notice-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), "{");
  recordConfigNotice(root, { source: "local_settings", file_path: path.join(root, ".claude/settings.local.json") });
  const bin = fileURLToPath(new URL("../bin/skel.mjs", import.meta.url));
  const run = args => spawnSync(process.execPath, [bin, "status", ...args], { cwd: root, encoding: "utf8" });
  for (const content of ["{", '{"phase":"foreign"}', '{"phase":"fill","files":42}']) {
    fs.writeFileSync(path.join(root, ".skeleton/state.json"), content);
    const text = run([]);
    assert.equal(text.status, 1);
    assert.match(text.stderr, /settings change was blocked/);
    assert.match(text.stderr, /state\.json/);
    assert.match(text.stderr, /init --force/);
    assert.doesNotMatch(text.stderr, /TypeError|at ModuleJob/);
    const json = run(["--json"]);
    assert.equal(json.status, 1);
    const report = JSON.parse(json.stdout);
    assert.match(report.error, /state\.json/);
    assert.match(report.configNotice, /historical notice/);
  }
});

test("malformed notices are ignored and notice storage failure cannot permit a reload", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-notice-failure-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), JSON.stringify({ phase: "fill" }));
  const notice = configNoticePath(root);
  fs.mkdirSync(path.dirname(notice), { recursive: true });
  fs.writeFileSync(notice, "{}");
  assert.equal(readConfigNotice(root), null);
  const blockedConfig = path.join(root, "not-a-directory");
  fs.writeFileSync(blockedConfig, "x");
  const entry = fileURLToPath(new URL("../bin/skel-config-hook.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, source: "local_settings" }),
    env: { ...process.env, XDG_STATE_HOME: blockedConfig, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "block");
  assert.match(result.stderr, /notice/);
});

test("an approval record protects a skeleton link redirected to a regular file", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-notice-link-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const target = path.join(root, "regular-file");
  fs.writeFileSync(target, "x");
  try { fs.symlinkSync(target, path.join(root, ".skeleton")); }
  catch (err) {
    if (["EPERM", "EACCES"].includes(err.code)) return t.skip("file symlinks require platform privilege");
    throw err;
  }
  const receipt = storePath(root, ".snapshot");
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, "{}");
  assert.equal(configDecision({ cwd: root }, root).decision, "block");
});

// #44: the approval-record lookup once any project on the machine has a record.
const HOOK = fileURLToPath(new URL("../bin/skel-hook.mjs", import.meta.url));
function receiptFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skel-receipts-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: path.join(home, "state"), XDG_CONFIG_HOME: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local") };
  const store = path.join(env.XDG_STATE_HOME, "skel");
  fs.mkdirSync(store, { recursive: true });
  const project = path.join(home, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.js"), "let a = 1;\n");
  const record = (dir) => {
    const code = `import { projectKey } from ${JSON.stringify(new URL("../lib/state.mjs", import.meta.url).href)}; process.stdout.write(projectKey(${JSON.stringify(dir)}))`;
    const key = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 60_000 }).stdout;
    assert.match(key, /^[0-9a-f]{24}$/);
    fs.writeFileSync(path.join(store, `${key}.snapshot.json`), "{}");
  };
  const hook = (input, cwd = project, projectDir = cwd) => {
    const result = spawnSync(process.execPath, [HOOK], { cwd, env: { ...env, CLAUDE_PROJECT_DIR: projectDir }, input: JSON.stringify({ cwd, ...input }), encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    return { decision: result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : null, stderr: result.stderr };
  };
  return { home, env, store, project, record, hook };
}
const edit = (file) => ({ tool_name: "Edit", tool_input: { file_path: file, old_string: "1", new_string: "2" } });

test("#44: a listable store answers by name, and a read-only one isn't \"unreadable\"", t => {
  const f = receiptFixture(t);
  f.record(path.join(f.home, "elsewhere"));
  f.record(f.project);
  const status = (dir) => {
    const code = `import fs from "node:fs"; const l = fs.lstatSync; let store = 0; fs.lstatSync = function (p, ...a) { if (String(p).startsWith(${JSON.stringify(f.store)})) store++; return l.call(this, p, ...a); }; const { approvalReceiptStatus } = await import(${JSON.stringify(new URL("../lib/state.mjs", import.meta.url).href)}); process.stdout.write(JSON.stringify([approvalReceiptStatus(${JSON.stringify(dir)}), store]))`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(status(f.project), ["present", 0], "found in the listing, no lstat into the store");
  assert.deepEqual(status(path.join(f.home, "other")), ["absent", 0], "another project's record isn't this one's");
  if (process.platform === "win32") return;
  // r-- : listable, but no name in it can be looked up.
  fs.chmodSync(f.store, 0o400);
  try {
    let searchable = true;
    try { fs.lstatSync(path.join(f.store, "x"), { throwIfNoEntry: false }); } catch (err) { searchable = err.code !== "EACCES"; }
    if (searchable) return t.skip("effective user can search r-- directories");
    assert.deepEqual(status(f.project), ["present", 0], "read-only store: enrolled");
    assert.deepEqual(status(path.join(f.home, "other")), ["absent", 0], "read-only store: a miss is a miss");
  } finally {
    fs.chmodSync(f.store, 0o700);
  }
});

test("#44: an enrolled project whose state was deleted still denies, from inside it", t => {
  const f = receiptFixture(t);
  f.record(f.project);
  fs.mkdirSync(path.join(f.project, ".skeleton"));
  fs.writeFileSync(path.join(f.project, ".skeleton", "state.json"), JSON.stringify({ phase: "fill", activeStep: "1", files: [] }));
  fs.rmSync(path.join(f.project, ".skeleton", "state.json"));
  assert.equal(f.hook(edit(path.join(f.project, "src", "a.js"))).decision, "deny", "state.json gone");
  fs.rmSync(path.join(f.project, ".skeleton"), { recursive: true });
  for (const input of [edit(path.join(f.project, "src", "a.js")), { tool_name: "Bash", tool_input: { command: "ls" } }]) {
    const r = f.hook(input);
    assert.equal(r.decision, "deny", `${input.tool_name}: .skeleton gone`);
    assert.match(r.stderr, /approval record exists but \.skeleton is missing/);
  }
  // A hook process started in a subdirectory: the project is an ancestor of its cwd.
  assert.equal(f.hook(edit(path.join(f.project, "src", "a.js")), path.join(f.project, "src"), f.project).decision, "deny", "from a subdirectory");
});

test("#44: a project reached through a symlink still finds its record", t => {
  const f = receiptFixture(t);
  f.record(f.project);
  const link = path.join(f.home, "link");
  const inside = path.join(f.home, "cwd");
  fs.mkdirSync(inside);
  try {
    fs.symlinkSync(f.project, link, "junction");
    fs.symlinkSync(f.project, path.join(inside, "link"), "junction");
  } catch (err) {
    if (["EPERM", "EACCES"].includes(err.code)) return t.skip("directory links require platform privilege");
    throw err;
  }
  const status = (dir, cwd) => {
    const code = `import { approvalReceiptStatus } from ${JSON.stringify(new URL("../lib/state.mjs", import.meta.url).href)}; process.stdout.write(approvalReceiptStatus(${JSON.stringify(dir)}))`;
    return spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, env: f.env, encoding: "utf8", timeout: 60_000 }).stdout;
  };
  assert.equal(status(link, f.home), "present", "link beside the cwd");
  assert.equal(status(path.join(inside, "link"), inside), "present", "link below the cwd");
  assert.equal(status(link, link), "present", "link as the cwd");
  assert.equal(status(path.join(f.home, "elsewhere"), f.home), "absent", "an unrelated path isn't enrolled");
  // And the hook, run from the link with .skeleton deleted, denies.
  assert.equal(f.hook(edit(path.join(link, "src", "a.js")), link).decision, "deny", "hook from the link");
});
