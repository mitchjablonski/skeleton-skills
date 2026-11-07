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
  return writeState(root, { ...DEFAULTS, title, reviewEpoch: Date.now(), reviewRound: crypto.randomUUID() });
}

// The key a project's store files are named by.
export function projectKey(root, platform = process.platform) {
  let real = root;
  try { real = fs.realpathSync.native(root); } catch {}
  if (platform === "win32") real = real.toLowerCase();
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 24);
}
/** Every per-project store file: `<key><suffix>.json`. */
export const STORE_SUFFIXES = ["", ".snapshot", ".rendered", "-install", ".config-notice", ".stop-notice"];
// Preserve protocol-2 home selection: delivery metadata follows the records;
// a leftover Stop cache must not move authority away from the state dir.
const LEGACY_ROUTING_SUFFIXES = STORE_SUFFIXES.filter(s => s !== ".stop-notice");
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
  return LEGACY_ROUTING_SUFFIXES.some((s) => lexists(path.join(from, `${key}${s}.json`)));
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
  // One listing per store dir per hook call: the names it holds, so a
  // populated store answers by lookup rather than an lstat per project dir.
  if (!cache.has(RECEIPT_INDEX)) {
    const index = { dirs: [], unreadable: false };
    for (const dir of skelStoreDirs()) {
      try {
        // Case-folded: on a case-folding store a variant is the same file; elsewhere it only adds protection.
        const names = new Set(fs.readdirSync(dir).map(name => name.toLowerCase()).filter(name => name.endsWith(".snapshot.json")));
        if (names.size) index.dirs.push({ dir, names });
      } catch (err) {
        // A dir that can't be listed may still answer for one known name: look it up.
        if (!["ENOENT", "ENOTDIR"].includes(err.code)) { index.unreadable = true; index.dirs.push({ dir, names: null }); }
      }
    }
    cache.set(RECEIPT_INDEX, index);
  }
  const index = cache.get(RECEIPT_INDEX);
  let status = index.unreadable ? "unreadable" : "absent";
  if (!index.dirs.length) return status;
  const name = projectKey(root) + ".snapshot.json";
  for (const { dir, names } of index.dirs) {
    if (names) { if (names.has(name)) return "present"; continue; }
    try { if (fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })) return "present"; }
    catch (err) { if (!["ENOENT", "ENOTDIR"].includes(err.code)) status = "unreadable"; }
  }
  // #55: no record under this spelling's key. On WSL's drvfs a record written
  // from a case variant or 8.3 alias of this path has another key; only a
  // proven one counts (see receiptAliases).
  if (receiptAliases(root, { cache, index }).verified.length) return "present";
  return status;
}

/**
 * The mount point of WSL's drvfs (`/mnt/c`) holding `p`, or null: the longest
 * mount point above it, when that mount is drvfs. Read once per process.
 */
let mounts;
export function drvfsMountOf(p) {
  loadMounts();
  const m = mounts.find(({ at }) => p === at || p.startsWith(at.endsWith("/") ? at : at + "/"));
  return m?.drvfs ? m.at : null;
}
/** Is any drvfs mounted (WSL)? */
export const anyDrvfs = () => (loadMounts(), mounts.some((m) => m.drvfs));
function loadMounts() {
  if (!mounts) {
    mounts = [];
    try {
      for (const line of fs.readFileSync("/proc/self/mountinfo", "utf-8").split("\n")) {
        const [pre, post] = line.split(" - ");
        const point = pre?.split(" ")[4];
        if (!post || !point) continue;
        const [fstype, , opts = ""] = post.split(" ");
        const at = point.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
        mounts.push({ at, drvfs: fstype === "drvfs" || (fstype === "9p" && /(^|[,;])aname=drvfs([,;]|$)/.test(opts)) });
      }
    } catch {}
    mounts.sort((a, b) => b.at.length - a.at.length);
  }
}

/** An 8.3 short name: a stem, `~` and a number, maybe an extension (`LONGPR~1`, `MYPROJ~1.DIR`). */
const SHORT_NAME = /^([^~]+)~\d+(\.[^.~]*)?$/;
/**
 * Could the 8.3 name `short` be `long`'s? Its stem is the start of the long
 * name with spaces and dots dropped (`LONGPR~1`, LongProjectName), or, for a
 * crowded dir, the first one or two characters and four hex digits of a hash
 * (`LO1A2B~1`). Either way, case aside. `backup~1` isn't every name.
 */
