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

export async function launchWindowCheckpoint({ seat, scratch, signal, environment, review, exercise }) {
  const windows = bindDecisionWindows(seat, environment);
  const before = windows.decisionWindows();
  if (!before) throw new Fail("wslg-window-inventory-unavailable");
  if (before.length) throw new Fail("wslg-decision-window-already-present");

  const fixed = review ?? captureFixture(scratch);
  const listener = createDecisionListener({ provider: { read: fixed.read ?? (() => fixed) } });
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
  const whileOwned = async (operation) => {
    if (!isCurrent()) throw new Fail("wslg-owned-window-lost");
    const watchdog = AbortSignal.any([signal, windowLoss.signal]);
    const timer = setInterval(() => {
      if (!isCurrent()) windowLoss.abort();
    }, 500);
    try {
      await operation(watchdog);
      interrupted();
      if (watchdog.aborted) throw new Fail("wslg-owned-window-lost");
      if (!isCurrent()) throw new Fail("wslg-owned-window-lost");
    } catch (error) {
      if (error?.label === "real-seat-cleanup-unproven") throw error;
      interrupted();
      if (watchdog.aborted) throw new Fail("wslg-owned-window-lost");
      throw error;
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

    const compare = async (confirm, ownedSignal) => requireCode(await confirm(ownedSignal));
    await whileOwned((ownedSignal) => compare(presentation.confirmMatch, ownedSignal));
    if (exercise) {
      await whileOwned((ownedSignal) => exercise({
        signal: ownedSignal,
        windowCurrent: () => isCurrent() && Boolean(presentation.comparison()),
        async confirmRestart() {
          await sampleBrowser(600);
          await compare(presentation.confirmRestart, ownedSignal);
        },
        async confirmRetained() {
          await sampleBrowser(600);
          await compare(presentation.confirmMatch, ownedSignal);
        },
      }));
    } else {
      process.stdout.write("Checking the retained window at the restart checkpoint.\n");
      await sampleBrowser(600);
      await whileOwned((ownedSignal) => compare(presentation.confirmRestart, ownedSignal));
      await sampleBrowser(600);
    }
    if (!isCurrent() || !presentation.comparison()) throw new Fail("wslg-owned-window-lost");
    interrupted();
  } finally {
    try {
      await listener.close();
    } finally {
      if (browser && browser.exit === null) {
        browser.proc.kill("SIGTERM");
        const deadline = performance.now() + 4000;
        while (browser.exit === null && performance.now() < deadline) await sleep(50);
      }
    }
  }
  const deadline = performance.now() + 2000;
  while (browser.exit !== null && performance.now() < deadline) {
    const remaining = windows.decisionWindows();
    if (remaining?.length === 0) return;
    if (!remaining) break;
    await sleep(50);
  }
  throw new Fail("wslg-window-teardown-unproven");
}

async function run(scratch, input, output, contained) {
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
    const options = contained ? contained.prepare({ input, output, interactive }) : {};
    await launchWindowCheckpoint({ seat, scratch, signal: cancelled.signal, environment: WSLG_ENV, ...options });
    return cancelled.signal.aborted ? "real-seat-interrupted" : contained?.success ?? SUCCESS;
  } catch (error) {
    return error?.label === "real-seat-cleanup-unproven" ? error.label
      : cancelled.signal.aborted ? "real-seat-interrupted"
      : error instanceof Fail ? error.label : "real-seat-evidence-unavailable";
  } finally {
    for (const name of signalNames) process.off(name, abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, scratch, workspace, receipt, terminalPin] = process.argv.slice(2);
  const full = flag === "--supervised-wslg-contained" && process.argv.length === 7;
  if (!full && (process.argv.length !== 4 || flag !== "--supervised-wslg-window")) process.exit(2);
  let code;
  let success = SUCCESS;
  try {
    if (!fs.fstatSync(2).isFIFO()) process.exit(2);
    const contained = full
      ? (await import("./strict-real-seat-contained.mjs")).configureContainedRun(workspace, receipt, terminalPin) : null;
    success = contained?.success ?? SUCCESS;
    code = await run(scratch, process.stdin, process.stdout, contained);
  } catch {
    code = "real-seat-evidence-unavailable";
  }
  fs.writeSync(2, code + "\n");
  process.exit(code === success ? 0 : 1);
}
