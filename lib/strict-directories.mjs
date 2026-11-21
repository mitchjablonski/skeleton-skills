// Strict directory manager, bootstrap step 2 (docs/strict-protected-bootstrap.md,
// "Durable history versus scratch"). DISABLED PROTOTYPE: imported by tests
// only, wired into no launcher.
//
// Durable history holds the enrollment, the authority record and journal, and
// the immutable captures. It is reopened (or laid out on first enrollment
// only) and never removed by ordinary cleanup. Whether it holds a valid
// enrollment is the store's check in step 3, not this module's.
//
// Scratch is per launch: created fresh (an existing path is refused), never
// overlapping durable history, and removed only by remove({ writersStopped:
// true }) once the caller has proven every writer into it has exited (the
// launcher's physical stop comes first). Anything this module can't remove as
// expected is retained and reported.
//
// Threat model: the agent can't reach either directory (N9). A same-uid
// process that is still running can always race path operations, which is
// why removal requires the writers to be stopped first.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const freeze = Object.freeze;
// statfs f_type magic numbers.
const FS = freeze({ ext: 0xef53, xfs: 0x58465342, btrfs: 0x9123683e, tmpfs: 0x01021994 });
const DURABLE_FS = freeze([FS.ext, FS.xfs, FS.btrfs]);
const SCRATCH_FS = freeze([FS.ext, FS.xfs, FS.btrfs, FS.tmpfs]);
const LAYOUT = freeze(["authority", "captures"]); // exactly these durable entries

class DirectoryRefusal extends Error {
  constructor(code) { super(code); this.name = "DirectoryRefusal"; this.code = code; }
}
const refuse = (code) => { throw new DirectoryRefusal(code); };
/** Run a filesystem call; any raw error becomes a fixed refusal (no paths in messages). */
function io(code, fn) {
  try { return fn(); } catch (e) { if (e instanceof DirectoryRefusal) throw e; refuse(code); }
}

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

function requirePrivate(st) {
  if (!st.isDirectory() || st.isSymbolicLink()) refuse("not-a-directory");
  if (st.uid !== process.geteuid()) refuse("foreign-owner");
  if (st.mode & 0o077) refuse("not-private");
  return st;
}
function requirePrivateDirectory(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { refuse("missing-directory"); }
  return requirePrivate(st);
}

function requireFilesystem(dir, allowed, statfs) {
  let type;
  try { type = statfs(dir).type; } catch { refuse("filesystem-unknown"); }
  if (!allowed.includes(type)) refuse("filesystem-not-allowed");
  return type;
}

function syncDirectory(dir) {
  io("io-error", () => {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function deps(options) {
  const statfs = options?.statfs ?? fs.statfsSync;
  // Only the final rename is replaceable, so a test can fail it after the temporary layout exists.
  const rename = options?.renameSync ?? fs.renameSync;
  if (typeof statfs !== "function" || typeof rename !== "function") refuse("invalid-options");
  return { statfs, rename };
}

/**
 * Reopen durable history (default), or lay it out on first enrollment
 * ({ firstEnrollment: true }). Reopen requires exactly the private layout on
 * one allowed filesystem and never creates anything. First enrollment builds
 * the layout in a private temporary sibling and renames it into place, so a
 * failure never leaves a half-made root. Returns frozen
 * { root, authority, captures, filesystem }.
 */
export function prepareDurableHistory(rootPath, options = {}) {
  requireLinux();
  const { statfs, rename } = deps(options);
  const root = absolute(rootPath);
  if (options.firstEnrollment !== undefined && typeof options.firstEnrollment !== "boolean") refuse("invalid-options");
  const parent = path.dirname(root);
  requireAncestors(parent);
  requireFilesystem(parent, DURABLE_FS, statfs);
  if (options.firstEnrollment === true) {
    if (exists(root)) refuse("durable-history-exists");
    const temp = path.join(parent, `.${path.basename(root)}.enrolling-${crypto.randomBytes(6).toString("hex")}`);
    try {
      io("io-error", () => fs.mkdirSync(temp, { mode: 0o700 }));
      for (const name of LAYOUT) io("io-error", () => fs.mkdirSync(path.join(temp, name), { mode: 0o700 }));
      for (const name of LAYOUT) syncDirectory(path.join(temp, name));
      syncDirectory(temp);
      if (exists(root)) refuse("durable-history-exists");
      io("io-error", () => rename(temp, root)); // an empty directory raced into place would be replaced; same-uid only
      syncDirectory(parent);
    } catch (e) {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort; temp is private */ }
      throw e;
    }
  }
  const rootStat = requirePrivateDirectory(root);
  const filesystem = requireFilesystem(root, DURABLE_FS, statfs);
  const entries = io("io-error", () => fs.readdirSync(root)).sort();
  if (entries.length !== LAYOUT.length || entries.some((e, i) => e !== [...LAYOUT].sort()[i])) {
    refuse(entries.every((e) => LAYOUT.includes(e)) ? "durable-history-incomplete" : "durable-history-unexpected-entry");
  }
  for (const name of LAYOUT) {
    const sub = path.join(root, name);
    const st = requirePrivateDirectory(sub);
    if (st.dev !== rootStat.dev) refuse("durable-history-mixed-filesystem"); // no mount under the root
    requireFilesystem(sub, DURABLE_FS, statfs);
  }
  return freeze({ root, authority: path.join(root, "authority"), captures: path.join(root, "captures"), filesystem });
}

/** Delete a tree without following links or descending onto a different device. Caller has stopped all writers.
 * A bind mount of the same filesystem shares the device and isn't detected (needs mount privilege). */
function removeTree(dir, dev) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.dev !== dev) throw new Error("cross-device");
    if (st.isDirectory() && !st.isSymbolicLink()) removeTree(p, dev);
    else fs.unlinkSync(p); // a symlink is unlinked, never followed
  }
  fs.rmdirSync(dir);
}

