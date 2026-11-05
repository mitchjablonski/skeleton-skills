// Advisory delivery metadata only: never approval authority or baseline state.
// One zero-wait exclusive lock serializes claims and clean resets. Busy locks,
// corrupt metadata and storage failures only suppress a corrective continuation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { storePath, writeFileAtomic } from "./state.mjs";

export const stopNoticePath = root => storePath(root, ".stop-notice");
const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function withLock(file, action) {
  const lock = file + ".lock";
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return action(file);
  } catch { return false; }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      try { fs.rmSync(lock); } catch {}
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
