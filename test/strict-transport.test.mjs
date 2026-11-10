// #77: the strict decision UI logic (lib/review-decision.mjs) against a MOCK
// of contract v1 (test/fixtures/strict-results.mjs, checked with Sol's
// lib/strict-protocol.mjs), and the guarantee that the default review page
// doesn't carry it. A minimal DOM stand-in covers the drawing.
//
// Not tested, because they can't be yet: origin/CSRF binding and real browser
// reachability of the human-channel listener. Both need Sol's listener (#75,
// #76); see docs/strict-transport.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientScript, renderHtml, renderShell } from "../lib/review.mjs";
import {
  AUTHORITY_STATES, INTENTS, RESULTS, STRICT_ACTIONS, STRICT_REJECTIONS, VERSION_A, VERSION_B,
  committedFor, createMockAuthority, intentFor, parseAuthorityState, parseStrictIntent, parseStrictResult,
} from "./fixtures/strict-results.mjs";
import { skelDecisionConfirms, skelDecisionController, skelDecisionOutcome, skelDecisionRender, skelMountDecision } from "../lib/review-decision.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");
const read = (f) => fs.readFileSync(path.join(LIB, f), "utf-8");
const DECISION = read("review-decision.mjs");
const REJECTION_CODES = STRICT_REJECTIONS;

// ---- a minimal DOM stand-in: enough for createElement/append/replaceWith/click ----
function fakeDoc() {
  const node = (tag) => {
    const n = {
      tag, attrs: {}, children: [], parent: null, listeners: {},
      setAttribute(k, v) { n.attrs[k] = v; },
      hasAttribute(k) { return k in n.attrs; },
      addEventListener(t, f) { (n.listeners[t] ??= []).push(f); },
      append(...kids) { for (const k of kids) { k.parent = n; n.children.push(k); } },
      replaceWith(other) { const i = n.parent.children.indexOf(n); other.parent = n.parent; n.parent.children[i] = other; },
      get textContent() { return n.tag === "#text" ? n.text : n.children.map((c) => c.textContent).join(""); },
      click() { if (!("disabled" in n.attrs)) for (const f of n.listeners.click ?? []) f(); },
    };
    return n;
  };
  return {
    createElement: node,
    createTextNode: (text) => Object.assign(node("#text"), { text }),
  };
}
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.children ?? []) all(c, pred, out); return out; };
const byAttr = (root, k, v) => all(root, (n) => n.attrs && k in n.attrs && (v === undefined || n.attrs[k] === v));

const tick = () => new Promise((r) => setImmediate(r));
const ids = () => { let i = 0; return () => `req-${++i}`; };
const SHOWN = { phase: "scaffold", reviewVersion: VERSION_A, approvedVersion: null, pendingNotes: false };
async function setup({ state = AUTHORITY_STATES.skeleton, shown = SHOWN } = {}) {
  const auth = createMockAuthority({ state });
  const ctl = skelDecisionController({ channel: auth, shown, newRequestId: ids() });
  await ctl.load();
  return { auth, ctl };
}
const action = (v, a) => v.actions.find((x) => x.action === a);

// ---- fixtures validate against each other ----

test("#77 fixtures: every AuthorityState, Intent and Result passes lib/strict-protocol.mjs, and each Result answers its Intent", () => {
  for (const [k, st] of Object.entries(AUTHORITY_STATES)) assert.ok(parseAuthorityState(st), k);
  for (const [k, i] of Object.entries(INTENTS)) assert.ok(parseStrictIntent(i), k);
  for (const [k, r] of Object.entries(RESULTS)) assert.ok(parseStrictResult(r), k);
  assert.ok(parseStrictResult(committedFor(INTENTS.reshape)));
  assert.deepEqual(Object.keys(RESULTS).sort(), ["committed", ...REJECTION_CODES].sort(), "one fixture per Result state");
  assert.deepEqual(skelDecisionOutcome(RESULTS.committed, INTENTS.approve), { kind: "committed", revision: 5 });
  for (const code of REJECTION_CODES) assert.deepEqual(skelDecisionOutcome(RESULTS[code], INTENTS.approve), { kind: "rejected", code });
  // An Intent is the ReviewRef of an AuthorityState.
  assert.equal(INTENTS.approve.expectedRevision, AUTHORITY_STATES.skeleton.revision);
  assert.equal(INTENTS.approve.reviewVersion, AUTHORITY_STATES.skeleton.reviewVersion, "approve names the current reviewable version");
  assert.equal(INTENTS.reshape.reviewVersion, AUTHORITY_STATES.fill.approvedVersion, "reshape names the approved version, not a draft");
  assert.deepEqual([...STRICT_ACTIONS], ["approve", "reshape", "finalize"]);
});

