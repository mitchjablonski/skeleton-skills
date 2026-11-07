import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const BIN = fileURLToPath(new URL("../bin/skel.mjs", import.meta.url));
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

// #55: on WSL's drvfs (/mnt/c) realpath keeps the caller's spelling, so a case
// variant or 8.3 alias of a project's path hashes to another record name.
const STATE = new URL("../lib/state.mjs", import.meta.url).href;
const CONFIG_HOOK = fileURLToPath(new URL("../bin/skel-config-hook.mjs", import.meta.url));
/** Run module code in the fixture's environment; it writes JSON. */
function inEnv(f, code) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
/** `p` with the case of every letter below `base` flipped. */
const flipBelow = (base, p) => base + [...p.slice(base.length)].map(c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
const sha24 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
/** Is the temp dir on WSL's drvfs, folding case? */
const onDrvfs = await (async () => {
  if (process.platform !== "linux") return false;
  const { drvfsMountOf } = await import("../lib/state.mjs");
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skel-fold-")));
  try {
    const v = flipBelow(path.dirname(d), d);
    return !!drvfsMountOf(d) && fs.statSync(v, { throwIfNoEntry: false })?.ino === fs.statSync(d).ino;
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const DRVFS = { skip: !onDrvfs && "needs WSL's drvfs (/mnt/c) as the temp dir: TMPDIR=/mnt/c/..." };
function caseFixture(t) {
  const f = receiptFixture(t);
  const variant = flipBelow(path.dirname(f.home), f.project);
  /** An approval record as skel writes one from `dir`: keyed by its realpath as spelled, naming `dir`. */
  const approve = (dir, { root = dir, key = sha24(fs.realpathSync.native(dir)) } = {}) => {
    const file = path.join(f.store, `${key}.snapshot.json`);
    fs.writeFileSync(file, JSON.stringify({ root, format: 3, approvedAt: 1 }));
    return file;
  };
  const config = (cwd) => {
    const r = spawnSync(process.execPath, [CONFIG_HOOK], { cwd, env: { ...f.env, CLAUDE_PROJECT_DIR: cwd }, input: JSON.stringify({ cwd, source: "user_settings" }), encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).decision : null;
  };
  const aliases = (dir) => inEnv(f, `import { receiptAliases } from ${JSON.stringify(STATE)}; process.stdout.write(JSON.stringify(receiptAliases(${JSON.stringify(dir)})))`);
  return { ...f, variant, approve, config, aliases };
}

test("#55: a case-variant session path finds the record and denies with the state deleted", DRVFS, t => {
  const f = caseFixture(t);
  const file = f.approve(f.project);
  for (const cwd of [f.project, f.variant]) {
    for (const input of [edit(path.join(cwd, "src", "a.js")), { tool_name: "Bash", tool_input: { command: "ls" } }]) {
      const r = f.hook(input, cwd);
      assert.equal(r.decision, "deny", `${input.tool_name} from ${cwd}`);
      assert.match(r.stderr, /approval record exists but \.skeleton is missing/);
    }
    assert.equal(f.config(cwd), "block", `ConfigChange from ${cwd}`);
  }
  assert.deepEqual(f.aliases(f.variant), { verified: [file], unverified: [] });
  const notice = inEnv(f, `import { storeNotice } from ${JSON.stringify(new URL("../lib/store-notice.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(await storeNotice(${JSON.stringify(f.variant)})))`);
  assert.match(notice, /written from another spelling of its path/, "skel status says the CLI needs the approved spelling");
  // A third spelling finds it too, and the record written from the variant is found from the original.
  assert.equal(f.hook(edit(path.join(f.project, "src", "a.js")), flipBelow(f.home, f.project)).decision, "deny", "a third spelling");
  fs.rmSync(file);
  f.approve(f.variant);
  assert.equal(f.hook(edit(path.join(f.project, "src", "a.js"))).decision, "deny", "written from the variant, read from the original");
  // Lookup only: what skel writes, and where, is unchanged.
  const keys = inEnv(f, `import { projectKey } from ${JSON.stringify(STATE)}; process.stdout.write(JSON.stringify([projectKey(${JSON.stringify(f.project)}), projectKey(${JSON.stringify(f.variant)})]))`);
  assert.deepEqual(keys, [sha24(f.project), sha24(f.variant)], "keys are still the realpath as spelled");
});

test("#55: a record written under any earlier spelling is found from any other, by its resolved root", DRVFS, t => {
  const f = caseFixture(t);
  const mixed = path.join(f.home, "LegacyMiXeD", "ProjectMiXeD");
  fs.mkdirSync(path.join(mixed, "src"), { recursive: true });
  const file = f.approve(mixed); // keyed by that spelling, as skel before #55 wrote it
  const query = path.join(f.home, "lEgAcYmIxEd", "pRoJeCtMiXeD");
  assert.deepEqual(f.aliases(query), { verified: [file], unverified: [] }, "neither the query spelling nor its lowercase is the written one");
  assert.equal(f.hook(edit(path.join(query, "src", "a.js")), query).decision, "deny");
  assert.equal(f.config(query), "block");
});

test("#55: a record written through a link since replaced doesn't carry over", DRVFS, t => {
  const f = caseFixture(t);
  const target = path.join(f.home, "target");
  fs.mkdirSync(target);
  const p = path.join(f.home, "Proj");
  try { fs.symlinkSync(target, p); } catch (err) { return t.skip(`no symlinks here (${err.code})`); }
  // Approved through the link (from a variant spelling of it): keyed by the target's realpath, naming the link.
  const file = f.approve(p, { root: flipBelow(f.home, p) });
  assert.equal(path.basename(file, ".snapshot.json"), sha24(fs.realpathSync.native(target)));
  fs.rmSync(p);
  fs.mkdirSync(path.join(p, "src"), { recursive: true }); // a real dir at the link's path now
  const { verified, unverified } = f.aliases(p);
  assert.deepEqual(verified, []);
  assert.deepEqual(unverified.map(u => u.file), [file]);
  assert.equal(f.hook(edit(path.join(p, "src", "a.js")), p).decision, null, "not enrolled: the record was the target's");
});

test("#55: a lookalike record that can't be proven is reported, not counted", DRVFS, t => {
  const f = caseFixture(t);
  // Its root, resolved now, doesn't hash to its name: written when that path led elsewhere (a link since retargeted, a dir replaced).
  const moved = f.approve(f.project, { root: f.variant, key: sha24(path.join(f.home, "elsewhere")) });
  // Another project, named like this one's but not a lookalike.
  f.approve(f.project, { root: path.join(flipBelow(path.dirname(f.home), f.home), "PROJECT-gone"), key: sha24("x") });
  fs.writeFileSync(path.join(f.store, `${sha24("y")}.snapshot.json`), "not json"); // no root: as good as another project's
  const { verified, unverified } = f.aliases(f.project);
  assert.deepEqual(verified, []);
  assert.deepEqual(unverified.map(u => u.file).sort(), [moved].sort(), "the gone path isn't a lookalike of this one");
  assert.match(unverified[0].why, /resolves to .* now, which isn't where the record was written/);
  for (const cwd of [f.project, f.variant]) assert.equal(f.hook(edit(path.join(cwd, "src", "a.js")), cwd).decision, null, `not enrolled from ${cwd}`);
  assert.equal(f.config(f.project), null);
  const notice = inEnv(f, `import { storeNotice } from ${JSON.stringify(new URL("../lib/store-notice.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(await storeNotice(${JSON.stringify(f.project)})))`);
  assert.match(notice, /can't be proven to be it/, "skel status tells the human");
});

test("#55: a case-sensitive sibling isn't the project, and an 8.3 alias is", DRVFS, t => {
  const f = caseFixture(t);
  const cs = path.join(f.home, "cs");
  fs.mkdirSync(cs);
  const win = spawnSync("wslpath", ["-w", cs], { encoding: "utf8", timeout: 10_000 }).stdout?.trim();
  // fsutil exits 0 on failure too: trust its words, and that a case variant is then a miss.
  const set = win && spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", win, "enable"], { cwd: "/mnt/c", encoding: "utf8", timeout: 20_000 });
  fs.mkdirSync(path.join(cs, "Sub"));
  if (/is enabled/.test(set?.stdout ?? "") && !fs.existsSync(path.join(cs, "SUB"))) {
    fs.mkdirSync(path.join(cs, "sub"));
    const file = f.approve(path.join(cs, "Sub"));
    assert.deepEqual(f.aliases(path.join(cs, "sub")), { verified: [], unverified: [] }, "sub beside Sub is another dir");
    assert.deepEqual(f.aliases(path.join(flipBelow(path.dirname(f.home), cs), "Sub")).verified, [file], "Sub through a variant of the dirs above it is Sub");
    fs.rmSync(file);
  } else t.diagnostic("couldn't enable per-directory case sensitivity here");
  const long = path.join(f.home, "LongProjectName");
  fs.mkdirSync(long);
  const short = path.join(f.home, "LONGPR~1");
  if (fs.existsSync(short)) {
    const fromShort = f.approve(short);
    assert.deepEqual(f.aliases(long).verified, [fromShort], "written from the 8.3 name, found from the long one");
    fs.rmSync(fromShort);
    const fromLong = f.approve(long);
    assert.deepEqual(f.aliases(short).verified, [fromLong], "and the other way");
  } else t.diagnostic("no 8.3 names on this volume");
});

test("#55: with no lookalike record, the fallback touches nothing but the store", DRVFS, t => {
  const f = caseFixture(t);
  for (let i = 0; i < 50; i++) f.approve(f.project, { root: path.join(f.home, `other-${i}`), key: sha24(`other-${i}`) });
  const code = `import fs from "node:fs"; let n = 0; for (const k of ["statSync", "lstatSync", "realpathSync"]) { const o = fs[k]; fs[k] = function (p, ...a) { if (!String(p).startsWith(${JSON.stringify(f.store)})) n++; return o.call(this, p, ...a); }; } const rn = fs.realpathSync.native; fs.realpathSync.native = function (...a) { n++; return rn.apply(this, a); }; const { approvalReceiptStatus } = await import(${JSON.stringify(STATE)}); const r = approvalReceiptStatus(${JSON.stringify(f.variant)}); process.stdout.write(JSON.stringify([r, n]))`;
  assert.deepEqual(inEnv(f, code), ["absent", 2], "two realpaths of the project (the exact key, then the fallback's), no stat");
});

test("#55: off drvfs, the fallback does nothing and keys are unchanged", async () => {
  const { projectKey, receiptAliases, drvfsMountOf } = await import("../lib/state.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skel-key-"));
  try {
    const real = fs.realpathSync.native(dir);
    assert.equal(projectKey(dir, "win32"), sha24(real.toLowerCase()), "Windows: the lowercased realpath");
    assert.deepEqual(receiptAliases(dir, { platform: "win32" }), { verified: [], unverified: [] });
    if (process.platform === "linux" && !drvfsMountOf(real)) {
      assert.equal(projectKey(dir), sha24(real), "ext4: the realpath as is");
      assert.deepEqual(receiptAliases(dir), { verified: [], unverified: [] }, "ext4: case-sensitive, no fallback");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
