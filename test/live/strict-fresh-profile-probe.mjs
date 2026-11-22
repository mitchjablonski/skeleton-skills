#!/usr/bin/env node
// Opt-in Linux C20 first slice (#77 / #79): the decision page opens in a
// fresh, launcher-owned browser data directory with remote debugging off, and
// a sandboxed agent can't reach the listener the page talks to.
//
//   node test/live/strict-fresh-profile-probe.mjs
//
// The fixture:
//   1. starts the existing read-only decision listener on loopback with a
//      fixed fixture capture and mints the one-time URL;
//   2. creates a fresh 0700 browser data directory of its own (an existing
//      path is refused) and launches headless Chrome on it with
//      --remote-debugging-pipe only, no display variables (WSLg is never
//      touched) and HOME set to the scratch root;
//   3. proves remote debugging is off: no DevToolsActivePort file, and no TCP
//      listener (any network namespace the browser's processes are in) is held
//      by any process in the browser's session, tree or reparented helpers
//      (TCP only, sampled twice). A second disposable browser WITH a loopback
//      debugging port, in its own fresh directory, is the negative control:
//      the same check must find its listener and DevToolsActivePort;
//   4. navigates to the URL over the pipe: the page binds and renders the
//      fixed capture;
//   5. agent control: a Bubblewrap worker with --unshare-net gets ECONNREFUSED
//      on the listener origin; the same worker sharing the network namespace
//      connects and gets an HTTP status for GET /;
//   6. closes the browser and the listener, proves nothing remains in the
//      browser's session, among our children, or naming the scratch root,
//      and only then removes the directory. The same cleanup runs on SIGINT,
//      SIGTERM, SIGHUP and the watchdog, which abandon the run (exit 1).
// It connects to nothing but the fixture's own listener (and the browser's
// pipe). Never human proof, never a support claim.
//
// Exit 0: passed. Exit 1: a check or cleanup failed (scratch retained; its
// path goes to stderr only). Exit 2: unsupported (not Linux, no Chrome or
// Chromium, no Bubblewrap or system Python, or the browser can't start).
//
// Cleanup: Chrome's crash handlers leave the browser session. The probe
// re-executes itself through a tiny Python shim that makes it a Linux child
// subreaper, so orphaned helpers are reparented to it. Signals go only to
// our direct children (checked by parent pid just before signalling); a
// command line naming the scratch root fails the run but never authorizes a
// signal. Node never reaps reparented orphans, so their pids can't be reused
// while the probe runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";
import { createDecisionListener } from "../../lib/strict-decision-listener.mjs";
import { launchChrome } from "./cdp-pipe.mjs";

const MAX = 32768;
const CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const PYTHON = "/usr/bin/python3";
const BWRAP = "/usr/bin/bwrap";
const PREFIX = "strict-fresh-profile-";
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unsupported = (reason) => ({ ok: false, strictState: "unverified", code: "unsupported", reason });
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
if (process.argv[2] !== "--supervised") {
  if (process.argv.length !== 2) finish(unsupported("unexpected arguments"), 2);
  if (process.platform !== "linux") finish(unsupported("not Linux"), 2);
  if (!CANDIDATES.some((c) => fs.existsSync(c))) finish(unsupported("no Chrome or Chromium"), 2);
  if (!fs.existsSync(BWRAP)) finish(unsupported("no /usr/bin/bwrap"), 2);
  if (!fs.existsSync(PYTHON)) finish(unsupported("no /usr/bin/python3"), 2);
  // Signals and the overall timeout are forwarded so the inner run cleans up;
  // SIGKILL only after a grace period, and only to the inner process we started.
  const inner = spawn(PYTHON, ["-I", "-c", SHIM, process.execPath, SELF, "--supervised"], { stdio: ["ignore", "pipe", "inherit"] });
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
function stat(pid) {
  try {
    const data = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = data.slice(data.lastIndexOf(")") + 2).split(" ");
    return { state: f[0], ppid: Number(f[1]), sid: Number(f[3]) };
  } catch { return null; }
}
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
/** Listening TCP socket inodes in the network namespace(s) seen through each pid. */
function listeningInodes(pids) {
  const inodes = new Set();
  let netUnreadable = 0;
  for (const pid of [process.pid, ...pids]) {
    for (const file of ["net/tcp", "net/tcp6"]) {
      let text;
      try { text = fs.readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { if (live(stat(pid))) netUnreadable++; continue; }
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
    try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) out.add(Number(m[1])); } catch { /* closed meanwhile */ }
  }
  return out;
}
/** Count listeners held by `pids`; unreadable fd and net tables are counted, never skipped silently. */
function heldListeners(pids) {
  const { inodes: listening, netUnreadable } = listeningInodes(pids);
  let held = 0, sockets = 0, unreadable = 0, readable = 0;
  for (const pid of pids) {
    let mine;
    try { mine = socketInodes(pid); } catch { if (live(stat(pid))) unreadable++; continue; }
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
const CHROME = CANDIDATES.find((c) => fs.existsSync(c));
const result = { ok: false, strictState: "unverified", code: "unsupported" };
const state = { exitCode: 2, scratch: null, listener: null, launches: [], aborted: null, cleanupOk: true };
const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); };
// Every message that can reach stdout is a fixed label: never a path or token.
class Fail extends Error { constructor(label, unsupported = false) { super(label); this.label = label; this.unsupported = unsupported; } }
const labelOf = (e) => e instanceof Fail ? e.label
  : /timed out|timeout/i.test(e?.message ?? "") ? "browser-timeout"
  : /chrome (exited|failed)/i.test(e?.message ?? "") ? "browser-exited"
  : /^E[A-Z]+$/.test(e?.code ?? "") ? `unexpected-error:${e.code}` : "unexpected-error";

let abortResolve;
const aborted = new Promise((r) => { abortResolve = r; });
function abort(reason) { if (state.aborted) return; state.aborted = reason; abortResolve(); }
const guard = () => { if (state.aborted) throw new Fail("aborted"); };
// Test-only hook: pause after the browser is up so a signal test can interrupt it.
const PAUSE_MS = Math.min(Number(process.env.SKEL_C20_TEST_PAUSE_AFTER_LAUNCH_MS) || 0, 60000);

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

async function launch(name, sandbox, extraArgs = []) {
  const { dir, check } = makeDataDir(name);
  const env = { HOME: state.scratch, PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "disabled:" }; // no display variables
  guard();
  const browser = await launchChrome(CHROME, { sandbox, userDataDir: dir, env, detached: true, extraArgs });
  const rec = { browser, pid: browser.pid, dir, check };
  state.launches.push(rec);
  guard();
  return rec;
}

const cmdlineOf = (p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); } catch { return ""; } };
/** The same check for the real browser and the debugging-port negative control. */
function debuggingCheck(rec) {
  const pids = browserPids(rec.pid, state.scratch);
  return { ...heldListeners(pids), devToolsActivePort: findNamed(state.scratch, "DevToolsActivePort"),
    portFlag: pids.filter((p) => /--remote-debugging-(port|address)/.test(cmdlineOf(p))).length,
    pipeFlag: /--remote-debugging-pipe/.test(cmdlineOf(rec.pid)) };
}

