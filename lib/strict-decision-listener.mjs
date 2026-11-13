// #77: PROTOTYPE protected decision listener (host side, Node).
//
// MOCK ONLY, wired into nothing: no production module imports or starts this.
// It implements the request checks of docs/strict-decision-page.md (b) so they
// can be tested in a real browser, and serves the read-only capture view. It
// has NO decision, approve, reshape, finalize or Recapture route: submit stays
// disabled. It authenticates no human. A mock provider is plumbing only.
//
// What it is NOT (all still open, see docs/strict-decision-listener.md):
//   - not started by any launcher, and not proven unreachable from the agent
//     (#75 owns that; this binds 127.0.0.1 in whatever netns runs it);
//   - not the control channel: `mintNavigation()` stands in for the trusted
//     launcher window that opens the browser;
//   - not a source of truth: `provider.read()` must, in production, come from
//     the protected V2 authority store and immutable capture store (#76).
//
// Request rules (every request):
//   - HTTP/1.1, exact `Host: 127.0.0.1:<port>`; anything else 421/400.
//   - Fetch Metadata required. The document needs Sec-Fetch-Site `none`,
//     mode `navigate`, dest `document`. Everything else needs `same-origin`.
//   - Non-GET needs exact `Origin: http://127.0.0.1:<port>` and JSON.
//   - OPTIONS (preflight) and every other method refuse; no CORS headers ever.
//   - Cookies are ignored. Responses carry a strict CSP, no framing, no-store,
//     no-referrer and same-origin resource policy.
//   - API reads need the in-memory tab binding header from POST /api/bind,
//     which consumes a one-time navigation nonce. Only the latest bound tab is
//     live; minting or binding again revokes the earlier ones.

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { buildStrictCaptureViewModel } from "./strict-capture-view-model.mjs";

export const DECISION_LISTENER_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
  + "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'";
export const TAB_HEADER = "x-skel-tab";
const NONCE_TTL_MS = 2 * 60 * 1000;
const MAX_BODY = 1024;

// Fixed assets only: no project-derived path is ever served.
const ASSETS = Object.freeze({
  "/assets/strict-decision-app.mjs": ["strict-decision-app.mjs", "text/javascript; charset=utf-8", "script"],
  "/assets/strict-capture-view-dom.mjs": ["strict-capture-view-dom.mjs", "text/javascript; charset=utf-8", "script"],
  "/assets/review-decision.mjs": ["review-decision.mjs", "text/javascript; charset=utf-8", "script"],
  "/assets/strict-protocol.mjs": ["strict-protocol.mjs", "text/javascript; charset=utf-8", "script"],
  "/assets/strict-decision.css": ["strict-decision.css", "text/css; charset=utf-8", "style"],
});

