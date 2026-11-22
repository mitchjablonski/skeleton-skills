// Shared harness for the opt-in C20 browser fixtures (#77 / #79):
//   test/live/strict-fresh-profile-probe.mjs  (fresh browser data directory, debugging off)
//   test/live/strict-agent-browser-probe.mjs  (an agent-started debugging browser never gets the page)
// Not part of `npm test` (needs Linux, Chrome, Bubblewrap and system Python).
//
// It provides the supervised-run shell (child subreaper shim, signal
// forwarding, watchdog, cleanup proof, bounded JSON with fixed labels), the
// browser pin, fresh data directories, headless launches with no display
// variables, and the per-launch debugging sampler. Every browser it starts is
// tracked so the cleanup proof covers all of them. Signals go only to the
// probe's own direct children, rechecked by parent pid just before each one.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";

export const MAX = 32768;
export const CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
export const PYTHON = "/usr/bin/python3";
export const BWRAP = "/usr/bin/bwrap";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const bounded = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);

const unsupported = (reason, code = "unsupported") => ({ ok: false, strictState: "unverified", code, reason });
export function finish(result, exitCode) {
  const line = JSON.stringify(result);
  process.stdout.write((line.length <= MAX * 2 ? line : JSON.stringify({ ok: false, code: "fixture-failed", reason: "result too large" })) + "\n");
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
/** Outer process. Signals and the overall timeout are forwarded so the inner run
 *  cleans up; SIGKILL only after a grace period, and only to the inner process. */
export function runOuter(self) {
  const args = process.argv.slice(2);
  const pinOk = args.length === 0 || (args.length === 2 && args[0] === "--chrome-sha256" && /^[0-9a-f]{64}$/i.test(args[1]));
  if (!pinOk) finish(unsupported("unexpected arguments"), 2);
  if (process.platform !== "linux") finish(unsupported("not Linux"), 2);
  if (!CANDIDATES.some((c) => fs.existsSync(c))) finish(unsupported("no Chrome or Chromium"), 2);
  if (!fs.existsSync(BWRAP)) finish(unsupported("no /usr/bin/bwrap"), 2);
  if (!fs.existsSync(PYTHON)) finish(unsupported("no /usr/bin/python3"), 2);
  const inner = spawn(PYTHON, ["-I", "-c", SHIM, process.execPath, self, "--supervised", ...args.map((a) => a.toLowerCase())],
    { stdio: ["ignore", "pipe", "inherit"] });
  let buf = Buffer.alloc(0), hard = null;
  inner.stdout.on("data", (c) => { if (buf.length <= MAX * 4) buf = Buffer.concat([buf, c]); });
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
export function readStat(pid) {
  const data = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = data.lastIndexOf(")");
  const f = data.slice(end + 2).split(" ");
  if (end < 0 || !/^[A-Z]$/i.test(f[0]) || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[3]))
    throw new Error("malformed process status");
  return { state: f[0], ppid: Number(f[1]), sid: Number(f[3]) };
}
export function stat(pid) { try { return readStat(pid); } catch { return null; } }
const vanished = (e) => e.code === "ENOENT" || e.code === "ESRCH";
export const allPids = () => fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
export const live = (s) => s && s.state !== "Z" && s.state !== "X";
export const sessionPids = (sid) => allPids().filter((p) => { const s = stat(p); return live(s) && s.sid === sid; });
export const childPids = () => allPids().filter((p) => { const s = stat(p); return live(s) && s.ppid === process.pid; });
function readCmdline(p) {
  const fd = fs.openSync(`/proc/${p}/cmdline`, "r");
  try { const b = Buffer.alloc(1 << 16); const n = fs.readSync(fd, b, 0, b.length, 0); return b.subarray(0, n); } finally { fs.closeSync(fd); }
}
/** Corroborating only: a command line naming a path never authorizes a signal. */
export function namingPids(needle) {
  const out = [];
  for (const p of allPids()) {
    if (p === process.pid) continue;
    try { if (readCmdline(p).includes(needle) && live(stat(p))) out.push(p); } catch { /* gone or unreadable */ }
  }
  return out;
}
/** Processes with exactly `--user-data-dir=<dir>` as one whole argv element (no prefix collisions). */
export function userDataDirPids(dir) {
  const want = `--user-data-dir=${dir}`;
  const out = [];
  for (const p of allPids()) {
    if (p === process.pid) continue;
    try { if (readCmdline(p).toString("utf8").split("\0").includes(want) && live(stat(p))) out.push(p); } catch { /* gone or unreadable */ }
  }
  return out;
}
export function descendants(root) {
  const kids = new Map();
  for (const p of allPids()) { const s = stat(p); if (live(s)) kids.set(s.ppid, [...(kids.get(s.ppid) ?? []), p]); }
  const out = [], stack = [root];
  while (stack.length) { const p = stack.pop(); for (const c of kids.get(p) ?? []) { out.push(c); stack.push(c); } }
  return out;
}
/** A /proc read of a live process; a process that is exiting (fd table already
 *  released) is retried once after 25 ms and then skipped only if no longer live. */
export function procRead(pid, fn) {
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
      const r = procRead(pid, () => fs.readFileSync(`/proc/${pid}/${file}`, "utf8"));
      if (!("value" in r)) { if (r.unreadable) netUnreadable++; continue; }
      for (const row of r.value.split("\n").slice(1)) {
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
/** Inodes of 127.0.0.1:<port> TCP listeners in the network namespace seen through `pid`, or null if unreadable. */
function loopbackListenerInodes(pid, port) {
  const want = "0100007F:" + port.toString(16).toUpperCase().padStart(4, "0");
  const r = procRead(pid, () => fs.readFileSync(`/proc/${pid}/net/tcp`, "utf8"));
  if (!("value" in r)) return null;
  const out = new Set();
  for (const row of r.value.split("\n").slice(1)) {
    const f = row.trim().split(/\s+/);
    if (f.length > 9 && f[1] === want && f[3] === "0A") out.add(Number(f[9]));
  }
  return out;
}
/** Count listeners held by `pids`; unreadable fd and net tables are counted, never skipped silently. */
export function heldListeners(pids) {
  const { inodes: listening, netUnreadable } = listeningInodes(pids);
  let held = 0, sockets = 0, unreadable = 0, readable = 0;
  for (const pid of pids) {
    const r = procRead(pid, () => socketInodes(pid));
    if (!("value" in r)) { if (r.unreadable) unreadable++; continue; }
    readable++; sockets += r.value.size;
    for (const i of r.value) if (listening.has(i)) held++;
  }
  return { processes: pids.length, readable, unreadable, netUnreadable, sockets, listeningInodesSeen: listening.size, held };
}
/** Files named `name` under `dir`, skipping the directories in `exclude`. */
export function findNamed(dir, name, exclude = new Set(), depth = 0) {
  if (depth > 12) return 1;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (exclude.has(full)) continue;
    if (e.name === name) n++;
    if (e.isDirectory() && !e.isSymbolicLink()) n += findNamed(full, name, exclude, depth + 1);
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
export function bwrapArgv(unshareNet) {
  const a = [BWRAP, "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session", "--clearenv"];
  if (unshareNet) a.push("--unshare-net");
  a.push("--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib");
  if (fs.existsSync("/lib64")) a.push("--ro-bind", "/lib64", "/lib64");
  return [...a, "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"];
}
export function runSandboxed(argv) {
  return spawnSync(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: {}, timeout: 30000, maxBuffer: MAX });
}
/** Asynchronous: the listener lives on this event loop and must keep answering. */
export function runWorker(unshareNet, port) {
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

// --- labels, pin and sandbox evidence ---------------------------------------
/** Every message that can reach stdout is a fixed label: never a path or token. */
export class Fail extends Error {
  constructor(label, unsupported = false, code = "unsupported") { super(label); this.label = label; this.unsupported = unsupported; this.code = code; }
}
export const labelOf = (e) => e instanceof Fail ? e.label : /^E[A-Z]+$/.test(e?.code ?? "") ? `unexpected-error:${e.code}` : "unexpected-error";

function sha256File(file) {
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), chunk = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
/** The ELF binary we execute (a wrapper script is resolved to its sibling `chrome`), and its SHA-256. */
function resolveBrowser(testBrowser) {
  if (testBrowser) {
    const real = fs.realpathSync(testBrowser);
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

const userNs = (p) => { try { return fs.readlinkSync(`/proc/${p}/ns/user`); } catch { return null; } };
const seccomp = (p) => { try { return /^Seccomp:\s*(\d)/m.exec(fs.readFileSync(`/proc/${p}/status`, "utf8"))?.[1] ?? null; } catch { return null; } };
// If this /proc doesn't expose namespace and seccomp state, sandbox evidence is
// "unavailable" and the run refuses (exit 2) rather than passing without it.
export const SANDBOX_EVIDENCE = userNs("self") && seccomp("self") !== null ? "measured" : "unavailable";
const exeOf = (p) => { try { return fs.readlinkSync(`/proc/${p}/exe`); } catch { return null; } };
/** A boundary Chrome itself added: the process and its parent both run the pinned binary,
 *  and the process is in a different user namespace from its parent, or is seccomp-filtered
 *  while its parent isn't. A wrapper's namespace (e.g. bwrap) is never counted. */
function addedBoundary(p, binary) {
  const parent = stat(p)?.ppid;
  if (!parent || exeOf(p) !== binary || exeOf(parent) !== binary) return false;
  const ns = userNs(p), pns = userNs(parent), sc = seccomp(p), psc = seccomp(parent);
  return (ns !== null && pns !== null && ns !== pns) || (sc === "2" && psc !== null && psc !== "2");
}

export const SANDBOX_TEXT = /(FATAL|ERROR)[^\n]*(sandbox|zygote)/i;
export const statusOf = (dom) => /<p id="status"[^>]*>([^<]*)<\/p>/.exec(dom)?.[1] ?? "";

/** The fixed fixture capture both probes render (the listener browser probe's hostile-title file). */
export function buildFixtureCapture(scratch) {
  const src = path.join(scratch, "src"); fs.mkdirSync(src, { mode: 0o700 });
  fs.writeFileSync(path.join(src, "a.js"),
    "const x = 1;\n// SKEL[1] <img src=x onerror=window.PWNED=1> step\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n");
  const fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let cap;
  try { cap = JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "a.js", mode: "fenced" }]))); } finally { fs.closeSync(fd); }
  const binding = { protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
    phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
    approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false };
  return { cap, binding };
}

/** The fixed positive rendering, from a dumped DOM and the listener requests served meanwhile. */
export function renderingOf(dom, served) {
  return { capture: dom.includes("data-strict-capture"), status: statusOf(dom).slice(0, 80),
    imgInView: /<img/i.test(dom.split('id="view"')[1] ?? ""), hostileTitleAsText: dom.includes("&lt;img src=x onerror"),
    bindOk: served.some((e) => e.url === "/api/bind" && e.status === 200),
    viewOk: served.some((e) => e.url === "/api/view" && e.status === 200), listenerRequests: served.length };
}

// --- the stateful fixture ---------------------------------------------------
/**
 * One supervised fixture run. `prefix` names the scratch root under the temp
 * directory. Test hooks (labelled in the output by the caller):
 * SKEL_C20_TEST_ANNOUNCE_LAUNCH=1 writes a stderr marker once the primary browser is up.
 */
export function createFixture({ prefix }) {
  const result = { ok: false, strictState: "unverified", code: "unsupported" };
  const state = { exitCode: 2, scratch: null, listener: null, launches: [], aborted: null, cleanupOk: true, binary: null };
  const failures = [];
  // After an abort the abandoned run may still resolve in the background: it records nothing more.
  const expect = (ok, what) => { if (!ok && !state.aborted) failures.push(what); };
  let abortResolve;
  const aborted = new Promise((r) => { abortResolve = r; });
  const abort = (reason) => { if (state.aborted) return; state.aborted = reason; abortResolve(); };
  const guard = () => { if (state.aborted) throw new Fail("aborted"); };
  const ANNOUNCE = process.env.SKEL_C20_TEST_ANNOUNCE_LAUNCH === "1";

  /** The processes that are certainly this launch's: its session, tree, those with exactly its
   *  --user-data-dir argument, and crash handlers they reference by --crashpad-handler-pid. */
  function corePids(rec) {
    if (!rec.pid) return new Set();
    const set = new Set([...sessionPids(rec.pid), ...descendants(rec.pid), ...userDataDirPids(rec.dir)]);
    if (live(stat(rec.pid))) set.add(rec.pid);
    for (const p of [...set]) {
      try { const m = /--crashpad-handler-pid=(\d+)/.exec(readCmdline(p).toString("latin1")); if (m && live(stat(Number(m[1])))) set.add(Number(m[1])); } catch { /* gone */ }
    }
    set.delete(process.pid);
    return set;
  }
  /** Every live process attributable to this launch: its core, plus our children (reparented
   *  helpers) that no other running launch accounts for. */
  function browserPids(rec) {
    const set = corePids(rec);
    const others = new Set();
    for (const o of state.launches) if (o !== rec && o.exit === null) for (const p of corePids(o)) others.add(p);
    for (const p of childPids()) if (!others.has(p)) set.add(p);
    for (const p of others) set.delete(p);
    return [...set];
  }

  /** Is 127.0.0.1:<port> a listening socket held by a process of exactly this launch?
   *  The same socket-inode method as the sampler; anything unreadable is "not proven". */
  function portOwnedBy(rec, port) {
    if (rec.exit !== null || !live(stat(rec.pid))) return { owned: false, reason: "browser-exited" };
    const inodes = loopbackListenerInodes(rec.pid, port);
    if (inodes === null) return { owned: false, reason: "net-table-unreadable" };
    if (!inodes.size) return { owned: false, reason: "no-loopback-listener" };
    for (const p of corePids(rec)) {
      const r = procRead(p, () => socketInodes(p));
      if ("value" in r && [...inodes].some((i) => r.value.has(i))) return { owned: true };
    }
    return { owned: false, reason: "listener-not-held-by-launch" };
  }

  /** Our direct children only, except those `keep` (a running launch) accounts for. */
  async function stopOwned(keep = null) {
    const started = Date.now();
    const targets = () => { const k = keep ? corePids(keep) : new Set(); return childPids().filter((p) => !k.has(p)); };
    while (Date.now() - started < 10000) {
      const kids = targets();
      if (!kids.length) return true;
      const sig = Date.now() - started < 2000 ? "SIGTERM" : "SIGKILL";
      for (const pid of kids) {
        if (stat(pid)?.ppid !== process.pid) continue; // re-check just before signalling
        try { process.kill(pid, sig); } catch { /* exited meanwhile */ }
      }
      await sleep(100);
    }
    return targets().length === 0;
  }

  /** Pin first: compared right after the digest, before the binary is ever run. */
  function pinBrowser(pin, testBrowser) {
    const b = resolveBrowser(testBrowser);
    result.browser = { label: b.label, sha256: b.sha256, pinRequested: !!pin, pinMatched: pin ? pin === b.sha256 : null };
    if (pin && pin !== b.sha256) throw new Fail("browser-pin-mismatch", true, "browser-pin-mismatch");
    if (testBrowser) throw new Fail("test-browser-override-mismatch-only", true, "test-browser-override-mismatch-only");
    state.binary = b.binary;
    if (SANDBOX_EVIDENCE !== "measured") throw new Fail("sandbox-evidence-unavailable", true, "sandbox-evidence-unavailable");
    return b;
  }

  /** Subreaper and Bubblewrap preconditions, then the browser version and the scratch root. */
  async function prepare() {
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
    try { version = spawnSync(state.binary, ["--version"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10000, maxBuffer: 4096 }).stdout.toString().trim().slice(0, 64); } catch { /* recorded empty */ }
    result.browser.version = version;
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.chmodSync(state.scratch, 0o700);
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

  /**
   * Headless, Chrome's default sandbox (never --no-sandbox), own session, no display variables,
   * HOME = the scratch root. `existingDir` reuses another launch's directory (singleton
   * handoff only); `wrap` prefixes the argv (test only).
   */
  function launch(name, args, { primary = false, existingDir = null, wrap = null } = {}) {
    const { dir, check } = existingDir ? { dir: existingDir, check: null } : makeDataDir(name);
    guard();
    const env = { HOME: state.scratch, PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "disabled:" };
    let argv = [state.binary, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", `--user-data-dir=${dir}`, ...args];
    if (wrap) argv = [...wrap, ...argv];
    const proc = spawn(argv[0], argv.slice(1), { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
    const rec = { name, proc, pid: proc.pid, dir, check, primary, out: Buffer.alloc(0), err: Buffer.alloc(0), overflow: false, exit: null };
    state.launches.push(rec);
    rec.exited = new Promise((r) => {
      proc.on("error", () => { rec.exit = { code: null, signal: null, error: true }; r(); });
      proc.on("exit", (code, signal) => { rec.exit = { code, signal }; r(); });
    });
    proc.stdout.on("data", (c) => { if (rec.out.length + c.length > 8 * MAX * 64) rec.overflow = true; else rec.out = Buffer.concat([rec.out, c]); });
    // stderr is kept bounded and only matched against fixed failure text; it never reaches stdout.
    proc.stderr.on("data", (c) => { if (rec.err.length < 65536) rec.err = Buffer.concat([rec.err, c.subarray(0, 65536 - rec.err.length)]); });
    return rec;
  }

  /** The other launches' directories: excluded from this launch's port-file scan of the scratch root. */
  const otherDirs = (rec) => new Set(state.launches.filter((o) => o.dir !== rec.dir).map((o) => o.dir));
  /** One sample: switches, port file (the scratch root, which is HOME, minus other launches'
   *  directories), held TCP listeners and sandbox boundaries for this launch's processes. */
  function debuggingCheck(rec) {
    const pids = browserPids(rec);
    let debuggingFlag = 0, cmdlineUnreadable = 0;
    for (const p of pids) {
      const command = procRead(p, () => fs.readFileSync(`/proc/${p}/cmdline`, "utf8"));
      if (!("value" in command)) { if (command.unreadable) cmdlineUnreadable++; continue; }
      if (/--remote-debugging/.test(command.value)) debuggingFlag++;
    }
    return { ...heldListeners(pids), devToolsActivePort: findNamed(state.scratch, "DevToolsActivePort", otherDirs(rec)), debuggingFlag, cmdlineUnreadable,
      sandboxed: SANDBOX_EVIDENCE === "measured" ? pids.filter((p) => addedBoundary(p, state.binary)).length : null };
  }

  /** The sampling loop: about every 50 ms plus scan time, until the --dump-dom browser exits.
   *  `window` ends sampling after that many ms instead (a debugging-port browser keeps running
   *  after the dump). `onSample(agg, sample)` is called after each sample. */
  async function sampleRun(rec, { window = null, onSample = null } = {}) {
    const agg = { samples: 0, samplesWithBrowser: 0, samplesWithHeld: 0, samplesWithDevToolsActivePort: 0, samplesWithSwitch: 0,
      maxProcesses: 0, maxSockets: 0, held: 0, unreadable: 0, netUnreadable: 0, cmdlineUnreadable: 0,
      devToolsActivePort: 0, debuggingFlag: 0, maxSandboxed: SANDBOX_EVIDENCE === "measured" ? 0 : null,
      ownSession: false, exePinned: false, displayVariable: false };
    let announced = false;
    const deadline = Date.now() + (window ?? 60000);
    while (rec.exit === null && Date.now() < deadline) {
      guard();
      const c = debuggingCheck(rec);
      agg.samples++;
      if (c.processes > 0) agg.samplesWithBrowser++;
      if (c.held > 0) agg.samplesWithHeld++;
      if (c.devToolsActivePort > 0) agg.samplesWithDevToolsActivePort++;
      if (c.debuggingFlag > 0) agg.samplesWithSwitch++;
      agg.maxProcesses = Math.max(agg.maxProcesses, c.processes); agg.maxSockets = Math.max(agg.maxSockets, c.sockets);
      agg.held += c.held; agg.unreadable += c.unreadable; agg.netUnreadable += c.netUnreadable; agg.cmdlineUnreadable += c.cmdlineUnreadable;
      agg.devToolsActivePort = Math.max(agg.devToolsActivePort, c.devToolsActivePort);
      agg.debuggingFlag = Math.max(agg.debuggingFlag, c.debuggingFlag);
      if (c.sandboxed !== null) agg.maxSandboxed = Math.max(agg.maxSandboxed, c.sandboxed);
      if (rec.exit === null && live(stat(rec.pid))) {
        agg.ownSession ||= stat(rec.pid)?.sid === rec.pid;
        try { agg.exePinned ||= fs.readlinkSync(`/proc/${rec.pid}/exe`) === state.binary; } catch { /* exited */ }
        try {
          const keys = fs.readFileSync(`/proc/${rec.pid}/environ`, "utf8").split("\0").map((kv) => kv.split("=")[0]);
          agg.displayVariable ||= keys.some((k) => ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"].includes(k));
        } catch { /* exited */ }
      }
      if (rec.primary && ANNOUNCE && !announced && c.processes > 0) { announced = true; process.stderr.write("probe: browser launched\n"); }
      onSample?.(agg, c);
      await sleep(50);
    }
    guard();
    if (rec.exit === null && window === null) throw new Fail("dump-dom-timeout");
    agg.devToolsActivePort = Math.max(agg.devToolsActivePort, findNamed(state.scratch, "DevToolsActivePort", otherDirs(rec)));
    agg.browserExit = rec.exit ? { code: rec.exit.code, signal: rec.exit.signal } : "running-at-window-end";
    return agg;
  }

  /** Debugging-off assessment of a primary --dump-dom run, recorded before any classification.
   *  Exit 2 browser-sandbox-unavailable only with nothing seen, all tables read, a numeric exit
   *  and Chrome's sandbox text; any other failed run is browser-run-failed (exit 1). */
  function assessPrimary(rec, agg) {
    const dom = rec.out.toString("utf8");
    const sandboxText = SANDBOX_TEXT.test(rec.err.toString("utf8"));
    const block = { mode: "off", evidence: "dump-dom run only", sampling: "about every 50 ms plus scan time, while the browser ran",
      sandboxEvidence: SANDBOX_EVIDENCE, stderrSandboxText: sandboxText, ...agg };
    const debugSeen = agg.held > 0 || agg.devToolsActivePort > 0 || agg.debuggingFlag > 0;
    const ranClean = rec.exit.code === 0 && dom.length > 0 && !rec.overflow;
    const tablesRead = agg.unreadable === 0 && agg.netUnreadable === 0 && agg.cmdlineUnreadable === 0; // else "no debugging" is unverified
    if (!ranClean && !debugSeen && tablesRead && Number.isInteger(rec.exit.code) && rec.exit.code !== 0 && sandboxText && !dom.length)
      return { block, dom, unavailable: true };
    expect(agg.samplesWithBrowser >= 2, "browser not sampled at least twice while running");
    expect(agg.debuggingFlag === 0, "a browser process carries a remote-debugging switch");
    expect(agg.devToolsActivePort === 0, "DevToolsActivePort present");
    expect(agg.held === 0, "a browser process holds a TCP listener");
    expect(agg.unreadable === 0 && agg.netUnreadable === 0, "unreadable fd or net tables");
    expect(agg.cmdlineUnreadable === 0, "unverified browser command line");
    expect(agg.ownSession && agg.exePinned && !agg.displayVariable, "browser session, binary or environment unexpected");
    expect(agg.maxSandboxed >= 1, "no browser process added a sandbox boundary");
    return { block, dom, ranClean };
  }

  /** The launcher's positive rendering: escaped DOM markers, bind and view 200s, and (#220) the
   *  listener's once-only observation of the exact selected view, each an independent requirement. */
  function assessRendering(dom, served, windowNavigation) {
    const rendering = renderingOf(dom, served);
    expect(rendering.capture, "dumped DOM has no capture view");
    expect(/Showing stored capture/.test(rendering.status), "status does not say showing");
    expect(!rendering.imgInView && rendering.hostileTitleAsText, "hostile title not rendered as text");
    expect(rendering.bindOk && rendering.viewOk, "listener did not serve bind and view");
    rendering.selectedViewObserved = windowNavigation.takeView();
    expect(rendering.selectedViewObserved && !windowNavigation.takeView(), "missing or reusable selected listener view observation");
    return rendering;
  }

  /** One cleanup for normal exit, failure, signal and watchdog: every browser, including agents. */
  async function cleanup() {
    const c = {};
    if (state.listener) await bounded(state.listener.close(), 3000);
    if (state.launches.length || state.scratch) {
      if (!(await stopOwned())) state.cleanupOk = false;
      await sleep(200);
      c.browsers = state.launches.length;
      c.sessionLeft = state.launches.reduce((n, r) => n + (r.pid ? sessionPids(r.pid).length : 0), 0);
      c.childrenLeft = childPids().length;
      c.namingDataDirLeft = [...new Set(state.launches.map((r) => r.dir))].reduce((n, d) => n + namingPids(d).length, 0);
      c.namingScratchLeft = state.scratch ? namingPids(state.scratch).length : 0;
      if (c.sessionLeft || c.childrenLeft || c.namingDataDirLeft || c.namingScratchLeft) state.cleanupOk = false;
    }
    // Remove only after the proof: on a pass, an unsupported run, or an interrupted one.
    if (state.scratch && state.cleanupOk && (failures.length === 0 || state.aborted)) {
      try {
        if (path.dirname(state.scratch) !== os.tmpdir() || !path.basename(state.scratch).startsWith(prefix) || fs.lstatSync(state.scratch).isSymbolicLink()) throw new Fail("scratch");
        fs.rmSync(state.scratch, { recursive: true, maxRetries: 5 });
        c.removed = !fs.existsSync(state.scratch);
        if (!c.removed) state.cleanupOk = false;
      } catch { state.cleanupOk = false; }
    }
    return c;
  }

  /** The supervised run: signals and the watchdog abandon `run`, then one cleanup, then one result. */
  async function supervise(run, { limitations, failureCodes = ["browser-run-failed"] }) {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => abort(`signal-${sig}`));
    const watchdog = setTimeout(() => abort("watchdog"), 150000);
    if (ANNOUNCE) result.testLaunchAnnouncement = true;
    const pin = process.argv[3] === "--chrome-sha256" ? process.argv[4] : null;
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
        : failureCodes.find((f) => failures.includes(f)) ?? "fixture-failed";
    }
    if (!state.cleanupOk) { state.exitCode = 1; result.ok = false; result.code = "cleanup-failed"; }
    result.cleanup = cleanupResult;
    if (state.exitCode === 1 && state.scratch && fs.existsSync(state.scratch)) { result.retainedScratch = true; process.stderr.write(`retained scratch: ${state.scratch}\n`); }
    result.node = process.version;
    result.limitations = limitations;
    finish(result, state.exitCode);
  }

  return { result, state, failures, expect, guard, ANNOUNCE, corePids, browserPids, portOwnedBy, stopOwned, pinBrowser, prepare,
    makeDataDir, launch, debuggingCheck, sampleRun, assessPrimary, assessRendering, cleanup, supervise };
}
