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
  CAPTURE_1, CAPTURE_2, CAPTURE_3, SHAPE_A, SHAPE_B, V2_INITIAL_STATE, createPlannerAuthority, v2ShownFor,
} from "./fixtures/strict-results.mjs";
import { SKEL_DECISION_REJECTION, SKEL_DECISION_V2_ABSENT_GATES, skelDecisionConfirms, skelDecisionController, skelDecisionOutcome, skelDecisionRender, skelMountDecision, skelShownProtocol } from "../lib/review-decision.mjs";

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
  "stale-review": /aaaaaaaaaaaa is no longer the version under review, so this request was refused and made no change\. .*Reload the review/,
  "revision-conflict": /after this page read it, so this request was refused and made no change\. The current state has been re-read/,
  "invalid-transition": /Approve skeleton isn't allowed while the skeleton is in the skeleton phase, so this request was refused and made no change\./,
  "unauthorized-channel": /didn't arrive through the protected human channel.*Copy\/Send feedback still work/,
  "session-ended": /session this review belongs to has ended, so this request was refused and made no change\. That doesn't show whether an earlier request committed\. Decisions from this page are off/,
  unavailable: /answered "unavailable", so whether the request for aaaaaaaaaaaa was recorded is unknown, and it is not shown as approved\. Retry sends the same request.*Re-read shows the current state, which can't show whether this request was recorded/,
  "request-reused": /already used for a different decision, so this request was refused and recorded nothing/,
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
    assert.match(v.message.text, /phase fill, review round example-round, revision 5, version under review aaaaaaaaaaaa, approved version aaaaaaaaaaaa\. The current state can't show whether the request for aaaaaaaaaaaa was recorded, so it is still unconfirmed/);
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

test("#77 #83: a committed reshape confirms on the rotated review round", async () => {
  const shown = { phase: "fill", reviewVersion: VERSION_A, approvedVersion: VERSION_A, pendingNotes: false };
  const { auth, ctl } = await setup({ state: AUTHORITY_STATES.fill, shown });
  assert.deepEqual(await ctl.decide("reshape"), { kind: "committed", revision: 6 });
  assert.equal(auth.state.reviewRoundId, "example-round-after-r6", "the mock rotates the round, as #83 does");
  const v = ctl.view();
  assert.equal(v.message.title, "Reshape recorded", "not 'Recorded, but the state differs'");
  assert.equal(v.status, "ready");
  assert.equal(v.identity.reviewRoundId, "example-round-after-r6");
  assert.equal(v.approved, null, "a reshape is never shown as an approval");
});

test("#77 #83: the mock's reshape can also set the new version under review, as #83's host contentVersion does", async () => {
  const shown = { phase: "fill", reviewVersion: VERSION_A, approvedVersion: VERSION_A, pendingNotes: false };
  const auth = createMockAuthority({ state: AUTHORITY_STATES.fill, nextReviewVersion: () => VERSION_B });
  const ctl = skelDecisionController({ channel: auth, shown, newRequestId: ids() });
  await ctl.load();
  assert.deepEqual(await ctl.decide("reshape"), { kind: "committed", revision: 6 });
  assert.deepEqual(auth.state, { ...AUTHORITY_STATES.fill, phase: "skeleton", approvedVersion: null, reviewRoundId: "example-round-after-r6", reviewVersion: VERSION_B, revision: 6 });
  assert.ok(parseAuthorityState(auth.state));
  assert.equal(auth.calls.submit[0].reviewVersion, VERSION_A, "the intent still names the approved version");
  const v = ctl.view();
  assert.equal(v.message.title, "Reshape recorded");
  assert.equal(v.identity.reviewVersion, VERSION_B);
  // Without the option, the version under review is unchanged (the existing behaviour).
  const plain = createMockAuthority({ state: AUTHORITY_STATES.fill });
  await plain.submit(INTENTS.reshape);
  assert.equal(plain.state.reviewVersion, VERSION_A);
});

test("#77 #83: reshape and approve confirmation rules around the round", () => {
  const reshape = intentFor(AUTHORITY_STATES.fill, "reshape", "rs-1"); // round example-round, expects rev 5
  const rotated = { ...AUTHORITY_STATES.fill, reviewRoundId: "example-round-2", phase: "skeleton", approvedVersion: null, revision: 6 };
  assert.equal(skelDecisionConfirms(rotated, reshape, 6), true, "rotated round, skeleton, no approval, at the commit");
  assert.equal(skelDecisionConfirms({ ...rotated, revision: 9 }, reshape, 6), true, "later revisions too");
  assert.equal(skelDecisionConfirms({ ...rotated, revision: 5 }, reshape, 6), false, "older than the commit");
  assert.equal(skelDecisionConfirms({ ...rotated, reviewRoundId: "example-round", revision: 5 }, reshape, 6), false, "old round, lower revision");
  assert.equal(skelDecisionConfirms({ ...rotated, reviewRoundId: "example-round" }, reshape, 6), false, "a reshape that didn't rotate isn't the one #83 commits");
  assert.equal(skelDecisionConfirms({ ...rotated, phase: "fill", approvedVersion: VERSION_A }, reshape, 6), false);
  assert.equal(skelDecisionConfirms({ ...rotated, sessionId: "other-session" }, reshape, 6), false);
  assert.equal(skelDecisionConfirms({ ...rotated, projectId: "other-project" }, reshape, 6), false);
  const approve = intentFor(AUTHORITY_STATES.skeleton, "approve", "ap-1");
  const filled = { ...AUTHORITY_STATES.skeleton, phase: "fill", approvedVersion: VERSION_A, revision: 5 };
  assert.equal(skelDecisionConfirms(filled, approve, 5), true);
  assert.equal(skelDecisionConfirms({ ...filled, reviewRoundId: "example-round-2" }, approve, 5), false, "approve keeps the same-round rule");
});

test("#77: an unreadable or malformed state turns decisions off", async () => {
  for (const getState of [async () => { throw new Error("down"); }, async () => ({ ...AUTHORITY_STATES.skeleton, revision: "4" }), async () => null]) {
    const ctl = skelDecisionController({ channel: { getState, submit: async () => assert.fail("no submit") }, shown: SHOWN, newRequestId: ids() });
    await ctl.load();
    const v = ctl.view();
    assert.equal(v.identity, null);
    assert.deepEqual(v.actions, []);
    assert.match(v.message.text, /decisions are off\. Reading the state never changes it/);
  }
});

// R6 (docs/strict-decision-page.md): no copy may imply that a Re-read, a
// reload or the current state settles whether an earlier request committed.
// Only the same-id Retry answer, or an authoritative journal lookup, can.
// Messages are single sentences joined on one line, so `.*` spans periods
// inside version strings.
const R6_OVERCLAIMS = [
  /\blanded\b/i,
  /\btook effect\b|\btakes effect\b/i,
  /\bnothing (new )?(was |has been |is )?(approved|reshaped|finali[sz]ed|recorded|changed|\$\{)/i,
  /\b(re-?read(ing)?|reload(ing)?|the current state)\b.*\b(shows|confirms|settles|tells you|will show) whether/i,
  /\bcheck whether (it|the request|the decision)\b/i,
];
// After an unknown outcome, a refused Retry can't say the request made no change.
// Codes whose answer to a Retry leaves the earlier send's outcome unknown.
const RESEND_UNKNOWN = ["session-ended", "unauthorized-channel", "unavailable", "request-reused"];
const RESEND_OVERCLAIMS = [/made no change/i, /recorded nothing/i, /nothing (new )?(was )?recorded/i];
const r6Check = (text, extra = []) => { for (const bad of [...R6_OVERCLAIMS, ...extra]) assert.doesNotMatch(text, bad, `overclaims a historical outcome: ${text}`); };

test("#77 R6: no decision string or rendered rejection claims a Re-read, reload or current state settles an earlier outcome", () => {
  // Every string literal in the module, single-quoted included, with comments stripped first ...
  const code = DECISION.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([;,{}()\]])\s*\/\/.*$/gm, "$1");
  const literals = code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g);
  assert.ok(literals.length > 40, "the scan found the module's strings");
  for (const known of ["Couldn't confirm whether the decision was recorded", "The current state can't show whether", "has ended, so this request was refused", "this retry was refused"]) {
    assert.ok(literals.some((l) => l.includes(known)), `the scan covers: ${known}`);
  }
  // ... and every rejection's rendered copy, for both offered actions, fresh and resent.
  assert.deepEqual(Object.keys(SKEL_DECISION_REJECTION).sort(), [...REJECTION_CODES].sort());
  for (const code of REJECTION_CODES) {
    for (const w of [{ label: "Approve skeleton", done: "approved" }, { label: "Reshape", done: "reshaped" }]) {
      for (const resent of [false, true]) {
        const m = SKEL_DECISION_REJECTION[code]({ ...w, version: "v1.2.3", phase: "skeleton", resent });
        r6Check(`${m.title} ${m.text}`, resent && RESEND_UNKNOWN.includes(code) ? RESEND_OVERCLAIMS : []);
      }
    }
  }
  for (const text of literals) r6Check(text);
  // The scan itself catches the phrasings it is for, across periods in a version.
  for (const old of ["Whether the request landed is unconfirmed.", "Re-read to see whether it took effect.", "so nothing was approved.", "so nothing was ${c.done}.", "Nothing changed.", "Re-read shows whether it was recorded.", "Re-read for v1.2.3 shows whether it was recorded."]) {
    assert.ok(R6_OVERCLAIMS.some((re) => re.test(old)), old);
  }
});

