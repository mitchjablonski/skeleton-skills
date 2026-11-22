#!/usr/bin/env node
// Opt-in Linux C20 first slice (#77 / #79): the decision page opens in a
// fresh, launcher-owned browser data directory with remote debugging OFF, and
// a sandboxed agent can't reach the listener the page talks to.
//
//   node test/live/strict-fresh-profile-probe.mjs [--chrome-sha256 <hex>]
//
// The fixture:
//   1. pins the browser: SHA-256 of the resolved Chrome/Chromium ELF binary,
//      which is what it executes, compared with --chrome-sha256 before the
//      binary is ever run (refused, exit 2, on a mismatch);
//   2. starts the existing read-only decision listener on loopback with a
//      fixed fixture capture and mints the one-time URL;
//   3. runs headless Chrome ONCE with --dump-dom <URL> and
//      --virtual-time-budget, on a fresh 0700 browser data directory of its own
//      (an existing path is refused), with NO --remote-debugging-* switch of any
//      kind, Chrome's default sandbox only (no --no-sandbox), no display
//      variables (WSLg is never touched) and HOME set to the scratch root;
//   4. while that browser runs, samples its processes: no debugging switch in
//      any command line, no DevToolsActivePort, and no TCP listener held (any
//      network namespace they are in). After it exits, parses the dumped DOM
//      for the fixed capture markers;
//   5. negative control: the same --dump-dom run WITH a loopback debugging
//      port, in its own fresh directory, must be caught by the same sampling
//      loop (held listener, DevToolsActivePort, switch);
//   6. agent control: a Bubblewrap worker with --unshare-net gets ECONNREFUSED
//      on the listener origin; the same worker sharing the network namespace
//      connects and gets an HTTP status for GET /;
//   7. stops the browsers and the listener, proves nothing remains in a
//      browser session, among our children, or naming the scratch root, and
//      only then removes the directory. The same cleanup runs on SIGINT,
//      SIGTERM, SIGHUP and the watchdog, which abandon the run (exit 1).
// No CDP is used. It connects to nothing but the fixture's own listener.
// Never human proof, never a support claim.
//
// Exit 0: passed. Exit 1: a check or cleanup failed (scratch retained; its
// path goes to stderr only). Exit 2: unsupported (not Linux, no Chrome or
// Chromium, no Bubblewrap or system Python, a pin mismatch, or the sandboxed
// browser can't start: `browser-sandbox-unavailable`, only when no debugging
// was seen, the exit was a numeric code and stderr has Chrome's sandbox text;
// any other failed run is exit 1 `browser-run-failed`).
//
// Cleanup: Chrome's crash handlers leave the browser session. The probe
// re-executes itself through a tiny Python shim that makes it a Linux child
// subreaper, so orphaned helpers are reparented to it. Signals go only to
// our direct children (checked by parent pid just before signalling); a
// command line naming the scratch root fails the run but never authorizes a
// signal. Node never reaps reparented orphans, so their pids can't be reused
// while the probe runs.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";
import { createDecisionListener } from "../../lib/strict-decision-listener.mjs";
import { displaySocketPresent, displayToolsAvailable, mappedBrowserWindow, PrivateDisplayError, startPrivateDisplay, waitForPrivateDisplay, XVFB } from "./strict-private-display.mjs";

const MAX = 32768;
const CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const PYTHON = "/usr/bin/python3";
const BWRAP = "/usr/bin/bwrap";
const PREFIX = "strict-fresh-profile-";
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const supervised = process.argv[2] === "--supervised";
const args = process.argv.slice(supervised ? 3 : 2);
const privateDisplay = args[0] === "--private-display";
const pinArgs = privateDisplay ? args.slice(1) : args;

const unsupported = (reason, code = "unsupported") => ({ ok: false, strictState: "unverified", code, reason });
function finish(result, exitCode) {
  const line = JSON.stringify(result);
  process.stdout.write((line.length <= MAX ? line : JSON.stringify({ ok: false, code: "fixture-failed", reason: "result too large" })) + "\n");
  process.exit(exitCode);
}

// --- outer process: preflight, then re-exec as a child subreaper -----------
const SHIM = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
v = ctypes.c_int(0)
if libc.prctl(36, 1, 0, 0, 0) != 0 or libc.prctl(37, ctypes.byref(v), 0, 0, 0) != 0 or v.value != 1:
    sys.exit(3)
