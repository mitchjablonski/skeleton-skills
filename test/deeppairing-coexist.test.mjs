// #192: coexistence with deepPairing skeleton plans, on a synthetic
// .deeppairing/ fixture shaped like deepPairing's skeleton-scope.ts writes it.
// Default behaviour (no .deeppairing/) must not change. Gate yielding and the
// Stop downgrade are off unless the human ran `skel install --deeppairing-yield`.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DP_MAX_FILES, DP_MAX_IDS, DP_MAX_SESSIONS, DP_MAX_STEPS, DP_SCOPE_MAX_AGE_MS, deepPairingSessionIds, optInRefusal, ownsFence, readDeepPairing } from "../lib/deeppairing.mjs";
import { isPhaseChange } from "../lib/phase.mjs";
import { projectKey } from "../lib/state.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "bin", "skel.mjs");
const HOOK = path.join(REPO, "bin", "skel-hook.mjs");
const STOP = path.join(REPO, "bin", "skel-stop.mjs");
const NOTE = /deepPairing skeleton plan is live/;
const TODO = 'throw new Error("SKEL_TODO");';
const SKEL_A = `export function a() {\n  // SKEL[1] a\n  ${TODO}\n  // /SKEL[1]\n}\n`;
const DP_B = `export function b() {\n  // SKEL[d1] b\n  ${TODO}\n  // /SKEL[d1]\n}\n`;
const SID = "s1";

