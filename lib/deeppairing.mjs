// Coexistence with deepPairing skeleton plans (#192, deepPairing#684).
// Read only: skel never writes .deeppairing/.
//
// What a deepPairing skeleton plan leaves in the project (deepPairing
// packages/mcp-server/src/skeleton-scope.ts):
// - `.deeppairing/skeleton-scopes/<artifactId>.json`, one per plan, written by
//   update_plan_progress while a step is in progress and removed when none is:
//   { artifactId, activeSkelIds, updatedAt, sessionId?, workspaceRoot?, reshape? }.
//   deepPairing ignores a scope older than 8 hours (SKELETON_SCOPE_MAX_AGE_MS).
// - `.deeppairing/sessions/<sessionId>/artifacts.json`: the plan artifacts,
//   { id, type: "plan", status, updatedAt, content: { steps: [{ skelId, status, files }] } }.
//   deepPairing's own gate fences a scope only while its plan is `approved`
//   there, and only for edits from the scope's own session inside its
//   workspaceRoot (selectSkeletonScope, cli/preflight-hook-core.ts).
// Its fences use skel's SKEL[id] grammar (ported from lib/markers.mjs).
//
// Trust: everything under .deeppairing/ is inside the project, so an agent can
// write it. It is never allowed to take a fence skel approved (that record
// lives outside the project), and it relaxes skel's gate or Stop hook only
// when the human opted in through `skel install --deeppairing-yield`, which is
// recorded outside the project too. Reading is bounded: a total byte budget,
// regular files only (no FIFOs, no symlinked dirs), capped counts, and only
// the fields skel needs are kept. Any limit hit, or anything unreadable,
// counts as unreadable, and callers then fail closed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DP_DIR = ".deeppairing";
/** deepPairing's own scope lifetime (SKELETON_SCOPE_MAX_AGE_MS). */
export const DP_SCOPE_MAX_AGE_MS = 8 * 60 * 60 * 1000;
/** Total bytes read from .deeppairing/ per call. */
export const DP_BYTE_BUDGET = 1024 * 1024;
export const DP_MAX_SESSIONS = 64;
export const DP_MAX_SCOPES = 64;
const NAME = /^[A-Za-z0-9_-]{1,160}$/;
const SCOPE_NAME = /^[A-Za-z0-9_-]{1,80}\.json$/;

export const DP_MAX_STEPS = 512;
export const DP_MAX_FILES = 64;
export const DP_MAX_IDS = 256;
class Truncated extends Error {}

/** Non-empty strings of `v`; throws Truncated when a cap or an over-long entry would drop any. */
function strs(v, cap) {
  if (!Array.isArray(v)) return [];
  if (v.length > cap) throw new Truncated("list over cap");
  const out = v.filter((x) => typeof x === "string" && x.length > 0);
  if (out.some((x) => x.length > 1024)) throw new Truncated("entry over cap");
  return out;
}

/** lstat, or null when absent (ENOENT, ENOTDIR); any other failure (EACCES, EIO, …) throws. */
function lstat(p) {
  try { return fs.lstatSync(p); } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Read one JSON file within `budget` ({ left, exhausted }): opened without
 * following a symlink and without blocking on a FIFO, then required to be a
 * regular file no bigger than what's left. Throws on anything else.
 */
function readJson(file, budget) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > budget.left) { budget.left = 0; budget.exhausted = true; throw new Error("over budget"); }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    budget.left -= st.size;
    return JSON.parse(buf.subarray(0, off).toString("utf8"));
  } finally { fs.closeSync(fd); }
}

/** A timestamp in the past (or now): its ms, else NaN. Future stamps don't count. */
function pastTime(v, now) {
  const at = Date.parse(String(v ?? ""));
  return Number.isFinite(at) && at <= now ? at : NaN;
}

/**
 * deepPairing's skeleton-plan state in `root`, read only and bounded.
 * - `status`: "absent" (no `.deeppairing`), "present", or "unreadable"
 *   (anything couldn't be read, or a cap would have truncated it: callers
 *   must then treat ownership as unknown, never as absent).
 * - `present`: `.deeppairing` exists, or couldn't be checked.
 * - `owned`: [{ id, files }] for each skeleton step of a plan in draft,
 *   revised or approved status, updated within 8 hours, with a skeleton step
 *   not yet done or skipped; plus each fresh scope's active ids (files null).
 * - `fresh`: a fresh scope exists, or such a plan does.
 * - `gateScopes`: fresh, non-reshape scopes whose plan is `approved` in their
 *   own session's artifacts.json: { activeSkelIds, sessionId, workspaceRoot }.
 * - `unreadable`: what couldn't be read within the limits (malformed,
 *   symlinked, not a regular file, over the byte budget or the count caps,
 *   badly named). While it is nonzero, ownership is undetermined.
 */
