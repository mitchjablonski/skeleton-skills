import fs from "node:fs";
import os from "node:os";
import { sha256Descriptor } from "./strict-browser-fixture.mjs";
import { bindSeatMetadata } from "./strict-seat-metadata.mjs";

const CHROME_PATH = "/opt/google/chrome/chrome";
const CHROME_PIN = "7ee5f9e4bf6674e3b19d8c7fb952aea78385e6ba6caa6330d62ed9821558cf6f";
const INSTALL_PATH = ["/", "/opt", "/opt/google", "/opt/google/chrome", CHROME_PATH];
const MAX_ELF_BYTES = 512 * 1024 * 1024;

function trustedPath(io) {
  const entries = [];
  for (const file of INSTALL_PATH) {
    const entry = io.lstatSync(file, { bigint: true });
    if (entry.uid !== 0n || (entry.mode & 0o022n) !== 0n) return null;
    if (file === CHROME_PATH) {
      if (!entry.isFile() || entry.size <= 0n || entry.size > BigInt(MAX_ELF_BYTES)) return null;
    } else if (!entry.isDirectory()) return null;
    entries.push(entry);
  }
  return entries;
}

function sameEntry(first, second) {
  return first.dev === second.dev && first.ino === second.ino
    && first.ctimeNs === second.ctimeNs && first.uid === second.uid
    && first.mode === second.mode && first.size === second.size;
}

// Sample option (a) of the launcher design. Root and the filesystem still
// need to be trusted by the operator. This does not execute the ELF.
export function checkPinnedChromeInstallation(io = fs, pin = CHROME_PIN) {
  try {
    const initial = trustedPath(io);
    if (!initial) return "browser-executable-untrusted";
    io.accessSync(CHROME_PATH, fs.constants.X_OK);
    const fd = io.openSync(CHROME_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const executable = initial.at(-1);
      if (!sameEntry(executable, io.fstatSync(fd, { bigint: true }))) return "browser-executable-changed";
      const digest = sha256Descriptor(fd, { read: io.readSync, limit: Number(executable.size) });
      const after = trustedPath(io);
      if (!after || !initial.every((entry, index) => sameEntry(entry, after[index]))
          || !sameEntry(executable, io.fstatSync(fd, { bigint: true }))) return "browser-executable-changed";
      return digest === pin ? "browser-pin-matched" : "browser-pin-mismatch";
    } finally {
      io.closeSync(fd);
    }
  } catch {
    return "browser-evidence-unavailable";
  }
}

// Read-only composition for the fixed WSLg candidate. Window attribution,
// the operator boundary and the sandbox policy have their own proofs.
export function preflightRealSeat() {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || process.arch !== "x64" || !/microsoft-standard-WSL2$/i.test(os.release())
      || !uid || uid !== process.geteuid?.()) return { code: "seat-platform-unsupported" };
  const seat = bindSeatMetadata();
  if (seat.code !== "seat-metadata-observed") return { code: seat.code };
  const browser = checkPinnedChromeInstallation();
  if (browser !== "browser-pin-matched") return { code: browser };
  const current = seat.recheck();
  if (current !== "seat-metadata-matched") return { code: current };
  return { code: "real-seat-preflight-passed" };
}