os.execv(sys.argv[1], sys.argv[1:])
`;
const pinOk = (!privateDisplay && pinArgs.length === 0)
  || (pinArgs.length === 2 && pinArgs[0] === "--chrome-sha256" && /^[0-9a-f]{64}$/i.test(pinArgs[1]));
if (!pinOk) finish(unsupported("unexpected arguments"), 2);
if (!supervised) {
  if (process.platform !== "linux") finish(unsupported("not Linux"), 2);
  if (!CANDIDATES.some((c) => fs.existsSync(c))) finish(unsupported("no Chrome or Chromium"), 2);
  if (!fs.existsSync(BWRAP)) finish(unsupported("no /usr/bin/bwrap"), 2);
  if (!fs.existsSync(PYTHON)) finish(unsupported("no /usr/bin/python3"), 2);
  if (privateDisplay && !displayToolsAvailable()) finish(unsupported("private display tools unavailable", "display-unavailable"), 2);
  // Signals and the overall timeout are forwarded so the inner run cleans up;
  // SIGKILL only after a grace period, and only to the inner process we started.
  const inner = spawn(PYTHON, ["-I", "-c", SHIM, process.execPath, SELF, "--supervised", ...args.map((a) => a.toLowerCase())],
    { stdio: ["ignore", "pipe", "inherit"] });
  let buf = Buffer.alloc(0), hard = null;
  inner.stdout.on("data", (c) => { if (buf.length <= MAX * 2) buf = Buffer.concat([buf, c]); });
  const forward = (sig) => {
    try { inner.kill(sig); } catch { /* already gone */ }
    hard ??= setTimeout(() => { try { inner.kill("SIGKILL"); } catch { /* gone */ } }, 45000);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => forward(sig));
  const timeout = setTimeout(() => forward("SIGTERM"), 180000);
  inner.on("error", () => finish(unsupported("cannot start the supervised run"), 2));
  inner.on("close", (status, signal) => {
    clearTimeout(timeout); if (hard) clearTimeout(hard);
    const out = buf.toString("utf8").trim().split("\n").pop() ?? "";
    if (status === 3) finish(unsupported("child subreaper unavailable"), 2);
    try { finish(JSON.parse(out), [0, 1, 2].includes(status) ? status : 1); }
    catch { finish({ ok: false, strictState: "unverified", code: "fixture-failed", reason: `supervised run ended without a result (${status ?? signal})` }, 1); }
  });
}

// --- /proc helpers ----------------------------------------------------------
function readStat(pid) {
  const data = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = data.lastIndexOf(")");
  const f = data.slice(end + 2).split(" ");
  if (end < 0 || !/^[A-Z]$/i.test(f[0]) || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[3]))
    throw new Error("malformed process status");
  return { state: f[0], ppid: Number(f[1]), sid: Number(f[3]) };
}
function stat(pid) { try { return readStat(pid); } catch { return null; } }
const vanished = (e) => e.code === "ENOENT" || e.code === "ESRCH";
const allPids = () => fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
const live = (s) => s && s.state !== "Z" && s.state !== "X";
const sessionPids = (sid) => allPids().filter((p) => { const s = stat(p); return live(s) && s.sid === sid; });
const childPids = () => allPids().filter((p) => { const s = stat(p); return live(s) && s.ppid === process.pid; });
function namingPids(needle) {
  const out = [];
  for (const p of allPids()) {
    if (p === process.pid) continue;
    try {
      const fd = fs.openSync(`/proc/${p}/cmdline`, "r");
      try {
        const b = Buffer.alloc(1 << 16); const n = fs.readSync(fd, b, 0, b.length, 0);
        if (b.subarray(0, n).includes(needle) && live(stat(p))) out.push(p);
      } finally { fs.closeSync(fd); }
    } catch { /* gone or unreadable */ }
  }
  return out;
}
function descendants(root) {
  const kids = new Map();
  for (const p of allPids()) { const s = stat(p); if (live(s)) kids.set(s.ppid, [...(kids.get(s.ppid) ?? []), p]); }
  const out = [], stack = [root];
  while (stack.length) { const p = stack.pop(); for (const c of kids.get(p) ?? []) { out.push(c); stack.push(c); } }
  return out;
}
/** Every live process attributable to this browser run. */
function browserPids(browserPid, scratch) {
  const set = new Set([...sessionPids(browserPid), ...descendants(browserPid), ...childPids(), ...namingPids(scratch)]);
  if (live(stat(browserPid))) set.add(browserPid);
  set.delete(process.pid);
  return [...set];
}
/** A /proc read of a live process; a process that is exiting (fd table already
 *  released) is retried once after 25 ms and then skipped only if no longer live. */
function procRead(pid, fn) {
  try { return { value: fn() }; } catch { /* retry below */ }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  try { return { value: fn() }; } catch {
    try { return { unreadable: live(readStat(pid)) }; }
    catch (statusError) { return { unreadable: !vanished(statusError) }; }
  }
}
/** Listening TCP socket inodes in the network namespace(s) seen through each pid. */
function listeningInodes(pids) {
  const inodes = new Set();
  let netUnreadable = 0;
  for (const pid of [process.pid, ...pids]) {
    for (const file of ["net/tcp", "net/tcp6"]) {
      let text;
      const r = procRead(pid, () => fs.readFileSync(`/proc/${pid}/${file}`, "utf8"));
      if (!("value" in r)) { if (r.unreadable) netUnreadable++; continue; }
      text = r.value;
      for (const row of text.split("\n").slice(1)) {
        const f = row.trim().split(/\s+/);
        if (f.length > 9 && f[3] === "0A") inodes.add(Number(f[9]));
      }
    }
  }
  return { inodes, netUnreadable };
}
function socketInodes(pid) {
  const out = new Set();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    let target;
    try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); }
    catch (e) {
      if (vanished(e)) continue; // the entry vanished: closed meanwhile
      throw e; // EACCES, EIO, ...: unknown descriptor, so the whole table is unreadable evidence
    }
    const m = /^socket:\[(\d+)\]$/.exec(target);
    if (m) out.add(Number(m[1]));
  }
  return out;
}
/** Count listeners held by `pids`; unreadable fd and net tables are counted, never skipped silently. */
function heldListeners(pids) {
  const { inodes: listening, netUnreadable } = listeningInodes(pids);
  let held = 0, sockets = 0, unreadable = 0, readable = 0;
  for (const pid of pids) {
    let mine;
    const r = procRead(pid, () => socketInodes(pid));
    if (!("value" in r)) { if (r.unreadable) unreadable++; continue; }
    mine = r.value;
    readable++; sockets += mine.size;
    for (const i of mine) if (listening.has(i)) held++;
  }
  return { processes: pids.length, readable, unreadable, netUnreadable, sockets, listeningInodesSeen: listening.size, held };
}
function findNamed(dir, name, depth = 0) {
  if (depth > 12) return 1;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === name) n++;
    if (e.isDirectory() && !e.isSymbolicLink()) n += findNamed(path.join(dir, e.name), name, depth + 1);
  }
  return n;
}

// --- sandboxed worker -------------------------------------------------------
const WORKER = String.raw`
import errno, json, resource, socket, sys
resource.setrlimit(resource.RLIMIT_FSIZE, (32768, 32768)); resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
port = int(sys.argv[1])
out = {"connect": None, "status": None}
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(3)
try:
    s.connect(("127.0.0.1", port)); out["connect"] = "connected"
    s.sendall(("GET / HTTP/1.0\r\nHost: 127.0.0.1:%d\r\n\r\n" % port).encode())
    line = s.recv(256).split(b"\r\n", 1)[0].split()
    out["status"] = int(line[1]) if len(line) > 1 and line[0].startswith(b"HTTP/") else "malformed"