test("#77 R6: rendered messages on every controller path make no historical claim", async () => {
  const seen = [];
  const note = (ctl, label, extra = []) => { const m = ctl.view().message; if (m) { seen.push(label); r6Check(`${m.title} ${m.text}`, extra); } };
  // Fresh rejections, and the same codes on a Retry after an unknown outcome.
  for (const code of REJECTION_CODES) {
    const fresh = await setup();
    fresh.auth.force({ kind: "rejected", requestId: "req-1", code });
    await fresh.ctl.decide("approve");
    note(fresh.ctl, `fresh ${code}`);
    for (const first of ["unavailable", "throw"]) {
      const { auth, ctl } = await setup();
      if (first === "throw") { const real = auth.submit; let n = 0; auth.submit = async (i) => { if (n++ === 0) { auth.calls.submit.push(i); throw new Error("reset"); } return real(i); }; }
      else auth.force({ kind: "rejected", requestId: "req-1", code: "unavailable" });
      await ctl.decide("approve");
      note(ctl, `unknown ${first}`, RESEND_OVERCLAIMS);
      await ctl.load(); // Re-read keeps it unconfirmed
      note(ctl, `reread after ${first}`, RESEND_OVERCLAIMS);
      auth.force({ kind: "rejected", requestId: "req-1", code });
      await ctl.decide("approve");
      note(ctl, `retry ${code} after ${first}`, RESEND_UNKNOWN.includes(code) ? RESEND_OVERCLAIMS : []);
    }
  }
  // Malformed answer.
  const mal = await setup();
  mal.auth.force({ kind: "committed", requestId: "other", action: "approve", reviewVersion: VERSION_A, revision: 5 });
  await mal.ctl.decide("approve");
  note(mal.ctl, "malformed");
  // Committed, but the re-read state doesn't show it.
  const differs = await setup();
  differs.auth.force(committedFor({ ...INTENTS.approve, requestId: "req-1" }));
  await differs.ctl.decide("approve");
  note(differs.ctl, "recorded but differs");
  // The page moved while sending.
  const moved = await setup();
  let release;
  moved.auth.submit = (i) => new Promise((r) => { release = () => r({ kind: "rejected", requestId: i.requestId, code: "unavailable" }); });
  const p = moved.ctl.decide("approve");
  await tick(); await tick();
  await moved.ctl.setShown({ ...SHOWN, reviewVersion: VERSION_B });
  note(moved.ctl, "page moved");
  release();
  await p;
  note(moved.ctl, "moved answer", RESEND_OVERCLAIMS);
  // An unreadable state.
  const unreadable = skelDecisionController({ channel: { getState: async () => null, submit: async () => assert.fail("no submit") }, shown: SHOWN, newRequestId: ids() });
  await unreadable.load();
  note(unreadable, "unreadable");
  assert.ok(seen.length >= REJECTION_CODES.length * 7 + 5, `paths covered: ${seen.length}`);
});

