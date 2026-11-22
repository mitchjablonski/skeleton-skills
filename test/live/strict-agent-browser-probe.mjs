#!/usr/bin/env node
// Opt-in Linux C20 second slice (#77 / #79): an agent-started debugging browser
// never receives the decision page that the launcher opens.
//
//   node test/live/strict-agent-browser-probe.mjs [--chrome-sha256 <hex>]
//
// The fixture:
//   1. pins the browser (SHA-256 of the resolved ELF, compared before any run);
//   2. starts an "agent" headless Chrome on about:blank in its OWN fresh data
//      directory with --remote-debugging-port=0, reads its port from
//      DevToolsActivePort and keeps it running throughout;
//   3. starts the read-only decision listener, mints the one-time URL and opens
//      it on the #213 primary path: a fresh launcher data directory,
//      --dump-dom, no debugging switch, Chrome's default sandbox, sampled while
//      it runs (switches, port file, held TCP listeners). It must render, with
//      bind and view 200s;
//   4. polls the agent's GET /json/list (the fixture-owned port only) before,
//      during and after the launcher run: no target may name the listener
//      origin and the agent's page targets must not change. Every bind and
//      view the listener saw falls inside the launcher run: exactly one bind;
//   5. singleton handoff: with a second nonce, starts the pinned Chrome on the
//      URL with the AGENT's data directory (no --dump-dom) and records what
//      happens (forward, lock refusal or second instance);
//   6. negative control, so the check is shown to detect a page arriving in the
//      agent browser: if the singleton did not forward, a third nonce is opened
//      in the agent through `PUT /json/new` on its fixture-owned port, and
//      /json/list must then show the listener origin;
//   7. stops every browser (the agent too) and the listener, proves nothing
//      remains, and only then removes the scratch root. Signals and the
//      watchdog run the same cleanup (exit 1).
// It connects to nothing but the fixture's listener and the agent's port.
// Never human proof, never a support claim.
//
// Exit 0: passed. Exit 1: a check or cleanup failed (scratch retained; its
// path goes to stderr only). Exit 2: unsupported (not Linux, no Chrome or
// Chromium, no Bubblewrap or system Python, a pin mismatch, no sandbox
// evidence, the agent browser can't start, or the sandboxed launcher browser
// can't start: `browser-sandbox-unavailable`).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDecisionListener } from "../../lib/strict-decision-listener.mjs";
import { MAX, sleep, runOuter, sessionPids, Fail, buildFixtureCapture, renderingOf, createFixture } from "./strict-browser-fixture.mjs";

const PREFIX = "strict-agent-browser-";
const SELF = fileURLToPath(import.meta.url);
if (process.argv[2] !== "--supervised") runOuter(SELF);

const fx = createFixture({ prefix: PREFIX });
const { result, state, failures, expect, guard } = fx;

