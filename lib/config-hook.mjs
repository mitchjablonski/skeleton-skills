import fs from "node:fs";
import path from "node:path";
import { leavesBase, approvalReceiptStatus } from "./state.mjs";
// Only positive receipt evidence may enroll an otherwise absent skeleton.
const hasApprovalRecord = (root, cache) => approvalReceiptStatus(root, cache) === "present";

// Inspect every ancestor: a nested scaffold must not hide an active fill.
export function enrollment(base, cache = new Map(), { boundary = base } = {}) {
  let enrolled = false;
  let filling = false;
  let nearest = null;
  let root = null;
  boundary = path.resolve(boundary);
  const inScope = dir => { const rel = path.relative(boundary, dir); return dir === path.resolve(base) || rel === "" || !leavesBase(rel); };
  const invalid = (dir, why) => ({ protected: true, invalid: true, root: dir, reason: `${why}: ${path.join(dir, ".skeleton", "state.json")}. Ensure .skeleton is a directory; repair the named file or move an unexpected .skeleton file aside, then run skel init --force "<title>" from ${dir} (requires approval; replaces prior fill state)` });
  for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".skeleton", "state.json");
    try {
      if (!cache.has(file)) {
        try {
          const store = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
          if (!store) {
            cache.set(file, (dir === boundary || dir === path.resolve(base)) && hasApprovalRecord(dir, cache) ? { error: Object.assign(new Error("approved skeleton directory is missing"), { skelReason: "an approval record exists but .skeleton is missing; the record may belong to an earlier project at this path" }) } : { missing: true });
          } else if (!store.isDirectory() && !store.isSymbolicLink()) {
            cache.set(file, hasApprovalRecord(dir, cache) ? { error: Object.assign(new Error("approved skeleton directory is not a directory"), { skelReason: "an approval record exists but .skeleton is not a directory" }) } : { missing: true });
          } else {
            try { cache.set(file, { state: JSON.parse(fs.readFileSync(file, "utf8")) }); }
            catch (error) {
              const dangling = error.code === "ENOENT" && fs.lstatSync(file, { throwIfNoEntry: false });
              cache.set(file, error.code === "ENOENT" && !dangling && !hasApprovalRecord(dir, cache) ? { missing: true } : { error });
            }
          }
        } catch (error) {
          // A known path whose read fails (including a dangling link) is invalid.
          cache.set(file, { error });
        }
      }
      const entry = cache.get(file);
      if (entry.error) throw entry.error;
      if (entry.missing) {
        if (path.dirname(dir) === dir) break;
        continue;
      }
      const state = entry.state;
      if (state && typeof state === "object" && !("phase" in state)) {
        if (hasApprovalRecord(dir, cache)) return invalid(dir, "approved skeleton state is invalid");
        if (path.dirname(dir) === dir) break;
        continue;
      }
      if (!state || !["scaffold", "fill", "done"].includes(state.phase)) {
        if (inScope(dir) || hasApprovalRecord(dir, cache)) return invalid(dir, "skeleton state is invalid");
        if (path.dirname(dir) === dir) break;
        continue;
      }
      enrolled = true;
      nearest ??= dir;
      root ??= dir;
      if (state.phase === "fill") { filling = true; root = dir; }
    } catch (err) {
      if ((err.code !== "ENOTDIR" && inScope(dir)) || hasApprovalRecord(dir, cache)) return invalid(dir, err.skelReason || (err instanceof SyntaxError ? "skeleton state is malformed JSON" : `skeleton state cannot be read${err.code ? ` (${err.code})` : ""}`));
    }
    if (path.dirname(dir) === dir) break;
  }
  return filling ? { protected: true, enrolled, nearest, root, reason: "a skeleton fill is active" } : { protected: false, enrolled, nearest, root };
}

export function configDecision(input = {}, fallback = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  // Claude Code does not permit blocking managed policy changes.
  if (input?.source === "policy_settings") return null;
  const base = typeof input?.cwd === "string" && input.cwd ? input.cwd : fallback;
  const cache = new Map();
  const status = [enrollment(base, cache, { boundary: fallback }), enrollment(fallback, cache)].find(s => s.protected) || { protected: false };
  return status.protected ? { decision: "block", reason: `skel: settings changes blocked because ${status.reason}. Finish or reshape the skeleton before changing settings.` } : null;
}

export async function runConfigHook() {
  let input;
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    input = JSON.parse(raw || "{}");
  } catch (err) {
    process.stderr.write(`skel ConfigChange: ${err.message}\n`);
  }
  const fallback = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const base = typeof input?.cwd === "string" && input.cwd ? input.cwd : fallback;
  const verdict = configDecision(input, fallback);
  const cache = new Map();
  const contexts = [enrollment(base, cache, { boundary: fallback }), enrollment(fallback, cache)];
  const roots = [...new Set([fallback, ...contexts.map(s => s.root).filter(Boolean)])];
  // Notice storage is best-effort; a disk error must never permit blocked settings.
  try {
    const { recordConfigNotice, clearConfigNotice } = await import("./config-notice.mjs");
    for (const root of roots) { if (verdict) recordConfigNotice(root, input); else clearConfigNotice(root); } }
  catch (err) { process.stderr.write(`skel ConfigChange notice: ${err.message}\n`); }
  if (verdict) process.stdout.write(JSON.stringify(verdict));
}