function project(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skel-dp-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "proj");
  fs.mkdirSync(root);
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CONFIG_DIR: path.join(base, "claude"), XDG_CONFIG_HOME: path.join(base, "config"), XDG_STATE_HOME: path.join(base, "state"), LOCALAPPDATA: path.join(base, "lad") };
  delete env.CLAUDE_PLUGIN_ROOT;
  const run = (args, input, { cwd = root, projectDir = root } = {}) => spawnSync(process.execPath, args, { cwd, env: { ...env, CLAUDE_PROJECT_DIR: projectDir }, encoding: "utf8", timeout: 60_000, input });
  const skel = (...args) => run([BIN, ...args]);
  const ok = (...args) => { const r = skel(...args); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const hook = (tool_name, tool_input, session_id = SID, { cwd = root, projectDir = root } = {}) => run([HOOK], JSON.stringify({ cwd, session_id, tool_name, tool_input }), { cwd, projectDir });
  const stop = () => run([STOP], JSON.stringify({ cwd: root, stop_hook_active: false, session_id: SID, hook_event_name: "Stop" }));
  // The opt-in needs a TTY (a human's terminal), which tests don't have, so
  // tests record it in install's ownership record directly, as install would.
  const recordFile = (dir) => path.join(base, "state", "skel", `${projectKey(dir)}-install.json`);
  const readOpt = (dir = root) => { try { return JSON.parse(fs.readFileSync(recordFile(dir), "utf8")).deepPairing; } catch { return undefined; } };
  const setOpt = (dir, value) => {
    let rec = { root: dir, ownedDeny: [] };
    try { rec = JSON.parse(fs.readFileSync(recordFile(dir), "utf8")); } catch {}
    if (value === undefined) delete rec.deepPairing; else rec.deepPairing = value;
    fs.mkdirSync(path.dirname(recordFile(dir)), { recursive: true });
    fs.writeFileSync(recordFile(dir), JSON.stringify(rec));
  };
  const optIn = () => setOpt(root, "yield");
  return { base, root, skel, ok, write, read, hook, stop, optIn, setOpt, readOpt };
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const OLD = DP_SCOPE_MAX_AGE_MS + 60_000;
const dpSession = (root) => [...deepPairingSessionIds(root, SID)][0];
const plan = ({ id = "plan_1", status = "approved", steps = [{ skelId: "d1", status: "in_progress", files: ["b.js"] }], updatedAt = iso() } = {}) =>
  ({ id, type: "plan", status, title: "dp plan", updatedAt, content: { steps } });
const scope = (root, over = {}) => ({ artifactId: "plan_1", activeSkelIds: ["d1"], updatedAt: iso(), sessionId: dpSession(root), workspaceRoot: root, ...over });
/** Write .deeppairing/: sessions[sid] = artifacts; scopes = scope files. Defaults: one live, approved plan filling SKEL[d1]. */
function deepPairing(p, { sessions, scopes } = {}) {
  sessions ??= { [dpSession(p.root)]: [plan()] };
  scopes ??= [scope(p.root)];
  for (const [sid, arts] of Object.entries(sessions)) p.write(`.deeppairing/sessions/${sid}/artifacts.json`, typeof arts === "string" ? arts : JSON.stringify(arts));
  for (const s of scopes) p.write(`.deeppairing/skeleton-scopes/${s.name ?? s.artifactId}.json`, typeof s.raw === "string" ? s.raw : JSON.stringify(s));
}
const resetDp = (p) => fs.rmSync(path.join(p.root, ".deeppairing"), { recursive: true, force: true });

// ---- reading deepPairing's state ----

test("the session id is derived as deepPairing derives it", (t) => {
  const p = project(t);
  const hash = crypto.createHash("sha256").update(p.root).digest("hex").slice(0, 8);
  assert.ok(deepPairingSessionIds(p.root, SID).has(`session_proj_${hash}_s1`));
  assert.ok(deepPairingSessionIds(p.root, "../x").has(`session_proj_${hash}`), "an unusable id gives the fallback");
});

test("readDeepPairing: absent, live, stale, future-dated, old or finished plans, duplicates", (t) => {
  const p = project(t);
  assert.deepEqual(readDeepPairing(p.root), { status: "absent", present: false, owned: [], fresh: false, gateScopes: [], unreadable: 0 });
  deepPairing(p);
  let dp = readDeepPairing(p.root);
  assert.deepEqual([dp.fresh, dp.unreadable, dp.gateScopes.map((s) => s.activeSkelIds)], [true, 0, [["d1"]]]);
  assert.ok(ownsFence(dp, "b.js", "d1"));

  resetDp(p);
  const sid = dpSession(p.root);
  deepPairing(p, { sessions: { [sid]: [plan({ updatedAt: iso(OLD) })] }, scopes: [scope(p.root, { updatedAt: iso(OLD) })] });
  dp = readDeepPairing(p.root);
  assert.deepEqual([dp.fresh, dp.owned, dp.gateScopes], [false, [], []], "stale scope and an old plan: nothing live");

  resetDp(p);
  deepPairing(p, { sessions: { [sid]: [plan({ updatedAt: iso(-OLD) })] }, scopes: [scope(p.root, { updatedAt: iso(-60_000) })] });
  dp = readDeepPairing(p.root);
  assert.deepEqual([dp.fresh, dp.owned, dp.gateScopes], [false, [], []], "future-dated stamps are ignored");

  resetDp(p);
  deepPairing(p, { sessions: { [sid]: [plan({ steps: [{ skelId: "d1", status: "done" }] })] }, scopes: [] });
  assert.deepEqual(readDeepPairing(p.root).owned, [], "a finished plan owns nothing");

  resetDp(p);
  deepPairing(p, { sessions: { [sid]: [plan({ status: "rejected" }), plan({ status: "approved" })] } });
  assert.deepEqual(readDeepPairing(p.root).gateScopes, [], "the first of duplicate plan ids wins, as in deepPairing");
});

test("readDeepPairing fails closed: malformed, symlinked, FIFO, over budget, too many or badly named", (t) => {
  const p = project(t);
  const sid = dpSession(p.root);
  const cases = {
    malformed: () => deepPairing(p, { sessions: { [sid]: "{ nope" }, scopes: [{ name: "x", raw: "nope" }] }),
    "symlinked .deeppairing": () => { const real = path.join(p.base, "elsewhere"); fs.mkdirSync(path.join(real, "skeleton-scopes"), { recursive: true }); fs.symlinkSync(real, path.join(p.root, ".deeppairing")); },
    "symlinked skeleton-scopes": () => { fs.mkdirSync(path.join(p.root, ".deeppairing"), { recursive: true }); const real = path.join(p.base, "scopes"); fs.mkdirSync(real, { recursive: true }); fs.symlinkSync(real, path.join(p.root, ".deeppairing", "skeleton-scopes")); },
    "over the byte budget": () => deepPairing(p, { sessions: { [sid]: JSON.stringify([plan(), { pad: "x".repeat(1100 * 1024) }]) } }),
    "too many sessions": () => { for (let i = 0; i <= DP_MAX_SESSIONS; i++) p.write(`.deeppairing/sessions/s${String(i).padStart(3, "0")}/artifacts.json`, "[]"); },
    "badly named session": () => p.write(".deeppairing/sessions/bad.name/artifacts.json", "[]"),
  };
  if (process.platform !== "win32") cases.fifo = () => { fs.mkdirSync(path.join(p.root, ".deeppairing", "sessions", sid), { recursive: true }); execFileSync("mkfifo", [path.join(p.root, ".deeppairing", "sessions", sid, "artifacts.json")]); };
  for (const [name, make] of Object.entries(cases)) {
    resetDp(p);
    make();
    const t0 = Date.now();
    const dp = readDeepPairing(p.root);
    assert.ok(dp.unreadable > 0, name);
    assert.ok(Date.now() - t0 < 5000, `${name}: finishes fast`);
  }
});

test("a hard-linked large artifacts.json in every session exhausts the budget fast and counts as unreadable", (t) => {
  const p = project(t);
  const big = path.join(p.root, ".deeppairing", "big.json");
  p.write(".deeppairing/big.json", JSON.stringify([plan(), { pad: "x".repeat(600 * 1024) }]));
  for (let i = 0; i < DP_MAX_SESSIONS; i++) {
    fs.mkdirSync(path.join(p.root, ".deeppairing", "sessions", `s${i}`), { recursive: true });
    fs.linkSync(big, path.join(p.root, ".deeppairing", "sessions", `s${i}`, "artifacts.json"));
  }
  const t0 = Date.now();
  assert.ok(readDeepPairing(p.root).unreadable > 0);
  assert.ok(Date.now() - t0 < 5000);
});

test("ownsFence compares files as well as ids", () => {
  const dp = { owned: [{ id: "1", files: ["./src/x.js"] }, { id: "2", files: null }] };
  assert.ok(ownsFence(dp, "src/x.js", "1"));
  assert.ok(!ownsFence(dp, "a.js", "1"));
  assert.ok(ownsFence(dp, "a.js", "2"));
});

// ---- init, approve, finalize ----

test("default (no .deeppairing/): init, approve and finalize say nothing about deepPairing and strip every marker", (t) => {
  const p = project(t);
  p.write("a.js", SKEL_A);
  for (const r of [p.ok("init", "t"), p.ok("approve")]) assert.doesNotMatch(r.stdout + r.stderr, /deepPairing/);
  p.ok("next");
  p.write("a.js", SKEL_A.replace(TODO, "return 1;"));
  p.ok("done");
  const r = p.ok("finalize");
  assert.doesNotMatch(r.stdout + r.stderr, /deepPairing|untouched/);
  assert.doesNotMatch(p.read("a.js"), /SKEL/);
});

test("init and approve warn while a fresh plan is live; approve counts fences both claim; a stale plan doesn't warn", (t) => {
  const p = project(t);
  p.write("a.js", SKEL_A);
  deepPairing(p, { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "1", status: "pending", files: ["a.js"] }] })] }, scopes: [] });
  assert.match(p.ok("init", "t").stderr, NOTE);
  const r = p.ok("approve");
  assert.match(r.stderr, NOTE);
  assert.match(r.stderr, /1 fence\(s\) just approved are also named by a live deepPairing plan/);
  const q = project(t);
  q.write("a.js", SKEL_A);
  deepPairing(q, { sessions: { [dpSession(q.root)]: [plan({ updatedAt: iso(OLD) })] }, scopes: [scope(q.root, { updatedAt: iso(OLD) })] });
  assert.doesNotMatch(q.ok("init", "t").stderr, /deepPairing/);
});

