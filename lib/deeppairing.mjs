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
// Its fences use the SKEL[id] grammar. These project-local records are only
// used for notices and to veto marker removal. The edit gate and Stop hook
// do not depend on them.

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
function readJson(file, base, budget) {
  const dirs = new Map();
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const st = fs.lstatSync(dir, { bigint: true });
    if (!st.isDirectory()) throw new Error("not a real directory");
    dirs.set(dir, st);
    if (dir === base) break;
  }
  const entry = fs.lstatSync(file, { bigint: true });
  if (!entry.isFile()) throw new Error("not a regular file");
  const sameEntry = (old, current) => old.dev === current.dev && old.ino === current.ino
    && old.mode === current.mode && old.ctimeNs === current.ctimeNs && old.size === current.size;
  const unchanged = (fd) => sameEntry(entry, fs.fstatSync(fd, { bigint: true }))
    && sameEntry(entry, fs.lstatSync(file, { bigint: true }))
    && [...dirs].every(([dir, st]) => sameEntry(st, fs.lstatSync(dir, { bigint: true })));
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    if (!unchanged(fd)) throw new Error("metadata changed while opening");
    if (entry.size > BigInt(budget.left)) { budget.left = 0; budget.exhausted = true; throw new Error("over budget"); }
    const size = Number(entry.size);
    budget.left -= size;
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off !== size || !unchanged(fd)) throw new Error("metadata changed while reading");
    return JSON.parse(buf.toString("utf8"));
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
 * - `ambiguous`: a scope with ambiguous ownership, such as a fresh reshape.
 * - `unreadable`: what couldn't be read within the limits (malformed,
 *   symlinked, not a regular file, over the byte budget or the count caps,
 *   badly named). While it is nonzero, ownership is undetermined.
 */
export function readDeepPairing(root, { now = Date.now(), budgetBytes = DP_BYTE_BUDGET } = {}) {
  const out = { status: "absent", present: false, owned: [], fresh: false, ambiguous: false, unreadable: 0 };
  try { readInto(out, root, now, budgetBytes); } catch { out.present = true; out.unreadable++; }
  out.status = out.unreadable ? "unreadable" : out.present ? "present" : "absent";
  return out;
}

function readInto(out, root, now, budgetBytes) {
  const base = path.join(fs.realpathSync(root), DP_DIR);
  const st = lstat(base);
  if (!st) return;
  out.present = true;
  if (!st.isDirectory()) { out.unreadable++; return; }
  const budget = { left: budgetBytes, exhausted: false };
  const plans = new Map(); // The first plan's declarations for each session and artifact.
  const listDir = (dir, cap) => {
    let d;
    try { d = lstat(dir); } catch { out.unreadable++; return []; }
    if (!d) return [];
    if (!d.isDirectory()) { out.unreadable++; return []; }
    // Iterate with a cap instead of listing the whole directory: one entry
    // past the cap means there are too many, so ownership is unknown.
    const names = [];
    let handle;
    try {
      handle = fs.opendirSync(dir);
      for (let e = handle.readSync(); e; e = handle.readSync()) {
        if (names.length === cap) { out.unreadable++; break; }
        names.push(e.name);
      }
    } catch { out.unreadable++; return []; } finally { try { handle?.closeSync(); } catch {} }
    return names.sort();
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
    try { arr = readJson(file, base, budget); } catch { out.unreadable++; continue; }
    if (!Array.isArray(arr)) { out.unreadable++; continue; }
    try { readPlans(out, sid, arr, plans, now); } catch { out.unreadable++; }
    arr = null;
  }
  readScopes(out, base, listDir, plans, now, budget);
  if (budget.exhausted) out.unreadable++;
}

function declaredPaths(files) {
  if (files == null) return null;
  if (!Array.isArray(files) || files.length > DP_MAX_FILES) throw new Truncated("invalid file declarations");
  const paths = files.map((entry) => typeof entry === "string" ? entry : entry?.filePath ?? entry?.path);
  if (paths.some((file) => typeof file !== "string" || !file || file.length > 1024)) throw new Truncated("invalid file declaration");
  return paths.length ? paths : null;
}

