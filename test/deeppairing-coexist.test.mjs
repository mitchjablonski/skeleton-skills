// #192: coexistence with deepPairing skeleton plans, on a synthetic
// .deeppairing/ fixture shaped like deepPairing's skeleton-scope.ts writes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DP_MAX_FILES, DP_MAX_IDS, DP_MAX_SESSIONS, DP_MAX_STEPS, DP_SCOPE_MAX_AGE_MS, ownsFence, readDeepPairing } from "../lib/deeppairing.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "bin", "skel.mjs");
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
  return { base, root, skel, ok, write, read };
}

// Backdated a few seconds by default, so clock skew can't make "now" look future-dated.
const iso = (msAgo = 5000) => new Date(Date.now() - msAgo).toISOString();
const OLD = DP_SCOPE_MAX_AGE_MS + 60_000;
const plan = ({ id = "plan_1", status = "approved", steps = [{ skelId: "d1", status: "in_progress", files: ["b.js"] }], updatedAt = iso() } = {}) =>
  ({ id, type: "plan", status, title: "dp plan", updatedAt, content: { steps } });
const scope = (root, over = {}) => ({ artifactId: "plan_1", activeSkelIds: ["d1"], updatedAt: iso(), sessionId: SID, workspaceRoot: root, ...over });
/** Write .deeppairing/: sessions[sid] = artifacts; scopes = scope files. Defaults: one live, approved plan filling SKEL[d1]. */
function deepPairing(p, { sessions, scopes } = {}) {
  sessions ??= { [SID]: [plan()] };
  scopes ??= [scope(p.root)];
  for (const [sid, arts] of Object.entries(sessions)) p.write(`.deeppairing/sessions/${sid}/artifacts.json`, typeof arts === "string" ? arts : JSON.stringify(arts));
  for (const s of scopes) p.write(`.deeppairing/skeleton-scopes/${s.name ?? s.artifactId}.json`, typeof s.raw === "string" ? s.raw : JSON.stringify(s));
}
const resetDp = (p) => fs.rmSync(path.join(p.root, ".deeppairing"), { recursive: true, force: true });

// ---- reading deepPairing's state ----

test("readDeepPairing: absent, live, stale, future-dated, old or finished plans, duplicates", (t) => {
  const p = project(t);
  assert.deepEqual(readDeepPairing(p.root), { status: "absent", present: false, owned: [], fresh: false, ambiguous: false, unreadable: 0 });
  deepPairing(p);
  let dp = readDeepPairing(p.root);
  assert.deepEqual([dp.fresh, dp.unreadable, dp.ambiguous], [true, 0, false]);
  assert.ok(ownsFence(dp, "b.js", "d1"));

  resetDp(p);
  const sid = SID;
  deepPairing(p, { sessions: { [sid]: [plan({ updatedAt: iso(OLD) })] }, scopes: [scope(p.root, { updatedAt: iso(OLD) })] });
  dp = readDeepPairing(p.root);
  assert.deepEqual([dp.fresh, dp.owned, dp.ambiguous], [false, [], false], "stale scope and an old plan: nothing live");

  resetDp(p);
  deepPairing(p, { sessions: { [sid]: [plan({ updatedAt: iso(-OLD) })] }, scopes: [scope(p.root, { updatedAt: iso(-60_000) })] });
  dp = readDeepPairing(p.root);
  assert.deepEqual([dp.fresh, dp.owned, dp.ambiguous], [false, [], true], "a future scope gives ambiguous ownership");

  resetDp(p);
  deepPairing(p, { sessions: { [sid]: [plan({ steps: [{ skelId: "d1", status: "done" }] })] }, scopes: [] });
  assert.deepEqual(readDeepPairing(p.root).owned, [], "a finished plan owns nothing");

  resetDp(p);
  deepPairing(p, { sessions: { [sid]: [plan({ status: "rejected" }), plan({ status: "approved" })] }, scopes: [] });
  assert.deepEqual(readDeepPairing(p.root).owned, [{ id: "d1", files: ["b.js"] }], "a later live duplicate still claims its files");
});

