// #77 prototype protected decision listener: request checks over raw HTTP.
// Loopback only, ephemeral port, mock provider; nothing installed or persisted.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecisionListener, DECISION_LISTENER_CSP, TAB_HEADER } from "../lib/strict-decision-listener.mjs";
import { captureStrictManifest } from "../lib/strict-capture.mjs";
import { parseStrictCaptureViewModel } from "../lib/strict-capture-view-dom.mjs";

const linux = process.platform === "linux";
const lt = (name, fn) => test(name, { skip: !linux && "capture needs Linux" }, fn);

function realCapture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skel-listener-"));
  const root = path.join(base, "root"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "a.js"), "const a = 1;\n// SKEL[1] <b>step</b>\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n");
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { return JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "a.js", mode: "fenced" }]))); }
  finally { fs.closeSync(fd); fs.rmSync(base, { recursive: true, force: true }); }
}
const bindingFor = (cap) => ({ protocolVersion: 2, projectId: "example-project", sessionId: "example-session",
  reviewRoundId: "example-round", phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
  approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false });

async function setup(t, opts = {}) {
  const cap = realCapture();
  let clock = 1_000_000;
  const provider = opts.provider ?? { read: () => ({ binding: bindingFor(cap), capture: cap }) };
  const l = createDecisionListener({ provider, now: () => clock });
  const { origin } = await l.start();
  t.after(() => l.close());
  const port = Number(new URL(origin).port);
  const host = `127.0.0.1:${port}`;
  const req = (method, url, headers = {}, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: url, headers: { host, ...headers }, agent: false }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
  const doc = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  const api = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
  const post = { ...api, origin, "content-type": "application/json" };
  const nonceOf = (u) => new URL(u).hash.slice(3);
  const bind = async (nonce) => req("POST", "/api/bind", post, JSON.stringify({ nonce }));
  return { l, cap, origin, port, host, req, doc, api, post, nonceOf, bind, tick: (ms) => { clock += ms; } };
}