// The browser module graph imports "./review-decision.mjs" etc. relative to
// /assets/, so file names map 1:1. The shell loads one module and one sheet.
const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Skeleton decision (prototype)</title>
<link rel="stylesheet" href="/assets/strict-decision.css">
<script type="module" src="/assets/strict-decision-app.mjs"></script></head>
<body><main><h1>Skeleton decision page (prototype)</h1>
<p id="status" role="status">Loading…</p>
<p class="disabled-note">Decisions are disabled in this prototype. It shows the stored capture only.</p>
<p><button id="reread" type="button" disabled>Re-read</button></p>
<div id="view"></div></main></body></html>`;

const token = () => randomBytes(32).toString("base64url");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Create (not start) a prototype listener.
 *   provider: { read() -> { binding, capture } } — the registered V2 binding
 *             and the persisted capture it names. Called on each view read.
 *   now:      optional clock for tests.
 *   observe:  optional ({ method, url, status, code }) callback for test
 *             probes. Never given headers or bodies.
 * Returns { start() -> Promise<{origin}>, mintNavigation() -> url, close(), origin }.
 */
export function createDecisionListener({ provider, now = Date.now, observe = null } = {}) {
  if (!provider || typeof provider.read !== "function") throw new TypeError("provider.read required");
  let origin = null, host = null;
  let nonces = new Map(); // nonce -> expiry; only the latest mint is kept
  let liveTab = null;

  const assetBody = new Map();
  for (const [route, [file]] of Object.entries(ASSETS))
    assetBody.set(route, fs.readFileSync(new URL(`./${file}`, import.meta.url)));

  const base = {
    "content-security-policy": DECISION_LISTENER_CSP,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
  };
  const send = (res, status, type, body) => {
    res.writeHead(status, { ...base, "content-type": type, "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
  const refuse = (res, status, code) => { res.skelCode = code; json(res, status, { error: code }); };

  function handle(req, res) {
    const h = req.headers;
    if (req.httpVersion !== "1.1") return refuse(res, 505, "http-version");
    if (h.host !== host) return refuse(res, 421, "host");
    const site = h["sec-fetch-site"], mode = h["sec-fetch-mode"], dest = h["sec-fetch-dest"];
    if (typeof site !== "string") return refuse(res, 403, "fetch-metadata");
    const url = req.url ?? "";

    if (req.method === "GET" && url === "/") {
      if (site !== "none" || mode !== "navigate" || dest !== "document") return refuse(res, 403, "document-site");
      return send(res, 200, "text/html; charset=utf-8", SHELL);
    }
    if (site !== "same-origin") return refuse(res, 403, "same-origin-required");

    if (req.method === "GET" && Object.hasOwn(ASSETS, url)) {
      if (dest !== ASSETS[url][2]) return refuse(res, 403, "asset-dest");
      return send(res, 200, ASSETS[url][1], assetBody.get(url));
    }
    if (req.method === "POST" && url === "/api/bind") return bind(req, res);
    if (req.method === "GET" && (url === "/api/view" || url === "/api/state")) {
      if (!liveTab || !same(h[TAB_HEADER], liveTab)) return refuse(res, 403, "tab-binding");
      return view(res, url === "/api/state");
    }
    if (req.method !== "GET" && req.method !== "POST") return refuse(res, 405, "method");
    return refuse(res, 404, "not-found");
  }

  function bind(req, res) {
    const h = req.headers;
    if (h.origin !== origin) return refuse(res, 403, "origin");
    if (!/^application\/json(;\s*charset=utf-8)?$/i.test(h["content-type"] ?? "")) return refuse(res, 415, "content-type");
    const chunks = []; let size = 0, over = false;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { over = true; req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (over) return;
      let nonce;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) throw 0;
        nonce = body.nonce;
      } catch { return refuse(res, 400, "body"); }
      let match = null;
      for (const [n, expiry] of nonces) if (same(nonce, n)) match = [n, expiry];
      if (!match || match[1] <= now()) return refuse(res, 403, "nonce");
      nonces = new Map(); // one-time: consumed, and no other pending nonce survives
      liveTab = token();  // earlier tabs stop being live
      return json(res, 200, { tab: liveTab });
    });
    req.on("error", () => {});
  }

  function view(res, stateOnly) {
    let model;
    try {
      const { binding, capture } = provider.read();
      model = buildStrictCaptureViewModel({ binding, capture });
    } catch (e) {
      return refuse(res, 503, typeof e?.code === "string" && /^VIEW_[A-Z]+$/.test(e.code) ? e.code : "unavailable");
    }
    return json(res, 200, stateOnly ? { binding: model.binding } : model);
  }

  const server = http.createServer((req, res) => {
    if (observe) res.on("finish", () => { try { observe({ method: req.method, url: req.url, status: res.statusCode, code: res.skelCode ?? null }); } catch {} });
    handle(req, res);
  });
  server.on("clientError", (_e, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); } catch {} });

  return {
    get origin() { return origin; },
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address();
          origin = `http://127.0.0.1:${port}`;
          host = `127.0.0.1:${port}`;
          resolve({ origin });
        });
      });
    },
    /** Control-channel stand-in: a fresh one-time URL; earlier nonces and tabs die. */
    mintNavigation() {
      if (!origin) throw new Error("listener not started");
      const n = token();
      nonces = new Map([[n, now() + NONCE_TTL_MS]]);
      liveTab = null;
      return `${origin}/#n=${n}`;
    },
    close() { return new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
  };
}