/** An approved, filled one-step skel skeleton, ready to finalize. */
function filled(p) {
  p.write("a.js", SKEL_A);
  p.ok("init", "t");
  p.ok("approve");
  p.ok("next");
  p.write("a.js", SKEL_A.replace(TODO, "return 1;"));
  p.ok("done");
}

test("finalize next to a live plan strips only this skeleton's fences", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p);
  assert.match(p.ok("finalize").stderr, NOTE);
  assert.doesNotMatch(p.read("a.js"), /SKEL/);
});

test("finalize refuses when a live plan names a fence this skeleton approved, in the same file", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["a.js"] }] })] }, scopes: [] });
  const r = p.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /1 fence\(s\) finalize would strip are claimed by a live deepPairing plan/);
  assert.match(p.read("a.js"), /SKEL\[1\]/, "nothing stripped");
});

test("an old draft, or a plan naming the same id in another file, doesn't block finalize", (t) => {
  for (const arts of [[plan({ status: "draft", steps: [{ skelId: "1", status: "pending" }], updatedAt: iso(OLD) })], [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["other.js"] }] })]]) {
    const p = project(t);
    filled(p);
    deepPairing(p, { sessions: { [dpSession(p.root)]: arts }, scopes: [] });
    p.ok("finalize");
    assert.doesNotMatch(p.read("a.js"), /SKEL/);
  }
});