lt("document needs exact Host and Sec-Fetch-Site none/navigate/document; responses carry the strict headers", async (t) => {
  const s = await setup(t);
  const ok = await s.req("GET", "/", s.doc);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-security-policy"], DECISION_LISTENER_CSP);
  assert.equal(ok.headers["x-frame-options"], "DENY");
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(ok.headers["referrer-policy"], "no-referrer");
  assert.equal(ok.headers["cross-origin-resource-policy"], "same-origin");
  assert.match(ok.text, /src="\/assets\/strict-decision-app\.mjs"/);
  assert.doesNotMatch(ok.text, /<script>(?!<)/, "no inline script");
  for (const site of ["same-origin", "same-site", "cross-site"]) assert.equal((await s.req("GET", "/", { ...s.doc, "sec-fetch-site": site })).status, 403, site);
  assert.equal((await s.req("GET", "/", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).status, 403, "missing site");
  assert.equal((await s.req("GET", "/", { ...s.doc, "sec-fetch-dest": "iframe" })).status, 403, "framed");
  for (const host of [`localhost:${s.port}`, `0.0.0.0:${s.port}`, `[::1]:${s.port}`, "127.0.0.1", `127.0.0.2:${s.port}`, `evil.example:${s.port}`])
    assert.equal((await s.req("GET", "/", { ...s.doc, host })).status, 421, host);
});

lt("only fixed assets, same-origin with the right destination", async (t) => {
  const s = await setup(t);
  const a = await s.req("GET", "/assets/strict-capture-view-dom.mjs", { ...s.api, "sec-fetch-dest": "script" });
  assert.equal(a.status, 200);
  assert.equal(a.text, fs.readFileSync(new URL("../lib/strict-capture-view-dom.mjs", import.meta.url), "utf8"));
  assert.match(a.headers["content-type"], /^text\/javascript/);
  assert.equal((await s.req("GET", "/assets/strict-decision.css", { ...s.api, "sec-fetch-dest": "style" })).status, 200);
  assert.equal((await s.req("GET", "/assets/strict-capture-view-dom.mjs", { ...s.api, "sec-fetch-dest": "style" })).status, 403);
  assert.equal((await s.req("GET", "/assets/strict-capture-view-dom.mjs", { ...s.api, "sec-fetch-site": "same-site", "sec-fetch-dest": "script" })).status, 403);
  for (const p of ["/assets/strict-capture.mjs", "/assets/../lib/strict-capture.mjs", "/assets/%2e%2e/package.json", "/lib/strict-protocol.mjs", "/assets/strict-decision-app.mjs?x", "/.skeleton/serve.json"])
    assert.equal((await s.req("GET", p, { ...s.api, "sec-fetch-dest": "script" })).status, 404, p);
});

lt("bind: exact Origin, JSON only, one-time unexpired nonce; minting again revokes earlier nonces and tabs", async (t) => {
  const s = await setup(t);
  const n1 = s.nonceOf(s.l.mintNavigation());
  const { origin: _o, ...noOrigin } = s.post;
  assert.equal((await s.req("POST", "/api/bind", noOrigin, JSON.stringify({ nonce: n1 }))).status, 403, "no origin");
  for (const origin of [`http://localhost:${s.port}`, `http://127.0.0.1:${s.port + 1}`, "null", `https://127.0.0.1:${s.port}`])
    assert.equal((await s.req("POST", "/api/bind", { ...s.post, origin }, JSON.stringify({ nonce: n1 }))).status, 403, origin);
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])
    assert.equal((await s.req("POST", "/api/bind", { ...s.post, "content-type": ct }, JSON.stringify({ nonce: n1 }))).status, 415, ct);
  assert.equal((await s.req("POST", "/api/bind", s.post, JSON.stringify({ nonce: n1, extra: 1 }))).status, 400);
  assert.equal((await s.req("POST", "/api/bind", { ...s.post, "sec-fetch-site": "same-site" }, JSON.stringify({ nonce: n1 }))).status, 403);
  const ok = await s.bind(n1);
  assert.equal(ok.status, 200);
  const tab = JSON.parse(ok.text).tab;
  assert.match(tab, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await s.bind(n1)).status, 403, "reused nonce");
  assert.equal((await s.req("GET", "/api/view", { ...s.api, [TAB_HEADER]: tab })).status, 200);
  const n2 = s.nonceOf(s.l.mintNavigation());
  assert.equal((await s.req("GET", "/api/view", { ...s.api, [TAB_HEADER]: tab })).status, 403, "reopen revokes the old tab");
  const n3 = s.nonceOf(s.l.mintNavigation());
  assert.equal((await s.bind(n2)).status, 403, "superseded nonce");
  s.tick(2 * 60 * 1000);
  assert.equal((await s.bind(n3)).status, 403, "expired nonce");
});

lt("oversized bind body is cut off", async (t) => {
  const s = await setup(t);
  s.l.mintNavigation();
  const r = await s.req("POST", "/api/bind", s.post, JSON.stringify({ nonce: "x".repeat(4096) })).catch((e) => ({ error: e.code }));
  assert.ok(r.error || r.status >= 400, JSON.stringify(r));
});

lt("view/state need the live tab binding; the model is a valid browser view model", async (t) => {
  const s = await setup(t);
  assert.equal((await s.req("GET", "/api/view", s.api)).status, 403, "no binding");
  assert.equal((await s.req("GET", "/api/view", { ...s.api, [TAB_HEADER]: "A".repeat(43) })).status, 403, "forged");
  const tab = JSON.parse((await s.bind(s.nonceOf(s.l.mintNavigation()))).text).tab;
  const v = await s.req("GET", "/api/view", { ...s.api, [TAB_HEADER]: tab });
  assert.equal(v.status, 200);
  const model = parseStrictCaptureViewModel(JSON.parse(v.text));
  assert.equal(model.shown.captureVersion, s.cap.captureVersion);
  const st = JSON.parse((await s.req("GET", "/api/state", { ...s.api, [TAB_HEADER]: tab })).text);
  assert.deepEqual(Object.keys(st), ["binding"]);
  assert.equal((await s.req("GET", "/api/view", { "sec-fetch-site": "same-site", [TAB_HEADER]: tab })).status, 403, "same-site");
  assert.equal((await s.req("GET", "/api/view", { [TAB_HEADER]: tab })).status, 403, "no fetch metadata");
});