async function run() {
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

  state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  fs.chmodSync(state.scratch, 0o700);

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

  // Browser: pipe only, own session, a fresh directory per attempt; sandbox preferred.
  let main = null, fallbackReason = null, attempt = 0;
  for (const sandbox of [true, false]) {
    try { main = await launch(`browser-data-${++attempt}`, sandbox); break; }
    catch (e) {
      if (state.aborted) throw e;
      fallbackReason = labelOf(e);
      if (!(await stopOwned()) || namingPids(state.scratch).length) { state.cleanupOk = false; throw new Fail("first-browser-attempt-cleanup-unproven"); }
    }
  }
  if (!main) throw new Fail("browser-cannot-start", true);
  state.exitCode = 1; result.code = "fixture-failed";
  result.dataDirectory = { ...main.check, attempts: attempt };
  result.browser = { product: String(main.browser.product).slice(0, 64), chromeSandbox: main.browser.sandbox,
    sandboxFallbackReason: main.browser.sandbox ? null : fallbackReason, ownSession: stat(main.pid)?.sid === main.pid };
  expect(result.browser.ownSession, "browser is not its own session leader");
  const envSeen = fs.readFileSync(`/proc/${main.pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => kv.split("=")[0]);
  expect(!envSeen.some((k) => ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"].includes(k)), "browser environment has a display variable");
  if (PAUSE_MS) { process.stderr.write("probe: browser launched\n"); await sleep(PAUSE_MS); guard(); }

  // Remote debugging off, sampled twice (after launch and after rendering).
  await sleep(500);
  const atLaunch = debuggingCheck(main);

  // Positive rendering over the pipe.
  const page = await main.browser.newPage();
  const beforeNav = log.length;
  await page.goto(state.listener.mintNavigation());
  const rendered = await page.waitUntil(`!!document.querySelector("[data-strict-capture]") && /Showing stored capture/.test(document.getElementById("status")?.textContent ?? "")`, 15000);
  const view = await page.eval(`(() => { const v = document.getElementById("view"); return {
    capture: !!document.querySelector("[data-strict-capture]"),
    status: (document.getElementById("status")?.textContent ?? "").slice(0, 80),
    imgInView: !!v?.querySelector("img"), hostileTitleAsText: (v?.textContent ?? "").includes("<img src=x onerror"),
    pwned: window.PWNED === 1, hashStripped: location.hash === "" }; })()`);
  const served = log.slice(beforeNav);
  result.rendering = { ...view, bindOk: served.some((e) => e.url === "/api/bind" && e.status === 200),
    viewOk: served.some((e) => e.url === "/api/view" && e.status === 200), listenerRequests: served.length };
  expect(rendered && view.capture, "page did not render the capture");
  expect(/Showing stored capture/.test(view.status), "status does not say showing");
  expect(!view.imgInView && view.hostileTitleAsText && !view.pwned, "hostile title not rendered as text");
  expect(result.rendering.bindOk && result.rendering.viewOk, "listener did not serve bind and view");
  const afterRender = debuggingCheck(main);
  result.remoteDebugging = { mode: "pipe-only", samples: 2, atLaunch, afterRender };
  for (const [label, c] of [["launch", atLaunch], ["render", afterRender]]) {
    expect(c.devToolsActivePort === 0, `${label}: DevToolsActivePort present`);
    expect(c.held === 0, `${label}: a browser process holds a TCP listener`);
    expect(c.unreadable === 0 && c.netUnreadable === 0, `${label}: unreadable fd or net tables`);
    expect(c.portFlag === 0 && c.pipeFlag, `${label}: debugging flags unexpected`);
    expect(c.processes > 0 && c.sockets > 0, `${label}: no browser processes or sockets observed`);
  }

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
  await page.close();

  // Close the real browser and prove it gone before the negative control.
  await bounded(main.browser.close(), 8000);
  if (!(await stopOwned())) state.cleanupOk = false;
  expect(sessionPids(main.pid).length === 0, "real browser session survived its close");
  guard();

  // Negative control: a disposable browser WITH a loopback debugging port, in
  // its own fresh directory, through the same check. Nothing connects to it.
  const ctrl = await launch("control-data", main.browser.sandbox, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]);
  const until = Date.now() + 15000;
  while (Date.now() < until && findNamed(ctrl.dir, "DevToolsActivePort") === 0) { await sleep(100); guard(); }
  await sleep(300);
  const control = debuggingCheck(ctrl);
  result.negativeControl = { dataDirectoryFresh: ctrl.check.fresh && ctrl.check.mode === "0700", ...control };
  expect(control.held >= 1, "negative control: debugging listener not found held by its browser");
  expect(control.devToolsActivePort >= 1, "negative control: no DevToolsActivePort");
  expect(control.portFlag >= 1, "negative control: port flag not seen");
  expect(control.unreadable === 0 && control.netUnreadable === 0, "negative control: unreadable fd or net tables");
  await bounded(ctrl.browser.close(), 8000);
  if (!(await stopOwned())) state.cleanupOk = false;
  expect(sessionPids(ctrl.pid).length === 0, "control browser session survived its close");

  if (!failures.length) { state.exitCode = 0; result.ok = true; result.code = "fresh-browser-data-fixture-passed"; }
}

/** One cleanup for normal exit, failure, signal and watchdog. */
async function cleanup() {
  const c = {};
  for (const rec of state.launches) await bounded(rec.browser.close(), 8000);
  if (state.listener) await bounded(state.listener.close(), 3000);
  if (state.launches.length || state.scratch) {
    if (!(await stopOwned())) state.cleanupOk = false;
    await sleep(200);
    c.sessionLeft = state.launches.reduce((n, r) => n + sessionPids(r.pid).length, 0);
    c.childrenLeft = childPids().length;
    c.namingDataDirLeft = state.launches.reduce((n, r) => n + namingPids(r.dir).length, 0);
    c.namingScratchLeft = state.scratch ? namingPids(state.scratch).length : 0;
    if (c.sessionLeft || c.childrenLeft || c.namingDataDirLeft || c.namingScratchLeft) state.cleanupOk = false;
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

if (process.argv[2] === "--supervised") {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => abort(`signal-${sig}`));
  const watchdog = setTimeout(() => abort("watchdog"), 150000);
  const running = run();
  running.catch(() => {}); // after an abort it may still reject; the race below already settled
  try {
    await Promise.race([running, aborted]);
  } catch (e) {
    if (e?.unsupported && !state.aborted) { state.exitCode = 2; result.code = "unsupported"; result.reason = labelOf(e); }
    else if (!state.aborted) { state.exitCode = 1; failures.push(labelOf(e)); }
  }
  clearTimeout(watchdog);
  if (state.aborted) { state.exitCode = 1; failures.push(state.aborted); }
  const cleanupResult = await cleanup();
  if (state.aborted) result.code = state.aborted === "watchdog" ? "watchdog-aborted" : "interrupted";
  if (failures.length) { state.exitCode = 1; result.ok = false; if (!state.aborted) result.code = "fixture-failed"; result.failures = failures.slice(0, 12); }
  if (!state.cleanupOk) { state.exitCode = 1; result.ok = false; result.code = "cleanup-failed"; }
  result.cleanup = cleanupResult;
  if (state.exitCode === 1 && state.scratch && fs.existsSync(state.scratch)) { result.retainedScratch = true; process.stderr.write(`retained scratch: ${state.scratch}\n`); }
  result.node = process.version;
  result.limitations = ["one fixture-owned headless browser, not the human's window",
    "agent control is network-namespace only; an agent-started browser is not launched",
    "TCP listeners only, at two samples; Unix-domain and abstract automation sockets are not measured", "measured host only"];
  finish(result, state.exitCode);
}
