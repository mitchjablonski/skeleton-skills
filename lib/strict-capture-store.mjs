// Trusted Linux outside-host immutable capture storage. This is not a private
// channel, hostile same-user path-race defense, activation or atomic authority
// transaction. The host owns this namespace and ancestors outside the agent.
// On I/O failure the outcome is unknown: stop writers/investigate storage health
// then retry. Successful reads/retries resync file, directory and parent, which
// is not proof that an earlier writeback failure was harmless.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateStoredCapture } from './strict-capture.mjs';

export const MAX_CAPTURE_BLOB_BYTES = 128 * 1024 * 1024;
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const linux = () => { if (process.platform !== 'linux') throw Error('capture store requires Linux'); };
const owned = stat => stat.uid === process.geteuid() && !(stat.mode & 0o022);
function ancestors(dir) {
  for (let current = path.resolve(dir);; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.geteuid()].includes(stat.uid)
      || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw Error('unsafe capture ancestor');
    if (path.dirname(current) === current) return;
  }
}
function directory(dir) {
  ancestors(path.dirname(dir));
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw Error('unsafe capture directory');
}
function syncDirectory(dir, io) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { io.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// Trusted test seam only; never a request-provided durability bypass.
const operations = value => ({ fsyncSync: value?.fsyncSync ?? fs.fsyncSync, linkSync: value?.linkSync ?? fs.linkSync });
function read(dir, captureVersion, io) {
  directory(dir);
  if (!id(captureVersion)) throw Error('invalid capture identity');
  const file = path.join(dir, `${captureVersion}.json`);
  const stat = fs.lstatSync(file);
  const valid = stat => stat.isFile() && owned(stat) && stat.nlink === 1 && stat.size <= MAX_CAPTURE_BLOB_BYTES;
  if (!valid(stat)) throw Error('unsafe capture blob');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!valid(before) || before.dev !== stat.dev || before.ino !== stat.ino) throw Error('unsafe capture blob');
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    if (!valid(after) || size !== before.size || ['dev','ino','size','mtimeMs','ctimeMs','mode','nlink'].some(key => before[key] !== after[key])) throw Error('capture blob changed');
    // Fatal decoding avoids silently replacing corrupt bytes before validation.
    const capture = validateStoredCapture(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0,size))));
    if (capture.captureVersion !== captureVersion) throw Error('capture identity mismatch');
    io.fsyncSync(fd);
    syncDirectory(dir, io); syncDirectory(path.dirname(dir), io);
    return capture;
  } finally { fs.closeSync(fd); }
}
function handle(dir, io) {
  return Object.freeze({ directory: dir,
    get(captureVersion) { return read(dir, captureVersion, io); },
    put(value) {
      directory(dir);
      const capture = validateStoredCapture(value);
      const bytes = Buffer.from(JSON.stringify(capture) + '\n');
      if (bytes.length > MAX_CAPTURE_BLOB_BYTES) throw Error('capture blob limit');
      const temp = path.join(dir, `.capture-${randomUUID()}.tmp`);
      const destination = path.join(dir, `${capture.captureVersion}.json`);
      let ownedTemp = false;
      try {
        const fd = fs.openSync(temp, 'wx', 0o600); ownedTemp = true;
        try { fs.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try { io.linkSync(temp, destination); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        // During publication the inode has two links. Never acknowledge it until
        // our temp is unlinked. A crash can leave both: get refuses nlink=2 until
        // manual outside-host cleanup of the independently verified temp alias.
        fs.unlinkSync(temp); ownedTemp = false;
        const stored = read(dir, capture.captureVersion, io);
        if (JSON.stringify(stored) !== JSON.stringify(capture)) throw Error('capture collision or corrupt existing blob');
        return stored;
      } finally { if (ownedTemp) fs.unlinkSync(temp); }
    },
  });
}
/** Enrollment only. Existing directories, including incomplete ones, refuse.
 * Creation failure leaves the directory for deliberate outside-host recovery.
 */
export function createCaptureStore(directoryPath, storageOperations) {
  linux(); const dir = path.resolve(directoryPath), io = operations(storageOperations);
  ancestors(path.dirname(dir)); fs.mkdirSync(dir, { mode: 0o700 });
  directory(dir); syncDirectory(dir, io); syncDirectory(path.dirname(dir), io);
  return handle(dir, io);
}
/** Opens an enrolled namespace; individual get/put operations validate blobs.
 * No cleanup, expiry, repair, temp promotion or authority references are written.
 */
export function openCaptureStore(directoryPath, storageOperations) {
  linux(); const dir = path.resolve(directoryPath); directory(dir);
  return handle(dir, operations(storageOperations));
}