function shortNameOf(short, long) {
  const m = SHORT_NAME.exec(short);
  if (!m) return false;
  const stem = m[1].toUpperCase();
  const squashed = long.toUpperCase().replace(/[\s.]/g, "");
  if (squashed.startsWith(stem)) return true;
  const hashed = /^(.{1,2})[0-9A-F]{4}$/.exec(stem);
  return !!hashed && squashed.startsWith(hashed[1]);
}
/**
 * Could `stored` name the dir `real` names, by text alone? Same number of
 * names, each pair the same but for case, or one the other's 8.3 name. Only a
 * candidate: two names that differ in case are two dirs under a dir with
 * per-directory case sensitivity on, so identity decides (receiptAliases).
 */
export function lookalike(stored, real) {
  if (stored === real) return true;
  const a = stored.split("/"), b = real.split("/");
  return a.length === b.length && a.every((x, i) => x === b[i] || x.toLowerCase() === b[i].toLowerCase() || shortNameOf(x, b[i]) || shortNameOf(b[i], x));
}

/**
 * A record's `root`, from the first bytes of its file (skel writes it first);
 * null if it names none; undefined if the file couldn't be read (a lock, a
 * permission, too many open files): unknown, not "no root", so it's never
 * indexed as one and is read again.
 */
function storedRoot(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const head = buf.toString("utf-8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
    let root = null;
    try { const m = /^\{\s*"root"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head); root = m && JSON.parse(m[1]); } catch {}
    return typeof root === "string" ? root : null;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Per store dir: each approval record's key and a verified resolved-path
 * witness, so hooks can find aliases without reading every record. Derived
 * and advisory: a reader trusts it only for the records it lists, and reads
 * any other record's own head; the roots it picks are verified as if read
 * from the records. Written by the CLI (approve, reshape, migrate, status,
 * the Stop hook's once-a-session look); never by PreToolUse or ConfigChange.
 */
export const RECEIPT_INDEX_NAME = "receipt-roots.json";
const SNAPSHOT_NAME = /^[0-9a-f]{24}\.snapshot\.json$/;
// #63: caller roots can change under the same filename key. Cache a resolved
// witness instead: its path hashes to that key regardless of later caller
// spelling. Old strings/nulls cannot provide that proof and fall back to heads.
function indexedWitness(entry, key) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    && typeof entry.root === "string" && typeof entry.resolved === "string"
    && path.posix.isAbsolute(entry.resolved)
    && crypto.createHash("sha256").update(entry.resolved).digest("hex").slice(0, 24) === key ? entry : null;
}
function witnessFromRoot(root, key) {
  if (typeof root !== "string" || !path.posix.isAbsolute(root)) return null;
  try {
    const entry = { root, resolved: fs.realpathSync.native(root) };
    return indexedWitness(entry, key);
  } catch { return null; }
}
function readIndex(dir) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dir, RECEIPT_INDEX_NAME), "utf-8"));
    if (index?.format !== 2 || !index.records || typeof index.records !== "object" || Array.isArray(index.records)) return null;
    return { records: index.records };
  } catch {
    return null;
  }
}
/**
 * Roots and immutable key witnesses, or each record's own head when no witness
 * is known. Rootless/unreadable records are never cached as negative evidence:
 * an older writer could replace one with a valid same-key record at any time.
 */
function recordRoots(dir, names, index = readIndex(dir)) {
  const indexed = index?.records;
  let missing = 0;
  const records = names.filter((n) => SNAPSHOT_NAME.test(n)).map((name) => {
    const key = name.slice(0, 24);
    const file = path.join(dir, name);
    const listed = indexed && Object.hasOwn(indexed, key) && indexedWitness(indexed[key], key);
    if (!listed) missing++;
    const root = listed ? listed.root : storedRoot(file);
    const witness = listed || witnessFromRoot(root, key);
    return { file, key, root, witness: witness ? witness.resolved : null };
  });
  return { records, missing };
}
/**
 * Bring each store dir's receipt index up to date with its listing. `reread`:
 * keys whose record was just rewritten. Only an existing dir that holds a
 * record gets one, and only under WSL (a drvfs mount exists); best-effort,
 * since the hooks fall back to the records.
 * Returns how many dirs it wrote.
 */
export function refreshReceiptIndex({ dirs = skelStoreDirs(), reread = [], force = false, platform = process.platform } = {}) {
  let wrote = 0;
  // Only the hooks on WSL's drvfs read it: elsewhere there's nothing to keep.
  if (platform !== "linux" || !anyDrvfs()) return wrote;
  for (const dir of dirs) {
    try {
      const listing = fs.readdirSync(dir);
      const names = listing.filter((n) => SNAPSHOT_NAME.test(n));
      const index = listing.includes(RECEIPT_INDEX_NAME) ? readIndex(dir) : null;
      const old = index?.records ?? null;
      const keys = names.map((n) => n.slice(0, 24));
      const stale = force || !old || reread.some((k) => keys.includes(k)) || keys.some((k) => !Object.hasOwn(old, k) || !indexedWitness(old[k], k)) || Object.keys(old).some((k) => !keys.includes(k));
      if (!stale) continue;
      const records = {};
      for (const key of keys) {
        const previous = old && indexedWitness(old[key], key);
        if (previous && !force && !reread.includes(key)) { records[key] = previous; continue; }
        const root = storedRoot(path.join(dir, `${key}.snapshot.json`));
        const entry = witnessFromRoot(root, key);
        if (entry) records[key] = entry; // unknown/unprovable: no negative cache entry
      }
      if (!keys.length) {
        if (listing.includes(RECEIPT_INDEX_NAME)) fs.rmSync(path.join(dir, RECEIPT_INDEX_NAME), { force: true });
        continue;
      }
      if (index && JSON.stringify(old) === JSON.stringify(records)) continue;
      writeFileAtomic(path.join(dir, RECEIPT_INDEX_NAME), JSON.stringify({ format: 2, records }), 0o600);
      wrote++;
    } catch {}
  }
  return wrote;
}