test("finalize refuses to strip when deepPairing's state can't be read", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { sessions: { [dpSession(p.root)]: "{ broken" }, scopes: [] });
  const r = p.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /can't tell which fences belong to deepPairing/);
  assert.match(p.read("a.js"), /SKEL\[1\]/);
});

// ---- the PreToolUse gate ----

/** skel approved with SKEL[1] in a.js (gate deny, no step active); deepPairing's SKEL[d1] lives in b.js. */
function gated(p, { dp = {}, optIn = true } = {}) {
  p.write("a.js", SKEL_A);
  p.ok("init", "t", "--gate", "deny");
  p.ok("approve");
  if (optIn) p.optIn();
  p.write("b.js", DP_B);
  if (dp) deepPairing(p, dp);
}
const insideB = { file_path: "b.js", old_string: `  ${TODO}`, new_string: "  return 2;" };
const decision = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null; };

test("gate: without the human's opt-in, a live deepPairing scope changes nothing", (t) => {
  const p = project(t);
  gated(p, { optIn: false });
  assert.equal(decision(p.hook("Edit", insideB)), "deny");
});

test("the opt-in needs an interactive invocation; turning it off doesn't", (t) => {
  const p = project(t);
  p.write("a.js", SKEL_A);
  p.ok("init", "t");
  const r = p.skel("install", "--deeppairing-yield");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs an interactive invocation/);
  assert.match(r.stderr, /in your own terminal/);
  assert.equal(p.readOpt(), undefined, "nothing recorded");
  p.ok("install");
  p.optIn();
  assert.equal(p.readOpt(), "yield");
  assert.match(p.ok("install", "--no-deeppairing-yield").stdout, /skel gates every fence/);
  assert.equal(p.readOpt(), "off", "turned off without a TTY, as an explicit off");
  p.ok("install");
  assert.equal(p.readOpt(), "off", "a plain re-install keeps the choice");
});

