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
  const display = { environment, server, number, failed: false };
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

export function displaySocketPresent(display) {
  return fs.existsSync(`/tmp/.X11-unix/X${display.number}`) || fs.existsSync(`/tmp/.X${display.number}-lock`);
}