test("#77 fixtures: the shared schema refuses what it should, and the UI fails closed on it", () => {
  for (const bad of [{ ...RESULTS.committed, reviewVersion: VERSION_B }, { ...RESULTS.committed, revision: 4 }, { ...RESULTS.committed, requestId: "other" }]) {
    assert.deepEqual(skelDecisionOutcome(bad, INTENTS.approve), { kind: "malformed" }, JSON.stringify(bad));
  }
  assert.equal(parseStrictResult({ ...RESULTS.committed, approved: true }), null, "extra fields");
  assert.equal(parseStrictResult({ kind: "rejected", code: "nope" }), null);
  assert.equal(parseStrictResult({ kind: "ok" }), null);
  assert.equal(parseStrictIntent({ ...INTENTS.approve, token: "x" }), null, "an Intent carries no secret");
  for (const action of ["replace", "migrate"]) assert.equal(parseStrictIntent({ ...INTENTS.approve, action }), null);
  assert.equal(parseAuthorityState({ ...AUTHORITY_STATES.skeleton, approvedVersion: VERSION_A }), null);
  assert.equal(parseAuthorityState({ ...AUTHORITY_STATES.skeleton, projectId: "/home/me/project" }), null, "opaque ids, never paths");
});

test("#77 fixtures: the reference mock authority is idempotent and refuses a reused request id", async () => {
  const auth = createMockAuthority();
  const r1 = await auth.submit(INTENTS.approve);
  assert.deepEqual(r1, RESULTS.committed);
  assert.deepEqual(await auth.submit(INTENTS.approve), r1, "same request, same answer");
  assert.equal(auth.commits(), 1);
  assert.deepEqual(await auth.submit({ ...INTENTS.approve, action: "reshape" }), RESULTS["request-reused"]);
  assert.equal(auth.state.revision, 5);
});

// ---- each Result state through the UI ----