test("optInRefusal: both stdin and stdout must be TTYs", () => {
  assert.equal(optInRefusal({ stdinTTY: true, stdoutTTY: true }), null);
  for (const tty of [{ stdinTTY: false, stdoutTTY: true }, { stdinTTY: true, stdoutTTY: false }, { stdinTTY: false, stdoutTTY: false }]) assert.match(optInRefusal(tty), /needs an interactive invocation/);
});

test("gate: the opt-in itself asks the human (defence in depth)", () => {
  for (const cmd of ["skel install --deeppairing-yield", "node bin/skel.mjs install --no-deeppairing-yield ."]) assert.equal(isPhaseChange(cmd), "coexist", cmd);
});

test("gate, opted in: an edit inside a fence a live, approved deepPairing scope fills for this session is left to deepPairing", (t) => {
  const p = project(t);
  gated(p);
  assert.equal(decision(p.hook("Edit", insideB)), null);
  assert.equal(decision(p.hook("MultiEdit", { file_path: "b.js", edits: [{ old_string: insideB.old_string, new_string: insideB.new_string }] })), null);
});

test("gate, opted in: skel still gates without a matching live approved scope", (t) => {
  const cases = {
    "no .deeppairing": null,
    "draft plan": (root) => ({ sessions: { [dpSession(root)]: [plan({ status: "draft" })] } }),
    "stale scope": (root) => ({ scopes: [scope(root, { updatedAt: iso(OLD) })] }),
    "future-dated scope": (root) => ({ scopes: [scope(root, { updatedAt: iso(-60_000) })] }),
    "scope without its plan": () => ({ sessions: {} }),
    "another session's scope": (root) => ({ scopes: [scope(root, { sessionId: `${dpSession(root)}x` })] }),
    "file outside the scope's workspaceRoot": (root) => ({ scopes: [scope(root, { workspaceRoot: path.join(root, "sub") })] }),
    "unreadable state": (root) => ({ sessions: { [dpSession(root)]: [plan()], other: "{ bad" } }),
  };
  for (const [name, dp] of Object.entries(cases)) {
    const p = project(t);
    gated(p, { dp: dp && dp(p.root) });
    assert.equal(decision(p.hook("Edit", insideB)), "deny", name);
  }
});

test("gate, opted in: a symlinked .deeppairing, or a huge hard-linked fixture, never yields and finishes fast", (t) => {
  const p = project(t);
  gated(p, { dp: null });
  const real = path.join(p.base, "dp-real");
  const sid = dpSession(p.root);
  fs.mkdirSync(path.join(real, "sessions", sid), { recursive: true });
  fs.writeFileSync(path.join(real, "sessions", sid, "artifacts.json"), JSON.stringify([plan()]));
  fs.mkdirSync(path.join(real, "skeleton-scopes"));
  fs.writeFileSync(path.join(real, "skeleton-scopes", "plan_1.json"), JSON.stringify(scope(p.root)));
  fs.symlinkSync(real, path.join(p.root, ".deeppairing"));
  assert.equal(decision(p.hook("Edit", insideB)), "deny", "symlinked .deeppairing");

  const q = project(t);
  gated(q, { dp: { scopes: [scope(q.root)], sessions: {} } });
  const big = path.join(q.root, ".deeppairing", "big.json");
  fs.writeFileSync(big, JSON.stringify([plan(), { pad: "x".repeat(600 * 1024) }]));
  for (const s of [dpSession(q.root), ...Array.from({ length: 40 }, (_, i) => `s${i}`)]) {
    fs.mkdirSync(path.join(q.root, ".deeppairing", "sessions", s), { recursive: true });
    fs.linkSync(big, path.join(q.root, ".deeppairing", "sessions", s, "artifacts.json"));
  }
  const t0 = Date.now();
  assert.equal(decision(q.hook("Edit", insideB)), "deny", "budget exhausted");
  assert.ok(Date.now() - t0 < 15_000);
});

