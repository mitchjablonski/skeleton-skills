// Trusted outside-host storage only: no authentication, listener, activation,
// hostile same-user path protection, or network-filesystem durability claim.
// The host owns this directory and its ancestors outside the agent boundary.
// This adapter serializes cooperating processes; it cannot make host content
// observations atomic with workspace writes. Never recover a leftover lock
// automatically: the host must reconcile unknown outcomes before removing it.
// Normal completion removes only this invocation's lock and temporary file.
// Ownership/path checks detect misconfiguration, not hostile path-swap races.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAuthorityRecord, parseAuthorityRecord, planAuthorityTransaction } from "./strict-authority.mjs";

const RECORD = "authority.json", LOCK = ".authority-lock", HOLDER = "holder.json";
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const requireLinux = () => { if (process.platform !== "linux") throw Error("authority storage requires Linux directory fsync"); };
const unavailable = () => Object.freeze({ kind: "rejected", code: "unavailable" });
const privateOwned = stat => stat.uid === process.geteuid() && !(stat.mode & 0o022);
function requireAncestors(dir) {
  for (let current = path.resolve(dir);; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      ![0, process.geteuid()].includes(stat.uid) || ((stat.mode & 0o022) && !(stat.mode & 0o1000)))
      throw Error("unsafe authority ancestor");
    if (path.dirname(current) === current) break;
  }
}
const requireDirectory = dir => {
  requireAncestors(path.dirname(dir));
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwned(stat)) throw Error("unsafe authority directory");
};

function processIdentity(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const tail = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { startTime: tail[19], state: tail[0] };
}
const bootId = () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
function holderIdentity() {
  return { pid: process.pid, bootId: bootId(), startTime: processIdentity(process.pid).startTime };
}

/** Nonmutating recovery hints only. Even an abandoned lock is NEVER removed.
 * Stop all writers and reconcile the record before manual host cleanup.
 */
export function inspectAuthorityStore(directory) {
  requireLinux();
  const dir = path.resolve(directory);
  requireDirectory(dir);
  let status = "absent", holder = null;
  try {
    const lock = path.join(dir, LOCK);
    requireDirectory(lock);
    status = "unknown";
    const file = path.join(lock, HOLDER), stat = fs.lstatSync(file);
    if (!stat.isFile() || !privateOwned(stat) || stat.size > 4096) throw Error("unsafe holder");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || Object.keys(parsed).sort().join() !== "bootId,pid,startTime" ||
      !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.bootId !== "string" || !/^[0-9a-f-]{36}$/.test(parsed.bootId) ||
      typeof parsed.startTime !== "string" || !/^\d+$/.test(parsed.startTime)) throw Error("invalid holder");
    holder = Object.freeze({ ...parsed });
    if (parsed.bootId !== bootId()) status = "abandoned";
    else {
      try {
        const actual = processIdentity(parsed.pid);
        status = actual.startTime !== parsed.startTime || ["Z", "X"].includes(actual.state) ? "abandoned" : "held";
      } catch (error) { status = error.code === "ENOENT" || error.code === "ESRCH" ? "abandoned" : "unknown"; }
    }
  } catch (error) {
    // A missing holder isn't an absent lock. A malformed/symlink lock is unknown.
    try { fs.lstatSync(path.join(dir, LOCK)); status = "unknown"; }
    catch (missing) { status = missing.code === "ENOENT" ? "absent" : "unknown"; }
  }
  const orphanTemps = fs.readdirSync(dir).filter(name => {
    if (!/^\.authority-[0-9a-f-]{36}\.tmp$/.test(name)) return false;
    const stat = fs.lstatSync(path.join(dir, name));
    return stat.isFile() && !stat.isSymbolicLink() && privateOwned(stat) && stat.nlink === 1;
  });
  return Object.freeze({ lock: status, holder, orphanTemps: Object.freeze(orphanTemps),
    recoveryHint: "Temporary names are candidates only. Stop all writers and reconcile unknown outcomes before manual outside-host cleanup; never expire locks automatically." });
}

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
  if (!stat.isFile() || stat.isSymbolicLink() || !privateOwned(stat) || stat.size > MAX_RECORD_BYTES) throw Error("invalid authority file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !privateOwned(opened) || opened.size > MAX_RECORD_BYTES) throw Error("invalid authority file");
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
  const holder = path.join(lock, HOLDER);
  let holderOwned = false;
  try {
    const fd = fs.openSync(holder, "wx", 0o600); holderOwned = true;
    try { fs.writeFileSync(fd, JSON.stringify(holderIdentity()) + "\n"); io.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(lock, io);
    syncDirectory(dir, io);
    return work();
  }
  finally {
    if (holderOwned) fs.unlinkSync(holder);
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
  requireAncestors(path.dirname(dir));
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
