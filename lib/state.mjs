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

export function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    // Some Windows volumes (RAM disks, odd network shares) fail the native call.
    // The JS realpath may keep the caller's spelling where the native one
    // returns the on-disk one; a containment check comparing the two then
    // reads the path as outside, which fails closed.
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
 * Is `abs` inside skel's config dir (or the dir itself)? The hook asks this on
 * every edit in every project, so it stays textual where it can: the path as
 * given against the dir as written and as resolved (one realpath of a dir
 * that exists). Only a path outside `project` is realpath'd too, to catch a
 * symlink out there; a symlink INSIDE the project that points into the dir is
 * left to install's deny rule, which Claude Code checks against both the
 * requested path and the file it resolves to. Compared case-insensitively
 * everywhere: on a case-folding filesystem a case variant is the same file,
 * and on one that isn't, asking about a lookalike costs a click.
 */
export function inSkelConfig(abs, { dir = skelConfigDir(), project = null, resolve = realish } = {}) {
  const fold = (p) => path.resolve(p).toLowerCase();
  const within = (p, d) => {
    const rel = path.relative(d, p);
    return rel === "" || !leavesBase(rel);
  };
  const target = fold(abs);
  const dirs = [...new Set([fold(dir), fold(resolve(path.resolve(dir)))])];
  if (dirs.some((d) => within(target, d))) return true;
  if (project && within(target, fold(project))) return false;
  const real = fold(resolve(path.resolve(abs)));
  return real !== target && dirs.some((d) => within(real, d));
}

/** True when `abs` (after resolving symlinks) is inside `root`. */
export function insideRoot(root, abs, realRoot) {
  return resolveInside(root, abs, realRoot) !== null;
}

/**
 * `abs` with symlinks resolved, or null when that leaves `root` or doesn't
 * exist. A caller checking many paths passes `realRoot` (the root's realpath)
 * to resolve it once; one that then reads should read the returned path, so
 * a link swapped in after the check can't redirect the read.
 */
export function resolveInside(root, abs, realRoot) {
  let real;
  try {
    // One native call each (the JS realpath lstats every segment, ~5ms apiece on /mnt/c).
    real = realpath(abs);
    realRoot ??= realpath(root);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, real);
  return rel === "" || !leavesBase(rel) ? real : null;
}

export function writeState(root, state) {
  const next = { ...DEFAULTS, ...state, updatedAt: new Date().toISOString() };
  writeFileAtomic(statePath(root), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function initState(root, title) {
  return writeState(root, { ...DEFAULTS, title, reviewEpoch: Date.now() });
}
