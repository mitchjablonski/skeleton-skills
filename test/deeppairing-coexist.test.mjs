// #192: coexistence with deepPairing skeleton plans, on a synthetic
// .deeppairing/ fixture shaped like deepPairing's skeleton-scope.ts writes it.
// Default behaviour (no .deeppairing/) must not change.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DP_SCOPE_MAX_AGE_MS, readDeepPairing } from "../lib/deeppairing.mjs";
import { stripMarkers, stripMarkersOf } from "../lib/markers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "bin", "skel.mjs");
const HOOK = path.join(REPO, "bin", "skel-hook.mjs");
const STOP = path.join(REPO, "bin", "skel-stop.mjs");
const NOTE = /deepPairing skeleton plan is live/;
const SKEL_A = 'export function a() {\n  // SKEL[1] a\n  throw new Error("SKEL_TODO");\n  // /SKEL[1]\n}\n';
const DP_B = 'export function b() {\n  // SKEL[d1] b\n  throw new Error("SKEL_TODO");\n  // /SKEL[d1]\n}\n';

function project(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skel-dp-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "proj");
  fs.mkdirSync(root);
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CONFIG_DIR: path.join(base, "claude"), XDG_CONFIG_HOME: path.join(base, "config"), XDG_STATE_HOME: path.join(base, "state"), LOCALAPPDATA: path.join(base, "lad") };
  delete env.CLAUDE_PLUGIN_ROOT;
  const run = (args, input) => spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 60_000, input });
  const skel = (...args) => run([BIN, ...args]);
  const ok = (...args) => { const r = skel(...args); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const hook = (tool_name, tool_input) => run([HOOK], JSON.stringify({ cwd: root, tool_name, tool_input }));
  const stop = () => run([STOP], JSON.stringify({ cwd: root, stop_hook_active: false, session_id: "s1", hook_event_name: "Stop" }));
  return { root, skel, ok, write, read, hook, stop };
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
/** A deepPairing plan, as artifacts.json holds it. */
const plan = ({ id = "plan_1", status = "approved", steps = [{ skelId: "d1", status: "in_progress", files: ["b.js"] }], updatedAt = iso() } = {}) =>
  ({ id, type: "plan", status, title: "dp plan", updatedAt, content: { steps } });
/** Write .deeppairing/: sessions[sid] = artifacts; scopes = scope files. */
function deepPairing(p, { sessions = { sess_1: [plan()] }, scopes = [{ artifactId: "plan_1", activeSkelIds: ["d1"], updatedAt: iso(), sessionId: "sess_1" }] } = {}) {
  for (const [sid, arts] of Object.entries(sessions)) p.write(`.deeppairing/sessions/${sid}/artifacts.json`, typeof arts === "string" ? arts : JSON.stringify(arts));
  for (const s of scopes) p.write(`.deeppairing/skeleton-scopes/${s.artifactId}.json`, typeof s.raw === "string" ? s.raw : JSON.stringify(s));
}

// ---- reading deepPairing's state ----

test("readDeepPairing: absent, live, stale, unfinished-between-steps, finished and unreadable", (t) => {
  const p = project(t);
  assert.deepEqual({ ...readDeepPairing(p.root), gateIds: [], ownedIds: [] }, { present: false, gateIds: [], ownedIds: [], fresh: false, unreadable: 0 });
  deepPairing(p);
  let dp = readDeepPairing(p.root);
  assert.deepEqual([dp.present, [...dp.gateIds], [...dp.ownedIds], dp.fresh, dp.unreadable], [true, ["d1"], ["d1"], true, 0]);

  // Stale scope (deepPairing's own 8 h) and an old plan: nothing gates, nothing fresh, the plan still owns its ids.
  fs.rmSync(path.join(p.root, ".deeppairing"), { recursive: true });
  const old = DP_SCOPE_MAX_AGE_MS + 60_000;
  deepPairing(p, { sessions: { sess_1: [plan({ updatedAt: iso(old) })] }, scopes: [{ artifactId: "plan_1", activeSkelIds: ["d1"], updatedAt: iso(old), sessionId: "sess_1" }] });
  dp = readDeepPairing(p.root);
  assert.deepEqual([[...dp.gateIds], [...dp.ownedIds], dp.fresh], [[], ["d1"], false]);

  // Between steps (no scope), a recently updated unfinished plan is fresh and owns its ids; a draft plan's scope doesn't gate.
  fs.rmSync(path.join(p.root, ".deeppairing"), { recursive: true });
  deepPairing(p, { sessions: { sess_1: [plan({ status: "draft", steps: [{ skelId: "d1", status: "pending" }, { skelId: "d2", status: "done" }] })] }, scopes: [{ artifactId: "plan_1", activeSkelIds: ["d1"], updatedAt: iso(), sessionId: "sess_1" }] });
  dp = readDeepPairing(p.root);
  assert.deepEqual([[...dp.gateIds], [...dp.ownedIds].sort(), dp.fresh], [[], ["d1", "d2"], true]);

  // A finished plan owns nothing; malformed files make ownership undeterminable.
  fs.rmSync(path.join(p.root, ".deeppairing"), { recursive: true });
  deepPairing(p, { sessions: { sess_1: [plan({ steps: [{ skelId: "d1", status: "done" }] })], sess_2: "{ not json" }, scopes: [{ artifactId: "bad", raw: "nope" }] });
  dp = readDeepPairing(p.root);
  assert.deepEqual([[...dp.ownedIds], dp.unreadable], [[], 2]);
});

test("stripMarkersOf strips only the named fences' marker lines", () => {
  const text = `${SKEL_A}${DP_B}`.replaceAll('throw new Error("SKEL_TODO");', "return 1;");
  const out = stripMarkersOf(text, new Set(["1"]));
  assert.doesNotMatch(out, /SKEL\[1\]/);
  assert.match(out, /\/\/ SKEL\[d1\] b\n {2}return 1;\n {2}\/\/ \/SKEL\[d1\]/);
  assert.equal(stripMarkersOf(text, new Set(["1", "d1"])), stripMarkers(text));
});

// ---- init, approve, finalize ----

test("default (no .deeppairing/): init, approve and finalize say nothing about deepPairing and strip every marker", (t) => {
  const p = project(t);
  p.write("a.js", SKEL_A);
  for (const r of [p.ok("init", "t"), p.ok("approve")]) assert.doesNotMatch(r.stdout + r.stderr, /deepPairing/);
  p.ok("next");
  p.write("a.js", SKEL_A.replace('throw new Error("SKEL_TODO");', "return 1;"));
  p.ok("done");
  const r = p.ok("finalize");
  assert.doesNotMatch(r.stdout + r.stderr, /deepPairing|untouched/);
  assert.doesNotMatch(p.read("a.js"), /SKEL/);
});

test("init and approve warn while a fresh plan is live, and approve counts the fence ids both claim", (t) => {
  const p = project(t);
  p.write("a.js", SKEL_A);
  deepPairing(p, { sessions: { sess_1: [plan({ steps: [{ skelId: "1", status: "pending" }] })] }, scopes: [] });
  assert.match(p.ok("init", "t").stderr, NOTE);
  const r = p.ok("approve");
  assert.match(r.stderr, NOTE);
  assert.match(r.stderr, /1 fence id\(s\) just approved are also named by a live deepPairing plan/);
});

test("a stale plan doesn't warn", (t) => {
  const p = project(t);
  p.write("a.js", SKEL_A);
  const old = DP_SCOPE_MAX_AGE_MS + 60_000;
  deepPairing(p, { sessions: { sess_1: [plan({ updatedAt: iso(old) })] }, scopes: [{ artifactId: "plan_1", activeSkelIds: ["d1"], updatedAt: iso(old), sessionId: "sess_1" }] });
  assert.doesNotMatch(p.ok("init", "t").stderr, /deepPairing/);
});

/** An approved, filled one-step skel skeleton, ready to finalize. */
function filled(p) {
  p.write("a.js", SKEL_A);
  p.ok("init", "t");
  p.ok("approve");
  p.ok("next");
  p.write("a.js", SKEL_A.replace('throw new Error("SKEL_TODO");', "return 1;"));
  p.ok("done");
}

test("finalize next to a live plan strips only this skeleton's fences", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p);
  const r = p.ok("finalize");
  assert.match(r.stderr, NOTE);
  assert.doesNotMatch(p.read("a.js"), /SKEL/);
});

