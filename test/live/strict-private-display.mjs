// Owned Xvfb helpers for the opt-in protected browser fixture.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const XVFB = "/usr/bin/Xvfb";
const XAUTH = "/usr/bin/xauth";
const XWININFO = "/usr/bin/xwininfo";
const XPROP = "/usr/bin/xprop";
const TOOL_ENV = { PATH: "/usr/bin:/bin" };
export const displayToolsAvailable = () => [XVFB, XAUTH, XWININFO, XPROP].every((file) => fs.existsSync(file));
export class PrivateDisplayError extends Error {}

function query(file, args, env) {
  return spawnSync(file, args, { env, encoding: "utf8", timeout: 1000, maxBuffer: 65536 });
}

function ownsDisplayLock(number, pid) {
  try {
    const fd = fs.openSync(`/tmp/.X${number}-lock`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid()) return false;
      const data = Buffer.alloc(32);
      const count = fs.readSync(fd, data, 0, data.length, 0);
      return count < data.length && data.subarray(0, count).toString("ascii").trim() === String(pid);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// --- display-slot proof ------------------------------------------------------
// Where /tmp/.X11-unix is not writable (WSL: a read-only bind of WSLg's tmpfs), Xvfb can't
// create the filesystem socket and listens only on the ABSTRACT socket @/tmp/.X11-unix/X<n>.
// A slot is therefore proven free only when the lock file, the filesystem socket and the
// abstract socket are all absent. Abstract sockets are seen only by READING /proc/<pid>/net/unix
// (never connecting). That table is per network namespace: Xvfb is spawned here without any
// namespace change, so it shares the probe's network namespace. While the server lives its own
// /proc/<pid>/net/unix is read (after checking its namespace matches ours); otherwise
// /proc/self/net/unix. An unreadable or malformed table means "not proven" (fail closed).
const SOCKET_DIR = "/tmp/.X11-unix";

/** Pure parser for /proc/net/unix text: the set of bound paths (abstract ones start with "@"). */
export function parseUnixSocketTable(text) {
  const paths = new Set();
  let malformed = 0, rows = 0;
  const lines = String(text).split("\n");
  if (!/^Num\s+RefCount\s+Protocol\s+Flags\s+Type\s+St\s+Inode(\s+Path)?\s*$/.test(lines[0] ?? "")) return { paths, rows, malformed: 1, header: false };
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const m = /^\s*[0-9a-fA-F]+:\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{4}\s+[0-9A-Fa-f]{2}\s+\d+(?:\s+(\S.*))?$/.exec(line);
    if (!m) { malformed++; continue; }
    rows++;
    if (m[1] !== undefined) paths.add(m[1]);
  }
  return { paths, rows, malformed, header: true };
}

/** Pure: socket state for display `number` from /proc/net/unix text (null text = unreadable). */
export function x11SocketState(text, number) {
  if (text === null || text === undefined) return { abstract: null, filesystem: null, proven: false };
  const table = parseUnixSocketTable(text);
  const name = `${SOCKET_DIR}/X${number}`;
  return { abstract: table.paths.has("@" + name), filesystem: table.paths.has(name), proven: table.header && table.malformed === 0 };
}

const readNetNs = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/ns/net`); } catch { return null; } };
function readUnixTable(pid) {
  try { return fs.readFileSync(`/proc/${pid}/net/unix`, "utf8"); } catch { return null; }
}
/** Fixed label: can this host's X socket directory take a filesystem socket? */
export function socketDirectoryLabel() {
  try { fs.accessSync(SOCKET_DIR, fs.constants.W_OK); return "writable"; }
  catch (e) { return e.code === "ENOENT" ? "absent" : e.code === "EACCES" || e.code === "EROFS" ? "read-only" : "unavailable"; }
}

/** The slot's lock, filesystem socket and abstract socket; `proven` false when the table can't be read. */
export function displaySlotState(display) {
  const { number } = display;
  const server = display.server;
  const serverLive = server && server.exitCode === null && server.signalCode === null && !display.failed;
  let pid = "self";
  if (serverLive) {
    const own = readNetNs("self"), theirs = readNetNs(server.pid);
    if (own && theirs && own === theirs) pid = server.pid;
    else if (theirs !== null) return { lock: true, filesystemSocket: true, abstractSocket: null, proven: false };
  } else if (display.netNamespace && display.netNamespace !== readNetNs("self")) {
    return { lock: true, filesystemSocket: true, abstractSocket: null, proven: false };
  }
  const table = x11SocketState(readUnixTable(pid), number);
  return {
    lock: fs.existsSync(`/tmp/.X${number}-lock`),
    filesystemSocket: fs.existsSync(`${SOCKET_DIR}/X${number}`) || table.filesystem === true,
    abstractSocket: table.abstract,
    proven: table.proven,
  };
}

export function startPrivateDisplay(scratch, { beforeSpawn } = {}) {
  const number = Array.from({ length: 16 }, () => randomInt(100, 10000)).find((candidate) => !displaySocketPresent({ number: candidate }));
  if (number === undefined) throw new PrivateDisplayError("display-number-unavailable");
  const authority = path.join(scratch, "Xauthority");
  fs.writeFileSync(authority, "", { flag: "wx", mode: 0o600 });
  const input = `add :${number} . ${randomBytes(16).toString("hex")}\n`;
  if (spawnSync(XAUTH, ["-f", authority], { input, env: TOOL_ENV, timeout: 2000, maxBuffer: 4096 }).status !== 0)
    throw new PrivateDisplayError("display-authority-setup-failed");
  const authorityFile = fs.lstatSync(authority);
  if (!authorityFile.isFile() || authorityFile.uid !== process.getuid() || (authorityFile.mode & 0o777) !== 0o600)
    throw new PrivateDisplayError("display-authority-not-private");

  const environment = { DISPLAY: `:${number}`, XAUTHORITY: authority };
  beforeSpawn?.(number);
  const server = spawn(XVFB, [environment.DISPLAY, "-nolisten", "tcp", "-auth", authority, "-screen", "0", "1024x768x24"],
    { env: TOOL_ENV, stdio: "ignore" });
  const display = { environment, server, number, failed: false, socketDirectory: socketDirectoryLabel(), netNamespace: readNetNs("self") };
  server.once("error", () => { display.failed = true; });
  return display;
}

function serverRunning({ failed, server }) {
  return !failed && server.exitCode === null && server.signalCode === null;
}

export async function waitForPrivateDisplay(display) {
  const { environment, number, server } = display;
  const env = { ...TOOL_ENV, ...environment };
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline && serverRunning(display)) {
    if (ownsDisplayLock(number, server.pid) && query(XWININFO, ["-root"], env).status === 0) {
      const refused = query(XWININFO, ["-root"], { ...env, XAUTHORITY: "/dev/null" });
      if (!Number.isInteger(refused.status) || refused.status === 0)
        throw new PrivateDisplayError("display-unauthenticated-client-control-failed");
      return;
    }
    await delay(25);
  }
  throw new PrivateDisplayError("display-not-ready");
}

export function mappedBrowserWindow(display, browserPid) {
  return Boolean(findMappedBrowserWindow(display, browserPid));
}

export function findMappedBrowserWindow(display, browserPid, expected = null) {
  if (!serverRunning(display) || !ownsDisplayLock(display.number, display.server.pid)) return null;
  const env = { ...TOOL_ENV, ...display.environment };
  const tree = query(XWININFO, ["-root", "-tree"], env);
  if (tree.status !== 0) return null;
  const windows = [...tree.stdout.matchAll(/^\s*(0x[0-9a-f]+)\s+"(Skeleton decision \(prototype\)[^"\n]*)"/gmi)];
  for (const [, id, title] of windows.slice(0, 8)) {
    if (expected && (id !== expected.id || title !== expected.title)) continue;
    const owner = query(XPROP, ["-id", id, "_NET_WM_PID"], env);
    if (owner.status !== 0 || Number(/=\s*(\d+)\s*$/.exec(owner.stdout)?.[1]) !== browserPid) continue;
    const geometry = query(XWININFO, ["-id", id], env);
    if (geometry.status === 0 && /Map State: IsViewable/.test(geometry.stdout)) return { id, title };
  }
  return null;
}

/** True unless the slot is proven clean: lock, filesystem socket and abstract socket all gone. */
export function displaySocketPresent(display) {
  const slot = displaySlotState(display);
  return !slot.proven || slot.lock || slot.filesystemSocket || slot.abstractSocket !== false;
}
