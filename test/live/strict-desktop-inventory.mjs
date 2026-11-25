#!/usr/bin/env node
// #231 first slice: a READ-ONLY inventory of the candidate human-desktop seat.
//
//   node test/live/strict-desktop-inventory.mjs [--chrome-sha256 <hex>]
//   node test/live/strict-desktop-inventory.mjs --real-seat-preflight
//
// It identifies a possible seat only. It observes no window, no input path and
// no running browser. Safety (an earlier probe crashed WSLg's compositor by
// connecting to its X11 and audio sockets):
//   - anything under /mnt/wslg, /tmp/.X11-unix, $XDG_RUNTIME_DIR, and the
//     Wayland, Pulse and session-bus sockets is only ever stat()ed: never
//     opened, read, connected to or bound;
//   - no child processes are started. Chrome's executable is hashed and
//     compared when --chrome-sha256 is given;
//   - output is bounded JSON with fixed labels: no home paths, user names or
//     socket paths.
// Exit 0: inventory recorded. Exit 2: unsupported (not Linux, no Chrome or
// Chromium binary, a pin mismatch, or unexpected arguments).

import fs from "node:fs";
import os from "node:os";
import { parseArgs, finish, Fail, labelOf, createFixture } from "./strict-browser-fixture.mjs";
import { bindSeatMetadata } from "./strict-seat-metadata.mjs";
import { preflightRealSeat } from "./strict-real-seat-preflight.mjs";

