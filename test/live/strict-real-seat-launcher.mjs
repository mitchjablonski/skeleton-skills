import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDecisionListener } from "../../lib/strict-decision-listener.mjs";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";
import { createFixture, Fail, live, sleep, stat } from "./strict-browser-fixture.mjs";
import { CHROME_PATH } from "./strict-real-seat-preflight.mjs";
import { bindControlTerminal, bindOperatorSeat, confirmAtTerminal } from "./strict-real-seat-rehearsal.mjs";
import { bindDecisionWindows, WSLG_ENV } from "./strict-wslg-window.mjs";

const MATCHED = "seat-metadata-matched";
const SUCCESS = "real-seat-window-checkpoint-passed";
const INVOCATION_REFUSED = "real-desktop-invocation-invalid";
const TMPFS_MAGIC = 0x01021994;

function captureFixture(scratch) {
  const directory = path.join(scratch, "candidate");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "example.js"),
    "// SKEL[1] Fixture greeting\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n", { mode: 0o600, flag: "wx" });
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const capture = captureStrictManifest(fd, [{ path: "example.js", mode: "fenced" }]);
    const binding = Object.freeze({
      protocolVersion: 2, projectId: "seat-witness", sessionId: "seat-witness", reviewRoundId: "seat-witness",
      phase: "scaffold", reviewVersion: capture.shapeVersion, captureVersion: capture.captureVersion,
      approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false,
    });
    return { binding, capture };
  } finally {
    fs.closeSync(fd);
  }
}

function isPrivateScratch(scratch) {
  const entry = fs.lstatSync(scratch);
  return /^\/dev\/shm\/skel-wslg-[a-z0-9_]{8}$/.test(scratch)
    && entry.isDirectory() && entry.uid === process.getuid() && (entry.mode & 0o7777) === 0o700
    && fs.realpathSync(scratch) === scratch && fs.statfsSync(scratch).type === TMPFS_MAGIC
    && fs.readdirSync(scratch).length === 0;
}

function requireCode(code, expected = MATCHED) {
  if (code !== expected) throw new Fail(code);
}