except OSError as e:
    if out["connect"] is None: out["connect"] = errno.errorcode.get(e.errno, type(e).__name__) if e.errno else type(e).__name__
    else: out["status"] = type(e).__name__
finally: s.close()
print(json.dumps(out, sort_keys=True))
`;
function bwrapArgv(unshareNet) {
  const a = [BWRAP, "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session", "--clearenv"];
  if (unshareNet) a.push("--unshare-net");
  a.push("--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib");
  if (fs.existsSync("/lib64")) a.push("--ro-bind", "/lib64", "/lib64");
  return [...a, "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"];
}
function runSandboxed(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: {}, timeout: 30000, maxBuffer: MAX });
  return r;
}
// Asynchronous: the listener lives on this event loop and must keep answering.
function runWorker(unshareNet, port) {
  const argv = [...bwrapArgv(unshareNet), "--", PYTHON, "-I", "-c", WORKER, String(port)];
  const label = unshareNet ? "agent" : "shared-net";
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "ignore"], env: {} });
    let out = Buffer.alloc(0);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (c) => { out = Buffer.concat([out, c]); if (out.length > MAX) child.kill("SIGKILL"); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`${label} worker failed: ${e.code ?? "spawn"}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || out.length > MAX) return reject(new Error(`${label} worker failed`));
      try { resolve(JSON.parse(out.toString("utf8"))); } catch { reject(new Error(`${label} worker output malformed`)); }
    });
  });
}



// --- supervised run ---------------------------------------------------------
const result = { ok: false, strictState: "unverified", code: "unsupported" };
const state = { exitCode: 2, scratch: null, listener: null, display: null, launches: [], aborted: null, cleanupOk: true, binary: null };
const failures = [];
// After an abort the abandoned run may still resolve in the background: it records nothing more.
const expect = (ok, what) => { if (!ok && !state.aborted) failures.push(what); };
// Every message that can reach stdout is a fixed label: never a path or token.
class Fail extends Error {
  constructor(label, unsupported = false, code = "unsupported") { super(label); this.label = label; this.unsupported = unsupported; this.code = code; }
}
const labelOf = (e) => e instanceof Fail ? e.label : /^E[A-Z]+$/.test(e?.code ?? "") ? `unexpected-error:${e.code}` : "unexpected-error";

let abortResolve;
const aborted = new Promise((r) => { abortResolve = r; });
function abort(reason) { if (state.aborted) return; state.aborted = reason; abortResolve(); }
const guard = () => { if (state.aborted) throw new Fail("aborted"); };
// Test-only hooks (each labelled in the output; a run using one never passes):
// SKEL_C20_TEST_ANNOUNCE_LAUNCH=1 writes a stderr marker once the primary browser is up (signal test);
// SKEL_C20_TEST_MUTATION=debugging-then-kill adds a debugging port to the primary run and SIGKILLs it after 3 samples;
// SKEL_C20_TEST_MUTATION=sandbox-blocked runs the primary browser where user namespaces are disabled;
// SKEL_C20_TEST_BROWSER=<file> replaces the resolved browser binary (pin-refusal test).
const ANNOUNCE = process.env.SKEL_C20_TEST_ANNOUNCE_LAUNCH === "1";
const MUTATION = ["debugging-then-kill", "sandbox-blocked"].includes(process.env.SKEL_C20_TEST_MUTATION) ? process.env.SKEL_C20_TEST_MUTATION : null;
const TEST_BROWSER = process.env.SKEL_C20_TEST_BROWSER || null;