/** stat() only, never open: a fixed label for what is at `p`. */
function statLabel(p) {
  if (!p) return "unset";
  try {
    const st = fs.lstatSync(p);
    return st.isSocket() ? "socket" : st.isDirectory() ? "directory" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : st.isCharacterDevice() ? "char-device" : "other";
  } catch (e) { return e.code === "ENOENT" ? "absent" : e.code === "EACCES" ? "not-permitted" : "unavailable"; }
}
/** access() only (no open): can this user write the path? */
function writable(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
}
const TOOL_DIRS = ["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin"];
function toolPresent(name) {
  return TOOL_DIRS.some((d) => { try { fs.accessSync(`${d}/${name}`, fs.constants.X_OK); return true; } catch { return false; } });
}
const nsId = (kind) => { try { return /^[a-z_]+:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/self/ns/${kind}`))?.[1] ?? "unrecognized"; } catch { return "unavailable"; } };
const displayName = (v) => v === undefined ? "unset" : /^:\d{1,4}(\.\d{1,2})?$/.test(v) ? v : "other";
const waylandName = (v) => v === undefined ? "unset" : /^wayland-\d{1,3}$/.test(v) ? v : "other";
/** A session-bus address: only whether it is a unix:path= address; the path is stat()ed, never printed. */
function sessionBus() {
  const v = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (v === undefined) return { address: "unset", socket: statLabel(`/run/user/${process.getuid()}/bus`) };
  const m = /^unix:path=([^,;]+)/.exec(v);
  return { address: m ? "unix-path" : /^unix:abstract=/.test(v) ? "unix-abstract" : "other", socket: m ? statLabel(m[1]) : "not-a-path" };
}

if (process.argv.length === 3 && process.argv[2] === "--real-seat-preflight") {
  const { code } = preflightRealSeat();
  const ok = code === "real-seat-preflight-passed";
  finish({ ok, strictState: "unverified", code }, ok ? 0 : 2);
}

const { supervised, ok, pin: suppliedPin } = parseArgs();
if (supervised || !ok) finish({ ok: false, strictState: "unverified", code: "unsupported", reason: "unexpected arguments" }, 2);
if (process.platform !== "linux") finish({ ok: false, strictState: "unverified", code: "unsupported", reason: "not Linux" }, 2);

const result = { ok: false, strictState: "unverified", code: "unsupported", kind: "read-only candidate seat inventory" };
try {
  const pin = suppliedPin?.toLowerCase() ?? null;
  // Reuse the fixed discovery and pin checks without executing the browser.
  const fx = createFixture({ prefix: "strict-desktop-inventory-" });
  let browser;
  try { browser = fx.pinBrowser(pin, null); } catch (e) {
    if (e instanceof Fail && e.label === "sandbox-evidence-unavailable") browser = { ...fx.result.browser, label: fx.result.browser?.label };
    else throw e;
  }
  let procVersion = "";
  try { procVersion = fs.readFileSync("/proc/version", "utf8").slice(0, 512); } catch { /* unavailable */ }
  const release = os.release();
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const waylandDisplay = process.env.WAYLAND_DISPLAY;
  const display = process.env.DISPLAY;
  const xNumber = /^:(\d{1,4})/.exec(display ?? "")?.[1];

  Object.assign(result, {
    ok: true, code: "inventory-recorded",
    platform: {
      machine: os.machine?.() ?? process.arch, kernelRelease: release.slice(0, 64),
      wsl: /microsoft/i.test(procVersion) ? (/WSL2/i.test(release) ? "WSL2" : "WSL") : "not-wsl",
      wslInteropBinfmt: statLabel("/proc/sys/fs/binfmt_misc/WSLInterop"),
      wslDistroNameSet: process.env.WSL_DISTRO_NAME !== undefined,
    },
    wslg: {
      mount: statLabel("/mnt/wslg"),
      versionFile: statLabel("/mnt/wslg/versions.txt"),
      stderrLog: statLabel("/mnt/wslg/stderr.log"),
      x11Anchor: bindSeatMetadata().code,
    },
    environment: { DISPLAY: displayName(display), WAYLAND_DISPLAY: waylandName(waylandDisplay),
      XDG_RUNTIME_DIR: runtimeDir === undefined ? "unset" : "set", PULSE_SERVER: process.env.PULSE_SERVER === undefined ? "unset" : "set",
      XAUTHORITY: process.env.XAUTHORITY === undefined ? "unset" : "set" },
    sockets: {
      x11SocketDirectory: statLabel("/tmp/.X11-unix"),
      x11SocketDirectoryWritable: writable("/tmp/.X11-unix"),
      x11DisplaySocket: xNumber === undefined ? "no-display-number" : statLabel(`/tmp/.X11-unix/X${xNumber}`),
      wslgX11SocketDirectory: statLabel("/mnt/wslg/.X11-unix"),
      waylandRuntimeSocket: runtimeDir && waylandDisplay && !waylandDisplay.includes("/") ? statLabel(`${runtimeDir}/${waylandDisplay}`) : "unset",
      wslgWaylandSocket: statLabel("/mnt/wslg/runtime-dir/wayland-0"),
      wslgPulseServer: statLabel("/mnt/wslg/PulseServer"),
      sessionBus: sessionBus(),
    },
    input: {
      uinputDevice: statLabel("/dev/uinput"), uinputWritableByThisUser: writable("/dev/uinput"),
      xtest: "unknown: needs an X client, which this inventory never runs",
    },
    tools: Object.fromEntries(["xdotool", "xprop", "xwininfo", "xinput", "xauth", "xclip", "xsel", "Xvfb",
      "wlrctl", "wtype", "ydotool", "wl-copy", "wl-paste", "weston", "bwrap"].map((t) => [t, toolPresent(t)])),
    browser: { label: browser.label, sha256: browser.sha256, pinRequested: !!pin, pinMatched: pin ? pin === browser.sha256 : null },
    namespaces: Object.fromEntries(["net", "mnt", "pid", "user", "uts", "ipc", "cgroup"].map((k) => [k, nsId(k)])),
    notShown: ["no window, input path, clipboard or running browser is observed",
      "socket presence is stat() only: a socket inode says nothing about a live server or who can reach it",
      "XTEST availability, compositor input policy and terminal clipboard handling need a client or a human"],
    node: process.version,
  });
  finish(result, 0);
} catch (e) {
  result.reason = labelOf(e);
  if (e instanceof Fail && e.code !== "unsupported") result.code = e.code;
  finish(result, 2);
}
