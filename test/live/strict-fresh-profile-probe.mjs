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

import { fileURLToPath } from "node:url";
import { createDecisionListener } from "../../lib/strict-decision-listener.mjs";
import { BWRAP, runOuter, parseArgs, sha256File, sessionPids, childPids, namingPids, runWorker, Fail, buildFixtureCapture, createFixture } from "./strict-browser-fixture.mjs";
import { mappedBrowserWindow, PrivateDisplayError, startPrivateDisplay, waitForPrivateDisplay, XVFB } from "./strict-private-display.mjs";

const PREFIX = "strict-fresh-profile-";
const SELF = fileURLToPath(import.meta.url);
// `--private-display` (#222) runs the windowed mode on the fixture's own Xvfb display only.
const { supervised, privateDisplay } = parseArgs({ allowPrivateDisplay: true });
if (!supervised) runOuter(SELF, { allowPrivateDisplay: true });

// Test-only hooks (each labelled in the output; a run using one never passes):
// SKEL_C20_TEST_ANNOUNCE_LAUNCH=1 writes a stderr marker once the primary browser is up (signal test);
// SKEL_C20_TEST_MUTATION=debugging-then-kill adds a debugging port to the primary run and SIGKILLs it after 3 samples;
// SKEL_C20_TEST_MUTATION=sandbox-blocked runs the primary browser where user namespaces are disabled;
// SKEL_C20_TEST_BROWSER=<file> supplies a pin-refusal sentinel that is never executed.
const MUTATION = ["debugging-then-kill", "sandbox-blocked"].includes(process.env.SKEL_C20_TEST_MUTATION) ? process.env.SKEL_C20_TEST_MUTATION : null;
const TEST_BROWSER = process.env.SKEL_C20_TEST_BROWSER || null;

const fx = createFixture({ prefix: PREFIX });
const { result, state, failures, expect, guard } = fx;

async function run(pin) {
  if (MUTATION) result.testMutation = MUTATION;
  if (TEST_BROWSER) result.testBrowserOverride = true;
  fx.pinBrowser(pin, TEST_BROWSER);
  await fx.prepare();
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
  const { cap, binding } = buildFixtureCapture(state.scratch);
  const log = [];
  state.listener = createDecisionListener({ provider: { read: () => ({ binding, capture: cap }) }, observe: (e) => log.push(e) });
  const { origin } = await state.listener.start();
  const port = Number(new URL(origin).port);

  // Primary evidence: a private window or a --dump-dom run, with no debugging switch.
  const beforeNav = log.length;
  const mutationArgs = MUTATION === "debugging-then-kill" ? ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] : [];
  const wrap = MUTATION === "sandbox-blocked" // test only: no user namespaces, so Chrome's sandbox can't start
    ? [BWRAP, "--unshare-user", "--disable-userns", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/",
      "--dev", "/dev", "--proc", "/proc", "--bind", state.scratch, state.scratch, "--"] : null;
  const windowNavigation = state.listener.mintWindowNavigation(binding);
  const navigationArgs = privateDisplay ? ["--new-window", windowNavigation.url]
    : ["--virtual-time-budget=10000", "--dump-dom", windowNavigation.url];
  const main = fx.launch("browser-data", [...mutationArgs, ...navigationArgs], { primary: true, wrap, display: state.display });
  state.exitCode = 1; result.code = "fixture-failed";
  result.dataDirectory = main.check;
  let killed = false;
  const agg = await fx.sampleRun(main, { window: privateDisplay ? 4000 : null, onSample: (a) => {
    if (MUTATION === "debugging-then-kill" && !killed && a.samplesWithBrowser >= 3) { killed = true; try { main.proc.kill("SIGKILL"); } catch { /* exited */ } }
  } });
  const assessed = fx.assessPrimary(main, agg);
  result.remoteDebugging = assessed.block;
  if (assessed.unavailable) throw new Fail("browser-sandbox-unavailable", true, "browser-sandbox-unavailable");
  if (!assessed.ranClean) throw new Fail("browser-run-failed");

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
  result.rendering = fx.assessRendering(assessed.dom, log.slice(beforeNav), windowNavigation);
  if (!(await fx.stopOwned())) state.cleanupOk = false;
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
  if (!(await fx.stopOwned()) || childPids().length || sessionPids(main.pid).length || namingPids(state.scratch).length)
    throw new Fail("primary-browser-cleanup-unproven");
  guard();
  result.primaryChildrenStoppedBeforeControl = true;
  const ctrl = fx.launch("control-data", ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--virtual-time-budget=10000", "--dump-dom", state.listener.mintNavigation()]);
  const control = await fx.sampleRun(ctrl, { window: 4000 });
  result.negativeControl = { dataDirectoryFresh: ctrl.check.fresh && ctrl.check.mode === "0700", ...control };
  expect(control.samplesWithHeld >= 1, "negative control: no sample found its debugging listener held");
  expect(control.samplesWithDevToolsActivePort >= 1, "negative control: no sample found DevToolsActivePort");
  expect(control.samplesWithSwitch >= 1, "negative control: no sample found the debugging switch");
  expect(control.unreadable === 0 && control.netUnreadable === 0 && control.cmdlineUnreadable === 0, "negative control: unreadable tables");
  if (!(await fx.stopOwned())) state.cleanupOk = false;
  expect(sessionPids(ctrl.pid).length === 0, "control browser session survived");

  conclude("fresh-browser-data-fixture-passed");
}

function conclude(code) {
  guard();
  if (MUTATION || fx.ANNOUNCE) failures.push("test-hook-active");
  if (!failures.length) { state.exitCode = 0; result.ok = true; result.code = code; }
}

if (supervised) {
  await fx.supervise(run, { allowPrivateDisplay: true, limitations: privateDisplay ? ["windowed Chromium on an owned Xvfb display; human desktop acceptance remains open",
    "selected listener view and mapped browser window; no DOM verification in this mode",
    "TCP listeners sampled; broader automation paths and runtime support remain open"] : ["no-debugging evidence comes from the --dump-dom run only; no CDP or pipe is used",
    "one fixture-owned headless browser, not the human's window",
    "agent control is network-namespace only; an agent-started browser is not launched (see strict-agent-browser-probe.mjs)",
    "TCP listeners only, sampled about every 50 ms plus scan time; a listener that exists only between samples is missed",
    "Unix-domain and abstract automation sockets are not measured",
    "the pin covers the chrome ELF only, not bundled libraries or crashpad", "measured host only"] });
}