export async function launchWindowCheckpoint({ seat, scratch, signal, environment }) {
  const windows = bindDecisionWindows(seat, environment);
  const before = windows.decisionWindows();
  if (!before) throw new Fail("wslg-window-inventory-unavailable");
  if (before.length) throw new Fail("wslg-decision-window-already-present");

  const fixed = captureFixture(scratch);
  const listener = createDecisionListener({ provider: { read: () => fixed } });
  const fixture = createFixture({ prefix: "skel-wslg-" });
  fixture.state.scratch = scratch;
  fixture.state.binary = CHROME_PATH;
  fixture.state.display = { environment };
  let browser, windowId;
  const windowLoss = new AbortController();
  const interrupted = () => {
    if (signal.aborted) throw new Fail("real-seat-interrupted");
  };
  const installation = fs.statSync(CHROME_PATH, { bigint: true });
  const isOwned = () => {
    if (!browser?.pid || browser.exit !== null) return false;
    try {
      const processState = stat(browser.pid);
      const executable = `/proc/${browser.pid}/exe`;
      const current = fs.statSync(executable, { bigint: true });
      return live(processState) && processState.ppid === process.pid && processState.sid === browser.pid
        && fs.readlinkSync(executable) === CHROME_PATH
        && current.dev === installation.dev && current.ino === installation.ino;
    } catch {
      return false;
    }
  };
  const isCurrent = () => Boolean(windowId) && isOwned() && windows.find(browser.pid, windowId) === windowId && isOwned();
  const sampleBrowser = async (duration) => {
    const sample = await fixture.sampleRun(browser, { window: duration });
    const result = fixture.assessPrimary(browser, sample);
    if (!result.ranClean || !sample.privateDisplayMatched || fixture.failures.length || !isOwned())
      throw new Fail("wslg-browser-verification-failed");
  };
  const confirmWhileOwned = async (confirm) => {
    if (!isCurrent()) throw new Fail("wslg-owned-window-lost");
    const watchdog = AbortSignal.any([signal, windowLoss.signal]);
    const timer = setInterval(() => {
      if (!isCurrent()) windowLoss.abort();
    }, 500);
    try {
      const result = await confirm(watchdog);
      interrupted();
      if (watchdog.aborted) throw new Fail("wslg-owned-window-lost");
      requireCode(result);
      if (!isCurrent()) throw new Fail("wslg-owned-window-lost");
    } finally {
      clearInterval(timer);
    }
  };

  try {
    await listener.start();
    const presentation = seat.prepareWindow(listener, fixed.binding);
    if (!presentation) throw new Fail("wslg-window-binding-unavailable");
    interrupted();
    requireCode(seat.recheck());
    browser = fixture.launch("browser-data", ["--new-window", presentation.navigation.url],
      { display: fixture.state.display });
    browser.exited.then(() => windowLoss.abort());
    await sampleBrowser(4000);
    let selected = false;
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && isOwned()) {
      interrupted();
      selected ||= presentation.navigation.takeView();
      windowId = windows.find(browser.pid);
      if (selected && windowId) break;
      await sleep(50);
    }
    if (!windowId) throw new Fail("wslg-owned-window-not-mapped");
    if (!selected || presentation.navigation.takeView()) throw new Fail("wslg-selected-view-unverified");

    await confirmWhileOwned(presentation.confirmMatch);
    process.stdout.write("Checking the retained window at the restart checkpoint.\n");
    await sampleBrowser(600);
    await confirmWhileOwned(presentation.confirmRestart);
    await sampleBrowser(600);
    if (!isCurrent() || !presentation.comparison()) throw new Fail("wslg-owned-window-lost");
    interrupted();
  } finally {
    await listener.close();
    if (browser && browser.exit === null) {
      browser.proc.kill("SIGTERM");
      const deadline = performance.now() + 4000;
      while (browser.exit === null && performance.now() < deadline) await sleep(50);
    }
  }
  if (browser.exit === null || windows.decisionWindows()?.length !== 0)
    throw new Fail("wslg-window-teardown-unproven");
}

async function run(scratch, input, output) {
  const interactive = bindControlTerminal(input, output);
  if (!interactive() || !isPrivateScratch(scratch)) return INVOCATION_REFUSED;
  const cancelled = new AbortController();
  const abort = () => cancelled.abort();
  const signalNames = ["SIGINT", "SIGHUP", "SIGTERM"];
  for (const name of signalNames) process.on(name, abort);
  try {
    const seat = await bindOperatorSeat({
      interactive,
      confirm: (prompt, signal = cancelled.signal) => confirmAtTerminal(input, output, prompt, 120_000, signal),
    });
    if (cancelled.signal.aborted) return "real-seat-interrupted";
    requireCode(seat.code, "real-seat-preflight-passed");
    await launchWindowCheckpoint({ seat, scratch, signal: cancelled.signal, environment: WSLG_ENV });
    return cancelled.signal.aborted ? "real-seat-interrupted" : SUCCESS;
  } catch (error) {
    return cancelled.signal.aborted ? "real-seat-interrupted"
      : error instanceof Fail ? error.label : "real-seat-evidence-unavailable";
  } finally {
    for (const name of signalNames) process.off(name, abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, scratch, descriptor] = process.argv.slice(2);
  if (process.argv.length !== 5 || flag !== "--supervised-wslg-window"
      || !/^\d{1,5}$/.test(descriptor ?? "") || Number(descriptor) < 3) process.exit(2);
  const report = Number(descriptor);
  let code;
  try {
    if (!fs.fstatSync(report).isFIFO()) process.exit(2);
    code = await run(scratch, process.stdin, process.stdout);
  } catch {
    code = "real-seat-evidence-unavailable";
  }
  fs.writeSync(report, code + "\n");
  fs.closeSync(report);
  process.exit(code === SUCCESS ? 0 : 1);
}