/** GET /json/list on the agent's fixture-owned loopback port; bounded. */
function jsonList(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 2000 }, (res) => {
      let body = Buffer.alloc(0);
      res.on("data", (c) => { body = Buffer.concat([body, c]); if (body.length > MAX * 8) req.destroy(new Error("too large")); });
      res.on("end", () => {
        try { const list = JSON.parse(body.toString("utf8")); if (!Array.isArray(list)) throw new Error("shape"); resolve(list); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
/** CDP HTTP `PUT /json/new?<url>` on the agent's fixture-owned port (negative control only). */
function jsonNew(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/json/new?${encodeURIComponent(url)}`, timeout: 5000 }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
const pageSignature = (list) => list.filter((t) => t.type === "page").map((t) => String(t.url)).sort().join("\n");

/** Background poller of the agent's targets; phases label when each poll happened. */
function startPoller(port, origin) {
  const p = { phase: "before", polls: {}, errors: 0, originSeen: {}, maxTargets: 0, pageSignatures: new Set(), stop: false, last: null };
  p.done = (async () => {
    while (!p.stop && !state.aborted) {
      try {
        const list = await jsonList(port);
        p.last = list;
        p.polls[p.phase] = (p.polls[p.phase] ?? 0) + 1;
        p.maxTargets = Math.max(p.maxTargets, list.length);
        if (list.some((t) => String(t.url).includes(origin))) p.originSeen[p.phase] = true;
        p.pageSignatures.add(pageSignature(list));
      } catch { p.errors++; }
      await sleep(100);
    }
  })();
  return p;
}

async function run(pin) {
  fx.pinBrowser(pin, null);
  await fx.prepare();

  // 1. The agent's debugging browser, on about:blank, in its own data directory.
  const agent = fx.launch("agent-data", ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "about:blank"]);
  let agentPort = null;
  for (let i = 0; i < 150 && agentPort === null && agent.exit === null; i++) {
    guard();
    try {
      const raw = fs.readFileSync(path.join(agent.dir, "DevToolsActivePort"), "utf8");
      const lines = raw.split("\n");
      const n = Number(lines[0]);
      if (raw.length <= 512 && Number.isInteger(n) && n > 0 && n < 65536 && /^\/devtools\/browser\//.test(lines[1] ?? "")) agentPort = n;
    } catch { /* not yet */ }
    await sleep(100);
  }
  if (agentPort === null) throw new Fail("agent-browser-cannot-start", true, "agent-browser-unavailable");
  await sleep(2000); // let the agent's own background targets settle before the baseline
  guard();
  const baseline = await jsonList(agentPort);
  result.agentBrowser = { dataDirectoryFresh: agent.check.fresh && agent.check.mode === "0700", debuggingPort: "loopback, fixture-owned",
    baselineTargets: baseline.length, baselinePageTargets: baseline.filter((t) => t.type === "page").length };

  // 2. The listener, then the launcher open on the #213 primary path.
  const { cap, binding } = buildFixtureCapture(state.scratch);
  const log = [];
  state.listener = createDecisionListener({ provider: { read: () => ({ binding, capture: cap }) }, observe: (e) => log.push(e) });
  const { origin } = await state.listener.start();
  const poller = startPoller(agentPort, origin);
  await sleep(500);
  guard();

  poller.phase = "during";
  const beforeLaunch = log.length;
  const main = fx.launch("launcher-data", ["--virtual-time-budget=10000", "--dump-dom", state.listener.mintNavigation()], { primary: true });
  state.exitCode = 1; result.code = "fixture-failed";
  result.dataDirectory = main.check;
  const agg = await fx.sampleRun(main);
  const afterLaunch = log.length;
  poller.phase = "after";
  const assessed = fx.assessPrimary(main, agg);
  result.remoteDebugging = assessed.block;
  if (assessed.unavailable) throw new Fail("browser-sandbox-unavailable", true, "browser-sandbox-unavailable");
  if (!assessed.ranClean) throw new Fail("browser-run-failed");
  result.rendering = renderingOf(assessed.dom, log.slice(beforeLaunch, afterLaunch));
  expect(result.rendering.capture, "dumped DOM has no capture view");
  expect(/Showing stored capture/.test(result.rendering.status), "status does not say showing");
  expect(!result.rendering.imgInView && result.rendering.hostileTitleAsText, "hostile title not rendered as text");
  expect(result.rendering.bindOk && result.rendering.viewOk, "listener did not serve bind and view");
  if (!(await fx.stopOwned(agent))) state.cleanupOk = false; // the launcher's leftovers only; the agent keeps running
  expect(sessionPids(main.pid).length === 0, "launcher browser session survived");
  await sleep(1500); // keep polling the agent after the launcher run
  guard();

  // 3. The agent browser never received the page.
  const binds = log.filter((e) => e.url === "/api/bind"), views = log.filter((e) => e.url === "/api/view");
  const inLaunch = (e) => { const i = log.indexOf(e); return i >= beforeLaunch && i < afterLaunch; };
  const finalList = poller.last ?? [];
  result.agentNeverReceived = {
    polls: { ...poller.polls }, pollErrors: poller.errors, originSeen: Object.keys(poller.originSeen).length > 0,
    pageTargetsUnchanged: poller.pageSignatures.size === 1 && poller.pageSignatures.has(pageSignature(baseline)),
    finalTargets: finalList.length, finalPageTargets: finalList.filter((t) => t.type === "page").length,
    binds: binds.length, bindsOk: binds.filter((e) => e.status === 200).length, views: views.length,
    allBindsAndViewsInLauncherRun: [...binds, ...views].every(inLaunch),
  };
  const r = result.agentNeverReceived;
  expect((poller.polls.before ?? 0) >= 1 && (poller.polls.during ?? 0) >= 2 && (poller.polls.after ?? 0) >= 2, "agent targets not polled before, during and after");
  expect(!r.originSeen, "an agent browser target named the listener origin");
  expect(r.pageTargetsUnchanged, "the agent browser's page targets changed");
  expect(r.binds === 1 && r.bindsOk === 1 && r.views >= 1 && r.allBindsAndViewsInLauncherRun, "binds or views outside the launcher run");
  expect(r.pollErrors === 0, "agent target poll failed");

  // 4. Singleton handoff with a second nonce: the agent's data directory, no --dump-dom.
  poller.phase = "singleton";
  const beforeSingleton = log.length;
  const handoff = fx.launch("singleton-handoff", [state.listener.mintNavigation()], { existingDir: agent.dir });
  await Promise.race([handoff.exited, sleep(10000)]);
  await sleep(1500);
  guard();
  const stderr = handoff.err.toString("utf8");
  result.singleton = {
    exited: handoff.exit !== null, exitCode: handoff.exit?.code ?? null, exitSignal: handoff.exit?.signal ?? null,
    lockRefusal: /SingletonLock|ProcessSingleton/.test(stderr),
    forwardedToAgent: !!poller.originSeen.singleton,
    listenerRequests: log.length - beforeSingleton,
    secondInstance: handoff.exit === null,
  };
  if (!(await fx.stopOwned(agent))) state.cleanupOk = false; // the handoff process and anything it left
  guard();

  // 5. Negative control: show the check detects a page arriving in the agent browser.
  if (result.singleton.forwardedToAgent) {
    result.negativeControl = { method: "singleton-forward", originSeenInAgent: true };
  } else {
    poller.phase = "control";
    const beforeControl = log.length;
    const status = await jsonNew(agentPort, state.listener.mintNavigation());
    for (let i = 0; i < 100 && !poller.originSeen.control; i++) { await sleep(100); guard(); }
    await sleep(1000);
    result.negativeControl = { method: "cdp-json-new", status, originSeenInAgent: !!poller.originSeen.control,
      listenerBindsFromAgent: log.slice(beforeControl).filter((e) => e.url === "/api/bind").length };
  }
  expect(result.negativeControl.originSeenInAgent, "negative control: a page opened in the agent browser was not seen");
  poller.stop = true;
  await poller.done;

  guard();
  if (fx.ANNOUNCE) failures.push("test-hook-active");
  if (!failures.length) { state.exitCode = 0; result.ok = true; result.code = "agent-browser-fixture-passed"; }
}

if (process.argv[2] === "--supervised") {
  await fx.supervise(run, { limitations: ["no-debugging evidence for the launcher comes from its --dump-dom run only",
    "the agent browser is fixture-started on the same host and user, polled over its own loopback port; an agent using other channels (CDP pipe, extensions, shared files) is not modelled",
    "page targets are compared; the agent's own background and service-worker targets may come and go",
    "TCP listeners only, sampled about every 50 ms plus scan time; a listener that exists only between samples is missed",
    "the pin covers the chrome ELF only, not bundled libraries or crashpad", "measured host only"] });
}
