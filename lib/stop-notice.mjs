// Advisory delivery metadata only: never approval authority or baseline state.
// One zero-wait exclusive lock serializes claims and clean resets. Busy locks,
// corrupt metadata and storage failures only suppress a corrective continuation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { configPath, writeFileAtomic } from "./state.mjs";

export const stopNoticePath = root => configPath(root, ".stop-notice");
const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function withLock(root, action) {
  const file = stopNoticePath(root);
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

/** True only after this approval/drift pair has been persisted. */
export function claimStopNotice(root, snap, drift) {
  if (!hex(drift)) return false;
  return withLock(root, file => {
    const approval = approvalIdentity(snap);
    let previous = null;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 256) return false;
      previous = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!previous || previous.format !== 1 || !hex(previous.approval) || !hex(previous.drift)) return false;
    } catch (err) {
      if (err.code !== "ENOENT") return false;
    }
    if (previous?.approval === approval && previous.drift === drift) return false;
    writeFileAtomic(file, JSON.stringify({ format: 1, approval, drift }), 0o600);
    return true;
  });
}

/** Observing a clean fill re-arms the next drift, without altering its snapshot. */
export function clearStopNotice(root) {
  return withLock(root, file => { fs.rmSync(file, { force: true }); return true; });
}
