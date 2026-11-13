// #77: browser app for the PROTOTYPE protected decision page.
// Served only by lib/strict-decision-listener.mjs from its own origin. Wired
// into nothing. The page never sends a decision: under the H3 proposal
// (docs/strict-human-channel.md, not adopted) it shows authority-issued codes
// that the human types into the launcher control window, which doesn't exist
// yet.
//
// Flow: read the one-time nonce from the URL fragment, strip it from history
// at once, exchange it with POST /api/bind for an in-memory tab binding, then
// GET { view, codes } and render the capture text-only. Codes are shown only
// in the fixed panel outside the capture, only for the capture this tab
// rendered, and the approve code only after "I have no unsent notes". Every
// load rebuilds the panel, so a declaration never carries over to another
// capture. Re-read is a GET that changes nothing. The binding lives only in
// this module's memory: no cookies, storage or URL.

import { renderStrictCaptureViewModel, clearStrictCaptureView } from "./strict-capture-view-dom.mjs";
import { parseDecisionCodes, commandFor, bindingLine, CONTROL_BANNER } from "./strict-decision-codes.mjs";

const TAB_HEADER = "x-skel-tab";
const statusEl = document.getElementById("status");
const view = document.getElementById("view");
const decide = document.getElementById("decide");
const reread = document.getElementById("reread");
let tab = null;

const say = (text) => { statusEl.textContent = text; };
const REOPEN = "Reopen the decision page from the launcher's control window.";

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

const codeBlock = (action, entry, lead) => el("div", { class: "code-block", "data-code-action": action },
  el("p", {}, lead),
  el("p", {}, el("code", { class: "decision-code" }, commandFor(action, entry))),
  el("p", { class: "code-binding" }, bindingLine(entry)));

/** Rebuild the decision panel from scratch for one rendered capture. */
function renderDecide(codes) {
  decide.replaceChildren();
  if (Object.keys(codes).length === 0) return;
  decide.append(el("p", { class: "code-warning" },
    `Type a code only in the window titled ${CONTROL_BANNER}. Never paste it into the agent's terminal or into review feedback. `
    + "Nothing is decided unless that window echoes it."));

  if (codes.approve) {
    const slot = el("div", { class: "code-slot", "data-slot": "approve" });
    const choice = (value, label) => {
      const id = `notes-${value}`;
      const input = el("input", { type: "radio", name: "notes", id, value });
      input.addEventListener("change", () => {
        slot.replaceChildren(value === "none"
          ? codeBlock("approve", codes.approve, `To approve this snapshot, type in the ${CONTROL_BANNER} window:`)
          : el("p", { class: "code-held" }, "Send or copy your notes on the review page first. No approve code is shown while you have notes on this version."));
      });
      return el("label", { for: id }, input, ` ${label}`);
    };
    decide.append(el("fieldset", { class: "notes-declaration" },
      el("legend", {}, "Before approving"),
      choice("none", "I have no unsent notes on this version"),
      choice("some", "I have notes on this version")), slot);
  }

  if (codes.reshape) {
    const slot = el("div", { class: "code-slot", "data-slot": "reshape" });
    const show = el("button", { type: "button", id: "show-reshape" }, "Show the reshape code");
    show.addEventListener("click", () => {
      show.remove();
      const ack = el("input", { type: "checkbox", id: "reshape-ack" });
      const codeHolder = el("div");
      ack.addEventListener("change", () => {
        codeHolder.replaceChildren(...(ack.checked ? [codeBlock("reshape", codes.reshape, `To reshape, type in the ${CONTROL_BANNER} window:`)] : []));
      });
      slot.replaceChildren(el("label", { for: "reshape-ack" }, ack,
        " I understand reshape discards the current fill and starts a new review round of the skeleton."), codeHolder);
    });
    decide.append(show, slot);
  }
}

function clearAll() { clearStrictCaptureView(view); decide.replaceChildren(); }

async function load() {
  reread.disabled = true;
  decide.replaceChildren(); // nothing from an earlier capture stays visible
  try {
    const res = await fetch("/api/view", { headers: { [TAB_HEADER]: tab }, cache: "no-store", credentials: "omit" });
    if (res.status === 403) { tab = null; clearAll(); say(`This tab is no longer the live decision page. ${REOPEN}`); return; }
    if (!res.ok) { clearAll(); say("The stored capture can't be shown right now. Re-read to try again."); reread.disabled = false; return; }
    const body = await res.json();
    const r = renderStrictCaptureViewModel({ doc: document, container: view, model: body?.view });
    // Codes must bind exactly the capture just rendered; otherwise none are shown.
    const codes = parseDecisionCodes(body?.codes, { binding: r.binding });
    if (!codes) say("The page received codes that don't match this capture, so none are shown. Re-read to try again.");
    else {
      renderDecide(codes);
      say(`Showing stored capture ${r.shown.captureVersion.slice(0, 12)}… for review round ${r.binding.reviewRoundId}.`);
    }
  } catch {
    clearAll();
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