for (const code of ["unauthorized-channel", "session-ended", "request-reused"]) {
  test(`#77 R6: a Retry answered ${code} leaves the first send's outcome unknown`, async () => {
    const { auth, ctl } = await setup();
    auth.force({ kind: "rejected", requestId: "req-1", code: "unavailable" });
    await ctl.decide("approve");
    assert.equal(ctl.requestRetained, "req-1");
    auth.force({ kind: "rejected", requestId: "req-1", code });
    assert.deepEqual(await ctl.decide("approve"), { kind: "rejected", code });
    assert.equal(auth.calls.submit.length, 2);
    assert.equal(auth.calls.submit[1].requestId, "req-1", "it was a resend of the kept intent");
    const v = ctl.view();
    assert.equal(v.status, { "session-ended": "ended", "unauthorized-channel": "refused", "request-reused": "stale" }[code]);
    assert.equal(v.approved, null);
    assert.equal(v.message.code, code);
    assert.match(v.message.text, /this (retry|send) was refused\. Whether the earlier send of this request for aaaaaaaaaaaa was recorded is unknown, and it is not shown as approved/);
    assert.doesNotMatch(v.message.text, /made no change|recorded nothing|doesn't show whether an earlier request committed/);
    assert.ok(v.actions.every((a) => !a.enabled && !a.retry), "decisions are held, and the kept request is gone");
    assert.equal(ctl.requestRetained, null);
    // A fresh request answered the same way still says this request changed nothing.
    const fresh = await setup();
    fresh.auth.force({ kind: "rejected", requestId: "req-1", code });
    await fresh.ctl.decide("approve");
    assert.match(fresh.ctl.view().message.text, code === "request-reused" ? /this request was refused and recorded nothing/ : /this request was refused and made no change/);
  });
}

for (const code of ["stale-review", "revision-conflict", "invalid-transition"]) {
  test(`#77 R6: a Retry answered ${code} still means nothing was recorded (exact retries replay first)`, async () => {
    const { auth, ctl } = await setup();
    auth.force({ kind: "rejected", requestId: "req-1", code: "unavailable" });
    await ctl.decide("approve");
    auth.force({ kind: "rejected", requestId: "req-1", code });
    await ctl.decide("approve");
    assert.equal(auth.calls.submit[1].requestId, "req-1");
    assert.match(ctl.view().message.text, /this request was refused and made no change/);
    assert.equal(ctl.requestRetained, null);
  });
}

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
      // The disabled capture-view prototype (host model, browser DOM half and
      // host convenience renderer) intentionally reuses the shown parser and
      // its own modules. No other lib/bin file may load either prototype.
      if (dir === "lib" && ["strict-capture-view.mjs", "strict-capture-view-model.mjs", "strict-capture-view-dom.mjs",
        "strict-decision-listener.mjs", "strict-decision-app.mjs"].includes(f)) continue;
      assert.doesNotMatch(fs.readFileSync(path.join(HERE, "..", dir, f), "utf-8"), /review-decision|strict-capture-view/, `${dir}/${f} loads a protected UI prototype`);
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

// ---- V2 exact-capture adapter (#77 after #90), against the REAL V2 planner ----

async function setupV2({ auth = createPlannerAuthority(), shown } = {}) {
  const ctl = skelDecisionController({ channel: auth, shown: shown ?? v2ShownFor(auth.state), newRequestId: ids() });
  await ctl.load();
  return { auth, ctl };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const v2Approve = (s, requestId) => ({ protocolVersion: 2, requestId, action: "approve", projectId: s.projectId, sessionId: s.sessionId, reviewRoundId: s.reviewRoundId, reviewVersion: s.reviewVersion, expectedRevision: s.revision, captureVersion: s.captureVersion });

test("#77 V2: approve binds the shown shape AND raw capture; approved only after the planner commits and the re-read confirms the pair", async () => {
  const { auth, ctl } = await setupV2();
  assert.equal(action(ctl.view(), "approve").enabled, true);
  const id = ctl.view().identity;
  assert.equal(id.protocolVersion, 2);
  assert.equal(id.captureVersion, CAPTURE_1);
  assert.equal(id.shownCaptureVersion, CAPTURE_1);
  assert.equal(id.approvedCaptureVersion, null);
  const out = await ctl.decide("approve");
  assert.equal(out.kind, "committed");
  assert.deepEqual(auth.calls.submit[0], v2Approve(V2_INITIAL_STATE, "req-1"));
  assert.ok(parseStrictIntent(auth.calls.submit[0]));
  assert.equal(auth.state.approvedCaptureVersion, CAPTURE_1);
  assert.deepEqual(ctl.view().approved, { reviewVersion: SHAPE_A, revision: 1, captureVersion: CAPTURE_1 });
  assert.match(ctl.view().message.text, new RegExp(CAPTURE_1));
});

test("#77 V2: reshape names the approved shape + approvedCapture and confirms on the planner's rotated round", async () => {
  const auth = createPlannerAuthority();
  assert.equal((await auth.submit(v2Approve(auth.state, "seed-approve"))).kind, "committed");
  auth.setFacts({ nextReviewRoundId: "example-round-2", contentVersion: SHAPE_B, captureVersion: CAPTURE_2 });
  const fill = auth.state;
  const { ctl } = await setupV2({ auth });
  assert.equal(action(ctl.view(), "reshape").enabled, true);
  const out = await ctl.decide("reshape");
  assert.equal(out.kind, "committed");
  assert.deepEqual(auth.calls.submit.at(-1), { protocolVersion: 2, requestId: "req-1", action: "reshape", projectId: fill.projectId, sessionId: fill.sessionId, reviewRoundId: fill.reviewRoundId, reviewVersion: SHAPE_A, expectedRevision: fill.revision, captureVersion: CAPTURE_1 });
  assert.equal(ctl.view().status, "ready");
  assert.equal(ctl.view().message.title, "Reshape recorded");
  assert.equal(auth.state.reviewRoundId, "example-round-2");
  assert.equal(auth.state.captureVersion, CAPTURE_2);
  // The page's approved capture disagreeing with the state holds reshape.
  const auth2 = createPlannerAuthority();
  await auth2.submit(v2Approve(auth2.state, "seed"));
  const { ctl: ctl2 } = await setupV2({ auth: auth2, shown: v2ShownFor(auth2.state, { approvedCaptureVersion: CAPTURE_3 }) });
  assert.equal(action(ctl2.view(), "reshape").enabled, false);
  assert.match(action(ctl2.view(), "reshape").reason, /approved raw capture/);
});

test("#77 V2: a same-shape raw capture swap in the state (real Recapture) holds the decision and never re-enables it", async () => {
  const { auth, ctl } = await setupV2();
  auth.setFacts({ captureVersion: CAPTURE_2 });
  assert.equal(auth.recapture("other-actor-recapture").kind, "recaptured");
  assert.equal(auth.state.reviewVersion, SHAPE_A, "same shape");
  assert.equal(auth.state.captureVersion, CAPTURE_2, "different raw capture");
  assert.equal((await ctl.decide("approve")).kind, "stale");
  assert.equal(auth.calls.submit.length, 0, "nothing sent");
  assert.equal(ctl.view().status, "stale");
  await ctl.load(); // Re-read: the page still shows CAPTURE_1
  assert.equal(ctl.view().status, "ready");
  const a = action(ctl.view(), "approve");
  assert.equal(a.enabled, false);
  assert.match(a.reason, /raw capture/);
  assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" });
  assert.equal(auth.calls.submit.length, 0);
  // Only a page that explicitly shows the new capture may approve, and it binds that capture.
  await ctl.setShown(v2ShownFor(auth.state));
  await ctl.load();
  assert.equal((await ctl.decide("approve")).kind, "committed");
  assert.equal(auth.calls.submit[0].captureVersion, CAPTURE_2);
});

test("#77 V2: a page showing the right shape but a different raw capture can't approve; the digest is never taken from the state", async () => {
  const { auth, ctl } = await setupV2({ shown: v2ShownFor(V2_INITIAL_STATE, { captureVersion: CAPTURE_2 }) });
  assert.equal(action(ctl.view(), "approve").enabled, false);
  assert.equal(ctl.view().identity.shownCaptureVersion, CAPTURE_2);
  assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" });
  assert.equal(auth.calls.submit.length, 0);
});

test("#77 V2 race: a same-shape raw swap on the page during the pre-send read sends nothing", async () => {
  const auth = createPlannerAuthority();
  const gate = deferred();
  let hold = false;
  const channel = { getState: async () => { if (hold) await gate.promise; return auth.getState(); }, submit: (i) => auth.submit(i) };
  const ctl = skelDecisionController({ channel, shown: v2ShownFor(auth.state), newRequestId: ids() });
  await ctl.load();
  hold = true;
  const p = ctl.decide("approve");
  const moved = ctl.setShown(v2ShownFor(auth.state, { captureVersion: CAPTURE_2 }));
  hold = false;
  gate.resolve();
  await moved;
  assert.equal((await p).kind, "stale");
  assert.equal(auth.calls.submit.length, 0);
  assert.equal(ctl.view().status, "stale");
  assert.equal(ctl.view().approved, null);
});

test("#77 V2 race: a same-shape raw swap on the page while the approve is in flight reports the commit but never shows approval or retains", async () => {
  const auth = createPlannerAuthority();
  const gate = deferred();
  const channel = { getState: () => auth.getState(), submit: async (i) => { const r = await auth.submit(i); await gate.promise; return r; } };
  const ctl = skelDecisionController({ channel, shown: v2ShownFor(auth.state), newRequestId: ids() });
  await ctl.load();
  const p = ctl.decide("approve");
  await tick(); await tick();
  assert.equal(auth.calls.submit.length, 1, "in flight");
  const moved = ctl.setShown(v2ShownFor(auth.state, { captureVersion: CAPTURE_2 }));
  gate.resolve();
  await moved;
  assert.equal((await p).kind, "committed");
  assert.equal(auth.commits(), 1);
  const v = ctl.view();
  assert.equal(v.status, "stale");
  assert.equal(v.approved, null);
  assert.equal(ctl.requestRetained, null);
  assert.match(v.message.text, /recorded it/);
  r6Check(v.message.text);
});

test("#77 V2: mixed-protocol, missing or wrong digest committed replies and recaptured results are malformed", () => {
  const intent = v2Approve(V2_INITIAL_STATE, "req-1");
  const good = { kind: "committed", requestId: "req-1", action: "approve", reviewVersion: SHAPE_A, revision: 1, protocolVersion: 2, captureVersion: CAPTURE_1 };
  assert.deepEqual(skelDecisionOutcome(good, intent), { kind: "committed", revision: 1 });
  const { protocolVersion, captureVersion, ...v1Reply } = good;
  assert.equal(skelDecisionOutcome(v1Reply, intent).kind, "malformed", "V1 reply to a V2 intent");
  assert.equal(skelDecisionOutcome({ ...good, captureVersion: CAPTURE_2 }, intent).kind, "malformed", "wrong raw digest");
  assert.equal(skelDecisionOutcome({ ...good, reviewVersion: SHAPE_B }, intent).kind, "malformed", "wrong shape digest");
  assert.equal(skelDecisionOutcome({ ...v1Reply, protocolVersion: 2 }, intent).kind, "malformed", "missing raw digest");
  assert.equal(skelDecisionOutcome({ kind: "recaptured", requestId: "req-1", action: "recapture", protocolVersion: 2, reviewVersion: SHAPE_A, captureVersion: CAPTURE_1, revision: 1, changed: true }, intent).kind, "malformed");
  const v1Intent = INTENTS.approve;
  assert.equal(skelDecisionOutcome({ ...committedFor(v1Intent), protocolVersion: 2, captureVersion: CAPTURE_1 }, v1Intent).kind, "malformed", "V2 reply to a V1 intent");
  assert.equal(skelDecisionOutcome(committedFor(v1Intent), v1Intent).kind, "committed");
  // Confirmation needs the approved capture, in the intent's protocol.
  const fill = { ...V2_INITIAL_STATE, phase: "fill", approvedVersion: SHAPE_A, approvedCaptureVersion: CAPTURE_1, revision: 1 };
  assert.equal(skelDecisionConfirms(fill, intent, 1), true);
  assert.equal(skelDecisionConfirms({ ...fill, approvedCaptureVersion: CAPTURE_2 }, intent, 1), false);
  const { protocolVersion: _p, captureVersion: _c, approvedCaptureVersion: _a, ...v1Fill } = fill;
  assert.equal(skelDecisionConfirms(v1Fill, intent, 1), false, "a V1 state confirms nothing for V2");
  assert.equal(skelDecisionConfirms(fill, { ...v1Intent, reviewVersion: SHAPE_A, expectedRevision: 0 }, 1), false, "a V2 state confirms nothing for V1");
});

test("#77 V2: a mixed or wrong-capture committed reply, or a recaptured result, in the controller is never shown as approved", async () => {
  for (const reply of [
    { kind: "committed", requestId: "req-1", action: "approve", reviewVersion: SHAPE_A, revision: 1 },
    { kind: "committed", requestId: "req-1", action: "approve", reviewVersion: SHAPE_A, revision: 1, protocolVersion: 2, captureVersion: CAPTURE_2 },
    { kind: "recaptured", requestId: "req-1", action: "recapture", protocolVersion: 2, reviewVersion: SHAPE_A, captureVersion: CAPTURE_1, revision: 1, changed: true },
  ]) {
    const { auth, ctl } = await setupV2();
    auth.force(reply);
    assert.equal((await ctl.decide("approve")).kind, "malformed");
    assert.equal(ctl.view().approved, null);
    assert.equal(ctl.view().status, "stale");
    assert.equal(ctl.requestRetained, null);
  }
});

test("#77 V2: a reply lost after a real commit keeps the exact request; Re-read never settles it; the same-ID Retry replays the original", async () => {
  const { auth, ctl } = await setupV2();
  auth.loseNextReply();
  assert.equal((await ctl.decide("approve")).kind, "unknown");
  assert.equal(auth.commits(), 1, "the planner really committed");
  assert.equal(ctl.requestRetained, "req-1");
  assert.equal(ctl.view().approved, null);
  await ctl.load(); // the current state shows the approve in effect, but that settles nothing
  const v = ctl.view();
  assert.equal(auth.state.approvedCaptureVersion, CAPTURE_1);
  assert.equal(v.approved, null);
  assert.equal(v.message.title, "Still unconfirmed");
  r6Check(v.message.text);
  assert.deepEqual(v.actions.map((a) => [a.action, a.retry]), [["approve", true]]);
  assert.equal((await ctl.decide("approve")).kind, "committed");
  assert.deepEqual(auth.calls.submit[1], auth.calls.submit[0], "the exact original requestID and pair, not rebuilt from the current state");
  assert.equal(auth.calls.submit[1].expectedRevision, 0);
  assert.equal(auth.commits(), 1, "replayed, not decided twice");
  assert.deepEqual(ctl.view().approved, { reviewVersion: SHAPE_A, revision: 1, captureVersion: CAPTURE_1 });
});

test("#77 V2: a missing, V1 or malformed shown context refuses, with no fallback to V1", async () => {
  const base = v2ShownFor(V2_INITIAL_STATE);
  const { protocolVersion, captureVersion, approvedCaptureVersion, ...v1Shown } = base;
  const { approvedCaptureVersion: _drop, ...noApprovedCap } = base;
  const cases = {
    "V1 shown on V2 state": v1Shown,
    "explicit protocolVersion 1 on V2 state": { ...v1Shown, protocolVersion: 1 },
    "missing approvedCaptureVersion": noApprovedCap,
    "non-digest captureVersion": { ...base, captureVersion: "not-a-digest" },
    "undefined captureVersion": { ...base, captureVersion: undefined },
    "captureVersion without protocolVersion": { ...v1Shown, captureVersion: CAPTURE_1 },
    "protocolVersion 1 with a capture": { ...base, protocolVersion: 1 },
    "unknown protocolVersion": { ...base, protocolVersion: 3 },
    "approved capture without approved version": { ...base, approvedCaptureVersion: CAPTURE_1 },
  };
  for (const [name, shown] of Object.entries(cases)) {
    const { auth, ctl } = await setupV2({ shown });
    const a = action(ctl.view(), "approve");
    assert.equal(a.enabled, false, name);
    assert.ok(a.reason, name);
    assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" }, name);
    assert.equal(auth.calls.submit.length, 0, name);
  }
  assert.equal(skelShownProtocol(v1Shown), 1);
  assert.equal(skelShownProtocol(base), 2);
  assert.equal(skelShownProtocol(noApprovedCap), null);
  assert.equal(skelShownProtocol(null), null);
  // A V1 state with a V2 shown context refuses too.
  const { auth, ctl } = await setup({ shown: { ...SHOWN, reviewVersion: SHAPE_A, protocolVersion: 2, captureVersion: CAPTURE_1, approvedCaptureVersion: null } });
  assert.equal(action(ctl.view(), "approve").enabled, false);
  assert.deepEqual(await ctl.decide("approve"), { kind: "refused-locally" });
  assert.equal(auth.calls.submit.length, 0);
});

test("#77 V2: Recapture is never offered or sent by the decision UI", async () => {
  const { auth, ctl } = await setupV2();
  assert.ok(ctl.view().actions.every((a) => a.action !== "recapture"));
  assert.deepEqual(await ctl.decide("recapture"), { kind: "refused-locally" });
  assert.equal(auth.calls.submit.length, 0);
});

test("#77 V2: identity draws as text only, with the shown and authority pair; the intent has no token or secret", async () => {
  const { auth, ctl } = await setupV2();
  const node = skelDecisionRender(fakeDoc(), ctl.view(), { decide() {}, reread() {} });
  const dl = byAttr(node, "data-decision-identity")[0];
  const text = dl.children.map((c) => c.textContent);
  for (const label of ["Protocol", "Raw capture shown", "Raw capture under review", "Approved raw capture"]) assert.ok(text.includes(label), label);
  assert.ok(text.includes(CAPTURE_1));
  assert.ok(dl.children.every((c) => c.children.every((k) => k.tag === "#text")), "text nodes only");
  await ctl.decide("approve");
  assert.deepEqual(Object.keys(auth.calls.submit[0]).sort(), ["action", "captureVersion", "expectedRevision", "projectId", "protocolVersion", "requestId", "reviewRoundId", "reviewVersion", "sessionId"]);
});

test("#77 V2: future gates stay absent and explicit", () => {
  assert.deepEqual([...SKEL_DECISION_V2_ABSENT_GATES], ["listener-authenticated-origin", "capture-persistence", "capture-freeze", "anti-rollback"]);
  assert.ok(Object.isFrozen(SKEL_DECISION_V2_ABSENT_GATES));
});

test("#77 V1 regression: default prototype intents, replies and identity carry no V2 fields", async () => {
  const { auth, ctl } = await setup();
  const id = ctl.view().identity;
  for (const k of ["protocolVersion", "captureVersion", "approvedCaptureVersion", "shownCaptureVersion"]) assert.ok(!(k in id), k);
  const node = skelDecisionRender(fakeDoc(), ctl.view(), { decide() {}, reread() {} });
  assert.ok(!byAttr(node, "data-decision-identity")[0].children.map((c) => c.textContent).includes("Protocol"));
  assert.equal(skelShownProtocol(SHOWN), 1);
  auth.force({ ...committedFor(intentFor(AUTHORITY_STATES.skeleton, "approve", "req-1")), protocolVersion: 2, captureVersion: CAPTURE_1 });
  assert.equal((await ctl.decide("approve")).kind, "malformed");
  assert.equal(ctl.view().approved, null);
  await ctl.load();
  assert.equal((await ctl.decide("approve")).kind, "committed");
  assert.deepEqual(auth.calls.submit[1], intentFor(AUTHORITY_STATES.skeleton, "approve", "req-2"));
  assert.deepEqual(ctl.view().approved, { reviewVersion: VERSION_A, revision: 5 });
});