test("gate, opted in: anything beyond that fence's body, or a body leaving its block, is still gated", (t) => {
  const p = project(t);
  gated(p);
  assert.equal(decision(p.hook("Edit", { file_path: "b.js", old_string: `${TODO}\n  // /SKEL[d1]`, new_string: "return 2;\n  // /SKEL[d1]" })), "deny", "touches the marker line");
  assert.equal(decision(p.hook("Edit", { file_path: "b.js", old_string: `export function b() {\n  // SKEL[d1] b\n  ${TODO}`, new_string: "export function b(x) {\n  // SKEL[d1] b\n  return 2;" })), "deny", "also changes the signature");
  assert.equal(decision(p.hook("Write", { file_path: "b.js", content: DP_B.replace(TODO, "return 2;") })), "deny", "Write isn't confined");
  assert.notEqual(decision(p.hook("Edit", { file_path: "b.js", old_string: `  ${TODO}`, new_string: "  return 2;\n}\nexport function evil() {" })), null, "a body that escapes its block");
});

test("gate, opted in: a deepPairing claim can never take a fence skel approved", (t) => {
  const p = project(t);
  gated(p, { dp: { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "1", status: "in_progress" }] })] }, scopes: [scope(p.root, { activeSkelIds: ["1"] })] } });
  assert.equal(decision(p.hook("Edit", { file_path: "a.js", old_string: `  ${TODO}`, new_string: "  return 1;" })), "deny");
});

// ---- the Stop hook ----