export function readDeepPairing(root, { now = Date.now(), budgetBytes = DP_BYTE_BUDGET } = {}) {
  const out = { status: "absent", present: false, owned: [], fresh: false, gateScopes: [], unreadable: 0 };
  try { readInto(out, root, now, budgetBytes); } catch { out.present = true; out.unreadable++; }
  out.status = out.unreadable ? "unreadable" : out.present ? "present" : "absent";
  return out;
}

function readInto(out, root, now, budgetBytes) {
  const base = path.join(root, DP_DIR);
  const st = lstat(base);
  if (!st) return;
  out.present = true;
  if (!st.isDirectory()) { out.unreadable++; return; }
  const budget = { left: budgetBytes, exhausted: false };
  const plans = new Map(); // `${session}\0${id}` -> { status } (the first wins, as in deepPairing)
  const listDir = (dir, cap) => {
    let d;
    try { d = lstat(dir); } catch { out.unreadable++; return []; }
    if (!d) return [];
    if (!d.isDirectory()) { out.unreadable++; return []; }
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch { out.unreadable++; return []; }
    if (names.length > cap) out.unreadable += names.length - cap;
    return names.slice(0, cap);
  };

  const sessionsDir = path.join(base, "sessions");
  for (const sid of listDir(sessionsDir, DP_MAX_SESSIONS)) {
    if (!NAME.test(sid)) { out.unreadable++; continue; }
    const dir = path.join(sessionsDir, sid);
    let d, f;
    const file = path.join(dir, "artifacts.json");
    try { d = lstat(dir); f = d?.isDirectory() ? lstat(file) : null; } catch { out.unreadable++; continue; }
    if (!d?.isDirectory()) { out.unreadable++; continue; }
    if (!f) continue; // a session without artifacts
    let arr;
    try { arr = readJson(file, budget); } catch { out.unreadable++; continue; }
    if (!Array.isArray(arr)) { out.unreadable++; continue; }
    try { readPlans(out, sid, arr, plans, now); } catch { out.unreadable++; }
    arr = null;
  }
  readScopes(out, base, listDir, plans, now, budget);
  if (budget.exhausted) out.unreadable++;
}

function readPlans(out, sid, arr, plans, now) {
    for (const a of arr) {
      if (!a || typeof a !== "object" || a.type !== "plan" || typeof a.id !== "string") continue;
      const key = `${sid}\0${a.id}`;
      if (plans.has(key)) continue;
      const status = typeof a.status === "string" ? a.status : "";
      plans.set(key, { status });
      const all = Array.isArray(a.content?.steps) ? a.content.steps : [];
      if (all.length > DP_MAX_STEPS) throw new Truncated("steps over cap");
      const steps = all.filter((s) => s && typeof s.skelId === "string" && s.skelId);
      if (steps.some((s) => s.skelId.length > 160)) throw new Truncated("id over cap");
      if (!steps.length || !["draft", "revised", "approved"].includes(status)) continue;
      if (steps.every((s) => s.status === "done" || s.status === "skipped")) continue;
      if (!(now - pastTime(a.updatedAt, now) <= DP_SCOPE_MAX_AGE_MS)) continue; // old or future-dated: not live
      out.fresh = true;
      for (const s of steps) { const files = strs(s.files, DP_MAX_FILES); out.owned.push({ id: s.skelId, files: files.length ? files : null }); }
    }
}

function readScopes(out, base, listDir, plans, now, budget) {
  const scopesDir = path.join(base, "skeleton-scopes");
  for (const name of listDir(scopesDir, DP_MAX_SCOPES)) {
    if (!SCOPE_NAME.test(name)) { if (name.endsWith(".json")) out.unreadable++; continue; }
    let s;
    try { s = readJson(path.join(scopesDir, name), budget); } catch { out.unreadable++; continue; }
    if (!s || typeof s !== "object" || typeof s.artifactId !== "string") { out.unreadable++; continue; }
    if (!(now - pastTime(s.updatedAt, now) <= DP_SCOPE_MAX_AGE_MS)) continue; // stale or future-dated
    let active;
    try { active = strs(s.activeSkelIds, DP_MAX_IDS); } catch { out.unreadable++; continue; }
    if (!active.length && !s.reshape) continue;
    out.fresh = true;
    for (const id of active) out.owned.push({ id, files: null });
    const sessionId = typeof s.sessionId === "string" && NAME.test(s.sessionId) ? s.sessionId : null;
    if (!s.reshape && sessionId && active.length && plans.get(`${sessionId}\0${s.artifactId}`)?.status === "approved") {
      out.gateScopes.push({ activeSkelIds: active, sessionId, workspaceRoot: typeof s.workspaceRoot === "string" && s.workspaceRoot ? s.workspaceRoot : null });
    }
  }
}