async function stopOwned() {
  // Our direct children only: the browsers, and helpers the kernel reparented to us.
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const kids = childPids();
    if (!kids.length) return true;
    const sig = Date.now() - started < 2000 ? "SIGTERM" : "SIGKILL";
    for (const pid of kids) {
      if (stat(pid)?.ppid !== process.pid) continue; // re-check just before signalling
      try { process.kill(pid, sig); } catch { /* exited meanwhile */ }
    }
    await sleep(100);
  }
  return childPids().length === 0;
}
const bounded = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);

/** The ELF binary we execute (a wrapper script is resolved to its sibling `chrome`), and its SHA-256. */
function sha256File(file) {
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), chunk = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
function resolveBrowser() {
  if (TEST_BROWSER) {
    const real = fs.realpathSync(TEST_BROWSER);
    if (!fs.statSync(real).isFile()) throw new Fail("test-browser-not-a-file", true);
    return { label: "test-override", binary: real, sha256: sha256File(real) };
  }
  const isElf = (p) => { try { const fd = fs.openSync(p, "r"); try { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); return b.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); } finally { fs.closeSync(fd); } } catch { return false; } };
  for (const c of CANDIDATES) {
    if (!fs.existsSync(c)) continue;
    let real = fs.realpathSync(c);
    if (!isElf(real)) { const sib = path.join(path.dirname(real), "chrome"); if (!isElf(sib)) continue; real = fs.realpathSync(sib); }
    return { label: path.basename(c), binary: real, sha256: sha256File(real) };
  }
  throw new Fail("no-elf-browser-binary", true);
}

/** A fresh, owned, 0700 browser data directory per launch; an existing path is refused. */
function makeDataDir(name) {
  guard();
  const dir = path.join(state.scratch, name);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { throw new Fail(e.code === "EEXIST" ? "browser-data-directory-exists" : "browser-data-directory-mkdir-failed"); }
  fs.chmodSync(dir, 0o700);
  const st = fs.lstatSync(dir);
  const real = fs.realpathSync(dir);
  const home = os.homedir();
  const defaults = [".config/google-chrome", ".config/google-chrome-beta", ".config/chromium", "snap/chromium"].map((d) => path.join(home, d));
  const check = {
    fresh: fs.readdirSync(dir).length === 0,
    directory: st.isDirectory() && !st.isSymbolicLink(),
    ownedByUs: st.uid === process.getuid(),
    mode: (st.mode & 0o777).toString(8).padStart(4, "0"),
    notDefault: real === dir && !defaults.some((d) => real === d || real.startsWith(d + path.sep)) && !real.startsWith(home + path.sep),
  };
  if (!(check.fresh && check.directory && check.ownedByUs && check.mode === "0700" && check.notDefault)) throw new Fail("browser-data-directory-checks-failed");
  return { dir, check };
}