/** skel approved with SKEL[1] in a.js and SKEL[2] in c.js; then deepPairing's SKEL[d1] added to a.js (drift there). */
function drifted(p, { optIn, live = true }) {
  p.write("a.js", SKEL_A);
  p.write("c.js", SKEL_A.replaceAll("SKEL[1]", "SKEL[2]"));
  p.ok("init", "t");
  p.ok("approve");
  if (optIn) p.optIn();
  p.write("a.js", SKEL_A + DP_B);
  if (live) deepPairing(p, { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "d1", status: "in_progress", files: ["a.js"] }] })] } });
}
const stopOut = (p) => { const r = p.stop(); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test("stop: a live deepPairing scope never downgrades skel's drift correction, opted in or not", (t) => {
  for (const optIn of [false, true]) {
    const p = project(t);
    drifted(p, { optIn });
    const out = stopOut(p);
    assert.equal(out.decision, "block", `optIn ${optIn}`);
    assert.doesNotMatch(out.systemMessage, /deepPairing/);
  }
});

// ---- #243 cross-review: lookup failure vs absence ----

test("a permission failure is unreadable, never absent, and finalize refuses", { skip: process.platform === "win32" || process.getuid?.() === 0 }, (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p);
  const dir = path.join(p.root, ".deeppairing");
  fs.chmodSync(dir, 0o000);
  t.after(() => { try { fs.chmodSync(dir, 0o755); } catch {} });
  const dp = readDeepPairing(p.root);
  assert.equal(dp.status, "unreadable");
  const r = p.skel("finalize");
  fs.chmodSync(dir, 0o755);
  assert.notEqual(r.status, 0);
  // Source discovery (git) may refuse first; either way nothing is stripped.
  assert.match(r.stderr, /can't tell which fences belong to deepPairing|source set/);
  assert.match(p.read("a.js"), /SKEL\[1\]/);
});

test("a truncated step, file or active-id list is unreadable, and finalize refuses", (t) => {
  const p = project(t);
  const sid = dpSession(p.root);
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const cases = {
    steps: { sessions: { [sid]: [plan({ steps: many(DP_MAX_STEPS + 1, (i) => ({ skelId: `x${i}`, status: "pending" })) })] }, scopes: [] },
    files: { sessions: { [sid]: [plan({ steps: [{ skelId: "d1", status: "pending", files: many(DP_MAX_FILES + 1, (i) => `f${i}.js`) }] })] }, scopes: [] },
    "active ids": { scopes: [scope(p.root, { activeSkelIds: many(DP_MAX_IDS + 1, (i) => `x${i}`) })] },
  };
  for (const [name, dp] of Object.entries(cases)) {
    resetDp(p);
    deepPairing(p, dp);
    assert.equal(readDeepPairing(p.root).status, "unreadable", name);
  }
  const q = project(t);
  filled(q);
  deepPairing(q, { scopes: [scope(q.root, { activeSkelIds: many(DP_MAX_IDS + 1, (i) => `x${i}`) })] });
  const r = q.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(q.read("a.js"), /SKEL\[1\]/);
});

// ---- #243 cross-review: canonical paths ----

test("gate, opted in: the gate's own canonical path decides; .., symlinks and case variants of skel's files never yield", (t) => {
  // deepPairing's SKEL[d1] added to a.js, one of skel's approved files.
  const p = project(t);
  gated(p, { dp: { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "d1", status: "in_progress", files: ["a.js"] }] })] } } });
  p.write("a.js", SKEL_A + DP_B);
  const inside = (file_path) => ({ file_path, old_string: `  ${TODO}\n  // /SKEL[d1]`, new_string: "  return 2;\n  // /SKEL[d1]" });
  fs.mkdirSync(path.join(p.root, "sub"));
  fs.symlinkSync(path.join(p.root, "a.js"), path.join(p.root, "link.js"));
  for (const target of ["a.js", "sub/../a.js", path.join(p.root, "sub", "..", "a.js"), "link.js"]) assert.equal(decision(p.hook("Edit", inside(target))), "deny", target);

  // A case variant of an approved file holding a foreign fence (case-sensitive filesystems).
  const q = project(t);
  gated(q, { dp: { sessions: { [dpSession(q.root)]: [plan({ steps: [{ skelId: "d1", status: "in_progress" }] })] } } });
  if (!fs.existsSync(path.join(q.root, "A.JS"))) {
    q.write("A.JS", DP_B);
    assert.equal(decision(q.hook("Edit", { ...insideB, file_path: "A.JS" })), "deny", "A.JS folds to a.js");
  }
  // The yield itself still works through a `..` spelling of a foreign file.
  assert.equal(decision(q.hook("Edit", { ...insideB, file_path: "sub/../b.js" })), null);
});

test("gate, opted in: a missing, relative, nonexistent or non-canonical workspaceRoot never yields", (t) => {
  const alias = (p) => { const l = path.join(p.base, "alias"); fs.symlinkSync(p.root, l); return l; };
  const cases = {
    missing: () => ({ workspaceRoot: undefined }),
    relative: () => ({ workspaceRoot: "proj" }),
    nonexistent: (p) => ({ workspaceRoot: path.join(p.root, "nope") }),
    "with ..": (p) => { fs.mkdirSync(path.join(p.root, "x"), { recursive: true }); return { workspaceRoot: `${p.root}/x/..` }; },
    symlinked: (p) => ({ workspaceRoot: alias(p) }),
  };
  for (const [name, over] of Object.entries(cases)) {
    const p = project(t);
    gated(p, { dp: { scopes: [scope(p.root, over(p))] } });
    assert.equal(decision(p.hook("Edit", insideB)), "deny", name);
  }
});

// ---- #243 cross-review: a local explicit opt-out beats an ancestor's opt-in ----

test("gate: a parent's opt-in covers a nested project, but the project's explicit opt-out wins", (t) => {
  const p = project(t);
  gated(p, { optIn: false });
  p.setOpt(p.base, "yield");
  assert.equal(decision(p.hook("Edit", insideB)), null, "inherited from the parent");
  p.setOpt(p.root, "off");
  assert.equal(decision(p.hook("Edit", insideB)), "deny", "explicit off beats the parent");
  p.setOpt(p.root, undefined);
  assert.equal(decision(p.hook("Edit", insideB)), null, "a record without the field inherits");
});

