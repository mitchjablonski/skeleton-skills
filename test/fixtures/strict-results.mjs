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

// ---- a reference mock authority (tests only) ----

/**
 * A mock DecisionChannel ({getState, submit}). NOT an implementation: no
 * channel authentication, durability or content recomputation. Preconditions
 * are lib/strict-protocol.mjs strictIntentConflict; dedupe is keyed by
 * requestId and compared with strictIntentIdentity:
 *   - same requestId + same intent -> the original Result;
 *   - same requestId + different intent -> request-reused.
 * Approve and reshape are modelled; finalize is refused (invalid-transition),
 * because its completion and drift checks aren't. `force` returns a fixed
 * result for the next submit, for codes the checks can't produce here.
 */
export function createMockAuthority({ state = AUTHORITY_STATES.skeleton } = {}) {
  let s = { ...state };
  const forced = [];
  const seen = new Map();
  const calls = { getState: 0, submit: [] };
  const decide = (i) => {
    const conflict = strictIntentConflict(s, i);
    if (conflict) return { kind: "rejected", requestId: i.requestId, code: conflict };
    if (i.action === "approve") s = { ...s, phase: "fill", approvedVersion: i.reviewVersion, revision: s.revision + 1 };
    else if (i.action === "reshape") s = { ...s, phase: "skeleton", approvedVersion: null, revision: s.revision + 1 };
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
