// Advisory delivery metadata only: never approval authority or baseline state.
// One zero-wait exclusive lock serializes claims and clean resets. Busy locks,
// corrupt metadata and storage failures only suppress a corrective continuation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { drvfsMountOf, storePath, writeFileAtomic } from "./state.mjs";

export const stopNoticePath = root => storePath(root, ".stop-notice");
const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const LOCK_TTL = 60_000;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
// Inspect only a bounded regular file. Compare the opened identity before any
// read, so a final-component symlink swap cannot make us read its target.
function readLock(file) {
  let fd;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    let record = null;
    if (st.size <= 256) {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      if (!sameFile(st, fs.fstatSync(fd))) return null;
      const bytes = Buffer.alloc(257);
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (size <= 256) { try { record = JSON.parse(bytes.subarray(0, size).toString("utf8")); } catch {} }
    }
    return { st, record };
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
// #61: on Windows and WSL's drvfs another process (a scanner, the indexer) can
// hold a just-written lock open for a moment: unlinking it answers EACCES, EPERM
// or EBUSY, and a file being deleted can stay visible, so the create right after
// answers EEXIST or EPERM. Only around a reclaim (or our own cleanup) is that
// waited out, briefly and boundedly, as lib/migrate.mjs does; a live owner's
// lock is never waited for.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRIES = 10, RETRY_MS = 20;
const transientRetries = file => {
  try { return process.platform === "win32" || drvfsMountOf(path.resolve(file)) ? RETRIES : 0; } catch { return 0; }
};
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS);
function removeObservedLock(file, observed) {
  for (let tries = transientRetries(file); ; tries--) {
    try {
      // Identity is checked again on each try: a replacement is never removed.
      const now = fs.lstatSync(file);
      if (!now.isFile() || !sameFile(now, observed.st)) return false;
      fs.unlinkSync(file);
      return true;
    } catch (err) {
      if (tries <= 0 || !TRANSIENT.has(err.code)) return false;
      pause();
    }
  }
}
/** The exclusive create right after a reclaim: a moment's grace for the old lock's delete to settle. */
function createAfterReclaim(lock) {
  for (let tries = transientRetries(lock); ; tries--) {
    try { return fs.openSync(lock, "wx", 0o600); }
    catch (err) {
      // EEXIST with a lock that can be read is another caller's: theirs, not ours to wait for.
      const settling = TRANSIENT.has(err.code) || (err.code === "EEXIST" && !readLock(lock));
      if (tries <= 0 || !settling) throw err;
      pause();
    }
  }
}
function reclaimLock(file) {
  const observed = readLock(file);
  if (!observed) return false;
  const r = observed.record;
  const valid = Number.isSafeInteger(r?.pid) && r.pid > 1 && Number.isFinite(r.at);
  let dead = false;
  if (valid) {
    try { process.kill(r.pid, 0); } catch (err) { dead = err.code === "ESRCH"; }
  }
  // Unknown/empty locks age from their filesystem timestamp. A reversed clock
  // cannot strand a known dead owner; EPERM is never evidence of death.
  const at = valid ? r.at : observed.st.mtimeMs;
  return (dead || Date.now() - at >= LOCK_TTL) && removeObservedLock(file, observed);
}
function withLock(file, action) {
  const lock = file + ".lock";
  const nonce = crypto.randomBytes(12).toString("hex");
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (err) {
      if (err.code !== "EEXIST" || !reclaimLock(lock)) return false;
      fd = createAfterReclaim(lock); // one more claim, never waiting on an owner
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), nonce }));
    return action(file);
  } catch { return false; }
  finally {
    if (fd !== undefined) {
      let own;
      try { own = fs.fstatSync(fd); } catch {}
      try { fs.closeSync(fd); } catch {}
      // A slow owner must not unlink the replacement after another caller's
      // TTL recovery. Identity plus nonce is best effort, not an authority lock.
      const current = readLock(lock);
      if (own && current?.record?.nonce === nonce && sameFile(own, current.st)) removeObservedLock(lock, current);
    }
  }
}

/** Stable approval identity, including legacy records without a version field. */
function approvalIdentity(snap) {
  return crypto.createHash("sha256").update(JSON.stringify([
    snap.approvedAt, snap.version ?? null,
    Object.keys(snap.files).sort().map(file => [file, snap.files[file].sha256]),
    snap.fences ?? [],
  ])).digest("hex");
}

// Missing permits a new claim; malformed or unreadable metadata only notifies.
function readClaim(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 256) return false;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return record?.format === 1 && hex(record.approval) && hex(record.drift) ? record : false;
  } catch (err) { return err.code === "ENOENT" ? null : false; }
}

/** True only after this approval/drift pair has been persisted. */
export function claimStopNotice(root, snap, drift) {
  if (!hex(drift)) return false;
  const file = stopNoticePath(root);
  const approval = approvalIdentity(snap);
  const matches = record => record?.approval === approval && record.drift === drift;
  const previous = readClaim(file);
  if (previous === false || matches(previous)) return false;
  return withLock(file, file => {
    // Only a new claim needs writes; re-read under the lock after the fast path.
    const current = readClaim(file);
    if (current === false || matches(current)) return false;
    writeFileAtomic(file, JSON.stringify({ format: 1, approval, drift }), 0o600);
    return true;
  });
}

/** Observing a clean fill re-arms the next drift, without altering its snapshot. */
export function clearStopNotice(root) {
  let file;
  try {
    file = stopNoticePath(root);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return true;
  } catch (err) {
    return ["ENOENT", "ENOTDIR"].includes(err.code);
  }
  // Most clean checks have no delivery record: do not create a lock or dir.
  return withLock(file, file => { fs.rmSync(file, { force: true }); return true; });
}