const ALIASES = Symbol("receipt roots");
/**
 * #55: approval records that belong to this project under another key. On
 * WSL's drvfs realpath keeps the caller's spelling, so a record written from
 * `.../PR54X7/proj` is keyed apart from `.../pr54x7/Proj`, or from an 8.3
 * alias (`LONGPR~1`). Keys are one-way hashes, so the only lead is the path a
 * record names in its `root` field, and that's the caller's path, maybe a
 * link, not a proof. A record counts only if:
 *   1. its root looks like this path (lookalike, text only: no disk access
 *      for the records of other projects),
 *   2. that root, resolved now, hashes to the record's file name (the key
 *      skel wrote it under: the root still leads where it led, so a link
 *      retargeted since doesn't carry an old record over), and
 *   3. the resolved root is this dir now: the same nonzero dev and inode as
 *      this project's realpath, so a case-sensitive sibling (`Sub` beside
 *      `sub`) isn't. Like the exact key, this is checked now, not against
 *      approval time: a dir deleted and made again at the root's path counts,
 *      as a record that "may belong to an earlier project at this path".
 * `verified` lists the files that pass; `unverified` the lookalikes that
 * don't, with why, for a human to resolve (skel status): skel won't guess.
 * `unindexed`: records without a verified index witness, whose heads were read.
 * Schema-1 roots/nulls are always read again and upgraded by the next refresh.
 * Only on Linux, for a path on drvfs: elsewhere the key already follows the
 * on-disk spelling (native Windows lowercases its realpath) or the filesystem
 * is case-sensitive. Every listable store dir is read (both, as for the exact
 * key), once per `cache`.
 */
export function receiptAliases(root, { cache = new Map(), platform = process.platform, index = null } = {}) {
  const none = { verified: [], unverified: [], unindexed: 0 };
  if (platform !== "linux") return none;
  let real;
  try { real = fs.realpathSync.native(root); } catch { return none; }
  const mount = drvfsMountOf(real);
  if (!mount || real === mount) return none;
  if (!cache.has(ALIASES)) {
    const all = { records: [], unindexed: 0 };
    // The hook's listing when there is one (its names are folded, as a key's are), else a listing here.
    const listings = index ? index.dirs.filter((d) => d.names).map((d) => [d.dir, [...d.names]]) : skelStoreDirs().map((dir) => { try { return [dir, fs.readdirSync(dir)]; } catch { return null; } }).filter(Boolean);
    for (const [dir, names] of listings) {
      const { records, missing } = recordRoots(dir, names, readIndex(dir));
      all.records.push(...records);
      all.unindexed += missing;
    }
    cache.set(ALIASES, all);
  }
  const { records, unindexed } = cache.get(ALIASES);
  const verified = [], unverified = [];
  let here;
  for (const r of records) {
    // A record whose root can't be read names no lookalike: as good as another project's.
    const candidate = r.witness ?? r.root;
    if (typeof candidate !== "string" || !path.posix.isAbsolute(candidate) || !lookalike(path.posix.normalize(candidate), real)) continue;
    const no = (why) => unverified.push({ file: r.file, root: candidate, why });
    let resolved;
    try { resolved = fs.realpathSync.native(candidate); } catch (err) { no(`it doesn't resolve now (${err.code ?? err.message})`); continue; }
    if (crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 24) !== r.key) { no(`it resolves to ${JSON.stringify(resolved)} now, not to the path the record was written for (a link retargeted since?)`); continue; }
    try {
      here ??= fs.statSync(real, { bigint: true });
      const there = fs.statSync(resolved, { bigint: true });
      if (here.ino === 0n || there.ino !== here.ino || there.dev !== here.dev) continue; // another dir (a case-sensitive sibling): not this project's
    } catch (err) { no(`can't compare it with this dir (${err.code ?? err.message})`); continue; }
    verified.push(r.file);
  }
  return { verified, unverified, unindexed };
}
