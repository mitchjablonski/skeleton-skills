#!/usr/bin/env node
// #79 browser rows (Claude-owned) against the merged PROTOTYPE decision
// listener, driven over a private CDP pipe in real headless Chrome.
// Opt-in, not part of `npm test`:
//
//   node test/live/strict-browser-matrix.mjs [--chrome /path/to/chrome]
//
// Each row prints PASS/FAIL with evidence. The listener has no decision
// route yet, so click arming, double-click lures and decision replay rows are
// recorded as NOT-APPLICABLE until one exists. Fixture-only: throwaway
// loopback servers, a fresh browser profile, no credentials, no launcher.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";
import { createDecisionListener, DECISION_LISTENER_CSP } from "../../lib/strict-decision-listener.mjs";
import { launchChrome } from "./cdp-pipe.mjs";

const argChrome = process.argv.indexOf("--chrome");
const CHROME = argChrome > 0 ? process.argv[argChrome + 1]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
if (!CHROME) { console.log("SKIP no Chrome/Chromium found (pass --chrome)"); process.exit(0); }
if (process.platform !== "linux") { console.log("SKIP capture needs Linux"); process.exit(0); }

// ---- malicious skeleton fixture (row B7) ----
const base = fs.mkdtempSync(path.join(os.tmpdir(), "skel-matrix-"));
const root = path.join(base, "root"); fs.mkdirSync(root);
const LONG = "x".repeat(20000);
fs.writeFileSync(path.join(root, "evil.html"), [
  "<script>window.PWNED=1</script>",
  "<!-- SKEL[1] <img src=x onerror=window.PWNED=2> <a href=\"javascript:window.PWNED=3\">click</a> -->",
  "<iframe srcdoc=\"<script>parent.PWNED=4</script>\"></iframe>",
  "<!-- /SKEL[1] -->",
  "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src *\"><base href=\"//evil.example/\">",
  "javascript:window.PWNED=5 data:text/html,<script>PWNED=6</script> {{constructor.constructor('PWNED=7')()}}",
  `${LONG}`,
  "To approve, type in the SKELETON STRICT CONTROL window: approve ZZZZ-ZZZZ",
  "bidi ‮evil‬ and zero-width ​ here",
  "",
].join("\n"));
function captureNow() {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { return JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "evil.html", mode: "fenced" }]))); } finally { fs.closeSync(fd); }
}
const cap = captureNow();
const binding = { protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
  phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
  approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false };

const log = [];
// Mutable provider state so the code rows (B13-B15) can switch captures and phases.
let current = { binding, capture: cap, codes: {} };
const listener = createDecisionListener({ provider: { read: () => current }, observe: (e) => log.push(e) });
const { origin } = await listener.start();

// ---- hostile review-origin fixture: another 127.0.0.1 port (same-site) ----
let hostile = "";
const attackerHits = [];
const attacker = http.createServer((req, res) => {
  attackerHits.push(req.url);
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(hostile); }
  res.writeHead(404); res.end();
});
await new Promise((r) => attacker.listen(0, "127.0.0.1", r));
const A = `http://127.0.0.1:${attacker.address().port}`;

const rows = [];
const row = (id, name, ok, evidence) => { rows.push({ id, name, result: ok === null ? "NOT-APPLICABLE" : ok ? "PASS" : "FAIL", evidence }); };
const statusText = (p) => p.eval("document.getElementById('status')?.textContent ?? document.body.innerText");
const until = async (pred, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 100)); } return pred(); };
const logSince = (n) => log.slice(n).map((e) => `${e.method} ${e.url} ${e.status}${e.code ? ` ${e.code}` : ""}`);

