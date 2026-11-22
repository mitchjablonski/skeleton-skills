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
//      by any process in the browser's session, tree or reparented helpers;
//   4. navigates to the URL over the pipe: the page binds and renders the
//      fixed capture;
//   5. agent control: a Bubblewrap worker with --unshare-net gets ECONNREFUSED
//      on the listener origin; the same worker sharing the network namespace
//      connects and gets an HTTP status for GET /;
//   6. closes the browser and the listener, proves nothing remains in the
//      browser's session, among our children, or naming the scratch root,
//      and only then removes the directory.
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
  const r = spawnSync(PYTHON, ["-I", "-c", SHIM, process.execPath, SELF, "--supervised"],
    { stdio: ["ignore", "pipe", "inherit"], maxBuffer: MAX * 2, timeout: 180000 });
  const out = (r.stdout ?? Buffer.alloc(0)).toString("utf8").trim().split("\n").pop() ?? "";
  if (r.status === 3) finish(unsupported("child subreaper unavailable"), 2);
  try { finish(JSON.parse(out), [0, 1, 2].includes(r.status) ? r.status : 1); }
  catch { finish({ ok: false, strictState: "unverified", code: "fixture-failed", reason: `supervised run ended without a result (${r.status ?? r.signal})` }, 1); }
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
  for (const base of ["/proc/self", ...pids.map((p) => `/proc/${p}`)]) {
    for (const file of ["net/tcp", "net/tcp6"]) {
      let text;
      try { text = fs.readFileSync(`${base}/${file}`, "utf8"); } catch { continue; }
      for (const row of text.split("\n").slice(1)) {
        const f = row.trim().split(/\s+/);
        if (f.length > 9 && f[3] === "0A") inodes.add(Number(f[9]));
      }
    }
  }
  return inodes;
}
function socketInodes(pid) {
  const out = new Set();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) out.add(Number(m[1])); } catch { /* closed meanwhile */ }
  }
  return out;
}
/** Count listeners held by `pids`; unreadable fd tables are counted, never skipped silently. */
function heldListeners(pids) {
  const listening = listeningInodes(pids);
  let held = 0, sockets = 0, unreadable = 0, readable = 0;
  for (const pid of pids) {
    let mine;
    try { mine = socketInodes(pid); } catch { if (live(stat(pid))) unreadable++; continue; }
    readable++; sockets += mine.size;
    for (const i of mine) if (listening.has(i)) held++;
  }
  return { processes: pids.length, readable, unreadable, sockets, listeningInodesSeen: listening.size, held };
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
let exitCode = 2, scratch = null, dataDir = null, listener = null, browser = null, browserPid = null, cleanupOk = true;
const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); };
const watchdog = setTimeout(() => { failures.push("watchdog: run exceeded 150 s"); }, 150000);

