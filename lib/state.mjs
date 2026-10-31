// .skeleton/state.json — the only state outside the code itself.
//
//   phase:      "scaffold" (writing the skeleton; edits are free)
//               "fill"     (skeleton approved; edits are fenced to activeStep)
//               "done"     (finalized; markers stripped)
//   activeStep: the step id currently being filled, or null
//   gate:       "ask" (prompt the human on an out-of-fence edit) or
//               "deny" (refuse it; the agent must propose a skeleton change)
//   reviewEpoch: when the current review round began (init / approve / reshape)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = ".skeleton";

const DEFAULTS = { title: "", phase: "scaffold", activeStep: null, gate: "ask", files: [], reviewEpoch: 0 };

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
  if (mode) fs.chmodSync(tmp, mode); // exact, not masked by umask
  fs.renameSync(tmp, file);
}

/**
 * Does a path.relative() result leave its base? Only a real `..` segment
 * does: `..settings.ts` or `..internal/x` are ordinary names inside it.
 */
export function leavesBase(rel) {
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || path.isAbsolute(rel);
}

/**
 * Resolve symlinks on the longest existing prefix (the file may not exist yet).
 * The native realpath also returns the on-disk spelling on Windows (and
 * macOS); on Linux, WSL's /mnt/c included, it keeps the caller's, which
 * onDiskRel covers for the folders that matter.
 */
export function realish(p) {
  let cur = p;
  const rest = [];
  for (;;) {
    try {
      return path.join(realpath(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    // Some Windows volumes (RAM disks, odd network shares) fail the native call.
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw err;
    return fs.realpathSync(p);
  }
}

/**
 * skel's own config dir, where its trusted stores live outside any project:
 * the approved-skeleton records, rendered versions, serve sessions and install
 * ownership records ($XDG_CONFIG_HOME/skel, else ~/.config/skel).
 */
export function skelConfigDir() {
  return path.resolve(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "skel");
}

/**
 * Is `abs` inside skel's config dir (or the dir itself), after resolving
 * symlinks on both sides? Compared case-insensitively everywhere: on a
 * case-folding filesystem a case variant is the same file, and on one that
 * isn't, asking about a lookalike costs a click.
 */
export function inSkelConfig(abs, resolve = realish, dir = skelConfigDir()) {
  const rel = path.relative(resolve(dir).toLowerCase(), resolve(path.resolve(abs)).toLowerCase());
  return rel === "" || !leavesBase(rel);
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
  return rel === "" || !leavesBase(rel);
}

export function writeState(root, state) {
  const next = { ...DEFAULTS, ...state, updatedAt: new Date().toISOString() };
  writeFileAtomic(statePath(root), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function initState(root, title) {
  return writeState(root, { ...DEFAULTS, title, reviewEpoch: Date.now() });
}
