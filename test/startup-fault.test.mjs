import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
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
    assert.equal(result.status, 0, result.stderr);
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
  f.writeState("fill");
  assert.equal(f.run("PreToolUse", { cwd: outside, tool_name: "Bash", tool_input: { command: "echo x" } }).decision, "deny", "session scope retained");
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
