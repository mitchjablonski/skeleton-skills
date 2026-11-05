import fs from "node:fs";
import path from "node:path";

// Inspect every ancestor: a nested scaffold must not hide an active fill.
export function enrollment(base, cache = new Map()) {
  let enrolled = false;
  let filling = false;
  let nearest = null;
  let root = null;
  for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".skeleton", "state.json");
    try {
      if (!cache.has(file)) {
        try {
          const exists = fs.lstatSync(file, { throwIfNoEntry: false });
          cache.set(file, exists ? { state: JSON.parse(fs.readFileSync(file, "utf8")) } : { missing: true });
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
      enrolled = true;
      nearest ??= dir;
      root ??= dir;
      if (!state || !["scaffold", "fill", "done"].includes(state.phase)) return { protected: true, invalid: true, reason: "skeleton state is invalid" };
      if (state.phase === "fill") { filling = true; root = dir; }
    } catch (err) {
      return { protected: true, invalid: true, reason: "skeleton state cannot be read" };
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
  const status = [enrollment(base, cache), enrollment(fallback, cache)].find(s => s.protected) || { protected: false };
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
  const verdict = configDecision(input);
  if (verdict) process.stdout.write(JSON.stringify(verdict));
}