test("uncertain plan or scope records never read as absent ownership", (t) => {
  const p = project(t);
  for (const [record, expected] of [
    [plan({ updatedAt: iso(-60_000) }), [true, "present"]],
    [plan({ updatedAt: "unknown" }), [false, "unreadable"]],
    [plan({ status: "unknown" }), [false, "unreadable"]],
    [{ ...plan(), content: {} }, [false, "unreadable"]],
    [plan({ steps: [{ skelId: 1 }] }), [false, "unreadable"]],
  ]) {
    deepPairing(p, { sessions: { [SID]: [record] }, scopes: [] });
    const dp = readDeepPairing(p.root);
    assert.deepEqual([dp.ambiguous, dp.status], expected);
  }
  resetDp(p);
  deepPairing(p, { scopes: [scope(p.root, { activeSkelIds: [1] })] });
  assert.equal(readDeepPairing(p.root).status, "unreadable");
});

test("readDeepPairing fails closed: malformed, symlinked, FIFO, over budget, too many or badly named", (t) => {
  const p = project(t);
  const sid = SID;
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

test("structured and repeated plan declarations preserve every claimed file", (t) => {
  const p = project(t);
  deepPairing(p, {
    sessions: { [SID]: [plan({ steps: [
      { skelId: "d1", status: "in_progress", files: [{ filePath: "src/A.js" }] },
      { skelId: "d1", status: "pending", files: [{ path: "src/b.js" }] },
      { skelId: "d2", status: "pending", files: ["src/c.js"] },
      { skelId: "d2", status: "pending" },
    ] })] },
    scopes: [],
  });
  const dp = readDeepPairing(p.root);
  assert.equal(dp.status, "present");
  assert.ok(ownsFence(dp, "src/a.js", "d1"));
  assert.ok(ownsFence(dp, "src/b.js", "d1"));
  assert.ok(!ownsFence(dp, "src/c.js", "d1"));
  assert.ok(ownsFence(dp, "elsewhere.js", "d2"));
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
  deepPairing(p, { sessions: { [SID]: [plan({ steps: [{ skelId: "1", status: "pending", files: ["a.js"] }] })] }, scopes: [] });
  assert.match(p.ok("init", "t").stderr, NOTE);
  const r = p.ok("approve");
  assert.match(r.stderr, NOTE);
  assert.match(r.stderr, /a live deepPairing plan also claims 1 fence\(s\) just approved/);
  const q = project(t);
  q.write("a.js", SKEL_A);
  deepPairing(q, { sessions: { [SID]: [plan({ updatedAt: iso(OLD) })] }, scopes: [scope(q.root, { updatedAt: iso(OLD) })] });
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
  deepPairing(p, { sessions: { [SID]: [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["a.js"] }] })] }, scopes: [] });
  const r = p.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /a live deepPairing plan claims 1 fence\(s\) finalize would strip/);
  assert.match(p.read("a.js"), /SKEL\[1\]/, "nothing stripped");
});

test("an old draft, or a plan naming the same id in another file, doesn't block finalize", (t) => {
  for (const arts of [[plan({ status: "draft", steps: [{ skelId: "1", status: "pending" }], updatedAt: iso(OLD) })], [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["other.js"] }] })]]) {
    const p = project(t);
    filled(p);
    deepPairing(p, { sessions: { [SID]: arts }, scopes: [] });
    p.ok("finalize");
    assert.doesNotMatch(p.read("a.js"), /SKEL/);
  }
});

test("finalize refuses to strip when deepPairing's state can't be read", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { sessions: { [SID]: "{ broken" }, scopes: [] });
  const r = p.skel("finalize");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /can't tell which fences belong to deepPairing/);
  assert.match(p.read("a.js"), /SKEL\[1\]/);
});

test("an active reshape warns without claiming exact ownership and pauses finalize", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { scopes: [scope(p.root, { activeSkelIds: [], reshape: { fromId: "previous" } })] });
  const result = p.skel("finalize");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fence ownership could not be verified/);
  assert.doesNotMatch(result.stderr, NOTE);
  assert.match(p.read("a.js"), /SKEL\[1\]/);
});

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
  const sid = SID;
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

test("finalize protects an ID in a live scope even when its plan lists a separate file", (t) => {
  const p = project(t);
  filled(p);
  deepPairing(p, { sessions: { [SID]: [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["b.js"] }] })] }, scopes: [scope(p.root, { activeSkelIds: ["1"] })] });
  assert.notEqual(p.skel("finalize").status, 0);
  assert.match(p.read("a.js"), /SKEL\[1\]/);
  deepPairing(p, { scopes: [scope(p.root, { activeSkelIds: ["1"], updatedAt: iso(OLD) })], sessions: { [SID]: [plan({ steps: [{ skelId: "1", status: "in_progress", files: ["b.js"] }] })] } });
  p.ok("finalize");
  assert.doesNotMatch(p.read("a.js"), /SKEL/);
});
