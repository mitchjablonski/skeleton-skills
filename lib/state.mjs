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
import crypto from "node:crypto";
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
 * skel's state dir, where its trusted stores live outside any project: the
 * approved-skeleton records, rendered versions, serve sessions and install
 * ownership records. $XDG_STATE_HOME/skel on every platform when that is set
 * (a relative value is ignored, as the XDG spec says: it would land wherever
 * the command ran, a project included); else ~/.local/state/skel, or
 * %LOCALAPPDATA%\skel on native Windows.
 */
export function skelStateDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const base = usableBase(env.XDG_STATE_HOME, platform) ??
    (platform === "win32" ? usableBase(env.LOCALAPPDATA, platform) ?? p.join(home, "AppData", "Local") : p.join(home, ".local", "state"));
  return p.resolve(base, "skel");
}

/** An env var's path if it's absolute, else null. On Windows `\\tmp\\x` hangs off the current drive, so it doesn't count. */
function usableBase(v, platform) {
  if (!v) return null;
  return (platform === "win32" ? /^([A-Za-z]:[\\/]|[\\/]{2})/.test(v) : path.posix.isAbsolute(v)) ? v : null;
}

/**
 * Where the stores lived before #18 ($XDG_CONFIG_HOME/skel, else ~/.config/skel).
 * A project with records here keeps using them until `skel migrate` moves them.
 * A relative value is ignored: what's found here gets trusted, and that would
 * let a repo supply it.
 */
export function legacyConfigDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.resolve(usableBase(env.XDG_CONFIG_HOME, platform) ?? p.join(home, ".config"), "skel");
}

/**
 * Every dir the hook and the deny rules guard: the state dir, and the old
 * location, which a project not yet migrated reads and trusts.
 */
export function skelStoreDirs() {
  return [...new Set([skelStateDir(), legacyConfigDir()])];
}

/**
 * Is `abs` inside one of skel's store dirs (or a dir itself)? `dir` is one dir
 * or a list. The hook asks this on every edit in every project, so it stays
 * textual where it can: the path as given against each dir as written and as
 * resolved (one realpath per dir). Only a path outside `project` is realpath'd too, to catch a
 * symlink out there; a symlink INSIDE the project that points into the dir is
 * left to install's deny rule, which Claude Code checks against both the
 * requested path and the file it resolves to. Compared case-insensitively
 * everywhere: on a case-folding filesystem a case variant is the same file,
 * and on one that isn't, asking about a lookalike costs a click.
 */
export function inSkelStores(abs, { dir = skelStoreDirs(), project = null, resolve = realish } = {}) {
  const fold = (p) => path.resolve(p).toLowerCase();
  const within = (p, d) => {
    const rel = path.relative(d, p);
    return rel === "" || !leavesBase(rel);
  };
  const target = fold(abs);
  const dirs = [...new Set([dir].flat().flatMap((d) => [fold(d), fold(resolve(path.resolve(d)))]))];
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

// The key a project's store files are named by.
export function projectKey(root, platform = process.platform) {
  let real = root;
  try { real = fs.realpathSync.native(root); } catch {}
  if (platform === "win32") real = real.toLowerCase();
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 24);
}
/** Every per-project store file: `<key><suffix>.json`. */
export const STORE_SUFFIXES = ["", ".snapshot", ".rendered", "-install", ".config-notice"];
/** In the old dir, once a project's records have moved: lib/migrate.mjs. */
export const migratedMarker = (key) => `${key}.migrated`;
/** An error other than "not there" (a dir we can't read) counts as there: the old location's readers then fail closed. */
const lexists = (file) => {
  try { return !!fs.lstatSync(file, { throwIfNoEntry: false }); } catch { return true; }
};

/**
 * "present" (whatever is at the marker's path, so every reader agrees before
 * anything is copied), "absent", or "unknown" when the lookup itself fails.
 */
export function migratedMarkerStatus(from, key) {
  try {
    return fs.lstatSync(path.join(from, migratedMarker(key)), { throwIfNoEntry: false }) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * Does this project still use the old location? Yes if it holds a record and no
 * marker says the project has moved. The old dir wins over anything in the state
 * dir, because the rule a running session has loaded may name only the old dir:
 * a record written to the state dir then vouches for nothing. Decided on each
 * access, so a running server follows a migration.
 */
export function usesLegacyStore(key) {
  const from = legacyConfigDir();
  // A move counts only on positive evidence. If the marker can't be looked up,
  // an unreadable old dir stays in use: its readers fail closed, where an empty
  // state dir would read as a fresh project.
  if (path.relative(from, skelStateDir()) === "" || migratedMarkerStatus(from, key) === "present") return false;
  return STORE_SUFFIXES.some((s) => lexists(path.join(from, `${key}${s}.json`)));
}

/** A per-project file in skel's store dir (`~/.local/state/skel/<hash><suffix>.json`). */
export function storePath(root, suffix = "") {
  const key = projectKey(root);
  return path.join(usesLegacyStore(key) ? legacyConfigDir() : skelStateDir(), `${key}${suffix}.json`);
}

const RECEIPT_INDEX = Symbol("approval receipt index");
/**
 * Is there an approved-skeleton record for this project, in either store dir?
 * Read-only: this is the hook's path. A project not yet migrated has its record
 * in the old dir and a migrated one in the new, and both count as enrolled. A
 * record only ever adds protection here.
 */
export function approvalReceiptStatus(root, cache = new Map()) {
  // Avoid canonicalizing every uninitialized project on /mnt/c when no store
  // holds approval records. The index lives only for this hook call.
  if (!cache.has(RECEIPT_INDEX)) {
    const index = { dirs: [], unreadable: false };
    for (const dir of skelStoreDirs()) {
      try { if (fs.readdirSync(dir).some(name => name.toLowerCase().endsWith(".snapshot.json"))) index.dirs.push(dir); }
      catch (err) {
        // A dir that can't be listed may still answer for one known name: look it up.
        if (!["ENOENT", "ENOTDIR"].includes(err.code)) { index.unreadable = true; index.dirs.push(dir); }
      }
    }
    cache.set(RECEIPT_INDEX, index);
  }
  const index = cache.get(RECEIPT_INDEX);
  let status = index.unreadable ? "unreadable" : "absent";
  if (!index.dirs.length) return status;
  const name = projectKey(root) + ".snapshot.json";
  for (const dir of index.dirs) {
    try { if (fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })) return "present"; }
    catch (err) { if (!["ENOENT", "ENOTDIR"].includes(err.code)) status = "unreadable"; }
  }
  return status;
}
