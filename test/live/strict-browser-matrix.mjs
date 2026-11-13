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
import { createDecisionListener } from "../../lib/strict-decision-listener.mjs";
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
  "bidi ‮evil‬ and zero-width ​ here",
  "",
].join("\n"));
const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
let cap;
try { cap = JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "evil.html", mode: "fenced" }]))); } finally { fs.closeSync(fd); }
const binding = { protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
  phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
  approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false };

const log = [];
const listener = createDecisionListener({ provider: { read: () => ({ binding, capture: cap }) }, observe: (e) => log.push(e) });
const { origin } = await listener.start();

// ---- hostile review-origin fixture: another 127.0.0.1 port (same-site) ----
let hostile = "";
const attacker = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(hostile); }
  res.writeHead(404); res.end();
});
await new Promise((r) => attacker.listen(0, "127.0.0.1", r));
const A = `http://127.0.0.1:${attacker.address().port}`;

const rows = [];
const row = (id, name, ok, evidence) => { rows.push({ id, name, result: ok === null ? "NOT-APPLICABLE" : ok ? "PASS" : "FAIL", evidence }); };
const statusText = (p) => p.eval("document.getElementById('status')?.textContent ?? document.body.innerText");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logSince = (n) => log.slice(n).map((e) => `${e.method} ${e.url} ${e.status}${e.code ? ` ${e.code}` : ""}`);

const browser = await launchChrome(CHROME);
try {
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
  row("B7", "malicious skeleton (HTML, javascript:/data: URLs, CSP meta, base, template injection, 20k line, bidi) renders inert",
    inert.pwned === null && inert.scripts === 0 && inert.links === 0 && inert.longLine && inert.escaped >= 1 && inert.titleText.includes("<img") && tabA.csp.length === 0,
    { ...inert, cspViolations: tabA.csp });

  // B2: reload refuses with the static page; nothing re-binds.
  let n = log.length;
  await tabA.reload();
  const reloadText = await tabA.eval("document.body.innerText");
  row("B2", "reload is refused with the static reopen page (no JSON, no capture)",
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
  row("B4", "a second tab without a fresh link gets no binding", /no fresh link/.test(await statusText(tabB)), { status: await statusText(tabB) });

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
  await tabD.eval("document.getElementById('reread').click()");
  await sleep(500);
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
document.getElementById("f").submit();
fetch("${origin}/api/bind", { method: "POST", mode: "no-cors", body: JSON.stringify({ nonce: "${nonce4}" }) }).catch(() => {});
fetch("${origin}/api/view", { headers: { "x-skel-tab": "${"A".repeat(43)}" } }).catch(() => {});
setTimeout(() => { location.href = "${url4}"; }, 1500);
</script></body>`;
  n = log.length;
  const tabE = await browser.newPage();
  await tabE.goto(`${A}/`);
  await sleep(3500); // let the delayed top-level navigation land
  const eText = await tabE.eval("document.body.innerText").catch(() => "");
  const reached = logSince(n);
  const anyOk = log.slice(n).some((e) => e.status < 400 && !e.url.startsWith("/assets/"));
  // The top-level navigation to url4 uses Sec-Fetch-Site same-site (initiated
  // by the hostile page), so the document is refused and the app never runs.
  // Now prove the nonce is unconsumed: a launcher-style open in a clean tab binds.
  const tabF = await browser.newPage();
  await tabF.goto(url4);
  const fOk = await tabF.waitUntil("!!document.querySelector('[data-strict-capture]')");
  row("B6", "hostile same-site origin (form POST, prefetch/prerender, iframe, fetches, top-level navigation) gets nothing and leaves the nonce unconsumed",
    !anyOk && fOk && !/data-strict-capture/.test(eText), { listener: reached, hostileTabText: eText.slice(0, 160), nonceStillBinds: fOk });

  // B8: a leaked review-server token or cookie grants nothing.
  n = log.length;
  const leak = await tabB.eval(`(async () => {
    const out = [];
    for (const h of [{ "x-skeleton-token": "leaked" }, { authorization: "Bearer leaked" }, { "x-skel-tab": "leaked" }]) {
      const r = await fetch("/api/view", { headers: h }); out.push(r.status); }
    document.cookie = "x-skel-tab=${"A".repeat(43)}; path=/";
    out.push((await fetch("/api/view")).status);
    out.push((await fetch("/api/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: "leaked", token: "leaked" }) })).status);
    return out; })()`);
  row("B8", "leaked review token, bearer header, cookie or bogus binding grants nothing", leak.every((s) => s === 403 || s === 400), { statuses: leak });

  // Rows that need a decision route (not in the prototype).
  row("B9", "Approve arms late after focus/visibility and needs a separate confirm", null, "no decision route in the prototype");
  row("B10", "double-click lure and focus steal from the review origin don't approve", null, "no decision route in the prototype");
  row("B11", "duplicate action / Retry dedupe through the real transport", null, "no decision route in the prototype");
} finally {
  await browser.close();
  await listener.close();
  attacker.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

console.log(JSON.stringify({ chrome: browser.product, node: process.version, rows }, null, 2));
const failed = rows.filter((r) => r.result === "FAIL");
for (const r of rows) console.log(`${r.result.padEnd(14)} ${r.id} ${r.name}`);
if (failed.length) { console.error(`FAIL ${failed.map((r) => r.id).join(", ")}`); process.exit(1); }
console.log("PASS");