lt("a provider failure or mismatched pair refuses with a code and leaks nothing", async (t) => {
  let mode = "throw";
  const cap = realCapture();
  const s = await setup(t, { provider: { read: () => {
    if (mode === "throw") throw new Error("/secret/path leaked");
    return { binding: { ...bindingFor(cap), captureVersion: "0".repeat(64) }, capture: cap };
  } } });
  const tab = JSON.parse((await s.bind(s.nonceOf(s.l.mintNavigation()))).text).tab;
  const a = await s.req("GET", "/api/view", { ...s.api, [TAB_HEADER]: tab });
  assert.deepEqual([a.status, JSON.parse(a.text)], [503, { error: "unavailable" }]);
  mode = "pair";
  const b = await s.req("GET", "/api/view", { ...s.api, [TAB_HEADER]: tab });
  assert.deepEqual([b.status, JSON.parse(b.text)], [503, { error: "VIEW_PAIR" }]);
});

lt("no decision routes, no preflight, no CORS headers, cookies grant nothing", async (t) => {
  const s = await setup(t);
  const tab = JSON.parse((await s.bind(s.nonceOf(s.l.mintNavigation()))).text).tab;
  for (const p of ["/api/approve", "/api/decision", "/api/reshape", "/api/finalize", "/api/recapture", "/api/intent", "/api/submit"])
    assert.equal((await s.req("POST", p, { ...s.post, [TAB_HEADER]: tab }, "{}")).status, 404, p);
  const pre = await s.req("OPTIONS", "/api/bind", { ...s.api, origin: s.origin, "access-control-request-method": "POST" });
  assert.equal(pre.status, 405);
  for (const m of ["PUT", "DELETE", "PATCH"]) assert.equal((await s.req(m, "/api/view", { ...s.api, [TAB_HEADER]: tab })).status, 405, m);
  const responses = [pre, await s.req("GET", "/", s.doc), await s.req("GET", "/api/view", { ...s.api, [TAB_HEADER]: tab, origin: "http://evil.example" })];
  for (const r of responses) for (const k of Object.keys(r.headers)) assert.doesNotMatch(k, /^access-control-/);
  assert.equal((await s.req("GET", "/api/view", { ...s.api, cookie: `tab=${tab}` })).status, 403, "cookie is not a binding");
});

test("listener and app are prototypes: nothing in lib/bin imports them; app has no storage or sinks", () => {
  const lib = new URL("../lib/", import.meta.url);
  const own = new Set(["strict-decision-listener.mjs", "strict-decision-app.mjs"]);
  for (const f of fs.readdirSync(lib).filter((n) => !own.has(n)))
    assert.doesNotMatch(fs.readFileSync(new URL(f, lib), "utf8"), /strict-decision-(listener|app)/, f);
  for (const f of fs.readdirSync(new URL("../bin/", import.meta.url)))
    assert.doesNotMatch(fs.readFileSync(new URL(`../bin/${f}`, import.meta.url), "utf8"), /strict-decision-(listener|app)/, f);
  const app = fs.readFileSync(new URL("strict-decision-app.mjs", lib), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /localStorage/, /sessionStorage/, /document\.cookie/, /eval\(/, /new Function/, /\/api\/(approve|decision|reshape|finalize|recapture|submit)/])
    assert.doesNotMatch(app, bad);
  const imports = [...app.matchAll(/^import [\s\S]*? from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./strict-capture-view-dom.mjs"]);
});