test("finalize refuses when a live plan names a fence this skeleton approved", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { sessions: { sess_1: [plan({ steps: [{ skelId: "1", status: "in_progress" }] })] }, scopes: [] });
  const r = p.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /1 fence\(s\) this skeleton approved are also named by a live deepPairing plan/);
  assert.match(p.read("a.js"), /SKEL\[1\]/, "nothing stripped");
});

test("finalize refuses to strip when deepPairing's state can't be read", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { sessions: { sess_1: "{ broken" }, scopes: [] });
  const r = p.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /can't tell which fences belong to deepPairing: 1 file\(s\)/);
  assert.match(p.read("a.js"), /SKEL\[1\]/);
});

// ---- the PreToolUse gate ----

/** skel approved with SKEL[1] in a.js (no step active); deepPairing's fence SKEL[d1] lives in b.js. */
function gated(p, dp = {}) {
  p.write("a.js", SKEL_A);
  p.ok("init", "t", "--gate", "deny");
  p.ok("approve");
  p.write("b.js", DP_B);
  if (dp) deepPairing(p, dp);
}
const fillB = { file_path: "b.js", old_string: 'throw new Error("SKEL_TODO");\n  // /SKEL[d1]', new_string: "return 2;\n  // /SKEL[d1]" };
const insideB = { file_path: "b.js", old_string: '  throw new Error("SKEL_TODO");', new_string: "  return 2;" };
const decision = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null; };

