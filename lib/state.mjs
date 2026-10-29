// .skeleton/state.json — the only state outside the code itself.
//
//   phase:      "scaffold" (writing the skeleton; edits are free)
//               "fill"     (skeleton approved; edits are fenced to activeStep)
//               "done"     (finalized; markers stripped)
//   activeStep: the step id currently being filled, or null
//   gate:       "ask" (prompt the human on an out-of-fence edit) or
//               "deny" (refuse it; the agent must propose a skeleton change)
//   reviewEpoch: when the current review round began (init / reshape); only
//               the human's feedback sent after it can approve or reshape
//   approvedBy: how the current fill phase was approved ("review" | "terminal")

import fs from "node:fs";
import path from "node:path";

export const STATE_DIR = ".skeleton";

const DEFAULTS = { title: "", phase: "scaffold", activeStep: null, gate: "ask", files: [], reviewEpoch: 0, approvedBy: null };

export function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, STATE_DIR, "state.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function statePath(root) {
  return path.join(root, STATE_DIR, "state.json");
}

export function readState(root) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(statePath(root), "utf-8")) };
  } catch {
    return null;
  }
}

/**
 * Write a file without following a symlink at its path: write a sibling temp
 * file, then rename over the target (rename replaces a link, never its
 * target). A cloned repo can't aim our writes at a file outside it.
 */
export function writeFileAtomic(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** True when `abs` (after resolving symlinks) is inside `root`. */
export function insideRoot(root, abs) {
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return false;
  }
  const rel = path.relative(fs.realpathSync(root), real);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function writeState(root, state) {
  const next = { ...DEFAULTS, ...state, updatedAt: new Date().toISOString() };
  writeFileAtomic(statePath(root), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function initState(root, title) {
  return writeState(root, { ...DEFAULTS, title, reviewEpoch: Date.now() });
}