/**
 * Create a fresh scratch directory at exactly scratchPath (an existing path,
 * including a dangling symlink, is refused). durable, if given, is a prepared
 * durable history: the two must not overlap. The handle holds the directory
 * open (pinning its inode) until remove() succeeds or retain() is called.
 */
export function createScratch(scratchPath, options = {}) {
  requireLinux();
  const { statfs } = deps(options);
  const scratch = absolute(scratchPath);
  let durableRoot;
  if (options.durable !== undefined) {
    durableRoot = options.durable?.root;
    if (typeof durableRoot !== "string") refuse("invalid-options");
    if (inside(scratch, durableRoot) || inside(durableRoot, scratch)) refuse("scratch-overlaps-durable");
  }
  const parent = path.dirname(scratch);
  requireAncestors(parent);
  requireFilesystem(parent, SCRATCH_FS, statfs);
  if (exists(scratch)) refuse("scratch-exists");
  try { fs.mkdirSync(scratch, { mode: 0o700 }); } catch (e) {
    refuse(e.code === "EEXIST" ? "scratch-exists" : "io-error");
  }
  let pin = null;
  let created;
  try {
    pin = fs.openSync(scratch, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    created = requirePrivate(fs.fstatSync(pin)); // judge the opened directory, not the path
    const now = fs.lstatSync(scratch);
    if (now.dev !== created.dev || now.ino !== created.ino) refuse("scratch-replaced");
    requireFilesystem(scratch, SCRATCH_FS, statfs);
  } catch (e) {
    // Remove only the directory we created: never one that replaced it at the path.
    try {
      const now = fs.lstatSync(scratch);
      if (created && now.isDirectory() && !now.isSymbolicLink() && now.dev === created.dev && now.ino === created.ino) fs.rmdirSync(scratch);
      else if (!created && pin === null) fs.rmdirSync(scratch); // opening failed before any identity was known
    } catch { /* left for the caller to report */ }
    if (pin !== null) { try { fs.closeSync(pin); } catch { /* closing */ } }
    if (e instanceof DirectoryRefusal) throw e;
    refuse("io-error");
  }
  let state = "held"; // held -> removed | released
  const release = () => { if (state === "held") { state = "released"; fs.closeSync(pin); } };
  const kept = (reason) => freeze({ removed: false, retained: scratch, reason });
  return freeze({
    path: scratch,
    /**
     * Remove this scratch, only after the caller has proven every writer into
     * it has exited ({ writersStopped: true }), and only if the path is still
     * the directory created. Never follows links or crosses filesystems. On
     * refusal the handle stays held, so remove() can be retried; retain()
     * releases it.
     */
    remove(opts = {}) {
      if (state === "removed") return freeze({ removed: true });
      if (state === "released") return kept("released");
      if (opts.writersStopped !== true) return kept("writers-not-stopped");
      try { requireAncestors(parent); } catch { return kept("unsafe-ancestor"); }
      let st;
      try { st = fs.lstatSync(scratch); } catch { return kept("scratch-missing"); }
      if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== created.dev || st.ino !== created.ino) return kept("scratch-replaced");
      try { removeTree(scratch, created.dev); } catch { return kept("removal-failed"); }
      if (exists(scratch) || isLink(scratch)) return kept("removal-unproven");
      state = "removed";
      fs.closeSync(pin);
      return freeze({ removed: true });
    },
    /** Keep the scratch and release the held handle; later remove() refuses. */
    retain() { release(); return kept("retained"); },
  });
}

export { DirectoryRefusal, FS as FILESYSTEM_TYPES, DURABLE_FS, SCRATCH_FS };