test("gate: an edit inside a fence a live, approved deepPairing scope is filling is left to deepPairing", (t) => {
  const p = project(t);
  gated(p);
  assert.equal(decision(p.hook("Edit", insideB)), null);
  assert.equal(decision(p.hook("MultiEdit", { file_path: "b.js", edits: [{ old_string: insideB.old_string, new_string: insideB.new_string }] })), null);
});

test("gate: without a live approved scope, or for anything beyond that fence's body, skel still gates", (t) => {
  const cases = {
    "no .deeppairing": null,
    "draft plan": { sessions: { sess_1: [plan({ status: "draft" })] } },
    "stale scope": { scopes: [{ artifactId: "plan_1", activeSkelIds: ["d1"], updatedAt: iso(DP_SCOPE_MAX_AGE_MS + 60_000), sessionId: "sess_1" }] },
    "scope without its plan": { sessions: {} },
  };
  for (const [name, dp] of Object.entries(cases)) {
    const p = project(t);
    gated(p, dp);
    assert.equal(decision(p.hook("Edit", insideB)), "deny", name);
  }
  const p = project(t);
  gated(p);
  assert.equal(decision(p.hook("Edit", fillB)), "deny", "an edit that touches the marker line");
  assert.equal(decision(p.hook("Edit", { file_path: "b.js", old_string: 'export function b() {\n  // SKEL[d1] b\n  throw new Error("SKEL_TODO");', new_string: 'export function b(x) {\n  // SKEL[d1] b\n  return 2;' })), "deny", "a body edit that also changes the signature");
  assert.equal(decision(p.hook("Write", { file_path: "b.js", content: DP_B.replace('throw new Error("SKEL_TODO");', "return 2;") })), "deny", "Write isn't confined");
});

test("gate: a deepPairing claim can never take a fence skel approved", (t) => {
  const p = project(t);
  gated(p, { sessions: { sess_1: [plan({ steps: [{ skelId: "1", status: "in_progress" }] })] }, scopes: [{ artifactId: "plan_1", activeSkelIds: ["1"], updatedAt: iso(), sessionId: "sess_1" }] });
  assert.equal(decision(p.hook("Edit", { file_path: "a.js", old_string: '  throw new Error("SKEL_TODO");', new_string: "  return 1;" })), "deny");
});

// ---- the Stop hook ----

test("stop: drift with a live deepPairing scope notifies without a corrective continuation; without one it blocks", (t) => {
  for (const live of [false, true]) {
    const p = project(t);
    gated(p, live ? {} : null);
    fs.rmSync(path.join(p.root, "b.js"));
    p.write("a.js", `// drift\n${SKEL_A}`);
    const r = p.stop();
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /a\.js/);
    if (live) {
      assert.equal(out.decision, undefined);
      assert.match(out.systemMessage, /deepPairing skeleton plan is filling/);
    } else {
      assert.equal(out.decision, "block");
    }
  }
});