/** Does a live plan name fence `id` in project-relative file `rel`? A plan step without files names it anywhere. */
export function ownsFence(dp, rel, id) {
  const norm = (f) => path.posix.normalize(String(f).split("\\").join("/")).replace(/^\.\//, "");
  return dp.owned.some((o) => o.id === id && (!o.files || o.files.some((f) => norm(f) === rel)));
}

/** The fence ids skel's approval record holds: never deepPairing's, whatever .deeppairing/ says. */
export function recordFenceIds(record) {
  return new Set((record?.fences ?? []).map((f) => f?.id).filter((x) => typeof x === "string"));
}

/**
 * deepPairing's artifact-session ids for a Claude session (deriveSessionId in
 * deepPairing's session-id.ts): `session_<name>_<hash8>[_<sid>]`, for both the
 * given root and its real path, since deepPairing hashes its canonical root.
 */
export function deepPairingSessionIds(root, claudeSessionId) {
  const usable = typeof claudeSessionId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(claudeSessionId) ? claudeSessionId : "";
  const roots = new Set([root]);
  try { roots.add(fs.realpathSync(root)); } catch {}
  const ids = new Set();
  for (const r of roots) {
    const name = path.basename(r).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
    const hash = crypto.createHash("sha256").update(r).digest("hex").slice(0, 8);
    ids.add(usable ? `session_${name}_${hash}_${usable}` : `session_${name}_${hash}`);
  }
  return ids;
}

/** The fence ids deepPairing's gate would fence for an edit to `abs` from these sessions (selectSkeletonScope). */
export function gateIdsFor(dp, { sessionIds, abs }) {
  const ids = new Set();
  for (const s of dp.gateScopes) {
    if (!sessionIds?.has(s.sessionId)) continue;
    // Stricter than deepPairing: the scope must name an existing, absolute,
    // canonical workspaceRoot, and `abs` (already canonical) must lie in it.
    const ws = canonicalDir(s.workspaceRoot);
    if (!ws || !abs) continue;
    const rel = path.relative(ws, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    for (const id of s.activeSkelIds) ids.add(id);
  }
  return ids;
}

/** `p` when it is an absolute path to an existing directory and already its own real path; else null. */
export function canonicalDir(p) {
  if (typeof p !== "string" || !path.isAbsolute(p) || path.resolve(p) !== p) return null;
  try { return fs.statSync(p).isDirectory() && fs.realpathSync(p) === p ? p : null; } catch { return null; }
}

/**
 * The human's opt-in to yield to deepPairing (`skel install --deeppairing-yield`),
 * read from install's ownership record in skel's state dir, outside the
 * project (a deny rule keeps the agent's file tools out, and the hook asks
 * before any `skel install --deeppairing-…`). Off unless recorded. Looked
 * up from each start upward: the nearest record that sets it decides, so a
 * project's explicit "off" (`--no-deeppairing-yield`) beats an ancestor's
 * "yield", and a record without the field inherits from above.
 */
export function deepPairingYieldEnabled(starts, storePath) {
  for (const start of starts) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      let v;
      try { v = JSON.parse(fs.readFileSync(storePath(dir, "-install"), "utf-8")).deepPairing; } catch {}
      if (v === "yield") return true;
      if (v === "off") return false;
      if (path.dirname(dir) === dir) break;
    }
  }
  return false;
}

/** The one-line warning for init, approve and finalize while a fresh plan is live. */
export function liveNotice() {
  return "note: a deepPairing skeleton plan is live in this project (.deeppairing/). skel and deepPairing both use SKEL[id] fences. " +
    "Fences skel approves are skel's; keep the two plans' fences in separate files with distinct ids, and use /deeppairing:skeleton for deepPairing's plan.";
}

/**
 * Why `skel install --deeppairing-yield` must refuse here, or null. The
 * opt-in relaxes skel's gate, so only a human at a terminal may turn it on:
 * stdin and stdout must both be TTYs. Claude Code's Bash tool has none, so no
 * spelling of the command an agent runs (quoting, variables, scripts) gets
 * past this. Turning it off needs no TTY.
 */
export function optInRefusal({ stdinTTY = process.stdin.isTTY === true, stdoutTTY = process.stdout.isTTY === true } = {}) {
  if (stdinTTY && stdoutTTY) return null;
  return "skel install --deeppairing-yield needs an interactive terminal: it relaxes skel's gate next to deepPairing, so only you can turn it on. Run it yourself in your own terminal (not through Claude). `--no-deeppairing-yield` turns it off from anywhere.";
}
