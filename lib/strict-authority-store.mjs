// Trusted outside-host storage only: no authentication, listener, activation,
// hostile same-user path protection, or network-filesystem durability claim.
// The host owns this directory and its ancestors outside the agent boundary.
// This adapter serializes cooperating processes; it cannot make host content
// observations atomic with workspace writes. Never recover a leftover lock
// automatically: the host must reconcile unknown outcomes before removing it.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAuthorityRecord, parseAuthorityRecord, planAuthorityTransaction } from "./strict-authority.mjs";

const RECORD = "authority.json", LOCK = ".authority-lock";
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const requireLinux = () => { if (process.platform !== "linux") throw Error("authority storage requires Linux directory fsync"); };
const unavailable = () => Object.freeze({ kind: "rejected", code: "unavailable" });
const requireDirectory = dir => {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("authority directory is not a regular directory");
};

// Narrow operation seam for deterministic storage-fault tests, never a mode
// switch. Production callers use the real defaults. No injected result bypass.
function operations(overrides) {
  return { fsyncSync: overrides?.fsyncSync ?? fs.fsyncSync,
    renameSync: overrides?.renameSync ?? fs.renameSync };
}
function syncDirectory(dir, io) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { io.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readRecord(dir) {
  requireDirectory(dir);
  const file = path.join(dir, RECORD), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw Error("invalid authority file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_RECORD_BYTES) throw Error("invalid authority file");
    const record = parseAuthorityRecord(JSON.parse(fs.readFileSync(fd, "utf8")));
    if (!record) throw Error("corrupt authority record");
    return record;
  } finally { fs.closeSync(fd); }
}
function syncRecord(dir, io) {
  const fd = fs.openSync(path.join(dir, RECORD), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { if (!fs.fstatSync(fd).isFile()) throw Error("invalid authority file"); io.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(dir, io);
}
function writeRecord(dir, record, io) {
  const temp = path.join(dir, `.authority-${randomUUID()}.tmp`);
  let owned = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600); owned = true;
    try { fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8"); io.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    io.renameSync(temp, path.join(dir, RECORD));
    owned = false;
    syncDirectory(dir, io);
  } finally {
    // Remove only the temporary file created by this invocation, never locks
    // or a record belonging to another process.
    if (owned) fs.unlinkSync(temp);
  }
}
function locked(dir, io, work) {
  requireDirectory(dir);
  const lock = path.join(dir, LOCK);
  fs.mkdirSync(lock, { mode: 0o700 }); // EEXIST refuses; no expiry or retry/delete.
  try { return work(); }
  finally {
    fs.rmdirSync(lock);
    syncDirectory(dir, io);
    // Creation may have renamed a valid record but failed to persist this
    // directory's entry in its parent. Reopen/retry must complete that barrier
    // too before acknowledging any result, including a journal duplicate.
    syncDirectory(path.dirname(dir), io);
  }
}
function handle(dir, io) {
  return Object.freeze({
    directory: dir,
    /** Host must authenticate the caller and compute trusted facts first.
     * Only the Result is returned, after the entire journal/state is durable.
     * unavailable may follow rename: retry the SAME request ID after recovery.
     */
    submit(intent, trustedFacts) {
      try {
        return locked(dir, io, () => {
          const record = readRecord(dir); // always reread under the process lock
          const plan = planAuthorityTransaction(record, intent, trustedFacts);
          if (plan.persist) writeRecord(dir, plan.record, io);
          // A previous process may have renamed then failed directory fsync.
          // Re-durabilize even an exact retry before reporting its old success.
          else syncRecord(dir, io);
          return plan.result;
        });
      } catch { return unavailable(); }
    },
  });
}

/** Explicit enrollment only: directory MUST NOT already exist. Never replaces
 * an old/missing/corrupt record in an existing directory. On failure, leave the
 * directory for deliberate host recovery rather than pretending creation failed
 * without effects. Local Linux fsync is required; other filesystems need proof.
 */
export function createAuthorityStore(directory, initialState, storageOperations) {
  requireLinux(); // Unsupported hosts refuse before any filesystem operation.
  const record = createAuthorityRecord(initialState);
  if (!record) throw Error("invalid initial authority state");
  const dir = path.resolve(directory), io = operations(storageOperations);
  fs.mkdirSync(dir, { mode: 0o700 });
  locked(dir, io, () => writeRecord(dir, record, io));
  return handle(dir, io);
}

/** Opens existing authority only; missing/corrupt/symlink records throw. */
export function openAuthorityStore(directory, storageOperations) {
  requireLinux();
  const dir = path.resolve(directory), io = operations(storageOperations);
  readRecord(dir);
  return handle(dir, io);
}