/** Headless, Chrome's default sandbox (never --no-sandbox), own session, no display variables. */
function launch(name, args, { primary = false, display = null } = {}) {
  const { dir, check } = makeDataDir(name);
  guard();
  const env = { HOME: state.scratch, PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "disabled:", ...display?.environment };
  let argv = [state.binary, display ? "--ozone-platform=x11" : "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", `--user-data-dir=${dir}`, ...args];
  if (primary && MUTATION === "sandbox-blocked") // test only: no user namespaces, so Chrome's sandbox can't start
    argv = [BWRAP, "--unshare-user", "--disable-userns", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/",
      "--dev", "/dev", "--proc", "/proc", "--bind", state.scratch, state.scratch, "--", ...argv];
  const proc = spawn(argv[0], argv.slice(1), { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
  const rec = { proc, pid: proc.pid, dir, check, primary, display, out: Buffer.alloc(0), err: Buffer.alloc(0), overflow: false, exit: null };
  state.launches.push(rec);
  rec.exited = new Promise((r) => {
    proc.on("error", () => { rec.exit = { code: null, signal: null, error: true }; r(); });
    proc.on("exit", (code, signal) => { rec.exit = { code, signal }; r(); });
  });
  proc.stdout.on("data", (c) => { if (rec.out.length + c.length > 8 * MAX * 64) rec.overflow = true; else rec.out = Buffer.concat([rec.out, c]); });
  // stderr is kept bounded and only matched against Chrome's sandbox failure text; it never reaches stdout.
  proc.stderr.on("data", (c) => { if (rec.err.length < 65536) rec.err = Buffer.concat([rec.err, c.subarray(0, 65536 - rec.err.length)]); });
  return rec;
}

const userNs = (p) => { try { return fs.readlinkSync(`/proc/${p}/ns/user`); } catch { return null; } };
const seccomp = (p) => { try { return /^Seccomp:\s*(\d)/m.exec(fs.readFileSync(`/proc/${p}/status`, "utf8"))?.[1] ?? null; } catch { return null; } };
// If this /proc doesn't expose namespace and seccomp state, sandbox evidence is
// "unavailable" and the run refuses (exit 2) rather than passing without it.
const SANDBOX_EVIDENCE = userNs("self") && seccomp("self") !== null ? "measured" : "unavailable";
const exeOf = (p) => { try { return fs.readlinkSync(`/proc/${p}/exe`); } catch { return null; } };
/** A boundary Chrome itself added: the process and its parent both run the pinned binary,
 *  and the process is in a different user namespace from its parent, or is seccomp-filtered
 *  while its parent isn't. A wrapper's namespace (e.g. bwrap) is never counted. */
function addedBoundary(p) {
  const parent = stat(p)?.ppid;
  if (!parent || exeOf(p) !== state.binary || exeOf(parent) !== state.binary) return false;
  const ns = userNs(p), pns = userNs(parent), sc = seccomp(p), psc = seccomp(parent);
  return (ns !== null && pns !== null && ns !== pns) || (sc === "2" && psc !== null && psc !== "2");
}
/** One sample; the same check for the real browser and the debugging-port negative control. */
function debuggingCheck(rec) {
  const pids = browserPids(rec.pid, rec.dir);
  let debuggingFlag = 0, cmdlineUnreadable = 0;
  for (const p of pids) {
    const command = procRead(p, () => fs.readFileSync(`/proc/${p}/cmdline`, "utf8"));
    if (!("value" in command)) { if (command.unreadable) cmdlineUnreadable++; continue; }
    if (/--remote-debugging/.test(command.value)) debuggingFlag++;
  }
  return { ...heldListeners(pids), devToolsActivePort: findNamed(rec.dir, "DevToolsActivePort"), debuggingFlag, cmdlineUnreadable,
    sandboxed: SANDBOX_EVIDENCE === "measured" ? pids.filter(addedBoundary).length : null };
}

/** The sampling loop: about every 50 ms plus scan time, until the --dump-dom browser exits.
 *  `window` bounds the sample for the windowed run and the debugging control,
 *  which keep Chrome running until the probe stops it. */
async function sampleRun(rec, { window = null } = {}) {
  const agg = { samples: 0, samplesWithBrowser: 0, samplesWithHeld: 0, samplesWithDevToolsActivePort: 0, samplesWithSwitch: 0,
    maxProcesses: 0, maxSockets: 0, held: 0, unreadable: 0, netUnreadable: 0, cmdlineUnreadable: 0,
    devToolsActivePort: 0, debuggingFlag: 0, maxSandboxed: SANDBOX_EVIDENCE === "measured" ? 0 : null,
    ownSession: false, exePinned: false, displayVariable: false, privateDisplayMatched: false };
  let announced = false, killed = false;
  const started = Date.now(), deadline = started + (window ?? 60000);
  while (rec.exit === null && Date.now() < deadline) {
    guard();
    const c = debuggingCheck(rec);
    const browser = stat(rec.pid);
    const browserRunning = rec.exit === null && live(browser);
    const browserSampled = rec.display ? browserRunning : c.processes > 0;
    agg.samples++;
    if (browserSampled) agg.samplesWithBrowser++;
    if (c.held > 0) agg.samplesWithHeld++;
    if (c.devToolsActivePort > 0) agg.samplesWithDevToolsActivePort++;
    if (c.debuggingFlag > 0) agg.samplesWithSwitch++;
    agg.maxProcesses = Math.max(agg.maxProcesses, c.processes); agg.maxSockets = Math.max(agg.maxSockets, c.sockets);
    agg.held += c.held; agg.unreadable += c.unreadable; agg.netUnreadable += c.netUnreadable; agg.cmdlineUnreadable += c.cmdlineUnreadable;
    agg.devToolsActivePort = Math.max(agg.devToolsActivePort, c.devToolsActivePort);
    agg.debuggingFlag = Math.max(agg.debuggingFlag, c.debuggingFlag);
    if (c.sandboxed !== null) agg.maxSandboxed = Math.max(agg.maxSandboxed, c.sandboxed);
    if (browserRunning) {
      agg.ownSession ||= browser.sid === rec.pid;
      try { agg.exePinned ||= fs.readlinkSync(`/proc/${rec.pid}/exe`) === state.binary; } catch { /* exited */ }
      try {
        const env = fs.readFileSync(`/proc/${rec.pid}/environ`, "utf8").split("\0");
        const keys = env.map((kv) => kv.split("=")[0]);
        agg.displayVariable ||= keys.some((k) => ["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"].includes(k)
          || (!rec.display && ["DISPLAY", "XAUTHORITY"].includes(k)));
        if (rec.display) agg.privateDisplayMatched ||= Object.entries(rec.display.environment).every(([key, value]) => env.includes(`${key}=${value}`));
      } catch { /* exited */ }
    }
    if (rec.primary && ANNOUNCE && !announced && browserSampled) { announced = true; process.stderr.write("probe: browser launched\n"); }
    if (rec.primary && MUTATION === "debugging-then-kill" && !killed && agg.samplesWithBrowser >= 3) {
      killed = true; try { rec.proc.kill("SIGKILL"); } catch { /* exited */ }
    }
    await sleep(50);
  }
  guard();
  if (rec.exit === null && window === null) throw new Fail("dump-dom-timeout");
  const after = findNamed(rec.dir, "DevToolsActivePort");
  agg.devToolsActivePort = Math.max(agg.devToolsActivePort, after);
  agg.browserExit = rec.exit ? { code: rec.exit.code, signal: rec.exit.signal } : "running-at-window-end";
  return agg;
}

const SANDBOX_TEXT = /(FATAL|ERROR)[^\n]*(sandbox|zygote)/i;
const statusOf = (dom) => /<p id="status"[^>]*>([^<]*)<\/p>/.exec(dom)?.[1] ?? "";

function conclude(code) {
  guard();
  if (MUTATION || ANNOUNCE) failures.push("test-hook-active");
  if (!failures.length) { state.exitCode = 0; result.ok = true; result.code = code; }
}

async function run(pin) {
  if (ANNOUNCE) result.testLaunchAnnouncement = true;
  if (MUTATION) result.testMutation = MUTATION;
  if (TEST_BROWSER) result.testBrowserOverride = true;
  // Pin first: compared right after the digest, before the binary is ever run.
  const b = resolveBrowser();
  result.browser = { label: b.label, sha256: b.sha256, pinRequested: !!pin, pinMatched: pin ? pin === b.sha256 : null };
  if (pin && pin !== b.sha256) throw new Fail("browser-pin-mismatch", true, "browser-pin-mismatch");
  if (TEST_BROWSER) throw new Fail("test-browser-override-mismatch-only", true, "test-browser-override-mismatch-only");
  state.binary = b.binary;
  if (SANDBOX_EVIDENCE !== "measured") throw new Fail("sandbox-evidence-unavailable", true, "sandbox-evidence-unavailable");

  // Preconditions (unsupported until the browser is up).
  if (childPids().length) throw new Fail("probe-started-with-children", true);
  const probe = spawnSync(PYTHON, ["-I", "-c", "import os,sys,time\npid=os.fork()\nif pid==0:\n time.sleep(20)\n os._exit(0)\nprint(pid)"],
    { stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  const orphan = Number(probe.stdout?.toString().trim());
  await sleep(100);
  const reparented = Number.isInteger(orphan) && stat(orphan)?.ppid === process.pid;
  if (reparented) process.kill(orphan, "SIGKILL");
  if (!reparented) throw new Fail("child-subreaper-not-effective", true);
  if (runSandboxed([...bwrapArgv(true), "--", "/usr/bin/true"]).status !== 0) throw new Fail("bubblewrap-cannot-start", true);

  let version = "";
  try { version = spawnSync(b.binary, ["--version"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10000, maxBuffer: 4096 }).stdout.toString().trim().slice(0, 64); } catch { /* recorded empty */ }
  result.browser.version = version;

  state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  fs.chmodSync(state.scratch, 0o700);
  if (privateDisplay) {
    const sha256 = sha256File(XVFB);
    try {
      state.display = startPrivateDisplay(state.scratch);
      await waitForPrivateDisplay(state.display);
    } catch (error) {
      throw new Fail(error instanceof PrivateDisplayError ? error.message : "private-display-start-failed", true, "display-unavailable");
    }
    guard();
    result.display = { fixture: "Xvfb", sha256, authenticated: true };
  }

  // Listener with a fixed fixture capture (as the listener browser probe builds it).
  const src = path.join(state.scratch, "src"); fs.mkdirSync(src, { mode: 0o700 });
  fs.writeFileSync(path.join(src, "a.js"),
    "const x = 1;\n// SKEL[1] <img src=x onerror=window.PWNED=1> step\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n");
  const fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let cap;
  try { cap = JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "a.js", mode: "fenced" }]))); } finally { fs.closeSync(fd); }
  const binding = { protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
    phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
    approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false };
  const log = [];
  state.listener = createDecisionListener({ provider: { read: () => ({ binding, capture: cap }) }, observe: (e) => log.push(e) });
  const { origin } = await state.listener.start();
  const port = Number(new URL(origin).port);

  // Primary evidence: a private window or a --dump-dom run, with no debugging switch.
  const beforeNav = log.length;
  const windowNavigation = state.listener.mintWindowNavigation(binding);
  const mutationArgs = MUTATION === "debugging-then-kill" ? ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] : [];
  const navigationArgs = privateDisplay ? ["--new-window", windowNavigation.url]
    : ["--virtual-time-budget=10000", "--dump-dom", windowNavigation.url];
  const main = launch("browser-data", [...mutationArgs, ...navigationArgs], { primary: true, display: state.display });
  state.exitCode = 1; result.code = "fixture-failed";
  result.dataDirectory = main.check;
  const agg = await sampleRun(main, privateDisplay ? { window: 4000 } : undefined);
  const dom = main.out.toString("utf8");
  const sandboxText = SANDBOX_TEXT.test(main.err.toString("utf8"));
  result.remoteDebugging = { mode: "off", evidence: privateDisplay ? "private display run" : "dump-dom run only",
    sampling: "about every 50 ms plus scan time, while the browser ran",
    sandboxEvidence: SANDBOX_EVIDENCE, stderrSandboxText: sandboxText, ...agg };
  // Classify only after the debugging evidence is recorded.
  const debugSeen = agg.held > 0 || agg.devToolsActivePort > 0 || agg.debuggingFlag > 0;
  const ranClean = privateDisplay ? main.exit === null : main.exit?.code === 0 && dom.length > 0 && !main.overflow;
  const tablesRead = agg.unreadable === 0 && agg.netUnreadable === 0 && agg.cmdlineUnreadable === 0; // else "no debugging" is unverified
  if (!ranClean && !debugSeen && tablesRead && Number.isInteger(main.exit?.code) && main.exit.code !== 0 && sandboxText && !dom.length)
    throw new Fail("browser-sandbox-unavailable", true, "browser-sandbox-unavailable");
  expect(agg.samplesWithBrowser >= 2, "browser not sampled at least twice while running");
  expect(agg.debuggingFlag === 0, "a browser process carries a remote-debugging switch");
  expect(agg.devToolsActivePort === 0, "DevToolsActivePort present");
  expect(agg.held === 0, "a browser process holds a TCP listener");
  expect(agg.unreadable === 0 && agg.netUnreadable === 0, "unreadable fd or net tables");
  expect(agg.cmdlineUnreadable === 0, "unverified browser command line");
  expect(agg.ownSession && agg.exePinned && !agg.displayVariable, "browser session, binary or environment unexpected");
  expect(agg.maxSandboxed >= 1, "no browser process added a sandbox boundary");
  if (!ranClean) throw new Fail("browser-run-failed");

  if (privateDisplay) {
    const mappedWindow = mappedBrowserWindow(state.display, main.pid);
    const selectedViewObserved = windowNavigation.takeView();
    expect(agg.privateDisplayMatched, "browser did not use the owned display environment");
    expect(mappedWindow && main.exit === null, "expected owned browser window is not mapped");
    expect(selectedViewObserved && !windowNavigation.takeView(), "missing or reusable selected listener view observation");
    result.window = { mappedWindow, selectedViewObserved };
    conclude("private-display-fixture-passed");
    return;
  }

  // Fixed positive rendering, from the dumped DOM.
  const served = log.slice(beforeNav);
  result.rendering = { capture: dom.includes("data-strict-capture"), status: statusOf(dom).slice(0, 80),
    imgInView: /<img/i.test(dom.split('id="view"')[1] ?? ""), hostileTitleAsText: dom.includes("&lt;img src=x onerror"),
    bindOk: served.some((e) => e.url === "/api/bind" && e.status === 200),
    viewOk: served.some((e) => e.url === "/api/view" && e.status === 200), listenerRequests: served.length };
  expect(result.rendering.capture, "dumped DOM has no capture view");
  expect(/Showing stored capture/.test(result.rendering.status), "status does not say showing");
  expect(!result.rendering.imgInView && result.rendering.hostileTitleAsText, "hostile title not rendered as text");
  expect(result.rendering.bindOk && result.rendering.viewOk, "listener did not serve bind and view");
  result.rendering.selectedViewObserved = windowNavigation.takeView();
  expect(result.rendering.selectedViewObserved && !windowNavigation.takeView(), "missing or reusable selected listener view observation");
  if (!(await stopOwned())) state.cleanupOk = false;
  expect(sessionPids(main.pid).length === 0, "dump-dom browser session survived");

  // Agent-side control and its positive control.
  const beforeAgent = log.length;
  const agent = await runWorker(true, port);
  const agentReached = log.length - beforeAgent;
  const shared = await runWorker(false, port);
  const sharedReached = log.length - beforeAgent - agentReached;
  result.agent = { netUnshared: agent, listenerRequests: agentReached };
  result.positiveControl = { sharedNet: shared, listenerRequests: sharedReached };
  expect(agent.connect === "ECONNREFUSED" && agent.status === null && agentReached === 0, "agent reached the listener");
  expect(shared.connect === "connected" && Number.isInteger(shared.status) && sharedReached >= 1, "shared-net control did not reach the listener");
  guard();

  // Negative control: the same --dump-dom run WITH a loopback debugging port,
  // in its own fresh directory, through the same sampling loop. Nothing connects to the port.
  if (!(await stopOwned()) || childPids().length || sessionPids(main.pid).length || namingPids(state.scratch).length)
    throw new Fail("primary-browser-cleanup-unproven");
  guard();
  result.primaryChildrenStoppedBeforeControl = true;
  const ctrl = launch("control-data", ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--virtual-time-budget=10000", "--dump-dom", state.listener.mintNavigation()]);
  const control = await sampleRun(ctrl, { window: 4000 });
  result.negativeControl = { dataDirectoryFresh: ctrl.check.fresh && ctrl.check.mode === "0700", ...control };
  expect(control.samplesWithHeld >= 1, "negative control: no sample found its debugging listener held");
  expect(control.samplesWithDevToolsActivePort >= 1, "negative control: no sample found DevToolsActivePort");
  expect(control.samplesWithSwitch >= 1, "negative control: no sample found the debugging switch");
  expect(control.unreadable === 0 && control.netUnreadable === 0 && control.cmdlineUnreadable === 0, "negative control: unreadable tables");
  if (!(await stopOwned())) state.cleanupOk = false;
  expect(sessionPids(ctrl.pid).length === 0, "control browser session survived");

  conclude("fresh-browser-data-fixture-passed");
}

