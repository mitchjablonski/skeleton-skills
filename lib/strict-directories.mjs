// Strict directory manager, bootstrap step 2 (docs/strict-protected-bootstrap.md,
// "Durable history versus scratch"). DISABLED PROTOTYPE: imported by tests
// only, wired into no launcher.
//
// Durable history holds the enrollment, the authority record and journal, and
// the immutable captures. It is reopened (or created on first enrollment
// only) and never removed by ordinary cleanup. Scratch is per launch: created
// fresh (an existing path is refused) and removed only when that removal can
// be proven; otherwise it is retained and reported. The two never overlap.
//
// Checks: Linux only; every ancestor is a real directory owned by root or us
// and not writable by others unless sticky; the directory itself is ours,
// private (no group/other write), not a symlink; its filesystem is on a fixed
// allowlist (durable history: local disk filesystems only; scratch may also
// be tmpfs). WSL drvfs/9p, NFS, SMB and FUSE are refused.
import fs from "node:fs";
import path from "node:path";

const freeze = Object.freeze;
// statfs f_type magic numbers.
const FS = freeze({ ext: 0xef53, xfs: 0x58465342, btrfs: 0x9123683e, tmpfs: 0x01021994 });
const DURABLE_FS = freeze([FS.ext, FS.xfs, FS.btrfs]);
const SCRATCH_FS = freeze([FS.ext, FS.xfs, FS.btrfs, FS.tmpfs]);
const LAYOUT = freeze(["authority", "captures"]); // durable subdirectories

class DirectoryRefusal extends Error {
  constructor(code) { super(code); this.name = "DirectoryRefusal"; this.code = code; }
}
const refuse = (code) => { throw new DirectoryRefusal(code); };

function requireLinux() {
  if (process.platform !== "linux") refuse("unsupported-platform");
}

function absolute(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096 || p.includes("\0") || !path.isAbsolute(p)) refuse("invalid-path");
  const resolved = path.resolve(p);
  if (resolved !== p.replace(/\/+$/, "") && resolved !== p) refuse("non-canonical-path");
  return resolved;
}

function requireAncestors(dir) {
  for (let current = dir;; current = path.dirname(current)) {
    let st;
    try { st = fs.lstatSync(current); } catch { refuse("missing-ancestor"); }
    if (!st.isDirectory() || st.isSymbolicLink()) refuse("unsafe-ancestor");
    if (![0, process.geteuid()].includes(st.uid)) refuse("unsafe-ancestor");
    if ((st.mode & 0o022) && !(st.mode & 0o1000)) refuse("unsafe-ancestor");
    if (path.dirname(current) === current) break;
  }
}

function requirePrivateDirectory(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { refuse("missing-directory"); }
  if (!st.isDirectory() || st.isSymbolicLink()) refuse("not-a-directory");
  if (st.uid !== process.geteuid()) refuse("foreign-owner");
  if (st.mode & 0o077) refuse("not-private");
  return st;
}

function requireFilesystem(dir, allowed, statfs) {
  let type;
  try { type = statfs(dir).type; } catch { refuse("filesystem-unknown"); }
  if (!allowed.includes(type)) refuse("filesystem-not-allowed");
  return type;
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function deps(options) {
  const statfs = options?.statfs ?? fs.statfsSync;
  if (typeof statfs !== "function") refuse("invalid-options");
  return { statfs };
}

/**
 * Reopen durable history (default), or create it on first enrollment
 * ({ firstEnrollment: true }). Reopen requires the existing, private layout
 * and never creates anything; first enrollment requires the root to be absent.
 * Returns frozen { root, authority, captures, filesystem }.
 */
export function prepareDurableHistory(rootPath, options = {}) {
  requireLinux();
  const { statfs } = deps(options);
  const root = absolute(rootPath);
  requireAncestors(path.dirname(root));
  requireFilesystem(path.dirname(root), DURABLE_FS, statfs);
  if (options.firstEnrollment === true) {
    if (fs.existsSync(root) || isLink(root)) refuse("durable-history-exists");
    fs.mkdirSync(root, { mode: 0o700 });
    for (const name of LAYOUT) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    syncDirectory(root);
    syncDirectory(path.dirname(root));
  } else if (options.firstEnrollment !== undefined && options.firstEnrollment !== false) {
    refuse("invalid-options");
  }
  requirePrivateDirectory(root);
  const filesystem = requireFilesystem(root, DURABLE_FS, statfs);
  const entries = fs.readdirSync(root).sort();
  for (const name of LAYOUT) {
    if (!entries.includes(name)) refuse("durable-history-incomplete");
    requirePrivateDirectory(path.join(root, name));
  }
  return freeze({ root, authority: path.join(root, "authority"), captures: path.join(root, "captures"), filesystem });
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * Create a fresh scratch directory at exactly scratchPath (an existing path,
 * including a dangling symlink, is refused). durable, if given, is a prepared
 * durable history: the two must not overlap. Returns a frozen handle with
 * remove() -> { removed: true } | { removed: false, retained, reason }.
 */
export function createScratch(scratchPath, options = {}) {
  requireLinux();
  const { statfs } = deps(options);
  const scratch = absolute(scratchPath);
  if (options.durable !== undefined) {
    const root = options.durable?.root;
    if (typeof root !== "string") refuse("invalid-options");
    if (inside(scratch, root) || inside(root, scratch)) refuse("scratch-overlaps-durable");
  }
  requireAncestors(path.dirname(scratch));
  requireFilesystem(path.dirname(scratch), SCRATCH_FS, statfs);
  if (isLink(scratch)) refuse("scratch-exists");
  try { fs.mkdirSync(scratch, { mode: 0o700 }); } catch (e) {
    if (e.code === "EEXIST") refuse("scratch-exists");
    throw e;
  }
  // Hold the directory open until removal: the open handle pins its inode, so
  // a directory recreated at the same path can never carry the same identity.
  const pin = fs.openSync(scratch, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const created = fs.fstatSync(pin);
  requirePrivateDirectory(scratch);
  const durableRoot = options.durable?.root;
  let removed = false;
  let released = false;
  const release = () => { if (!released) { released = true; fs.closeSync(pin); } };
  return freeze({
    path: scratch,
    /** Release the held handle without removing (the scratch is retained). */
    retain() { release(); return freeze({ removed: false, retained: scratch, reason: "retained" }); },
    /** Remove this scratch only if it is still the directory we created. */
    remove() {
      if (removed) return freeze({ removed: true });
      let st;
      try { st = fs.lstatSync(scratch); } catch { release(); return freeze({ removed: false, retained: null, reason: "scratch-missing" }); }
      if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== created.dev || st.ino !== created.ino) {
        return freeze({ removed: false, retained: scratch, reason: "scratch-replaced" });
      }
      if (durableRoot && (inside(scratch, durableRoot) || inside(durableRoot, scratch))) {
        return freeze({ removed: false, retained: scratch, reason: "scratch-overlaps-durable" });
      }
      try {
        fs.rmSync(scratch, { recursive: true, force: false });
      } catch {
        return freeze({ removed: false, retained: scratch, reason: "removal-failed" });
      }
      if (fs.existsSync(scratch) || isLink(scratch)) return freeze({ removed: false, retained: scratch, reason: "removal-unproven" });
      removed = true;
      release();
      return freeze({ removed: true });
    },
  });
}

export { DirectoryRefusal, FS as FILESYSTEM_TYPES, DURABLE_FS, SCRATCH_FS };
