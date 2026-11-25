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
export function bindPinnedChromeInstallation(io = fs, pin = CHROME_PIN) {
  try {
    const initial = trustedPath(io);
    if (!initial) return { code: "browser-executable-untrusted" };
    const pathMatches = () => {
      const current = trustedPath(io);
      return current && initial.every((entry, index) => sameEntry(entry, current[index]));
    };
    io.accessSync(CHROME_PATH, fs.constants.X_OK);
    const fd = io.openSync(CHROME_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const executable = initial.at(-1);
      if (!sameEntry(executable, io.fstatSync(fd, { bigint: true }))) return { code: "browser-executable-changed" };
      const digest = sha256Descriptor(fd, { read: io.readSync, limit: Number(executable.size) });
      if (!pathMatches() || !sameEntry(executable, io.fstatSync(fd, { bigint: true }))) {
        return { code: "browser-executable-changed" };
      }
      if (digest !== pin) return { code: "browser-pin-mismatch" };
    } finally {
      io.closeSync(fd);
    }
    let failure;
    return Object.freeze({
      code: "browser-pin-matched",
      recheck() {
        if (failure) return failure;
        try {
          if (!pathMatches()) failure = "browser-executable-changed";
        } catch {
          failure = "browser-evidence-unavailable";
        }
        return failure ?? "browser-pin-matched";
      },
    });
  } catch {
    return { code: "browser-evidence-unavailable" };
  }
}

export function checkPinnedChromeInstallation(io, pin) {
  return bindPinnedChromeInstallation(io, pin).code;
}

// Read-only composition for the fixed WSLg candidate. Window attribution,
// the operator boundary and the sandbox policy have their own proofs.
export function bindRealSeat() {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || process.arch !== "x64" || !/microsoft-standard-WSL2$/i.test(os.release())
      || !uid || uid !== process.geteuid?.()) return { code: "seat-platform-unsupported" };
  const seat = bindSeatMetadata();
  if (seat.code !== "seat-metadata-observed") return { code: seat.code };
  const browser = bindPinnedChromeInstallation();
  if (browser.code !== "browser-pin-matched") return { code: browser.code };
  let failure;
  const check = () => {
    const before = seat.recheck();
    if (before !== "seat-metadata-matched") return before;
    const pinned = browser.recheck();
    return pinned === "browser-pin-matched" ? seat.recheck() : pinned;
  };
  const recheck = () => {
    if (failure) return failure;
    const current = check();
    if (current !== "seat-metadata-matched") failure = current;
    return current;
  };
  const current = recheck();
  if (current !== "seat-metadata-matched") return { code: current };
  return Object.freeze({ code: "real-seat-preflight-passed", recheck });
}

export function preflightRealSeat() {
  return { code: bindRealSeat().code };
}