/** One cleanup for normal exit, failure, signal and watchdog. */
async function cleanup() {
  const c = {};
  if (state.listener) await bounded(state.listener.close(), 3000);
  if (state.launches.length || state.scratch) {
    if (!(await stopOwned())) state.cleanupOk = false;
    await sleep(200);
    c.sessionLeft = state.launches.reduce((n, r) => n + (r.pid ? sessionPids(r.pid).length : 0), 0);
    c.childrenLeft = childPids().length;
    c.namingDataDirLeft = state.launches.reduce((n, r) => n + namingPids(r.dir).length, 0);
    c.namingScratchLeft = state.scratch ? namingPids(state.scratch).length : 0;
    if (state.display) c.displaySocketLeft = displaySocketPresent(state.display);
    if (c.sessionLeft || c.childrenLeft || c.namingDataDirLeft || c.namingScratchLeft || c.displaySocketLeft) state.cleanupOk = false;
  }
  // Remove only after the proof: on a pass, an unsupported run, or an interrupted one.
  if (state.scratch && state.cleanupOk && (failures.length === 0 || state.aborted)) {
    try {
      if (path.dirname(state.scratch) !== os.tmpdir() || !path.basename(state.scratch).startsWith(PREFIX) || fs.lstatSync(state.scratch).isSymbolicLink()) throw new Fail("scratch");
      fs.rmSync(state.scratch, { recursive: true, maxRetries: 5 });
      c.removed = !fs.existsSync(state.scratch);
      if (!c.removed) state.cleanupOk = false;
    } catch { state.cleanupOk = false; }
  }
  return c;
}

