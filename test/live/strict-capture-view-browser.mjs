#!/usr/bin/env node
// #77 live smoke: load lib/strict-capture-view-dom.mjs in a REAL headless
// Chrome as a plain ES module and render a host-built view model fetched as
// JSON, under a strict CSP. Not part of `npm test` (needs a local Chrome).
//
//   node test/live/strict-capture-view-browser.mjs [--chrome /path/to/chrome]
//
// What it shows: the browser half has no Node dependency, renders the
// host-built model under `script-src 'self'`, keeps hostile text as text, and
// refuses a tampered model. What it does NOT show: the protected outside
// listener, origin/CSRF checks, human authentication or launcher reachability
// (#77/#79 later). The server here is a throwaway loopback fixture.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";
import { buildStrictCaptureViewModel } from "../../lib/strict-capture-view-model.mjs";

const ROOT = new URL("../../", import.meta.url);
const argChrome = process.argv.indexOf("--chrome");
const CHROME = argChrome > 0 ? process.argv[argChrome + 1]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
if (!CHROME) { console.log("SKIP no Chrome/Chromium found (pass --chrome)"); process.exit(0); }
if (process.platform !== "linux") { console.log("SKIP capture needs Linux"); process.exit(0); }

// ---- host side: real capture of a hostile fixture, then the view model ----
const base = fs.mkdtempSync(path.join(os.tmpdir(), "skel-view-browser-"));
const root = path.join(base, "root"); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, "a.js"),
  "const x = 1;\r\n// SKEL[1] <img src=x onerror=window.PWNED=1> & `rm`\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n");
fs.writeFileSync(path.join(root, "notes.txt"), "plain\r\nbidi ‮evil‬ here\nend");
const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
let model;
try {
  const cap = captureStrictManifest(fd, [{ path: "a.js", mode: "fenced" }, { path: "notes.txt", mode: "whole" }]);
  model = buildStrictCaptureViewModel({ capture: JSON.parse(JSON.stringify(cap)), binding: {
    protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
    phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
    approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false } });
} finally { fs.closeSync(fd); }

// ---- throwaway loopback fixture server: fixed allowlist, strict CSP ----
const PAGE = `<!doctype html><meta charset="utf-8"><title>view smoke</title><div id="view"></div><script type="module" src="/app.mjs"></script>`;
const APP = `
import { renderStrictCaptureViewModel, currentStrictCaptureShown } from "/lib/strict-capture-view-dom.mjs";
const out = { errors: [] };
window.addEventListener("error", (e) => out.errors.push(String(e.message)));
try {
  const model = await (await fetch("/model.json")).json();
  const view = document.getElementById("view");
  const r = renderStrictCaptureViewModel({ doc: document, container: view, model });
  out.rendered = r.isCurrent();
  out.shownProtocol = r.shown.protocolVersion;
  out.captureMatches = r.shown.captureVersion === model.binding.captureVersion;
  out.files = view.querySelectorAll("[data-capture-file]").length;
  out.lines = view.querySelectorAll("[data-line]").length;
  out.imgs = view.querySelectorAll("img").length;
  out.hostileTitleText = [...view.querySelectorAll(".fence-title")].some((n) => n.textContent.includes("<img src=x"));
  out.invisibleFlagged = view.querySelectorAll("[data-line-invisible]").length;
  out.pwned = window.PWNED === 1;
  const bad = structuredClone(model); bad.files[0].display[0].ending = "\\u2028";
  try { renderStrictCaptureViewModel({ doc: document, container: view, model: bad }); out.tamperRefused = false; }
  catch (e) { out.tamperRefused = e.code; }
  out.clearedAfterRefusal = view.childElementCount === 0 && currentStrictCaptureShown(view) === null;
} catch (e) { out.errors.push(String(e && e.stack || e)); }
document.body.setAttribute("data-result", JSON.stringify(out));
`;
const LIB = new Set(["strict-capture-view-dom.mjs", "review-decision.mjs", "strict-protocol.mjs"]);
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const served = [];
const server = http.createServer((req, res) => {
  served.push(req.url);
  const send = (type, body) => { res.writeHead(200, { "content-type": type, "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(body); };
  if (req.url === "/") return send("text/html; charset=utf-8", PAGE);
  if (req.url === "/app.mjs") return send("text/javascript", APP);
  if (req.url === "/model.json") return send("application/json", JSON.stringify(model));
  const m = /^\/lib\/([a-z-]+\.mjs)$/.exec(req.url ?? "");
  if (m && LIB.has(m[1])) return send("text/javascript", fs.readFileSync(new URL(`lib/${m[1]}`, ROOT)));
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

let dom = "";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "skel-view-chrome-"));
try {
  dom = await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu",
      "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", url],
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
  });
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const m = /data-result="([^"]*)"/.exec(dom);
const decode = (s) => s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const result = m ? JSON.parse(decode(m[1])) : { errors: ["no data-result in dumped DOM"] };
const expected = { rendered: true, shownProtocol: 2, captureMatches: true, files: 2, imgs: 0, hostileTitleText: true,
  pwned: false, tamperRefused: "VIEW_MODEL", clearedAfterRefusal: true };
const failures = Object.entries(expected).filter(([k, v]) => result[k] !== v).map(([k, v]) => `${k}: expected ${v}, got ${result[k]}`);
if (!(result.lines > 0)) failures.push("no lines rendered");
if (!(result.invisibleFlagged >= 1)) failures.push("bidi line not flagged");
if (result.errors?.length) failures.push(...result.errors.map((e) => `page error: ${e}`));
const unexpected = served.filter((u) => !["/", "/app.mjs", "/model.json", "/favicon.ico"].includes(u) && !/^\/lib\//.test(u));
if (unexpected.length) failures.push(`unexpected requests: ${unexpected.join(", ")}`);
let version = "";
try { version = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(); } catch {}
console.log(JSON.stringify({ chrome: version, node: process.version, served, result }, null, 2));
if (failures.length) { console.error("FAIL\n" + failures.join("\n")); process.exit(1); }
console.log("PASS");
