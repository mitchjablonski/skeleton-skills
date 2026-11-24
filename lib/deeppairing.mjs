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
//   deepPairing's own gate fences a scope only while its plan is `approved` there.
// Its fences use skel's SKEL[id] grammar (ported from lib/markers.mjs).
//
// Trust: everything under .deeppairing/ is inside the project, so an agent can
// write it. Callers must therefore never let a deepPairing claim take a fence
// skel approved (the approval record lives outside the project), and may only
// relax per-edit prompts and advisory notices with it. `done` and `finalize`
// still check drift against skel's own record, which nothing here can change.

import fs from "node:fs";
import path from "node:path";

export const DP_DIR = ".deeppairing";
/** deepPairing's own scope lifetime (SKELETON_SCOPE_MAX_AGE_MS). */
export const DP_SCOPE_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_FILES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,160}$/;

const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0) : []);

function readJson(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_BYTES) throw new Error("not a readable file");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function list(dir) {
  try { return fs.readdirSync(dir).sort().slice(0, MAX_FILES); }
  catch (err) { if (err.code === "ENOENT" || err.code === "ENOTDIR") return []; throw err; }
}

/**
 * deepPairing's skeleton-plan state in `root`, read only and bounded.
 * - `present`: a `.deeppairing/` dir exists.
 * - `gateIds`: fence ids deepPairing's own gate fences now: a fresh scope's
 *   `activeSkelIds` whose plan is `approved` in its session's artifacts.json
 *   (reshape scopes are left to skel's gate).
 * - `ownedIds`: every fence id a live plan names: the gate ids, plus the
 *   `skelId`s of any plan in draft, revised or approved status with a skeleton
 *   step not yet done or skipped (at any age: between steps a plan has no scope).
 * - `fresh`: a fresh scope exists, or such a plan was updated within 8 hours.
 * - `unreadable`: scope or artifacts files that exist but couldn't be parsed;
 *   while any exist, which fences deepPairing owns can't be determined.
 */
export function readDeepPairing(root, { now = Date.now() } = {}) {
  const base = path.join(root, DP_DIR);
  const out = { present: false, gateIds: new Set(), ownedIds: new Set(), fresh: false, unreadable: 0 };
  try { if (!fs.statSync(base).isDirectory()) return out; } catch { return out; }
  out.present = true;
  const plans = new Map(); // `${session}\0${id}` -> plan
  const sessionsDir = path.join(base, "sessions");
  let sessions = [];
  try { sessions = list(sessionsDir); } catch { out.unreadable++; }
  for (const sid of sessions) {
    if (!ID.test(sid)) continue;
    const file = path.join(sessionsDir, sid, "artifacts.json");
    if (!fs.existsSync(file)) continue;
    let arr;
    try { arr = readJson(file); } catch { out.unreadable++; continue; }
    if (!Array.isArray(arr)) { out.unreadable++; continue; }
    for (const a of arr) {
      if (!a || typeof a !== "object" || a.type !== "plan" || typeof a.id !== "string") continue;
      plans.set(`${sid}\0${a.id}`, a);
      const steps = Array.isArray(a.content?.steps) ? a.content.steps.filter((s) => s && typeof s.skelId === "string" && s.skelId) : [];
      if (!steps.length || !["draft", "revised", "approved"].includes(a.status)) continue;
      if (steps.every((s) => s.status === "done" || s.status === "skipped")) continue;
      for (const s of steps) out.ownedIds.add(s.skelId);
      const at = Date.parse(String(a.updatedAt ?? ""));
      if (Number.isFinite(at) && now - at <= DP_SCOPE_MAX_AGE_MS) out.fresh = true;
    }
  }
  const scopesDir = path.join(base, "skeleton-scopes");
  let scopes = [];
  try { scopes = list(scopesDir).filter((n) => n.endsWith(".json")); } catch { out.unreadable++; }
  for (const name of scopes) {
    let s;
    try { s = readJson(path.join(scopesDir, name)); } catch { out.unreadable++; continue; }
    if (!s || typeof s !== "object" || typeof s.artifactId !== "string") { out.unreadable++; continue; }
    const at = Date.parse(String(s.updatedAt));
    if (!Number.isFinite(at) || now - at > DP_SCOPE_MAX_AGE_MS) continue; // stale: deepPairing ignores it too
    const active = ids(s.activeSkelIds);
    if (!active.length && !s.reshape) continue;
    out.fresh = true;
    for (const id of active) out.ownedIds.add(id);
    const plan = typeof s.sessionId === "string" ? plans.get(`${s.sessionId}\0${s.artifactId}`) : undefined;
    if (!s.reshape && plan?.status === "approved") for (const id of active) out.gateIds.add(id);
  }
  return out;
}

/** The fence ids skel's approval record holds: never deepPairing's, whatever .deeppairing/ says. */
export function recordFenceIds(record) {
  return new Set((record?.fences ?? []).map((f) => f?.id).filter((x) => typeof x === "string"));
}

/** The one-line warning for init, approve and finalize while a fresh plan is live. */
export function liveNotice() {
  return "note: a deepPairing skeleton plan is live in this project (.deeppairing/). skel and deepPairing both use SKEL[id] fences. " +
    "Fences skel approves are skel's; keep the two plans' fences in separate files with distinct ids, and use /deeppairing:skeleton for deepPairing's plan.";
}
