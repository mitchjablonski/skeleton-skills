#!/usr/bin/env node
// #77 live probe: the PROTOTYPE decision listener in a REAL headless Chrome.
// Not part of `npm test` (needs a local Chrome).
//
//   node test/live/strict-decision-listener-browser.mjs [--chrome /path/to/chrome]
//
// Runs (each a fresh Chrome profile, --dump-dom):
//   1. open the minted one-time URL -> page binds, renders the capture;
//   2. open the SAME URL again      -> refused (nonce already used), nothing shown;
//   3. a hostile page on ANOTHER loopback port (same-site, cross-origin) tries
//      cross-origin bind/view/iframe with a FRESH valid nonce. None of it may
//      bind, read or frame; afterwards the nonce must still be unconsumed.
// The listener observes method/url/status/code for every request it got.
//
// Not shown here: hash stripping from history, reload behaviour, click arming,
// launcher reachability or human authentication (#79, #75). Throwaway fixtures.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";
import { createDecisionListener } from "../../lib/strict-decision-listener.mjs";

const argChrome = process.argv.indexOf("--chrome");
const CHROME = argChrome > 0 ? process.argv[argChrome + 1]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
if (!CHROME) { console.log("SKIP no Chrome/Chromium found (pass --chrome)"); process.exit(0); }
if (process.platform !== "linux") { console.log("SKIP capture needs Linux"); process.exit(0); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), "skel-listener-browser-"));
const root = path.join(base, "root"); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, "a.js"),
  "const x = 1;\n// SKEL[1] <img src=x onerror=window.PWNED=1> step\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n");
const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
let cap;
try { cap = JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "a.js", mode: "fenced" }]))); } finally { fs.closeSync(fd); }
const binding = { protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
  phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
  approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false };

const log = [];
const listener = createDecisionListener({ provider: { read: () => ({ binding, capture: cap }) }, observe: (e) => log.push(e) });
const { origin } = await listener.start();

// Hostile page: its own origin on another loopback port. Its script reports into the DOM.
let attackNonce = null;
const ATTACK_APP = () => `
const L = ${JSON.stringify(origin)}, nonce = ${JSON.stringify(attackNonce)};
const out = {};
const tryIt = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = "threw:" + e.name; } };
await tryIt("corsBind", async () => (await fetch(L + "/api/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce }) })).status);
await tryIt("noCorsBind", async () => (await fetch(L + "/api/bind", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ nonce }) })).type);
await tryIt("beacon", async () => navigator.sendBeacon(L + "/api/bind", new Blob([JSON.stringify({ nonce })], { type: "text/plain" })));
await tryIt("corsView", async () => (await fetch(L + "/api/view", { headers: { "x-skel-tab": "A".repeat(43) } })).status);
await tryIt("noCorsView", async () => (await fetch(L + "/api/view", { mode: "no-cors" })).type);
const frame = document.createElement("iframe"); frame.src = L + "/"; document.body.append(frame);
await new Promise((r) => setTimeout(r, 1500));
await tryIt("frameReadable", async () => { try { return !!frame.contentDocument; } catch { return false; } });
document.body.setAttribute("data-result", JSON.stringify(out));
`;
const attacker = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<!doctype html><body><script type="module" src="/a.mjs"></script>`); }
  if (req.url === "/a.mjs") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(ATTACK_APP()); }
  res.writeHead(404); res.end();
});
await new Promise((r) => attacker.listen(0, "127.0.0.1", r));
const attackUrl = `http://127.0.0.1:${attacker.address().port}/`;

function dump(url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "skel-listener-chrome-"));
  return new Promise((resolve, reject) => execFile(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
    "--disable-extensions", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", url],
  { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    return err ? reject(err) : resolve(out);
  }));
}
const statusOf = (dom) => /<p id="status"[^>]*>([^<]*)<\/p>/.exec(dom)?.[1] ?? "";

const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); };
let run1, run2, run3, attackResult = {}, attackBind;
try {
  const url = listener.mintNavigation();
  run1 = await dump(url);
  expect(run1.includes("data-strict-capture"), "run1: capture view rendered");
  expect(/Showing stored capture/.test(statusOf(run1)), `run1: status says showing (got "${statusOf(run1)}")`);
  expect(!/<img/i.test(run1.split('id="view"')[1] ?? ""), "run1: no <img> element in the view");
  expect(run1.includes("&lt;img src=x onerror"), "run1: hostile title shown as text");

  run2 = await dump(url);
  expect(!run2.includes("data-strict-capture"), "run2: reused link shows no capture");
  expect(/already used or has expired/.test(statusOf(run2)), `run2: status says used (got "${statusOf(run2)}")`);

  attackNonce = new URL(listener.mintNavigation()).hash.slice(3);
  const before = log.length;
  run3 = await dump(attackUrl);
  const m = /data-result="([^"]*)"/.exec(run3);
  attackResult = m ? JSON.parse(m[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&")) : { missing: true };
  expect(attackResult.corsBind?.startsWith?.("threw:"), `attack: CORS bind must fail (got ${attackResult.corsBind})`);
  expect(attackResult.corsView?.startsWith?.("threw:"), `attack: CORS view must fail (got ${attackResult.corsView})`);
  expect(attackResult.frameReadable === false, "attack: iframe not readable");
  const reached = log.slice(before);
  for (const e of reached) expect(e.status >= 400, `attack: listener answered ${e.method} ${e.url} with ${e.status}`);
  // The nonce survives every cross-origin attempt: the real page can still bind it.
  attackBind = await new Promise((resolve) => {
    const r = http.request(`${origin}/api/bind`, { method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" } },
      (res) => { res.resume(); resolve(res.statusCode); });
    r.end(JSON.stringify({ nonce: attackNonce }));
  });
  expect(attackBind === 200, `attack: nonce still unconsumed afterwards (bind got ${attackBind})`);
} finally {
  await listener.close();
  attacker.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

let version = "";
try { version = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(); } catch {}
console.log(JSON.stringify({ chrome: version, node: process.version, status1: statusOf(run1), status2: statusOf(run2), attackResult, attackBind, listenerLog: log }, null, 2));
if (failures.length) { console.error("FAIL\n" + failures.join("\n")); process.exit(1); }
console.log("PASS");