function readPlans(out, sid, arr, plans, now) {
    for (const a of arr) {
      if (!a || typeof a !== "object" || a.type !== "plan" || typeof a.id !== "string") continue;
      const key = `${sid}\0${a.id}`;
      if (plans.has(key)) continue;
      const status = typeof a.status === "string" ? a.status : "";
      const plan = { files: new Map() };
      plans.set(key, plan);
      const all = Array.isArray(a.content?.steps) ? a.content.steps : [];
      if (all.length > DP_MAX_STEPS) throw new Truncated("steps over cap");
      const steps = all.filter((s) => s && typeof s.skelId === "string" && s.skelId);
      if (steps.some((s) => s.skelId.length > 160)) throw new Truncated("id over cap");
      for (const s of steps) {
        const paths = declaredPaths(s.files);
        const prior = plan.files.get(s.skelId);
        if (paths === null || prior === null) plan.files.set(s.skelId, null);
        else if (prior) prior.push(...paths);
        else plan.files.set(s.skelId, paths);
      }
      if (!steps.length || !["draft", "revised", "approved"].includes(status)) continue;
      if (steps.every((s) => s.status === "done" || s.status === "skipped")) continue;
      if (!(now - pastTime(a.updatedAt, now) <= DP_SCOPE_MAX_AGE_MS)) continue; // old or future-dated: not live
      out.fresh = true;
      for (const [id, files] of plan.files) out.owned.push({ id, files });
    }
}

function readScopes(out, base, listDir, plans, now, budget) {
  const scopesDir = path.join(base, "skeleton-scopes");
  for (const name of listDir(scopesDir, DP_MAX_SCOPES)) {
    if (!SCOPE_NAME.test(name)) { if (name.endsWith(".json")) out.unreadable++; continue; }
    let s;
    try { s = readJson(path.join(scopesDir, name), base, budget); } catch { out.unreadable++; continue; }
    if (!s || typeof s !== "object" || typeof s.artifactId !== "string") { out.unreadable++; continue; }
    // Caps first: an over-cap list is unreadable whatever its timestamp says.
    let active;
    try { active = strs(s.activeSkelIds, DP_MAX_IDS); } catch { out.unreadable++; continue; }
    const updated = Date.parse(String(s.updatedAt ?? ""));
    if (!Number.isFinite(updated)) { out.unreadable++; continue; }
    if (now - updated > DP_SCOPE_MAX_AGE_MS) continue;
    if (!active.length && !s.reshape) continue;
    if (updated > now || s.reshape) {
      out.ambiguous = true;
      continue;
    }
    out.fresh = true;
    const sessionId = typeof s.sessionId === "string" && NAME.test(s.sessionId) ? s.sessionId : null;
    const plan = sessionId ? plans.get(`${sessionId}\0${s.artifactId}`) : undefined;
    // Owned by (file, id): the plan step's files when the scope's plan lists
    // them; with no files on record, the id is claimed in any file.
    const sameRoot = typeof s.workspaceRoot === "string" && path.resolve(s.workspaceRoot) === path.dirname(base);
    for (const id of active) out.owned.push({ id, files: sameRoot ? plan?.files.get(id) ?? null : null });
  }
}

/** Does a live plan name fence `id` in project-relative file `rel`? A plan step without files names it anywhere. */
export function ownsFence(dp, rel, id) {
  const norm = (file) => path.posix.normalize(file.replaceAll("\\", "/")).toLowerCase();
  const target = norm(rel);
  return dp.owned.some((o) => o.id === id && (!o.files || o.files.some((file) => {
    const candidate = norm(file);
    // A non-relative plan path cannot prove disjoint ownership.
    return candidate === target || candidate.startsWith("/") || /^[a-z]:/.test(candidate)
      || candidate === ".." || candidate.startsWith("../");
  })));
}