async function stopOwned() {
  // Our direct children only: the browser, and helpers the kernel reparented to us.
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

try {
  // Preconditions (unsupported until the browser is up).
  if (childPids().length) throw Object.assign(new Error("probe started with children"), { unsupported: true });
  const probe = spawnSync(PYTHON, ["-I", "-c", "import os,sys,time\npid=os.fork()\nif pid==0:\n time.sleep(20)\n os._exit(0)\nprint(pid)"],
    { stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  const orphan = Number(probe.stdout?.toString().trim());
  await sleep(100);
  const reparented = Number.isInteger(orphan) && stat(orphan)?.ppid === process.pid;
  if (Number.isInteger(orphan) && reparented) process.kill(orphan, "SIGKILL");
  if (!reparented) throw Object.assign(new Error("child subreaper not effective"), { unsupported: true });
  const cap0 = runSandboxed([...bwrapArgv(true), "--", "/usr/bin/true"]);
  if (cap0.status !== 0) throw Object.assign(new Error("bubblewrap cannot start a sandbox"), { unsupported: true });

  // Scratch root and a fresh, owned browser data directory.
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  fs.chmodSync(scratch, 0o700);
  dataDir = path.join(scratch, "browser-data");
  try { fs.mkdirSync(dataDir, { mode: 0o700 }); } catch (e) { throw new Error(e.code === "EEXIST" ? "browser data directory already exists: refused" : "mkdir failed"); }
  fs.chmodSync(dataDir, 0o700);
  const st = fs.lstatSync(dataDir);
  const real = fs.realpathSync(dataDir);
  const home = os.homedir();
  const defaults = [".config/google-chrome", ".config/google-chrome-beta", ".config/chromium", "snap/chromium"].map((d) => path.join(home, d));
  const dirCheck = {
    fresh: fs.readdirSync(dataDir).length === 0,
    directory: st.isDirectory() && !st.isSymbolicLink(),
    ownedByUs: st.uid === process.getuid(),
    mode: (st.mode & 0o777).toString(8).padStart(4, "0"),
    notDefault: real === dataDir && !defaults.some((d) => real === d || real.startsWith(d + path.sep)) && !real.startsWith(home + path.sep),
  };
  if (!(dirCheck.fresh && dirCheck.directory && dirCheck.ownedByUs && dirCheck.mode === "0700" && dirCheck.notDefault))
    throw new Error("browser data directory checks failed");
  result.dataDirectory = dirCheck;

  // Listener with a fixed fixture capture (as the listener browser probe builds it).
  const src = path.join(scratch, "src"); fs.mkdirSync(src, { mode: 0o700 });
  fs.writeFileSync(path.join(src, "a.js"),
    "const x = 1;\n// SKEL[1] <img src=x onerror=window.PWNED=1> step\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n");
  const fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let cap;
  try { cap = JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "a.js", mode: "fenced" }]))); } finally { fs.closeSync(fd); }
  const binding = { protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
    phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
    approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false };
  const log = [];
  listener = createDecisionListener({ provider: { read: () => ({ binding, capture: cap }) }, observe: (e) => log.push(e) });
  const { origin } = await listener.start();
  const port = Number(new URL(origin).port);

  // Browser: pipe only, no display variables, own session; sandbox preferred.
  const env = { HOME: scratch, PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "disabled:" };
  let fallbackReason = null;
  for (const sandbox of [true, false]) {
    try { browser = await launchChrome(CHROME, { sandbox, userDataDir: dataDir, env, detached: true }); break; }
    catch (e) {
      fallbackReason = String(e.message).slice(0, 80);
      if (!(await stopOwned()) || namingPids(scratch).length) { cleanupOk = false; throw new Error("first browser attempt cleanup unproven"); }
    }
  }
  if (!browser) throw Object.assign(new Error("browser cannot start"), { unsupported: true });
  browserPid = browser.pid;
  exitCode = 1; result.code = "fixture-failed";
  result.browser = { product: String(browser.product).slice(0, 64), chromeSandbox: browser.sandbox,
    sandboxFallbackReason: browser.sandbox ? null : fallbackReason, ownSession: stat(browserPid)?.sid === browserPid };
  expect(result.browser.ownSession, "browser is not its own session leader");
  const envSeen = fs.readFileSync(`/proc/${browserPid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => kv.split("=")[0]);
  expect(!envSeen.some((k) => ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"].includes(k)), "browser environment has a display variable");

  // Remote debugging off, observed twice (after launch and after rendering).
  const cmdlineOf = (p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); } catch { return ""; } };
  const debuggingCheck = () => {
    const pids = browserPids(browserPid, scratch);
    const tcp = heldListeners(pids);
    return { ...tcp, devToolsActivePort: findNamed(dataDir, "DevToolsActivePort") + findNamed(scratch, "DevToolsActivePort"),
      portFlag: pids.filter((p) => /--remote-debugging-(port|address)/.test(cmdlineOf(p))).length,
      pipeFlag: /--remote-debugging-pipe/.test(cmdlineOf(browserPid)) };
  };
  await sleep(500);
  const atLaunch = debuggingCheck();

  // Positive rendering over the pipe.
  const page = await browser.newPage();
  const beforeNav = log.length;
  await page.goto(listener.mintNavigation());
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
  const afterRender = debuggingCheck();

  // Self control: the same inode method finds our own listener held by us.
  const selfHeld = heldListeners([process.pid]).held;
  result.remoteDebugging = { mode: "pipe-only", atLaunch, afterRender, selfControlHeld: selfHeld };
  for (const [label, c] of [["launch", atLaunch], ["render", afterRender]]) {
    expect(c.devToolsActivePort === 0, `${label}: DevToolsActivePort present`);
    expect(c.held === 0, `${label}: a browser process holds a TCP listener`);
    expect(c.unreadable === 0, `${label}: unreadable browser fd tables`);
    expect(c.portFlag === 0 && c.pipeFlag, `${label}: debugging flags unexpected`);
    expect(c.processes > 0 && c.sockets > 0, `${label}: no browser processes or sockets observed`);
  }
  expect(selfHeld >= 1, "self control: inode method did not find the fixture listener");

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
  if (!failures.length) { exitCode = 0; result.ok = true; result.code = "fresh-browser-data-fixture-passed"; }
} catch (e) {
  if (e.unsupported) { exitCode = 2; result.code = "unsupported"; result.reason = String(e.message).slice(0, 120); }
  else { exitCode = 1; result.ok = false; result.code = "fixture-failed"; failures.push(String(e.message).slice(0, 160)); }
} finally {
  clearTimeout(watchdog);
  const cleanup = {};
  try { if (browser) await browser.close(); } catch { /* proven below */ }
  try { if (listener) await listener.close(); } catch { cleanupOk = false; }
  if (browser || scratch) {
    if (!(await stopOwned())) cleanupOk = false;
    await sleep(200);
    cleanup.sessionLeft = browserPid ? sessionPids(browserPid).length : 0;
    cleanup.childrenLeft = childPids().length;
    cleanup.namingDataDirLeft = dataDir ? namingPids(dataDir).length : 0;
    cleanup.namingScratchLeft = scratch ? namingPids(scratch).length : 0;
    if (cleanup.sessionLeft || cleanup.childrenLeft || cleanup.namingDataDirLeft || cleanup.namingScratchLeft) cleanupOk = false;
  }
  if (scratch && cleanupOk && exitCode !== 1 && failures.length === 0) {
    try {
      if (path.dirname(scratch) !== os.tmpdir() || !path.basename(scratch).startsWith(PREFIX) || fs.lstatSync(scratch).isSymbolicLink()) throw new Error("scratch");
      fs.rmSync(scratch, { recursive: true, maxRetries: 5 });
      cleanup.removed = !fs.existsSync(scratch);
      if (!cleanup.removed) cleanupOk = false;
    } catch { cleanupOk = false; }
  }
  if (!cleanupOk) { exitCode = 1; result.ok = false; result.code = "cleanup-failed"; }
  if (failures.length) { exitCode = 1; result.ok = false; if (result.code !== "cleanup-failed") result.code = "fixture-failed"; result.failures = failures.slice(0, 12); }
  result.cleanup = cleanup;
  if (exitCode === 1 && scratch && fs.existsSync(scratch)) { result.retainedScratch = true; process.stderr.write(`retained scratch: ${scratch}\n`); }
  result.node = process.version;
  result.limitations = ["one fixture-owned headless browser, not the human's window",
    "agent control is network-namespace only; an agent-started browser is not launched",
    "Unix-domain and abstract automation sockets are not measured", "measured host only"];
  finish(result, exitCode);
}
