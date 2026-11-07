import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { projectKey } from "../lib/state.mjs";
const REPO = fileURLToPath(new URL("../", import.meta.url));
const edit = file => ({ tool_name: "Edit", tool_input: { file_path: file, old_string: "const n = 1;", new_string: "const n = 2;" } });
function fixture(t, fault = null) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "startup-fault-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const tool = path.join(base, "tool"), root = path.join(base, "project");
  fs.mkdirSync(tool); fs.mkdirSync(root);
  for (const dir of ["bin", "lib"]) fs.cpSync(path.join(REPO, dir), path.join(tool, dir), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(tool, "package.json"));
  if (fault) fs.writeFileSync(path.join(tool, "lib", fault), 'throw new Error("injected startup import failure");');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: path.join(base, "home"), USERPROFILE: path.join(base, "home"), XDG_CONFIG_HOME: path.join(base, "config"), XDG_STATE_HOME: path.join(base, "state"), LOCALAPPDATA: path.join(base, "local") };
  const writeState = (phase, target = root) => {
    fs.mkdirSync(path.join(target, ".skeleton"), { recursive: true });
    fs.writeFileSync(path.join(target, ".skeleton/state.json"), JSON.stringify({ title: "startup test", phase, gate: "ask", files: [], activeStep: "1", reviewEpoch: 1 }));
  };
  const receipt = (target = root, legacy = false, upper = false) => {
    const dir = path.join(legacy ? env.XDG_CONFIG_HOME : env.XDG_STATE_HOME, "skel");
    fs.mkdirSync(dir, { recursive: true });
    const name = projectKey(target) + ".snapshot.json";
    fs.writeFileSync(path.join(dir, upper ? name.toUpperCase() : name), "{}");
  };
  const run = (kind, input = {}, cwd = root, extraEnv = {}) => {
    const entry = kind === "PreToolUse" ? "skel-hook.mjs" : "skel-config-hook.mjs";
    const result = spawnSync(process.execPath, [path.join(tool, "bin", entry)], { cwd, env: { ...env, ...extraEnv }, input: typeof input === "string" ? input : JSON.stringify({ cwd, ...input }), encoding: "utf8", timeout: 15000 });
    // A decision exits 0; a fallback that decides nothing keeps the import fault a failed hook.
    const broken = fault && (kind === "PreToolUse" || !["phase.mjs", "hook.mjs"].includes(fault));
    assert.equal(result.status, result.stdout || !broken ? 0 : 1, result.stderr);
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    return { decision: output?.hookSpecificOutput?.permissionDecision ?? output?.decision ?? null, output, stderr: result.stderr };
  };
  return { base, root, tool, env, run, receipt, writeState };
}
test("standalone fallback blocks remain identical and depend only on stdlib", () => {
  const block = entry => fs.readFileSync(path.join(REPO, "bin", entry), "utf8").split('// STARTUP FALLBACK:')[1].split('// END STARTUP FALLBACK')[0];
  assert.equal(block("skel-hook.mjs"), block("skel-config-hook.mjs"));
  assert.doesNotMatch(block("skel-hook.mjs"), /from "\.\.?\//);
});
for (const fault of ["state.mjs", "config-hook.mjs", "phase.mjs"]) {
  test(`startup ${fault} fault preserves enrollment and fresh-project behavior`, t => {
    const f = fixture(t, fault);
    assert.equal(f.run("PreToolUse", edit("a.js")).decision, null);
    assert.equal(f.run("ConfigChange", { source: "local_settings" }).decision, null);
    f.writeState("fill");
    assert.equal(f.run("PreToolUse", edit("a.js")).decision, "deny");
    assert.equal(f.run("ConfigChange", { source: "local_settings" }).decision, "block");
    assert.equal(f.run("ConfigChange", { source: "policy_settings" }).decision, null);
    for (const kind of ["PreToolUse", "ConfigChange"]) assert.equal(f.run(kind, '{').decision, kind === "PreToolUse" ? "deny" : "block");
    for (const phase of ["scaffold", "done"]) {
      f.writeState(phase); f.receipt();
      assert.equal(f.run("PreToolUse", edit("a.js")).decision, null);
      assert.equal(f.run("ConfigChange", { source: "local_settings" }).decision, null);
    }
    f.writeState("fill");
    fs.writeFileSync(path.join(f.root, ".skeleton/state.json"), '{');
    assert.equal(f.run("PreToolUse", edit("a.js")).decision, "deny");
    fs.rmSync(path.join(f.root, ".skeleton"), { recursive: true });
    assert.equal(f.run("PreToolUse", edit("a.js")).decision, "deny");
    assert.equal(f.run("ConfigChange", { source: "local_settings" }).decision, "block");
  });
}
test("fallback scoped ownership includes session, external owners and confirmed outer fills", t => {
  const f = fixture(t, "state.mjs");
  fs.writeFileSync(path.join(f.base, "noise"), "x");
  f.writeState("fill", f.base); // confirmed enclosing fill wins, even above session
  f.writeState("scaffold");
  assert.equal(f.run("PreToolUse", edit("a.js")).decision, "deny");
  fs.writeFileSync(path.join(f.base, ".skeleton/state.json"), '{');
  assert.equal(f.run("PreToolUse", edit("a.js")).decision, null, "malformed unrelated ancestor isn't enrollment");
  const outside = path.join(f.base, "outside"); fs.mkdirSync(outside);
  f.writeState("fill", outside);
  assert.equal(f.run("PreToolUse", edit(path.join(outside, "a.js"))).decision, "deny");
  f.writeState("scaffold", outside); // only the session's own fill may protect a call made from outside
  f.writeState("fill");
  assert.equal(f.run("PreToolUse", { cwd: outside, tool_name: "Bash", tool_input: { command: "echo x" } }).decision, "deny", "session scope retained");
  assert.equal(f.run("ConfigChange", { cwd: outside, source: "local_settings" }).decision, "block", "session scope retained");
});
test("fallback legacy/current receipt union, canonical alias and malformed own state stay protective", t => {
  const f = fixture(t, "config-hook.mjs");
  f.receipt(f.root, true, true);
  assert.equal(f.run("PreToolUse", edit("a.js")).decision, "deny");
  const alias = path.join(f.base, "alias");
  try { fs.symlinkSync(f.root, alias, "junction"); }
  catch (err) { if (["EPERM", "EACCES"].includes(err.code)) return t.skip("directory links unavailable"); throw err; }
  assert.equal(f.run("PreToolUse", edit("a.js"), alias, { CLAUDE_PROJECT_DIR: alias }).decision, "deny");
  f.writeState("scaffold");
  fs.writeFileSync(path.join(f.root, ".skeleton/state.json"), '{"phase":"invalid"}');
  assert.equal(f.run("PreToolUse", edit("a.js")).decision, "deny");
});
test("healthy launchers preserve normal in-fence edits and ConfigChange", t => {
  const f = fixture(t);
  f.writeState("fill");
  fs.writeFileSync(path.join(f.root, "a.js"), '// SKEL[1] n\nconst n = 1;\n// /SKEL[1]\n');
  assert.equal(f.run("PreToolUse", edit("a.js")).decision, null);
  assert.equal(f.run("ConfigChange", { source: "local_settings" }).decision, "block");
});
test("stdin is consumed once on healthy and failed imports; normal runtime throws stay outside load catch", t => {
  for (const fault of [null, "state.mjs"]) {
    const f = fixture(t, fault); f.writeState("fill");
    fs.writeFileSync(path.join(f.root, "a.js"), '// SKEL[1] n\nconst n = 1;\n// /SKEL[1]\n');
    const spy = path.join(f.base, "stdin-spy.mjs");
    fs.writeFileSync(spy, 'let reads=0;const iterator=process.stdin[Symbol.asyncIterator];process.stdin[Symbol.asyncIterator]=function(){reads++;return iterator.call(this)};process.once("exit",()=>process.stderr.write("STDIN_READS="+reads+"\\n"));');
    for (const kind of ["PreToolUse", "ConfigChange"]) {
      const result = f.run(kind, kind === "PreToolUse" ? edit("a.js") : { source: "local_settings" }, f.root, { NODE_OPTIONS: `--import=${pathToFileURL(spy).href}` });
      assert.match(result.stderr, /STDIN_READS=1/);
    }
  }
  const f = fixture(t);
  fs.writeFileSync(path.join(f.tool, "lib/hook.mjs"), 'export async function runHook(){throw new Error("normal runtime failure")}');
  const result = spawnSync(process.execPath, [path.join(f.tool, "bin/skel-hook.mjs")], { cwd: f.root, env: f.env, input: '{}', encoding: "utf8", timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /normal runtime failure/);
  assert.doesNotMatch(result.stderr, /skel PreToolUse startup/);
});
test("unknown receipt lookup doesn't enroll pristine projects; known state remains protected", t => {
  const f = fixture(t, "config-hook.mjs");
  const spy = path.join(f.base, "unknown-store.mjs");
  fs.writeFileSync(spy, `import fs from 'node:fs';import path from 'node:path';const dirs=[path.join(process.env.XDG_CONFIG_HOME,'skel'),path.join(process.env.XDG_STATE_HOME,'skel')];const read=fs.readdirSync,stat=fs.lstatSync;fs.readdirSync=function(p,...a){if(dirs.includes(String(p)))throw Object.assign(new Error('store not readable'),{code:'EACCES'});return read.call(this,p,...a)};fs.lstatSync=function(p,...a){if(dirs.some(d=>String(p).startsWith(d+path.sep)))throw Object.assign(new Error('receipt not searchable'),{code:'EACCES'});return stat.call(this,p,...a)};`);
  const env = { NODE_OPTIONS: `--import=${pathToFileURL(spy).href}` };
  const fresh = f.run("PreToolUse", edit("a.js"), f.root, env);
  assert.equal(fresh.decision, null);
  assert.match(fresh.stderr, /lookup was incomplete/);
  f.writeState("fill");
  assert.equal(f.run("PreToolUse", edit("a.js"), f.root, env).decision, "deny");
  assert.equal(f.run("ConfigChange", { source: "local_settings" }, f.root, env).decision, "block");
});
test("receipt keys preserve native-realpath-failure lexical identity without a JS retry", t => {
  const f = fixture(t, "config-hook.mjs"); f.receipt();
  const spy = path.join(f.base, "realpath-fault.mjs");
  fs.writeFileSync(spy, `import fs from 'node:fs';let js=0;const root=${JSON.stringify(f.root)},original=fs.realpathSync,native=fs.realpathSync.native;fs.realpathSync=function(p,...a){if(String(p)===root){js++;throw new Error('unexpected JS realpath')}return original.call(this,p,...a)};fs.realpathSync.native=function(p,...a){if(String(p)===root)throw Object.assign(new Error('native fault'),{code:'EACCES'});return native.call(this,p,...a)};process.once('exit',()=>process.stderr.write('JS_REALPATH='+js+'\\n'));`);
  const result = f.run("PreToolUse", edit("a.js"), f.root, { NODE_OPTIONS: `--import=${pathToFileURL(spy).href}` });
  assert.equal(result.decision, "deny");
  assert.match(result.stderr, /JS_REALPATH=0/);
});
test("a fallback with no decision exits non-zero with the import fault; a decision exits 0", t => {
  const cases = [["phase.mjs", "PreToolUse", edit("a.js")], ["state.mjs", "PreToolUse", edit("a.js")], ["config-hook.mjs", "ConfigChange", { source: "local_settings" }], ["state.mjs", "ConfigChange", { source: "policy_settings" }]];
  for (const [fault, kind, input] of cases) {
    const f = fixture(t, fault);
    const entry = kind === "PreToolUse" ? "skel-hook.mjs" : "skel-config-hook.mjs";
    const run = () => spawnSync(process.execPath, [path.join(f.tool, "bin", entry)], { cwd: f.root, env: f.env, input: JSON.stringify({ cwd: f.root, ...input }), encoding: "utf8", timeout: 15000 });
    const fresh = run();
    assert.equal(fresh.status, 1, `${fault} ${kind} ${input.source ?? ""}: ${fresh.stderr}`);
    assert.equal(fresh.stdout, "");
    assert.match(fresh.stderr, new RegExp(`skel ${kind} startup: `));
    f.writeState("fill");
    const filling = run();
    if (input.source === "policy_settings") { assert.equal(filling.status, 1); assert.equal(filling.stdout, ""); continue; }
    assert.equal(filling.status, 0, filling.stderr);
    assert.match(filling.stdout, kind === "PreToolUse" ? /"permissionDecision":"deny"/ : /"decision":"block"/);
  }
});

// Differential: the implementation's own failure path (runHook's catch, configDecision) computed
// in-process, against the launcher fallback with a broken product module. The fallback may deny
// more, never less.
test("fallback never allows where the implementation's failure path protects", { timeout: 900000 }, async t => {
  const { enrollment, configDecision } = await import("../lib/config-hook.mjs");
  const { leavesBase } = await import("../lib/state.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "startup-diff-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const tool = path.join(work, "tool");
  for (const dir of ["bin", "lib"]) fs.cpSync(path.join(REPO, dir), path.join(tool, dir), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(tool, "package.json"));
  fs.writeFileSync(path.join(tool, "lib", "state.mjs"), 'throw new Error("injected startup import failure");');

  const STATES = ["none", "scaffold", "fill", "done", "corrupt", "{}", "badphase", "emptydir", "skelfile", "statedir"];
  const RECEIPTS = ["none", "state", "legacy", "both", "migrated"];
  const DIRS = ["parent", "project", "nested", "outside"];
  const configs = [];
  for (const d of DIRS) for (const s of STATES) for (const r of RECEIPTS) configs.push({ [d]: [s, r] });
  // A nested or sibling skeleton must not hide what an enclosing or session one protects.
  for (const d of ["parent", "nested", "outside"]) for (const s of STATES) for (const r of ["none", "state"]) configs.push({ project: ["scaffold", "state"], [d]: [s, r] });
  for (const s of STATES) configs.push({ nested: ["scaffold", "state"], project: [s, "legacy"] });

  const writeSetup = (dirs, xdg, [stateKind, receiptKind], dir) => {
    const skel = path.join(dir, ".skeleton");
    const state = phase => { fs.mkdirSync(skel); fs.writeFileSync(path.join(skel, "state.json"), JSON.stringify({ title: "diff", phase, gate: "ask", files: [], activeStep: "1", reviewEpoch: 1 })); };
    if (["scaffold", "fill", "done"].includes(stateKind)) state(stateKind);
    else if (stateKind === "corrupt") { fs.mkdirSync(skel); fs.writeFileSync(path.join(skel, "state.json"), "{"); }
    else if (stateKind === "{}") { fs.mkdirSync(skel); fs.writeFileSync(path.join(skel, "state.json"), "{}"); }
    else if (stateKind === "badphase") { fs.mkdirSync(skel); fs.writeFileSync(path.join(skel, "state.json"), '{"phase":"bogus"}'); }
    else if (stateKind === "emptydir") fs.mkdirSync(skel);
    else if (stateKind === "skelfile") fs.writeFileSync(skel, "not a dir");
    else if (stateKind === "statedir") fs.mkdirSync(path.join(skel, "state.json"), { recursive: true });
    const key = projectKey(dir);
    const put = (store, name) => { fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(path.join(store, name), "{}"); };
    if (["state", "both"].includes(receiptKind)) put(xdg.state, key + ".snapshot.json");
    if (["legacy", "both", "migrated"].includes(receiptKind)) put(xdg.legacy, key + ".snapshot.json");
    if (receiptKind === "migrated") put(xdg.legacy, key + ".migrated");
  };

  const scenarios = [];
  configs.forEach((config, i) => {
    const base = path.join(work, `c${i}`);
    const dirs = { parent: path.join(base, "parent") };
    dirs.project = path.join(dirs.parent, "project");
    dirs.nested = path.join(dirs.project, "nested");
    dirs.outside = path.join(base, "outside");
    fs.mkdirSync(dirs.nested, { recursive: true }); fs.mkdirSync(dirs.outside);
    const env = { XDG_CONFIG_HOME: path.join(base, "config"), XDG_STATE_HOME: path.join(base, "state") };
    const xdg = { legacy: path.join(env.XDG_CONFIG_HOME, "skel"), state: path.join(env.XDG_STATE_HOME, "skel") };
    for (const [d, setup] of Object.entries(config)) writeSetup(dirs, xdg, setup, dirs[d]);
    const modes = [
      { label: "CPD=project cwd=outside", cpd: dirs.project, spawnCwd: dirs.project, cwd: dirs.outside },
      { label: "CPD=project cwd=project", cpd: dirs.project, spawnCwd: dirs.outside, cwd: dirs.project },
      { label: "CPD unset spawned in nested", cpd: null, spawnCwd: dirs.nested, cwd: null },
    ];
    const targets = { inside: path.join(dirs.project, "a.js"), nested: path.join(dirs.nested, "a.js"), outside: path.join(dirs.outside, "a.js"), parent: path.join(dirs.parent, "a.js") };
    const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    Object.assign(process.env, env);
    try {
      for (const mode of modes) {
        const session = mode.cpd ?? mode.spawnCwd;
        const base = mode.cwd ?? session;
        const events = Object.entries(targets).map(([name, target]) => ({ kind: "PreToolUse", name, input: { tool_name: "Edit", tool_input: { file_path: target, old_string: "a", new_string: "b" } } }));
        events.push({ kind: "ConfigChange", name: "local_settings", input: { source: "local_settings" } });
        for (const event of events) {
          const input = mode.cwd ? { cwd: mode.cwd, ...event.input } : event.input;
          let protects;
          if (event.kind === "ConfigChange") protects = configDecision(input, session) !== null;
          else {
            // runHook's catch: session, failure base, and the target dir it wasn't owned by the cwd skeleton.
            const verdict = shared => {
              const cache = new Map();
              const inspect = b => enrollment(b, shared ? cache : new Map(), { boundary: session });
              const abs = path.resolve(base, event.input.tool_input.file_path);
              const s = inspect(session), p = inspect(base);
              const owned = p.nearest && !leavesBase(path.relative(p.nearest, abs));
              return s.protected || p.protected || (!owned && inspect(path.dirname(abs)).protected);
            };
            protects = verdict(true) || verdict(false);
          }
          if (protects) scenarios.push({ label: `${JSON.stringify(config)} ${mode.label} ${event.kind}:${event.name}`, kind: event.kind, input, spawnCwd: mode.spawnCwd, env: { ...env, ...(mode.cpd ? { CLAUDE_PROJECT_DIR: mode.cpd } : {}) } });
        }
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  assert.ok(scenarios.length > 300, `matrix exercises protected cases (${scenarios.length})`);
  t.diagnostic(`${configs.length} layouts, ${scenarios.length} protected events checked against the fallback`);

  const baseEnv = { ...process.env, HOME: path.join(work, "home"), USERPROFILE: path.join(work, "home"), LOCALAPPDATA: path.join(work, "local") };
  delete baseEnv.CLAUDE_PROJECT_DIR; delete baseEnv.NODE_OPTIONS;
  const runOne = s => new Promise(resolve => {
    const entry = s.kind === "PreToolUse" ? "skel-hook.mjs" : "skel-config-hook.mjs";
    const child = spawn(process.execPath, [path.join(tool, "bin", entry)], { cwd: s.spawnCwd, env: { ...baseEnv, ...s.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(s.input));
  });
  const failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, os.availableParallelism?.() ?? 4) }, async () => {
    while (next < scenarios.length) {
      const s = scenarios[next++];
      const r = await runOne(s);
      let decision = null;
      try { const out = JSON.parse(r.stdout); decision = out?.hookSpecificOutput?.permissionDecision ?? out?.decision ?? null; } catch {}
      if (r.status !== 0 || decision !== (s.kind === "PreToolUse" ? "deny" : "block")) failures.push(`${s.label}: status ${r.status}, decision ${decision}; ${r.stderr.trim().split("\n").pop()}`);
    }
  }));
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length}/${scenarios.length} protected scenarios allowed by the fallback`);
});