test("#77: the UI shows the exact identity and version, and offers approve only with no pending notes", async () => {
  const { ctl } = await setup();
  const v = ctl.view();
  assert.deepEqual(v.identity, { projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round", phase: "skeleton", revision: 4, approvedVersion: null, reviewVersion: VERSION_A, shownVersion: VERSION_A });
  assert.equal(action(v, "approve").enabled, true);
  assert.equal(action(v, "reshape"), undefined, "reshape isn't offered before approval");
  const notes = await setup({ shown: { ...SHOWN, pendingNotes: true } });
  const a = action(notes.ctl.view(), "approve");
  assert.equal(a.enabled, false);
  assert.match(a.reason, /notes on this version/);
  assert.deepEqual(await notes.ctl.decide("approve"), { kind: "refused-locally" });
  assert.equal(notes.auth.calls.submit.length, 0);
});

test("#77: committed — approved only after the answer, naming what was committed", async () => {
  const { auth, ctl } = await setup();
  let release;
  const real = auth.submit;
  auth.submit = (i) => new Promise((r) => { release = () => r(real(i)); });
  const p = ctl.decide("approve");
  await new Promise((r) => setImmediate(r));
  const during = ctl.view();
  assert.equal(during.status, "submitting");
  assert.equal(during.approved, null, "never optimistic");
  assert.equal(action(during, "approve").enabled, false);
  release();
  assert.deepEqual(await p, { kind: "committed", revision: 5 });
  const v = ctl.view();
  assert.deepEqual(v.approved, { reviewVersion: VERSION_A, revision: 5 });
  assert.match(v.message.text, /Skeleton aaaaaaaaaaaa was approved \(revision 5\)/);
  assert.equal(v.identity.phase, "fill", "state re-read after the commit");
  assert.deepEqual(auth.calls.submit[0], { protocolVersion: 1, requestId: "req-1", action: "approve", projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round", reviewVersion: VERSION_A, expectedRevision: 4 });
});

test("#77: a committed answer that doesn't match the intent is never shown as approved", async () => {
  for (const bad of [{ reviewVersion: VERSION_B }, { requestId: "other" }, { action: "reshape" }, { revision: 4 }]) {
    const { auth, ctl } = await setup();
    auth.force({ ...RESULTS.committed, requestId: "req-1", ...bad });
    assert.deepEqual(await ctl.decide("approve"), { kind: "malformed" }, JSON.stringify(bad));
    const v = ctl.view();
    assert.equal(v.approved, null);
    assert.equal(v.status, "stale");
    assert.match(v.message.text, /not shown as approved/);
  }
  assert.deepEqual(skelDecisionOutcome({ kind: "rejected", code: "made-up" }, INTENTS.approve), { kind: "malformed" });
});

const COPY = {
  "stale-review": /aaaaaaaaaaaa is no longer the version under review, so nothing was approved\. .*Reload the review/,
  "revision-conflict": /nothing was approved from this tab\. The current state has been re-read/,
  "invalid-transition": /Approve skeleton isn't allowed while the skeleton is in the skeleton phase\. Nothing changed\./,
  "unauthorized-channel": /didn't arrive through the protected human channel.*Copy\/Send feedback still work/,
  "session-ended": /session this review belongs to has ended, so nothing changed\. Decisions from this page are off/,
  unavailable: /answered "unavailable", so whether the request for aaaaaaaaaaaa was recorded is unknown, and it is not shown as approved\. Retry sends the same request/,
  "request-reused": /already used for a different decision, so nothing new was recorded/,
};

for (const code of REJECTION_CODES) {
  test(`#77: rejected ${code} — specific recovery copy, nothing approved`, async () => {
    const { auth, ctl } = await setup();
    auth.force({ kind: "rejected", requestId: "req-1", code });
    assert.deepEqual(await ctl.decide("approve"), { kind: "rejected", code });
    const v = ctl.view();
    assert.equal(v.approved, null);
    assert.equal(v.message.code, code);
    assert.match(v.message.text, COPY[code]);
    assert.notEqual(v.message.title, "Approved");
    assert.doesNotMatch(v.message.title, /^Approved\b/, "the title never claims approval");
    assert.doesNotMatch(v.message.text, /was approved \(revision/, "the text never claims approval");
    const approve = action(v, "approve");
    if (code === "unavailable") {
      assert.equal(approve.enabled, true);
      assert.equal(approve.retry, true);
      assert.equal(v.canReread, true, "Re-read beside Retry");
      assert.doesNotMatch(v.message.text, /nothing (was|changed)/i, "unavailable is an unknown outcome, never proof nothing happened");
    } else {
      assert.equal(approve.enabled, false, "actions held after a definitive rejection");
    }
    if (code === "session-ended" || code === "unauthorized-channel") {
      assert.equal(v.canReread, false, "no way back from this page");
      await ctl.load();
      assert.equal(action(ctl.view(), "approve").enabled, false, "re-reading doesn't re-enable it");
    }
    if (["stale-review", "revision-conflict", "invalid-transition", "request-reused"].includes(code)) {
      assert.equal(v.status, "stale");
      assert.equal(v.canReread, true);
      assert.ok(auth.calls.getState >= 3, "state re-read after the rejection");
      await ctl.load();
      assert.equal(action(ctl.view(), "approve").enabled, true, "the human re-reads, then may decide again");
      await ctl.decide("approve");
      assert.equal(auth.calls.submit.at(-1).requestId, "req-2", "a fresh request after a definitive rejection");
    }
  });
}

test("#77: approve is decided only when the page shows the authority's reviewVersion", async () => {
  // The page shows B while the authority's version under review is A: held locally, nothing sent.
  const stale = await setup({ shown: { ...SHOWN, reviewVersion: VERSION_B } });
  const a = action(stale.ctl.view(), "approve");
  assert.equal(a.enabled, false);
  assert.equal(a.reason, "The page shows bbbbbbbbbbbb, but the version under review is aaaaaaaaaaaa: reload the review.");
  assert.deepEqual(await stale.ctl.decide("approve"), { kind: "refused-locally" });
  assert.equal(stale.auth.calls.submit.length, 0);
  // The authority's own check (strictIntentConflict) still answers stale-review to a direct request.
  assert.deepEqual(await stale.auth.submit({ ...INTENTS.approve, requestId: "direct-1", reviewVersion: VERSION_B }), { kind: "rejected", requestId: "direct-1", code: "stale-review" });
  assert.equal(stale.auth.commits(), 0);
});

test("#77 Sol P2: a re-read state older than the commit never confirms it", async () => {
  // Preflight at rev 4, committed at rev 5, then a re-read of fill/A at rev 0.
  const { auth, ctl } = await setup();
  const real = auth.submit;
  auth.submit = async (i) => {
    const r = await real(i);
    auth.setState({ ...AUTHORITY_STATES.fill, revision: 0 });
    return r;
  };
  assert.deepEqual(await ctl.decide("approve"), { kind: "committed", revision: 5 });
  const v = ctl.view();
  assert.equal(v.approved, null, "never 'Approved at revision 5' from a state that predates the request");
  assert.equal(v.message.title, "Recorded, but the state differs");
  assert.match(v.message.text, /revision 0,/);
  assert.equal(v.status, "stale");
  const intent = intentFor(AUTHORITY_STATES.skeleton, "approve", "x");
  assert.equal(skelDecisionConfirms({ ...AUTHORITY_STATES.fill, revision: 4 }, intent, 5), false);
  assert.equal(skelDecisionConfirms({ ...AUTHORITY_STATES.fill, revision: 5 }, intent, 5), true);
  assert.equal(skelDecisionConfirms({ ...AUTHORITY_STATES.fill, revision: 8 }, intent, 5), true, "later revisions still show it in effect");
});

// ---- duplicate submit ----

test("#77: a double click sends one request", async () => {
  const { auth, ctl } = await setup();
  const [a, b] = [ctl.decide("approve"), ctl.decide("approve")];
  assert.equal(a, b, "the second click is the same request");
  await a;
  assert.equal(auth.calls.submit.length, 1);
  assert.equal(auth.commits(), 1);
});

test("#77: a retry after a lost answer reuses the requestId, and the authority commits once", async () => {
  const { auth, ctl } = await setup();
  const real = auth.submit;
  // The authority commits, but the answer never arrives.
  auth.submit = async (i) => { await real(i); throw new Error("connection reset"); };
  assert.deepEqual(await ctl.decide("approve"), { kind: "unknown" });
  let v = ctl.view();
  assert.equal(v.approved, null, "an unknown outcome isn't shown as approved");
  assert.match(v.message.text, /Couldn't confirm whether the decision was recorded/);
  assert.equal(action(v, "approve").retry, true);
  auth.submit = real;
  assert.deepEqual(await ctl.decide("approve"), { kind: "committed", revision: 5 }, "the original result, not a revision conflict");
  assert.deepEqual(auth.calls.submit.map((i) => i.requestId), ["req-1", "req-1"]);
  assert.equal(auth.commits(), 1);
  v = ctl.view();
  assert.deepEqual(v.approved, { reviewVersion: VERSION_A, revision: 5 });
});

test("#77: a retry after unavailable reuses the requestId", async () => {
  const { auth, ctl } = await setup();
  auth.force({ ...RESULTS.unavailable, requestId: "req-1" });
  await ctl.decide("approve");
  await ctl.decide("approve");
  assert.deepEqual(auth.calls.submit.map((i) => i.requestId), ["req-1", "req-1"]);
  assert.equal(auth.commits(), 1);
});

// ---- stale state ----

test("#77: a revision change underneath (another tab, the CLI) holds actions and sends nothing", async () => {
  const { auth, ctl } = await setup();
  auth.setState(AUTHORITY_STATES.skeletonMoved);
  assert.deepEqual(await ctl.decide("approve"), { kind: "stale" });
  assert.equal(auth.calls.submit.length, 0);
  const v = ctl.view();
  assert.equal(v.identity.revision, 6, "the new state is re-read and shown");
  assert.equal(action(v, "approve").enabled, false);
  assert.equal(v.canReread, true);
  await ctl.load();
  await ctl.decide("approve");
  assert.equal(auth.calls.submit[0].expectedRevision, 6);
});

test("#77: a new review round or a restarted tab is stale, not approvable", async () => {
  const { auth, ctl } = await setup();
  auth.setState(AUTHORITY_STATES.newRound);
  assert.deepEqual(await ctl.decide("approve"), { kind: "stale" });
  assert.equal(ctl.view().identity.reviewRoundId, "example-round-2");
});

test("#77 #66: the page moving to another version drops the retry and never shows approval for the unseen version", async () => {
  const { auth, ctl } = await setup();
  auth.force({ kind: "rejected", requestId: "req-1", code: "unavailable" });
  await ctl.decide("approve");
  assert.equal(ctl.requestRetained, "req-1");
  await ctl.setShown({ ...SHOWN, reviewVersion: VERSION_B });
  let v = ctl.view();
  assert.equal(ctl.requestRetained, null, "a request for A is never resent once the page shows B");
  assert.equal(action(v, "approve").enabled, false);
  assert.match(v.message.text, /now shows bbbbbbbbbbbb/);
  // Approval lands for A while the page moves to B mid-flight: not shown as approved.
  const two = await setup();
  let release;
  const real = two.auth.submit;
  two.auth.submit = (i) => new Promise((r) => { release = () => r(real(i)); });
  const p = two.ctl.decide("approve");
  await tick();
  const moved = two.ctl.setShown({ ...SHOWN, reviewVersion: VERSION_B });
  release();
  await p;
  await moved;
  v = two.ctl.view();
  assert.equal(v.approved, null);
  assert.doesNotMatch(JSON.stringify(v), /Approved bbbbbbbbbbbb/);
  assert.equal(v.status, "stale", "the move survives the answer");
  assert.ok(v.actions.every((a) => !a.enabled), "nothing enabled until Re-read");
  assert.equal(two.ctl.requestRetained, null);
  assert.equal(v.canReread, true);
  assert.match(v.message.text, /moved to bbbbbbbbbbbb while the decision on aaaaaaaaaaaa was being sent\. The service recorded it \(revision 5\)\./);
});

// ---- races found in review (rvscripts/race.mjs, inv.mjs) ----

/** A channel whose submit waits for release(answer); answer is a Result or "throw". */
function held(auth) {
  const real = auth.submit;
  const h = { release: null };
  auth.submit = (i) => new Promise((res, rej) => {
    h.release = async (answer) => {
      if (answer === "throw") { await real(i); rej(new Error("reset")); } else res(answer ?? real(i));
    };
  });
  h.restore = () => { auth.submit = real; };
  return h;
}

test("#77 race 1 (blocking): the page moving during the pre-send read sends nothing, even when B is reviewable", async () => {
  const { auth, ctl } = await setup();
  const p = ctl.decide("approve"); // the human clicked while seeing A
  auth.setCurrent(VERSION_B); // the agent made B reviewable
  const s = ctl.setShown({ ...SHOWN, reviewVersion: VERSION_B });
  assert.deepEqual(await p, { kind: "stale" });
  await s;
  assert.deepEqual(auth.calls.submit, [], "no intent for B, or for A");
  const v = ctl.view();
  assert.equal(v.approved, null);
  assert.equal(v.status, "stale");
  assert.ok(v.actions.every((a) => !a.enabled));
  // After Re-read the human may approve B, which they now see.
  await ctl.load();
  await ctl.decide("approve");
  assert.equal(auth.calls.submit[0].reviewVersion, VERSION_B);
});

test("#77 race 1: the version is captured at the click, not after the read", async () => {
  // The read itself is slow; the page moves while it is pending.
  const auth = createMockAuthority();
  const ctl = skelDecisionController({ channel: auth, shown: SHOWN, newRequestId: ids() });
  await ctl.load();
  const realGet = auth.getState;
  const pending = [];
  auth.getState = () => new Promise((r) => { pending.push(() => r(realGet())); });
  const p = ctl.decide("approve");
  const s = ctl.setShown({ ...SHOWN, reviewVersion: VERSION_B });
  assert.equal(pending.length, 2, "the pre-send read and the move's re-read");
  pending[0](); // the pre-send read answers only after the page moved
  pending[1]();
  await p;
  await s;
  assert.deepEqual(auth.calls.submit, []);
});

for (const [name, answer] of [["unavailable", { kind: "rejected", requestId: "req-1", code: "unavailable" }], ["a lost answer", "throw"], ["revision-conflict", { kind: "rejected", requestId: "req-1", code: "revision-conflict" }]]) {
  test(`#77 race 2: ${name} arriving after a page move keeps actions held and retains nothing`, async () => {
    const { auth, ctl } = await setup();
    const h = held(auth);
    const p = ctl.decide("approve");
    await tick();
    assert.equal(ctl.view().canReread, false, "no Re-read while a decision is in flight");
    await ctl.setShown({ ...SHOWN, reviewVersion: VERSION_B });
    assert.equal(ctl.view().status, "stale");
    assert.equal(ctl.view().canReread, false, "still in flight");
    await ctl.load();
    assert.equal(ctl.view().status, "stale", "Re-read does nothing mid-flight");
    await h.release(answer);
    await p;
    h.restore();
    const v = ctl.view();
    assert.equal(v.status, "stale");
    assert.equal(ctl.requestRetained, null, "never a retry for the old version");
    assert.ok(v.actions.every((a) => !a.enabled && !a.retry));
    assert.equal(v.canReread, true);
    assert.equal(v.approved, null);
    assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" });
    assert.ok(auth.calls.submit.length <= 1, "nothing more sent without Re-read");
  });
}

test("#77 race 3: a committed answer is shown as approved only when the re-read state confirms it", async () => {
  const { auth, ctl } = await setup();
  const real = auth.submit;
  auth.submit = async (i) => { await real(i); throw new Error("reset"); };
  await ctl.decide("approve");
  auth.submit = real;
  auth.setState(AUTHORITY_STATES.newRound); // reshaped elsewhere meanwhile
  assert.deepEqual(await ctl.decide("approve"), { kind: "committed", revision: 5 }, "the original answer");
  const v = ctl.view();
  assert.equal(v.approved, null);
  assert.equal(v.status, "stale");
  assert.equal(v.message.title, "Recorded, but the state differs");
  assert.match(v.message.text, /recorded the request \(revision 5\), but the current review state doesn't show it in effect: phase skeleton, review round example-round-2, revision 7, version under review aaaaaaaaaaaa, approved version none\./);
  assert.equal(v.identity.reviewRoundId, "example-round-2", "the current state is shown");
  assert.ok(v.actions.every((a) => !a.enabled));
  // The same with a committed answer and a state that never moved.
  const two = await setup();
  two.auth.force({ ...RESULTS.committed, requestId: "req-1" });
  await two.ctl.decide("approve");
  assert.equal(two.ctl.view().approved, null);
  assert.equal(two.ctl.view().message.title, "Recorded, but the state differs");
});

test("#77 race 4: after a lost answer the state is re-read, and only the retained request is offered", async () => {
  const { auth, ctl } = await setup();
  const real = auth.submit;
  auth.submit = async (i) => { await real(i); throw new Error("reset"); };
  await ctl.decide("approve");
  const v = ctl.view();
  assert.equal(v.identity.revision, 5, "re-read after the thrown submit");
  assert.deepEqual(v.actions.map((a) => [a.action, a.enabled, a.retry]), [["approve", true, true]]);
  assert.equal(v.approved, null);
});

test("#77 inv: an inconsistent AuthorityState fails closed", async () => {
  const bad = [
    { projectId: "p", sessionId: "s", reviewRoundId: "r", phase: "fill", reviewVersion: "x", approvedVersion: null, revision: 3 },
    { projectId: "p", sessionId: "s", reviewRoundId: "r", phase: "finalized", reviewVersion: "x", approvedVersion: null, revision: 3 },
    { projectId: "p", sessionId: "s", reviewRoundId: "r", phase: "skeleton", reviewVersion: "x", approvedVersion: "x", revision: 3 },
    { projectId: "p", sessionId: "s", reviewRoundId: "r", phase: "skeleton", approvedVersion: null, revision: 3 }, // no reviewVersion
  ];
  for (const st of bad) {
    assert.equal(parseAuthorityState(st), null, "the shared schema refuses it too");
    const sent = [];
    const ch = { getState: async () => ({ ...st }), submit: async (i) => { sent.push(i); return { kind: "rejected", code: "unavailable" }; } };
    const page = { phase: st.phase === "skeleton" ? "scaffold" : "fill", reviewVersion: "x", approvedVersion: null, pendingNotes: false };
    const ctl = skelDecisionController({ channel: ch, shown: page, newRequestId: () => "id1" });
    await ctl.load();
    const v = ctl.view();
    assert.deepEqual(v.actions, [], JSON.stringify(st));
    assert.equal(v.identity, null);
    await ctl.decide("reshape");
    await ctl.decide("approve");
    assert.deepEqual(sent, []);
  }
});

for (const [name, lose] of [["unavailable", "unavailable"], ["a lost answer", "throw"]]) {
  test(`#77 notes: after ${name}, notes hold Retry with Re-read beside it, and the outcome stays unconfirmed`, async () => {
    const { auth, ctl } = await setup();
    const real = auth.submit;
    // The authority actually commits; the page only sees an unknown outcome.
    auth.submit = async (i) => { await real(i); if (lose === "throw") throw new Error("reset"); return { kind: "rejected", requestId: i.requestId, code: "unavailable" }; };
    await ctl.decide("approve");
    auth.submit = real;
    let v = ctl.view();
    assert.equal(v.approved, null);
    assert.equal(v.canReread, true);
    assert.deepEqual(v.actions.map((x) => [x.action, x.enabled, x.retry]), [["approve", true, true]]);
    assert.doesNotMatch(v.message.text, /nothing (was|changed)/i);
    await ctl.setShown({ ...SHOWN, pendingNotes: true }); // the human starts notes on A
    v = ctl.view();
    assert.equal(ctl.requestRetained, "req-1", "kept: its outcome is unknown, so it is never dropped");
    const retry = action(v, "approve");
    assert.deepEqual([retry.enabled, retry.retry], [false, true]);
    assert.match(retry.reason, /notes on this version: send or copy them first/);
    assert.equal(v.canReread, true);
    assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" });
    assert.equal(auth.calls.submit.length, 1, "held: nothing resent");
    await ctl.load();
    v = ctl.view();
    assert.equal(v.message.title, "Still unconfirmed");
    assert.match(v.message.text, /phase fill, review round example-round, revision 5, version under review aaaaaaaaaaaa, approved version aaaaaaaaaaaa\. Whether the request for aaaaaaaaaaaa landed is still unconfirmed/);
    assert.equal(v.approved, null, "a re-read alone never shows approval");
    await ctl.setShown({ ...SHOWN, pendingNotes: false });
    assert.deepEqual(await ctl.decide("approve"), { kind: "committed", revision: 5 }, "same id: the original answer");
    assert.deepEqual(auth.calls.submit.map((i) => i.requestId), ["req-1", "req-1"]);
    assert.equal(auth.commits(), 1);
    assert.deepEqual(ctl.view().approved, { reviewVersion: VERSION_A, revision: 5 });
  });
}

test("#77 notes: notes during the flight, then unavailable, hold the kept request", async () => {
  const { auth, ctl } = await setup();
  let release;
  auth.submit = (i) => { auth.calls.submit.push(i); return new Promise((r) => { release = () => r({ kind: "rejected", requestId: i.requestId, code: "unavailable" }); }); };
  const p = ctl.decide("approve");
  await tick();
  await ctl.setShown({ ...SHOWN, pendingNotes: true });
  release();
  await p;
  assert.equal(ctl.requestRetained, "req-1");
  assert.deepEqual(action(ctl.view(), "approve").enabled, false);
  assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" });
  assert.equal(auth.calls.submit.length, 1);
});

test("#77 notes: the drawn Retry is disabled while notes are pending", async () => {
  const doc = fakeDoc();
  const container = doc.createElement("div");
  const auth = createMockAuthority();
  const real = auth.submit;
  const m = await skelMountDecision({ doc, container, channel: auth, shown: SHOWN, newRequestId: ids() });
  auth.submit = async () => { throw new Error("reset"); };
  await m.controller.decide("approve");
  auth.submit = real;
  await m.controller.setShown({ ...SHOWN, pendingNotes: true });
  m.redraw();
  const btn = byAttr(container, "data-decision-action", "approve")[0];
  assert.ok("disabled" in btn.attrs);
  assert.match(btn.textContent, /^Retry/);
  assert.equal(byAttr(container, "data-decision-reread").length, 1);
});

test("#77: a second mount applies a new page via setShown; a different channel throws", async () => {
  const doc = fakeDoc();
  const container = doc.createElement("div");
  const make = ids();
  const a1 = createMockAuthority();
  const m1 = await skelMountDecision({ doc, container, channel: a1, shown: SHOWN, newRequestId: make });
  await assert.rejects(skelMountDecision({ doc, container, channel: createMockAuthority(), shown: SHOWN, newRequestId: make }), /already mounted/);
  await assert.rejects(skelMountDecision({ doc, container, channel: a1, shown: SHOWN, newRequestId: ids() }), /already mounted/);
  assert.equal(await skelMountDecision({ doc, container, channel: a1, shown: SHOWN, newRequestId: make }), m1, "the page's current shown: same mount");
  assert.equal(m1.controller.view().status, "ready");
  const m2 = await skelMountDecision({ doc, container, channel: a1, shown: { ...SHOWN, reviewVersion: VERSION_B }, newRequestId: make });
  assert.equal(m2, m1);
  assert.equal(m1.controller.view().identity.shownVersion, VERSION_B, "applied with setShown");
  assert.equal(m1.controller.view().status, "stale", "a page move holds actions as usual");
  assert.equal(container.children.length, 1);
});

test("#77: mounting twice in one container gives one UI and one controller", async () => {
  const doc = fakeDoc();
  const container = doc.createElement("div");
  const auth = createMockAuthority();
  const opts = { doc, container, channel: auth, shown: SHOWN, newRequestId: ids() };
  const [a, b] = await Promise.all([skelMountDecision(opts), skelMountDecision(opts)]);
  assert.equal(a, b);
  assert.equal(container.children.length, 1);
  assert.equal(await skelMountDecision(opts), a);
});

test("#77: reshape names the approved version and needs the page to agree", async () => {
  const shown = { phase: "fill", reviewVersion: VERSION_B, approvedVersion: VERSION_A, pendingNotes: true };
  const { auth, ctl } = await setup({ state: AUTHORITY_STATES.fill, shown });
  const v = ctl.view();
  assert.equal(action(v, "approve"), undefined);
  assert.equal(action(v, "reshape").enabled, true);
  assert.deepEqual(await ctl.decide("reshape"), { kind: "committed", revision: 6 });
  assert.equal(auth.calls.submit[0].reviewVersion, VERSION_A);
  assert.equal(ctl.view().approved, null, "a reshape is never shown as an approval");
  const off = await setup({ state: AUTHORITY_STATES.fill, shown: { ...shown, approvedVersion: VERSION_B } });
  assert.match(action(off.ctl.view(), "reshape").reason, /doesn't match/);
});

test("#77: an unreadable or malformed state turns decisions off", async () => {
  for (const getState of [async () => { throw new Error("down"); }, async () => ({ ...AUTHORITY_STATES.skeleton, revision: "4" }), async () => null]) {
    const ctl = skelDecisionController({ channel: { getState, submit: async () => assert.fail("no submit") }, shown: SHOWN, newRequestId: ids() });
    await ctl.load();
    const v = ctl.view();
    assert.equal(v.identity, null);
    assert.deepEqual(v.actions, []);
    assert.match(v.message.text, /decisions are off\. Nothing changed/);
  }
});

// ---- drawing ----

test("#77: drawn with a mock channel — identity as text, approve only after committed, duplicate clicks safe", async () => {
  const doc = fakeDoc();
  const container = doc.createElement("div");
  // Markup in an id never reaches the page: the shared schema refuses it, so no identity or action is drawn.
  const hostile = createMockAuthority();
  hostile.setState({ ...AUTHORITY_STATES.skeleton, projectId: "<img src=x onerror=alert(1)>" });
  const hc = doc.createElement("div");
  await skelMountDecision({ doc, container: hc, channel: hostile, shown: SHOWN, newRequestId: ids() });
  assert.equal(byAttr(hc, "data-decision-identity")[0].children.length, 0);
  assert.equal(byAttr(hc, "data-decision-action").length, 0);
  assert.doesNotMatch(hc.children[0].textContent, /<img/);
  const auth = createMockAuthority();
  const m = await skelMountDecision({ doc, container, channel: auth, shown: SHOWN, newRequestId: ids() });
  const panel = () => container.children[0];
  assert.equal(container.children.length, 1);
  const identity = byAttr(panel(), "data-decision-identity")[0];
  assert.ok(all(identity, (n) => n.tag === "#text").some((t) => t.text === "example-project"), "drawn as a text node");
  assert.ok(identity.textContent.includes(VERSION_A) && identity.textContent.includes("4"));
  assert.equal(byAttr(panel(), "data-decision-approved").length, 0);
  const btn = byAttr(panel(), "data-decision-action", "approve")[0];
  btn.click();
  btn.click();
  assert.ok("disabled" in byAttr(panel(), "data-decision-action", "approve")[0].attrs, "disabled while sending");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.calls.submit.length, 1);
  assert.equal(byAttr(panel(), "data-decision-approved", VERSION_A).length, 1);
  assert.equal(container.children.length, 1, "redrawn in place");
  assert.ok(m.controller);
  assert.doesNotMatch(DECISION, /innerHTML|insertAdjacentHTML|outerHTML/, "the module never writes markup");
});

test("#77: drawn rejection shows its copy and a Re-read button", async () => {
  const doc = fakeDoc();
  const container = doc.createElement("div");
  const auth = createMockAuthority();
  auth.force({ kind: "rejected", requestId: "req-1", code: "revision-conflict" });
  await skelMountDecision({ doc, container, channel: auth, shown: SHOWN, newRequestId: ids() });
  byAttr(container, "data-decision-action", "approve")[0].click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.match(byAttr(container, "data-decision-message", "revision-conflict")[0].textContent, /Another decision came first/);
  assert.equal(byAttr(container, "data-decision-reread").length, 1);
  assert.equal(byAttr(container, "data-decision-approved").length, 0);
});

// ---- production: no channel, no decision UI, the default page unchanged ----

test("#77: no channel means no decision UI", async () => {
  const doc = fakeDoc();
  const container = doc.createElement("div");
  assert.equal(await skelMountDecision({ doc, container, channel: null, shown: SHOWN, newRequestId: ids() }), null);
  assert.equal(container.children.length, 0);
  const ctl = skelDecisionController({ channel: null, shown: SHOWN, newRequestId: ids() });
  assert.deepEqual(ctl.view(), { present: false });
  assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" });
  assert.equal(skelDecisionRender(doc, ctl.view(), {}), null);
});

test("#77: the default page is unchanged — the decision module isn't loaded, served or wired", () => {
  const js = clientScript();
  const expected = ["review-poll.js", "review-feedback.js", "review-progress.js", "review-client.js"].map(read).join("\n").replace(/\r\n?/g, "\n");
  assert.equal(js, expected, "the served script is exactly the four existing files");
  for (const name of ["skelDecision", "skelMountDecision", "DecisionChannel", "review-decision"]) {
    assert.ok(!js.includes(name), `served script mentions ${name}`);
    assert.ok(!renderShell().includes(name));
    assert.ok(!renderHtml({ title: "T", diagrams: [], phase: "scaffold" }).includes(name));
  }
  // No approval or decision endpoint on the agent-reachable review server.
  // A source-text check of bin/skel.mjs: every use of req.url, and every
  // "/api/..." or "/assets/..." literal, is one of today's routes. Its limit:
  // a route added in another file, or through a router that never names
  // req.url, wouldn't be seen here.
  const server = fs.readFileSync(path.join(HERE, "..", "bin", "skel.mjs"), "utf-8");
  const uses = [...server.matchAll(/req\.url\b(\s*===\s*"[^"]*"|\.startsWith\("[^"]*"\))?/g)].map((m) => m[0].replace(/\s+/g, " "));
  assert.deepEqual([...new Set(uses)].sort(), [
    'req.url === "/"', 'req.url === "/api/data"', 'req.url === "/api/feedback"', 'req.url === "/api/version"', 'req.url === "/assets/review.js"', 'req.url.startsWith("/?")',
  ], "every req.url use is a known route comparison");
  const literals = new Set([...server.matchAll(/["'`](\/(?:api|assets)\/[^"'`]*)["'`]/g)].map((m) => m[1]));
  assert.deepEqual([...literals].sort(), ["/api/data", "/api/feedback", "/api/version", "/assets/review.js"]);
  assert.doesNotMatch(server, /switch\s*\(\s*req\.|new URL\(\s*req\.url|req\.path\b|\/api\/(approve|reshape|decision|intent|sign)/);
  assert.doesNotMatch(server, /review-decision/);
  for (const dir of ["lib", "bin"]) {
    for (const f of fs.readdirSync(path.join(HERE, "..", dir))) {
      if (f === "review-decision.mjs") continue;
      assert.doesNotMatch(fs.readFileSync(path.join(HERE, "..", dir, f), "utf-8"), /review-decision/, `${dir}/${f} loads the decision module`);
    }
  }
});

test("#77: an Intent built by the UI carries no token or secret, only the contract fields", async () => {
  const { auth, ctl } = await setup();
  await ctl.decide("approve");
  assert.ok(parseStrictIntent(auth.calls.submit[0]));
  assert.deepEqual(auth.calls.submit[0], intentFor(AUTHORITY_STATES.skeleton, "approve", "req-1"));
  assert.doesNotMatch(DECISION, /x-skeleton-token|sessionStorage|localStorage|fetch\(/, "the module uses no review token, storage or network of its own");
});
