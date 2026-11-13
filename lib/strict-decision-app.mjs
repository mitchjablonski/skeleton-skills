// #77: browser app for the PROTOTYPE protected decision page.
// Served only by lib/strict-decision-listener.mjs from its own origin. Wired
// into nothing; no decision controls: submit stays disabled.
//
// Flow: read the one-time nonce from the URL fragment, strip it from history
// at once, exchange it with POST /api/bind for an in-memory tab binding, then
// GET the host-built view model and render it text-only. Re-read is a GET
// that changes nothing. The binding lives only in this module's memory: no
// cookies, storage or URL. See docs/strict-decision-listener.md.

import { renderStrictCaptureViewModel, clearStrictCaptureView } from "./strict-capture-view-dom.mjs";

const TAB_HEADER = "x-skel-tab";
const statusEl = document.getElementById("status");
const view = document.getElementById("view");
const reread = document.getElementById("reread");
let tab = null;

const say = (text) => { statusEl.textContent = text; };
const REOPEN = "Reopen the decision page from the launcher's control window.";

async function load() {
  reread.disabled = true;
  try {
    const res = await fetch("/api/view", { headers: { [TAB_HEADER]: tab }, cache: "no-store", credentials: "omit" });
    if (res.status === 403) { tab = null; clearStrictCaptureView(view); say(`This tab is no longer the live decision page. ${REOPEN}`); return; }
    if (!res.ok) { clearStrictCaptureView(view); say("The stored capture can't be shown right now. Re-read to try again."); reread.disabled = false; return; }
    const r = renderStrictCaptureViewModel({ doc: document, container: view, model: await res.json() });
    say(`Showing stored capture ${r.shown.captureVersion.slice(0, 12)}… for review round ${r.binding.reviewRoundId}. Decisions are disabled in this prototype.`);
  } catch {
    clearStrictCaptureView(view);
    say("The stored capture was malformed or unreachable, so nothing is shown. Re-read to try again.");
  }
  reread.disabled = tab === null;
}

async function start() {
  const m = /^#n=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  history.replaceState(null, "", "/"); // the nonce never stays in history
  if (!m) { say(`This page has no fresh link. ${REOPEN}`); return; }
  try {
    const res = await fetch("/api/bind", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: m[1] }), cache: "no-store", credentials: "omit" });
    if (!res.ok) { say(`This link was already used or has expired. ${REOPEN}`); return; }
    const body = await res.json();
    if (typeof body?.tab !== "string") throw new Error("bad bind");
    tab = body.tab;
  } catch { say(`The decision page couldn't start. ${REOPEN}`); return; }
  reread.addEventListener("click", () => { if (tab) load(); });
  await load();
}

start();