if (supervised) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => abort(`signal-${sig}`));
  const watchdog = setTimeout(() => abort("watchdog"), 150000);
  const pin = pinArgs[0] === "--chrome-sha256" ? pinArgs[1] : null;
  const running = run(pin);
  running.catch(() => {}); // after an abort it may still reject; the race below already settled
  try {
    await Promise.race([running, aborted]);
  } catch (e) {
    if (e?.unsupported && !state.aborted) { state.exitCode = 2; result.code = e.code; result.reason = labelOf(e); }
    else if (!state.aborted) { state.exitCode = 1; failures.push(labelOf(e)); }
  }
  clearTimeout(watchdog);
  const cleanupResult = await cleanup();
  // Finalized after cleanup, so a signal during cleanup still ends ok:false, exit 1.
  if (state.aborted) { state.exitCode = 1; result.ok = false; failures.push(state.aborted); }
  if (failures.length) {
    state.exitCode = 1; result.ok = false; result.failures = failures.slice(0, 12);
    result.code = state.aborted ? (state.aborted === "watchdog" ? "watchdog-aborted" : "interrupted")
      : failures.includes("browser-run-failed") ? "browser-run-failed" : "fixture-failed";
  }
  if (!state.cleanupOk) { state.exitCode = 1; result.ok = false; result.code = "cleanup-failed"; }
  result.cleanup = cleanupResult;
  if (state.exitCode === 1 && state.scratch && fs.existsSync(state.scratch)) { result.retainedScratch = true; process.stderr.write(`retained scratch: ${state.scratch}\n`); }
  result.node = process.version;
  result.limitations = privateDisplay ? ["windowed Chromium on an owned Xvfb display; human desktop acceptance remains open",
    "selected listener view and mapped browser window; no DOM verification in this mode",
    "TCP listeners sampled; broader automation paths and runtime support remain open"] : ["no-debugging evidence comes from the --dump-dom run only; no CDP or pipe is used",
    "one fixture-owned headless browser, not the human's window",
    "agent control is network-namespace only; an agent-started browser is not launched",
    "TCP listeners only, sampled about every 50 ms plus scan time; a listener that exists only between samples is missed",
    "Unix-domain and abstract automation sockets are not measured",
    "the pin covers the chrome ELF only, not bundled libraries or crashpad", "measured host only"];
  finish(result, state.exitCode);
}
