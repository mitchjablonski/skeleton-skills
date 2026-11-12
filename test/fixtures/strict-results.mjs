// Fixtures for the strict tier's transition contract v1. MOCK ONLY.
//
// The schema is lib/strict-protocol.mjs (Sol, #82); this file holds no schema
// of its own. Every AuthorityState, Intent and Result here is checked with its
// parsers (test/strict-transport.test.mjs). Nothing here authenticates a
// caller, establishes human origin or activates strict mode: a matching object
// proves nothing about where it came from. The decision UI logic
// (lib/review-decision.mjs) is tested against these; nothing in production
// loads it.
//
// RuntimeEvidence fixtures (#78) aren't here: see PR #80.

import {
  STRICT_ACTIONS, STRICT_PROTOCOL_VERSION, STRICT_REJECTIONS,
  parseAuthorityState, parseStrictIntent, parseStrictResult, strictIntentConflict, strictIntentIdentity,
} from "../../lib/strict-protocol.mjs";
import { createAuthorityRecord, planAuthorityTransaction } from "../../lib/strict-authority.mjs";

export { STRICT_ACTIONS, STRICT_PROTOCOL_VERSION, STRICT_REJECTIONS, parseAuthorityState, parseStrictIntent, parseStrictResult };

const IDS = Object.freeze({ projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round" });
export const VERSION_A = "aaaaaaaaaaaa";
export const VERSION_B = "bbbbbbbbbbbb";

/**
 * AuthorityState: public and non-capability. `reviewVersion` is the current
 * reviewable version; decisions re-read it through the human listener.
 */
export const AUTHORITY_STATES = Object.freeze({
  skeleton: Object.freeze({ ...IDS, phase: "skeleton", reviewVersion: VERSION_A, approvedVersion: null, revision: 4 }),
  fill: Object.freeze({ ...IDS, phase: "fill", reviewVersion: VERSION_A, approvedVersion: VERSION_A, revision: 5 }),
  finalized: Object.freeze({ ...IDS, phase: "finalized", reviewVersion: VERSION_A, approvedVersion: VERSION_A, revision: 9 }),
  // The same session after something else committed: a stale tab's view.
  skeletonMoved: Object.freeze({ ...IDS, phase: "skeleton", reviewVersion: VERSION_A, approvedVersion: null, revision: 6 }),
  // A new review round in the same session (e.g. after a reshape).
  newRound: Object.freeze({ ...IDS, reviewRoundId: "example-round-2", phase: "skeleton", reviewVersion: VERSION_A, approvedVersion: null, revision: 7 }),
});

/** Intent = ReviewRef + {requestId, action}. Approve names reviewVersion; reshape/finalize name approvedVersion. */
export function intentFor(state, action, requestId) {
  const reviewVersion = action === "approve" ? state.reviewVersion : state.approvedVersion;
  return { protocolVersion: STRICT_PROTOCOL_VERSION, requestId, action, projectId: state.projectId, sessionId: state.sessionId, reviewRoundId: state.reviewRoundId, reviewVersion, expectedRevision: state.revision };
}

export const INTENTS = Object.freeze({
  approve: Object.freeze(intentFor(AUTHORITY_STATES.skeleton, "approve", "example-request-001")),
  reshape: Object.freeze(intentFor(AUTHORITY_STATES.fill, "reshape", "example-request-002")),
  finalize: Object.freeze(intentFor(AUTHORITY_STATES.fill, "finalize", "example-request-003")),
});

/** committed echoes the committed intent's action and version. */
export function committedFor(intent) {
  return { kind: "committed", requestId: intent.requestId, action: intent.action, reviewVersion: intent.reviewVersion, revision: intent.expectedRevision + 1 };
}

export const RESULTS = Object.freeze({
  committed: Object.freeze(committedFor(INTENTS.approve)),
  ...Object.fromEntries(STRICT_REJECTIONS.map((code) => [code, Object.freeze({ kind: "rejected", requestId: INTENTS.approve.requestId, code })])),
});

// ---- V2 exact-capture fixtures (#77 after #90) ----

export const SHAPE_A = "a".repeat(64);
export const SHAPE_B = "b".repeat(64);
export const CAPTURE_1 = "1".repeat(64);
export const CAPTURE_2 = "2".repeat(64);
export const CAPTURE_3 = "3".repeat(64);

/** A V2 bootstrap state (revision 0, as createAuthorityRecord requires). */
export const V2_INITIAL_STATE = Object.freeze({ ...IDS, phase: "skeleton", reviewVersion: SHAPE_A, approvedVersion: null, revision: 0, protocolVersion: 2, captureVersion: CAPTURE_1, approvedCaptureVersion: null });

/** The explicit V2 shown context for a state: the pair the page says it shows. */
export function v2ShownFor(state, extra = {}) {
  const phase = { skeleton: "scaffold", fill: "fill", finalized: "done" }[state.phase];
  return { phase, reviewVersion: state.reviewVersion, approvedVersion: state.approvedVersion, pendingNotes: false, protocolVersion: 2, captureVersion: state.captureVersion, approvedCaptureVersion: state.approvedCaptureVersion, ...extra };
}

/**
 * A mock DecisionChannel whose decisions come from the REAL V2 planner
 * (lib/strict-authority.mjs planAuthorityTransaction), so pair semantics can't
 * drift from it. NOT an implementation: no authentication, no persistence
 * beyond this closure, no capture freeze or anti-rollback; the host facts are
 * test-supplied, which is exactly what a real host must NOT do unverified.
 *   - `facts` is the host's independent observation (contentVersion,
 *     captureVersion, nextReviewRoundId, completionVerified); setFacts moves it.
 *   - `recapture(requestId)` is another actor submitting a V2 Recapture to the
 *     same planner (never through the decision UI).
 *   - `loseNextReply()` commits the next submit normally and then throws, an
 *     unknown outcome after a real commit.
 *   - `force(result)` answers the next submit with a fixed result, unplanned.
 */
export function createPlannerAuthority({ initialState = V2_INITIAL_STATE, facts } = {}) {
  let record = createAuthorityRecord(initialState);
  if (!record) throw new Error("bad initial state");
  let host = facts ?? { contentVersion: initialState.reviewVersion, captureVersion: initialState.captureVersion, nextReviewRoundId: null, completionVerified: false };
  let lose = 0;
  const forced = [];
  const calls = { getState: 0, submit: [] };
  const plan = (intent) => {
    const p = planAuthorityTransaction(record, intent, host);
    if (p.persist) record = p.record;
    return p.result;
  };
  return {
    calls,
    get state() { return { ...record.state }; },
    get record() { return record; },
    commits: () => record.journal.filter((e) => e.result.kind === "committed").length,
    setFacts(next) { host = { ...host, ...next }; },
    recapture(requestId) {
      const s = record.state;
      return plan({ protocolVersion: 2, requestId, action: "recapture", projectId: s.projectId, sessionId: s.sessionId, reviewRoundId: s.reviewRoundId, reviewVersion: s.reviewVersion, expectedRevision: s.revision, captureVersion: s.captureVersion });
    },
    loseNextReply() { lose++; },
    force(result) { forced.push(result); },
    async getState() { calls.getState++; return { ...record.state }; },
    async submit(intent) {
      calls.submit.push({ ...intent });
      if (forced.length) return forced.shift();
      const result = plan(intent);
      if (lose) { lose--; throw new Error("reply lost after commit"); }
      return result;
    },
  };
}

// ---- a reference mock authority (tests only) ----

/**
 * A mock DecisionChannel ({getState, submit}). NOT an implementation: no
 * channel authentication, durability or content recomputation. Preconditions
 * are lib/strict-protocol.mjs strictIntentConflict; dedupe is keyed by
 * requestId and compared with strictIntentIdentity:
 *   - same requestId + same intent -> the original Result;
 *   - same requestId + different intent -> request-reused.
 * Approve and reshape are modelled; a committed reshape rotates the review
 * round to `nextReviewRoundId(state)` and sets the version under review to
 * `nextReviewVersion(state)`, as lib/strict-authority.mjs (#83) does with its
 * host's nextReviewRoundId and contentVersion. nextReviewVersion is optional:
 * by default the version under review stays as it was. Finalize is refused (invalid-transition),
 * because its completion and drift checks aren't. `force` returns a fixed
 * result for the next submit, for codes the checks can't produce here.
 */
export function createMockAuthority({ state = AUTHORITY_STATES.skeleton, nextReviewRoundId = (st) => `${st.reviewRoundId}-after-r${st.revision + 1}`, nextReviewVersion = (st) => st.reviewVersion } = {}) {
  let s = { ...state };
  const forced = [];
  const seen = new Map();
  const calls = { getState: 0, submit: [] };
  const decide = (i) => {
    const conflict = strictIntentConflict(s, i);
    if (conflict) return { kind: "rejected", requestId: i.requestId, code: conflict };
    if (i.action === "approve") s = { ...s, phase: "fill", approvedVersion: i.reviewVersion, revision: s.revision + 1 };
    else if (i.action === "reshape") s = { ...s, phase: "skeleton", approvedVersion: null, reviewRoundId: nextReviewRoundId(s), reviewVersion: nextReviewVersion(s), revision: s.revision + 1 };
    else return { kind: "rejected", requestId: i.requestId, code: "invalid-transition" };
    return { kind: "committed", requestId: i.requestId, action: i.action, reviewVersion: i.reviewVersion, revision: s.revision };
  };
  return {
    calls,
    get state() { return { ...s }; },
    commits: () => [...seen.values()].filter((e) => e.result.kind === "committed").length,
    /** Something else changed the authority (another tab, the CLI, a restart). */
    setState(next) { s = { ...next }; },
    /** The reviewable version the authority would recompute now. */
    setCurrent(v) { s = { ...s, reviewVersion: v }; },
    force(result) { forced.push(result); },
    async getState() { calls.getState++; return { ...s }; },
    async submit(intent) {
      calls.submit.push({ ...intent });
      if (forced.length) return forced.shift();
      if (!parseStrictIntent(intent)) return { kind: "rejected", code: "invalid-transition" };
      const prior = seen.get(intent.requestId);
      if (prior) return prior.identity === strictIntentIdentity(intent) ? prior.result : { kind: "rejected", requestId: intent.requestId, code: "request-reused" };
      const result = decide(intent);
      seen.set(intent.requestId, { identity: strictIntentIdentity(intent), result });
      return result;
    },
  };
}