// ---- #243 re-review: one target, nearest opt-out, bounded listing, finalize ----

test("gate, opted in: the hook and the gate resolve a relative edit path against the event's cwd", (t) => {
  const p = project(t);
  gated(p, { dp: { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "d1", status: "in_progress", files: ["sub/b.js"] }] })] } } });
  p.write("sub/b.js", DP_B);
  // What a root-relative resolution would read instead: a fence no live scope fills, so it would deny.
  const other = DP_B.replaceAll("SKEL[d1]", "SKEL[zz]");
  p.write("b.js", other);
  const sub = path.join(p.root, "sub");
  assert.equal(decision(p.hook("Edit", insideB, SID, { cwd: sub })), null, "sub/b.js, as Claude Code resolves it");
  assert.equal(decision(p.hook("Edit", insideB)), "deny", "from the root, b.js is the other file");
});

test("gate: a nested Claude project's explicit off beats an enclosing skeleton's yield", (t) => {
  const p = project(t);
  gated(p, { optIn: false });
  const inner = path.join(p.root, "inner");
  fs.mkdirSync(inner);
  p.write("inner/b.js", DP_B);
  p.setOpt(p.root, "yield");
  p.setOpt(inner, "off");
  const edit = { ...insideB, file_path: path.join(inner, "b.js") };
  const live = { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "d1", status: "in_progress" }] })] } };
  deepPairing(p, live);
  assert.equal(decision(p.hook("Edit", edit, SID, { cwd: inner, projectDir: inner })), "deny", "the nearer explicit off wins");
  p.setOpt(inner, undefined);
  assert.equal(decision(p.hook("Edit", edit, SID, { cwd: inner, projectDir: inner })), null, "without it, the enclosing yield applies");
});

test("directory listing is bounded: one entry past a cap is unreadable", (t) => {
  const p = project(t);
  for (let i = 0; i <= 64; i++) p.write(`.deeppairing/skeleton-scopes/s${String(i).padStart(3, "0")}.json`, "{}");
  const t0 = Date.now();
  assert.equal(readDeepPairing(p.root).status, "unreadable");
  assert.ok(Date.now() - t0 < 5000);
});

test("finalize: a live deepPairing fence in a separate untracked file is never stripped", (t) => {
  // b.js appears after approval: the source-baseline check refuses before anything is stripped.
  const p = project(t);
  filled(p);
  p.write("b.js", DP_B);
  deepPairing(p);
  const r = p.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(p.read("a.js"), /SKEL\[1\]/, "a.js untouched");
  assert.equal(p.read("b.js"), DP_B, "b.js untouched");
  // A gitignored b.js is outside skel's scan and baseline: a.js is stripped, b.js left as it is.
  const q = project(t);
  q.write(".gitignore", "b.js\n");
  filled(q);
  q.write("b.js", DP_B);
  deepPairing(q);
  q.ok("finalize");
  assert.doesNotMatch(q.read("a.js"), /SKEL/);
  assert.equal(q.read("b.js"), DP_B);
});

test("finalize: ownership is by (file, id): a live scope whose plan lists another file doesn't block", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { sessions: { [dpSession(p.root)]: [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["b.js"] }] })] }, scopes: [scope(p.root, { activeSkelIds: ["1"] })] });
  p.ok("finalize");
  assert.doesNotMatch(p.read("a.js"), /SKEL/);
  const q = project(t);
  filled(q);
  deepPairing(q, { sessions: { [dpSession(q.root)]: [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["a.js"] }] })] }, scopes: [scope(q.root, { activeSkelIds: ["1"] })] });
  assert.notEqual(q.skel("finalize").status, 0, "the same file and id: refused");
  assert.match(q.read("a.js"), /SKEL\[1\]/);
});
