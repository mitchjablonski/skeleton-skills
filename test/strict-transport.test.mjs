// #77: the strict decision UI (lib/review-decision.js) against a MOCK of
// contract v1 (test/fixtures/strict-results.mjs), and the guarantee that the
// default review page doesn't carry it. Like test/review-page.test.mjs, the
// page script is run here as the page runs it (plain script, new Function),
// with a minimal DOM stand-in for the drawing.
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
  ACTIONS, AUTHORITY_STATES, INTENTS, REJECTION_CODES, RESULTS, VERSION_A, VERSION_B,
  committedFor, createMockAuthority, intentFor, validateAuthorityState, validateIntent, validateResult,
} from "./fixtures/strict-results.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");
const read = (f) => fs.readFileSync(path.join(LIB, f), "utf-8");
const DECISION = read("review-decision.js");
const { skelDecisionController, skelDecisionRender, skelMountDecision, skelDecisionOutcome } = new Function(
  DECISION + "\nreturn { skelDecisionController, skelDecisionRender, skelMountDecision, skelDecisionOutcome };",
)();

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

const ids = () => { let i = 0; return () => `req-${++i}`; };
const SHOWN = { phase: "scaffold", reviewVersion: VERSION_A, approvedVersion: null, pendingNotes: false };
async function setup({ state = AUTHORITY_STATES.skeleton, shown = SHOWN, current = VERSION_A } = {}) {
  const auth = createMockAuthority({ state, current });
  const ctl = skelDecisionController({ channel: auth, shown, newRequestId: ids() });
  await ctl.load();
  return { auth, ctl };
}
const action = (v, a) => v.actions.find((x) => x.action === a);

// ---- fixtures validate against each other ----

test("#77 fixtures: every AuthorityState, Intent and Result is valid, and each Result answers its Intent", () => {
  for (const [k, s] of Object.entries(AUTHORITY_STATES)) assert.deepEqual(validateAuthorityState(s), [], k);
  for (const [k, i] of Object.entries(INTENTS)) assert.deepEqual(validateIntent(i), [], k);
  assert.deepEqual(validateResult(RESULTS.committed, INTENTS.approve), []);
  assert.deepEqual(validateResult(committedFor(INTENTS.reshape), INTENTS.reshape), []);
  assert.deepEqual(Object.keys(RESULTS).sort(), ["committed", ...REJECTION_CODES].sort(), "one fixture per Result state");
  for (const code of REJECTION_CODES) assert.deepEqual(validateResult(RESULTS[code], INTENTS.approve), [], code);
  // An Intent is the ReviewRef of an AuthorityState: the revision it expects is the state's.
  assert.equal(INTENTS.approve.expectedRevision, AUTHORITY_STATES.skeleton.revision);
  assert.equal(INTENTS.reshape.reviewVersion, AUTHORITY_STATES.fill.approvedVersion, "reshape names the approved version, not a draft");
  assert.deepEqual([...ACTIONS], ["approve", "reshape", "replace", "finalize"]);
});

test("#77 fixtures: the validators refuse what they should", () => {
  assert.notDeepEqual(validateResult({ ...RESULTS.committed, reviewVersion: VERSION_B }, INTENTS.approve), [], "a commit for another version");
  assert.notDeepEqual(validateResult({ ...RESULTS.committed, revision: 4 }, INTENTS.approve), [], "a commit that doesn't advance");
  assert.notDeepEqual(validateResult({ ...RESULTS.committed, approved: true }), [], "extra fields");
  assert.notDeepEqual(validateResult({ kind: "rejected", code: "nope" }), []);
  assert.notDeepEqual(validateResult({ kind: "ok" }), []);
  assert.notDeepEqual(validateIntent({ ...INTENTS.approve, token: "x" }), [], "an Intent carries no secret");
  assert.notDeepEqual(validateIntent({ ...INTENTS.approve, action: "migrate" }), []);
  assert.notDeepEqual(validateAuthorityState({ ...AUTHORITY_STATES.skeleton, approvedVersion: VERSION_A }), []);
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
  assert.deepEqual(v.identity, { projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round", phase: "skeleton", revision: 4, approvedVersion: null, shownVersion: VERSION_A });
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
  unavailable: /nothing was approved\. You can retry: a retry sends the same request/,
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
    assert.doesNotMatch(v.message.text + v.message.title, /^Approved/);
    const approve = action(v, "approve");
    if (code === "unavailable") {
      assert.equal(approve.enabled, true);
      assert.equal(approve.retry, true);
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

test("#77: the mock authority's own checks reach the UI as typed rejections", async () => {
  // The page shows B while the authority would recompute A.
  const stale = await setup({ shown: { ...SHOWN, reviewVersion: VERSION_B } });
  assert.deepEqual(await stale.ctl.decide("approve"), { kind: "rejected", code: "stale-review" });
  assert.equal(stale.auth.commits(), 0);
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
  await new Promise((r) => setImmediate(r));
  const moved = two.ctl.setShown({ ...SHOWN, reviewVersion: VERSION_B });
  release();
  await p;
  await moved;
  v = two.ctl.view();
  assert.equal(v.approved, null);
  assert.doesNotMatch(JSON.stringify(v), /Approved bbbbbbbbbbbb/);
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
  const auth = createMockAuthority();
  const evil = "<img src=x onerror=alert(1)>";
  auth.setState({ ...AUTHORITY_STATES.skeleton, projectId: evil });
  const m = await skelMountDecision({ doc, container, channel: auth, shown: SHOWN, newRequestId: ids() });
  const panel = () => container.children[0];
  assert.equal(container.children.length, 1);
  const identity = byAttr(panel(), "data-decision-identity")[0].textContent;
  assert.ok(identity.includes(evil), "shown as text");
  assert.ok(identity.includes(VERSION_A) && identity.includes("4"));
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
  const server = fs.readFileSync(path.join(HERE, "..", "bin", "skel.mjs"), "utf-8");
  const routes = [...server.matchAll(/req\.url === "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(routes)].sort(), ["/", "/api/data", "/api/feedback", "/api/version", "/assets/review.js"]);
  assert.doesNotMatch(server, /review-decision/);
  assert.doesNotMatch(read("review.mjs"), /review-decision/);
});

test("#77: an Intent built by the UI carries no token or secret, only the contract fields", async () => {
  const { auth, ctl } = await setup();
  await ctl.decide("approve");
  assert.deepEqual(validateIntent(auth.calls.submit[0]), []);
  assert.deepEqual(auth.calls.submit[0], intentFor(AUTHORITY_STATES.skeleton, VERSION_A, "approve", "req-1"));
  assert.doesNotMatch(DECISION, /x-skeleton-token|sessionStorage|localStorage|fetch\(/, "the module uses no review token, storage or network of its own");
});