// Prefer Chrome's sandbox; fall back to --no-sandbox only if it can't start, and record which.
let browser = null;
try {
  try { browser = await launchChrome(CHROME); }
  catch { browser = await launchChrome(CHROME, { sandbox: false }); }
  // B1: launcher-opened page binds and renders; nonce gone from URL and history.
  const url1 = listener.mintNavigation();
  const nonce1 = new URL(url1).hash.slice(3);
  const tabA = await browser.newPage();
  await tabA.goto(url1);
  const rendered = await tabA.waitUntil("!!document.querySelector('[data-strict-capture]')");
  const href = await tabA.eval("location.href");
  const hist = await tabA.send("Page.getNavigationHistory");
  const histHasNonce = hist.entries.some((e) => e.url.includes(nonce1));
  row("B1", "launcher URL binds and renders; nonce stripped from location and history", rendered && !href.includes("#") && !histHasNonce,
    { href, history: hist.entries.map((e) => e.url) });

  // B7: malicious skeleton renders inert, no CSP/Trusted Types violations.
  const inert = await tabA.eval(`(() => { const v = document.getElementById('view');
    return { pwned: window.PWNED ?? null, scripts: v.querySelectorAll('script').length, links: v.querySelectorAll('a,iframe,img,meta,base').length,
      longLine: [...v.querySelectorAll('.line-text')].some((n) => n.textContent.length === ${LONG.length}),
      escaped: v.querySelectorAll('[data-line-invisible]').length, titleText: v.querySelector('.fence-title')?.textContent ?? '' }; })()`);
  const doc = tabA.documents.find((d) => new URL(d.url).pathname === "/" && d.status === 200);
  const cspHeader = doc && Object.entries(doc.headers).find(([k]) => k.toLowerCase() === "content-security-policy")?.[1];
  const violationsBefore = tabA.csp.length;
  // Positive controls: under the served policy an HTML sink must throw and an
  // injected inline script must not run. Without the policy both succeed.
  const controls = await tabA.eval(`(() => { let sinkBlocked = false;
    try { document.createElement('div').innerHTML = '<b>x</b>'; } catch { sinkBlocked = true; }
    const sc = document.createElement('script'); try { sc.text = 'window.INLINE_RAN = 1'; } catch {} document.body.append(sc);
    return { sinkBlocked, inlineRan: window.INLINE_RAN === 1 }; })()`);
  row("B7", "malicious skeleton renders inert under the exact served CSP/Trusted Types policy (header checked, sink and inline-script controls blocked)",
    cspHeader === DECISION_LISTENER_CSP && controls.sinkBlocked && !controls.inlineRan && violationsBefore === 0
      && inert.pwned === null && inert.scripts === 0 && inert.links === 0 && inert.longLine && inert.escaped >= 1 && inert.titleText.includes("<img"),
    { ...inert, cspHeader, controls, violationsDuringRender: tabA.csp.slice(0, violationsBefore) });

  // B2: reload refuses with the static page; nothing re-binds.
  let n = log.length;
  await tabA.reload();
  const reloadText = await tabA.eval("document.body.innerText");
  // Note: this checks Chrome's behaviour after the app's history.replaceState
  // (a CDP Page.reload then goes out as same-origin and is refused). Without
  // replaceState the reload would carry Sec-Fetch-Site none and get the shell,
  // and only the spent nonce would keep the capture hidden.
  row("B2", "reload (CDP Page.reload after the app strips the nonce) is refused with the static page; no capture",
    /can only be opened from the launcher's control window/.test(reloadText) && log.slice(n).some((e) => e.url === "/" && e.code === "document-site")
      && !(await tabA.eval("!!document.querySelector('[data-strict-capture]')")),
    { text: reloadText.trim(), listener: logSince(n) });

  // B3: the spent nonce URL, opened again, is refused.
  n = log.length;
  await tabA.goto("about:blank"); // "/" -> "/#n=" alone would be a same-document fragment change
  await tabA.goto(url1);
  await tabA.waitUntil("/already used|expired|no fresh link/.test(document.getElementById('status')?.textContent ?? '')");
  row("B3", "a spent nonce URL opened again is refused", /already used or has expired/.test(await statusText(tabA)),
    { status: await statusText(tabA), listener: logSince(n) });

  // B4: a second tab on the bare origin gets no binding.
  const tabB = await browser.newPage();
  await tabB.goto(`${origin}/`);
  await tabB.waitUntil("/fresh link/.test(document.getElementById('status')?.textContent ?? '')");
  n = log.length;
  const bView = await tabB.eval("fetch('/api/view').then((r) => r.status)");
  row("B4", "a second tab without a fresh link shows no binding, and the server refuses its view read (tab-binding)",
    /no fresh link/.test(await statusText(tabB)) && bView === 403 && log.slice(n).some((e) => e.url === "/api/view" && e.code === "tab-binding"),
    { status: await statusText(tabB), viewStatus: bView, listener: logSince(n) });

  // B12: the nonce comparison itself: a wrong one-key nonce, sent same-origin
  // while a real one is pending, is refused with "nonce"; the real one still binds.
  const urlN = listener.mintNavigation();
  n = log.length;
  const wrong = await tabB.eval(`fetch('/api/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: '${"B".repeat(43)}' }) }).then((r) => r.status)`);
  const wrongCode = log.slice(n).find((e) => e.url === "/api/bind")?.code;
  const tabN = await browser.newPage();
  await tabN.goto(urlN);
  const nOk = await tabN.waitUntil("!!document.querySelector('[data-strict-capture]')");
  row("B12", "a wrong nonce sent same-origin while a real one is pending is refused (code nonce); the real one still binds",
    wrong === 403 && wrongCode === "nonce" && nOk, { wrongStatus: wrong, wrongCode, realBinds: nOk });

  // B5: stale tab after reopen: the old tab's Re-read is refused, the new tab works.
  const url2 = listener.mintNavigation();
  const tabC = await browser.newPage();
  await tabC.goto(url2);
  await tabC.waitUntil("!!document.querySelector('[data-strict-capture]')");
  const url3 = listener.mintNavigation();
  const tabD = await browser.newPage();
  await tabD.goto(url3);
  const dOk = await tabD.waitUntil("!!document.querySelector('[data-strict-capture]')");
  await tabC.eval("document.getElementById('reread').click()");
  await tabC.waitUntil("/no longer the live/.test(document.getElementById('status').textContent)");
  const cText = await statusText(tabC);
  const cCleared = await tabC.eval("document.getElementById('view').childElementCount === 0");
  n = log.length;
  await tabD.eval("document.getElementById('reread').click()");
  await until(() => log.slice(n).some((e) => e.url === "/api/view"));
  await tabD.waitUntil("!document.getElementById('reread').disabled");
  const dStill = await tabD.eval("!!document.querySelector('[data-strict-capture]')");
  row("B5", "after reopen, the stale tab's Re-read is refused and cleared; the new tab keeps working",
    dOk && /no longer the live decision page/.test(cText) && cCleared && dStill, { stale: cText, staleCleared: cCleared, freshStillRenders: dStill });

  // B6: hostile same-site origin: form POST, prefetch of the nonce URL, top-level
  // navigation, iframe, fetches. Nonce must survive; the live tab keeps working.
  const url4 = listener.mintNavigation();
  const nonce4 = new URL(url4).hash.slice(3);
  hostile = `<!doctype html><body>
<link rel="prefetch" href="${url4}"><link rel="prerender" href="${url4}">
<iframe name="sink"></iframe>
<form id="f" method="POST" action="${origin}/api/bind" enctype="text/plain" target="sink"><input name='{"nonce":"${nonce4}","x":"' value='"}'></form>
<iframe src="${origin}/"></iframe>
<script>
navigator.sendBeacon("/ran"); // positive control: the hostile script ran
document.getElementById("f").submit();
fetch("${origin}/api/view", { mode: "no-cors" }).catch(() => {}); // simple GET: no preflight, reaches the listener
fetch("${origin}/api/bind", { method: "POST", mode: "no-cors", body: JSON.stringify({ nonce: "${nonce4}" }) }).catch(() => {});
fetch("${origin}/api/view", { headers: { "x-skel-tab": "${"A".repeat(43)}" } }).catch(() => {});
setTimeout(() => { location.href = "${url4}"; }, 1500);
</script></body>`;
  n = log.length;
  const tabE = await browser.newPage();
  await tabE.goto(`${A}/`);
  const ran = await until(() => attackerHits.includes("/ran"));
  // The iframe and prefetch alone produce refused document GETs, so prove the
  // top-level navigation itself: the hostile tab must end up on the listener
  // origin showing the static refusal page.
  const navSeen = await tabE.waitUntil(`location.origin === ${JSON.stringify(origin)}
    && /can only be opened from the launcher's control window/.test(document.body.innerText)`, 15000);
  const eText = await tabE.eval("document.body.innerText").catch(() => "");
  const reached = logSince(n);
  const anyOk = log.slice(n).some((e) => e.status < 400 && !e.url.startsWith("/assets/"));
  // The top-level navigation to url4 uses Sec-Fetch-Site same-site (initiated
  // by the hostile page), so the document is refused and the app never runs.
  // Now prove the nonce is unconsumed: a launcher-style open in a clean tab binds.
  const tabF = await browser.newPage();
  await tabF.goto(url4);
  const fOk = await tabF.waitUntil("!!document.querySelector('[data-strict-capture]')");
  const has = (method, url, code) => log.slice(n).some((e) => e.method === method && e.url === url && (!code || e.code === code));
  const expected = { ran, formOrBeaconBind: has("POST", "/api/bind", "same-origin-required"), preflight: has("OPTIONS", "/api/view"),
    simpleView: has("GET", "/api/view", "same-origin-required"), iframeRefused: has("GET", "/", "document-site"), topLevelNavigationRefused: navSeen };
  row("B6", "hostile same-site origin: its script runs, and form POST, no-cors bind, simple and preflighted view reads, iframe and top-level navigation all reach the listener and are refused; the nonce still binds",
    Object.values(expected).every(Boolean) && !anyOk && fOk && !/data-strict-capture/.test(eText),
    { expected, listener: reached, hostileTabText: eText.slice(0, 160), nonceStillBinds: fOk });

  // B8: a leaked review-server token or cookie grants nothing.
  n = log.length;
  const leak = await tabB.eval(`(async () => {
    const out = [];
    for (const h of [{ "x-skeleton-token": "leaked" }, { authorization: "Bearer leaked" }, { "x-skel-tab": "leaked" }]) {
      const r = await fetch("/api/view", { headers: h }); out.push(r.status); }
    document.cookie = "x-skel-tab=${"A".repeat(43)}; path=/";
    out.push((await fetch("/api/view")).status);
    out.push((await fetch("/api/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: "leaked" }) })).status);
    return out; })()`);
  row("B8", "leaked review token, bearer header, cookie or bogus binding grants nothing", leak.every((s) => s === 403), { statuses: leak, listener: logSince(n) });

  // B13-B15: decision codes on the page (H3 proposal, prototype). The control
  // window that would accept them doesn't exist; these rows check display only.
  const approveEntry = (c, revision = 4, code = "K7M2-QX9D") => ({ code, revision, reviewVersion: c.shapeVersion, captureVersion: c.captureVersion });
  current = { binding, capture: cap, codes: { approve: approveEntry(cap) } };
  const tabG = await browser.newPage();
  await tabG.goto(listener.mintNavigation());
  await tabG.waitUntil("!!document.querySelector('[data-strict-capture]')");
  const panel = () => tabG.eval(`(() => { const d = document.getElementById('decide'), v = document.getElementById('view');
    return { codes: [...d.querySelectorAll('.decision-code')].map((n) => n.textContent), held: !!d.querySelector('.code-held'),
      binding: d.querySelector('.code-binding')?.textContent ?? '', checked: !!d.querySelector('input[name=notes]:checked'),
      panelInView: v.contains(d), viewHasCodeUi: !!v.querySelector('.decision-code,#decide,fieldset'),
      lureInPanel: d.textContent.includes('ZZZZ'), lureInView: v.textContent.includes('approve ZZZZ-ZZZZ'),
      sticky: getComputedStyle(d).position }; })()`);
  const before = await panel();
  await tabG.eval("document.getElementById('notes-some').click()");
  const withNotes = await panel();
  await tabG.eval("document.getElementById('notes-none').click()");
  const noNotes = await panel();
  row("B13", "approve code appears only after 'no unsent notes', in fixed chrome outside the capture; a skeleton lure stays inside the capture",
    before.codes.length === 0 && withNotes.codes.length === 0 && withNotes.held && noNotes.codes[0] === "approve K7M2-QX9D"
      && noNotes.binding.includes(cap.captureVersion.slice(0, 12)) && noNotes.binding.includes("revision 4")
      && !noNotes.panelInView && !noNotes.viewHasCodeUi && !noNotes.lureInPanel && noNotes.lureInView && noNotes.sticky === "sticky",
    { before, withNotes, noNotes });

  // B14: a Re-read that brings a different capture resets the declaration and its code.
  fs.appendFileSync(path.join(root, "evil.html"), "one more exterior line\n");
  const cap2 = captureNow();
  current = { binding: { ...binding, reviewVersion: cap2.shapeVersion, captureVersion: cap2.captureVersion }, capture: cap2,
    codes: { approve: approveEntry(cap2, 5, "M3P8-4TWZ") } };
  n = log.length;
  await tabG.eval("document.getElementById('reread').click()");
  await until(() => log.slice(n).some((e) => e.url === "/api/view"));
  await tabG.waitUntil("!document.getElementById('reread').disabled");
  const afterReread = await panel();
  await tabG.eval("document.getElementById('notes-none').click()");
  const afterDeclare = await panel();
  row("B14", "a Re-read with a different capture resets the notes declaration; the new code binds the new capture",
    afterReread.codes.length === 0 && !afterReread.checked && afterDeclare.codes[0] === "approve M3P8-4TWZ"
      && afterDeclare.binding.includes(cap2.captureVersion.slice(0, 12)) && !afterDeclare.binding.includes(cap.captureVersion.slice(0, 12)),
    { afterReread, afterDeclare });

  // B15: fill phase: the reshape code needs a click and an acknowledgement.
  current = { binding: { ...binding, phase: "fill", reviewVersion: cap2.shapeVersion, captureVersion: cap2.captureVersion,
    approvedVersion: cap2.shapeVersion, approvedCaptureVersion: cap2.captureVersion }, capture: cap2,
    codes: { reshape: approveEntry(cap2, 6, "R5H9-2KQV") } };
  const tabH = await browser.newPage();
  await tabH.goto(listener.mintNavigation());
  await tabH.waitUntil("!!document.getElementById('show-reshape')");
  const codesNow = () => tabH.eval("[...document.querySelectorAll('#decide .decision-code')].map((x) => x.textContent)");
  const r0 = await codesNow();
  await tabH.eval("document.getElementById('show-reshape').click()");
  const r1 = await codesNow();
  await tabH.eval("document.getElementById('reshape-ack').click()");
  const r2 = await codesNow();
  await tabH.eval("document.getElementById('reshape-ack').click()");
  const r3 = await codesNow();
  row("B15", "fill: the reshape code appears only after 'Show' and the acknowledgement, and hides again if unchecked",
    r0.length === 0 && r1.length === 0 && r2[0] === "reshape R5H9-2KQV" && r3.length === 0, { r0, r1, r2, r3 });

  // B16: a failed Re-read after "no notes" leaves no code panel (and no capture).
  current = { binding, capture: cap, codes: { approve: approveEntry(cap) } };
  const tabI = await browser.newPage();
  await tabI.goto(listener.mintNavigation());
  await tabI.waitUntil("!!document.querySelector('[data-strict-capture]')");
  await tabI.eval("document.getElementById('notes-none').click()");
  const iBefore = await tabI.eval("document.querySelectorAll('#decide .decision-code').length");
  current = { read() { throw new Error("store offline"); } };
  n = log.length;
  await tabI.eval("document.getElementById('reread').click()");
  await until(() => log.slice(n).some((e) => e.url === "/api/view"));
  await tabI.waitUntil("!document.getElementById('reread').disabled");
  const iAfter = await tabI.eval("({ panel: document.getElementById('decide').childElementCount, view: document.getElementById('view').childElementCount })");
  row("B16", "a Re-read that fails after 'no notes' was chosen clears the code panel and the capture",
    iBefore === 1 && iAfter.panel === 0 && iAfter.view === 0, { codesBefore: iBefore, after: iAfter, listener: logSince(n) });

  // B17: codes the listener drops never reach the panel; the capture still shows.
  const dropCases = {
    pendingNotes: { binding: { ...binding, pendingNotes: true }, capture: cap, codes: { approve: approveEntry(cap) } },
    otherCapture: { binding, capture: cap, codes: { approve: approveEntry(cap2) } },
    reshapeNotRendered: { binding: { ...binding, phase: "fill", approvedVersion: cap2.shapeVersion, approvedCaptureVersion: cap2.captureVersion },
      capture: cap, codes: { reshape: approveEntry(cap2) } },
    donePhase: { binding: { ...binding, phase: "done", approvedVersion: cap.shapeVersion, approvedCaptureVersion: cap.captureVersion }, capture: cap, codes: {} },
  };
  const drops = {};
  for (const [name, state] of Object.entries(dropCases)) {
    current = state;
    const t = await browser.newPage();
    await t.goto(listener.mintNavigation());
    await t.waitUntil("!!document.querySelector('[data-strict-capture]')");
    drops[name] = await t.eval("({ panel: document.getElementById('decide').childElementCount, reshapeButton: !!document.getElementById('show-reshape'), status: document.getElementById('status').textContent, rule: !!document.querySelector('.code-rule') })");
    await t.close();
  }
  row("B17", "dropped codes (pending notes, another capture, reshape when the rendered pair isn't the approved pair) and the done phase show no code panel; the capture still shows",
    Object.values(drops).every((d) => d.panel === 0 && !d.reshapeButton && d.rule)
      && ["pendingNotes", "otherCapture", "reshapeNotRendered"].every((k) => /don't match this capture/.test(drops[k].status)), drops);

  // B18: the page's own re-check. A fake server (same app and assets) sends codes
  // for another capture without marking them dropped; the page must show none.
  current = { binding, capture: cap, codes: {} };
  const realTab = JSON.parse(await new Promise((resolve) => {
    const r = http.request(`${origin}/api/bind`, { method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" } },
      (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(b)); });
    r.end(JSON.stringify({ nonce: new URL(listener.mintNavigation()).hash.slice(3) }));
  })).tab;
  const fetchListener = (url, headers) => new Promise((resolve) => http.get(`${origin}${url}`, { headers }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(b)); }));
  const shellHtml = await fetchListener("/", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" });
  const realView = JSON.parse(await fetchListener("/api/view", { "sec-fetch-site": "same-origin", "x-skel-tab": realTab })).view;
  const fake = http.createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(shellHtml); }
    const m = /^\/assets\/([a-z-]+\.(?:mjs|css))$/.exec(req.url);
    if (m) { res.writeHead(200, { "content-type": m[1].endsWith(".css") ? "text/css" : "text/javascript" }); return res.end(fs.readFileSync(new URL(`../../lib/${m[1]}`, import.meta.url))); }
    if (req.url === "/api/bind") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ tab: "F".repeat(43) })); }
    if (req.url === "/api/view") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ view: realView, codes: { approve: approveEntry(cap2) }, codesDropped: false })); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const tabK = await browser.newPage();
  await tabK.goto(`http://127.0.0.1:${fake.address().port}/#n=${"Q".repeat(43)}`);
  await tabK.waitUntil("!!document.querySelector('[data-strict-capture]')");
  const k = await tabK.eval("({ panel: document.getElementById('decide').childElementCount, status: document.getElementById('status').textContent })");
  fake.close();
  row("B18", "the page re-checks codes itself: codes for another capture sent as valid are not shown",
    k.panel === 0 && /don't match this capture/.test(k.status), k);

  // Rows that need a decision route (not in the prototype).
  row("B9", "Approve arms late after focus/visibility and needs a separate confirm", null, "no decision route in the prototype");
  row("B10", "double-click lure and focus steal from the review origin don't approve", null, "no decision route in the prototype");
  row("B11", "duplicate action / Retry dedupe through the real transport", null, "no decision route in the prototype");
} finally {
  if (browser) await browser.close();
  await listener.close();
  attacker.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

console.log(JSON.stringify({ chrome: browser?.product, chromeSandbox: browser?.sandbox, node: process.version, rows }, null, 2));
const failed = rows.filter((r) => r.result === "FAIL");
for (const r of rows) console.log(`${r.result.padEnd(14)} ${r.id} ${r.name}`);
if (failed.length) { console.error(`FAIL ${failed.map((r) => r.id).join(", ")}`); process.exit(1); }
console.log("PASS");
