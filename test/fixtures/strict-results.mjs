// PROPOSED SCHEMA FOR SOL'S REVIEW (#76). MOCK ONLY.
//
// Deterministic fixtures for the strict tier's transition contract v1, as
// posted in #76, plus the changes proposed in the Claude/Opus review comment
// on #76 (AuthorityState, request-reused, the committed echo, and the meaning
// of reviewVersion for reshape/finalize). Nothing here authenticates a caller,
// establishes human origin or activates strict mode: a matching object proves
// nothing about where it came from. The review page's decision UI
// (lib/review-decision.js) is tested against these; production never loads it.
//
// RuntimeEvidence fixtures (#78) live in test/fixtures/strict-evidence.mjs,
// not here.
//
// If Sol changes the contract, change this file first: the validators below
// are what the tests hold the UI and the mock authority to.

export const PROTOCOL_VERSION = 1;

/**
 * Actions an Intent may carry. `replace` and `finalize` are in v1 as posted;
 * the review asked whether `replace` means `init --force` and whether
 * `migrate` belongs here. The decision UI offers only approve and reshape.
 */
export const ACTIONS = Object.freeze(["approve", "reshape", "replace", "finalize"]);

/** AuthorityState.phase. The page's own phase names map: scaffold -> skeleton, fill -> fill, done -> finalized. */
export const PHASES = Object.freeze(["skeleton", "fill", "finalized"]);

/** Every typed rejection. `request-reused` is the review's addition. */
export const REJECTION_CODES = Object.freeze([
  "stale-review",
  "revision-conflict",
  "invalid-transition",
  "unauthorized-channel",
  "session-ended",
  "unavailable",
  "request-reused",
]);

/**
 * What reviewVersion means per action (review point 5): approve names the
 * skeleton version the human reviewed; reshape and finalize name the
 * currently approved version, never a draft. Replace is open (#76).
 */
export const REVIEW_VERSION_MEANING = Object.freeze({
  approve: "the skeleton version shown to the human",
  reshape: "the currently approved version (AuthorityState.approvedVersion)",
  finalize: "the currently approved version (AuthorityState.approvedVersion)",
  replace: "open question for Sol (#76)",
});

const IDS = Object.freeze({ projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round" });
export const VERSION_A = "aaaaaaaaaaaa";
export const VERSION_B = "bbbbbbbbbbbb";

/**
 * AuthorityState (review point 2): public, carries no capability, and comes
 * from the same source as the verifier. The page reads it to build a
 * ReviewRef instead of guessing expectedRevision.
 */
export const AUTHORITY_STATES = Object.freeze({
  skeleton: Object.freeze({ ...IDS, phase: "skeleton", approvedVersion: null, revision: 4 }),
  fill: Object.freeze({ ...IDS, phase: "fill", approvedVersion: VERSION_A, revision: 5 }),
  finalized: Object.freeze({ ...IDS, phase: "finalized", approvedVersion: VERSION_A, revision: 9 }),
  // The same session after something else committed: a stale tab's view.
  skeletonMoved: Object.freeze({ ...IDS, phase: "skeleton", approvedVersion: null, revision: 6 }),
  // A new review round in the same session (e.g. after a reshape).
  newRound: Object.freeze({ ...IDS, reviewRoundId: "example-round-2", phase: "skeleton", approvedVersion: null, revision: 7 }),
});

/** ReviewRef = {projectId, sessionId, reviewRoundId, reviewVersion, expectedRevision}. */
export function reviewRefFor(state, reviewVersion) {
  return { projectId: state.projectId, sessionId: state.sessionId, reviewRoundId: state.reviewRoundId, reviewVersion, expectedRevision: state.revision };
}

/** Intent = ReviewRef + {requestId, action}, with protocolVersion as posted in #76. */
export function intentFor(state, reviewVersion, action, requestId) {
  return { protocolVersion: PROTOCOL_VERSION, requestId, action, ...reviewRefFor(state, reviewVersion) };
}

export const INTENTS = Object.freeze({
  approve: Object.freeze(intentFor(AUTHORITY_STATES.skeleton, VERSION_A, "approve", "example-request-001")),
  reshape: Object.freeze(intentFor(AUTHORITY_STATES.fill, VERSION_A, "reshape", "example-request-002")),
});

/** committed (review point 4): echoes action and reviewVersion so the page shows what was committed, not what it believed it sent. */
export function committedFor(intent) {
  return { kind: "committed", requestId: intent.requestId, revision: intent.expectedRevision + 1, action: intent.action, reviewVersion: intent.reviewVersion };
}

export const RESULTS = Object.freeze({
  committed: Object.freeze(committedFor(INTENTS.approve)),
  ...Object.fromEntries(REJECTION_CODES.map((code) => [code, Object.freeze({ kind: "rejected", requestId: INTENTS.approve.requestId, code })])),
});

// ---- validators: the shapes the tests hold everything to ----

const str = (v) => typeof v === "string" && v.length > 0;
const rev = (v) => Number.isSafeInteger(v) && v >= 0;
const exactKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();

/** Returns a list of problems; empty means valid. */
export function validateAuthorityState(s) {
  const p = [];
  if (!exactKeys(s, ["projectId", "sessionId", "reviewRoundId", "phase", "approvedVersion", "revision"])) return ["AuthorityState has the wrong fields"];
  for (const k of ["projectId", "sessionId", "reviewRoundId"]) if (!str(s[k])) p.push(`${k} must be a non-empty string`);
  if (!PHASES.includes(s.phase)) p.push(`phase must be one of ${PHASES.join("|")}`);
  if (!(s.approvedVersion === null || str(s.approvedVersion))) p.push("approvedVersion must be a string or null");
  if (s.phase === "skeleton" && s.approvedVersion !== null) p.push("a skeleton-phase state has no approved version");
  if (s.phase !== "skeleton" && s.approvedVersion === null) p.push("fill and finalized states name their approved version");
  if (!rev(s.revision)) p.push("revision must be a non-negative integer");
  return p;
}

export function validateIntent(i) {
  const p = [];
  if (!exactKeys(i, ["protocolVersion", "requestId", "action", "projectId", "sessionId", "reviewRoundId", "reviewVersion", "expectedRevision"])) return ["Intent has the wrong fields"];
  if (i.protocolVersion !== PROTOCOL_VERSION) p.push("protocolVersion must be 1");
  for (const k of ["requestId", "projectId", "sessionId", "reviewRoundId", "reviewVersion"]) if (!str(i[k])) p.push(`${k} must be a non-empty string`);
  if (!ACTIONS.includes(i.action)) p.push(`action must be one of ${ACTIONS.join("|")}`);
  if (!rev(i.expectedRevision)) p.push("expectedRevision must be a non-negative integer");
  return p;
}

/** With an intent, also checks that a committed result answers that intent exactly. */
export function validateResult(r, intent = null) {
  if (r?.kind === "committed") {
    if (!exactKeys(r, ["kind", "requestId", "revision", "action", "reviewVersion"])) return ["committed has the wrong fields"];
    const p = [];
    if (!str(r.requestId)) p.push("requestId must be a non-empty string");
    if (!rev(r.revision)) p.push("revision must be a non-negative integer");
    if (!ACTIONS.includes(r.action)) p.push("action must be a known action");
    if (!str(r.reviewVersion)) p.push("reviewVersion must be a non-empty string");
    if (intent) {
      if (r.requestId !== intent.requestId) p.push("requestId doesn't match the intent");
      if (r.action !== intent.action) p.push("action doesn't match the intent");
      if (r.reviewVersion !== intent.reviewVersion) p.push("reviewVersion doesn't match the intent");
      if (r.revision <= intent.expectedRevision) p.push("a commit must advance the revision");
    }
    return p;
  }
  if (r?.kind === "rejected") {
    // requestId on a rejection is optional: an `unavailable` from a transport may not know it.
    const keys = Object.keys(r);
    if (!keys.every((k) => ["kind", "code", "requestId"].includes(k))) return ["rejected has unknown fields"];
    if (!REJECTION_CODES.includes(r.code)) return [`unknown rejection code ${JSON.stringify(r.code)}`];
    if ("requestId" in r && intent && r.requestId !== intent.requestId) return ["requestId doesn't match the intent"];
    return [];
  }
  return ["result kind must be committed or rejected"];
}

// ---- a reference mock authority (tests only) ----

/**
 * The semantics the tests assume from the private authority, as a mock
 * DecisionChannel ({getState, submit}). It is NOT an implementation: it has
 * no channel authentication, durability or content recomputation. It exists so
 * Sol can check the assumed behaviour:
 *   - same requestId + same intent -> the original Result (idempotent);
 *   - same requestId + different intent -> request-reused;
 *   - wrong project/session/round -> session-ended (session) or stale-review (round);
 *   - expectedRevision != current revision -> revision-conflict;
 *   - reviewVersion not the current reviewable version -> stale-review;
 *   - action not allowed in the phase -> invalid-transition.
 * `current` is the version the authority would recompute from the project
 * now. `force` returns a fixed result for the next submit, for each
 * rejection code the authority's own checks can't produce here.
 */
export function createMockAuthority({ state = AUTHORITY_STATES.skeleton, current = VERSION_A } = {}) {
  let s = { ...state };
  let reviewable = current;
  let forced = [];
  const seen = new Map();
  const calls = { getState: 0, submit: [] };
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const decide = (i) => {
    if (i.projectId !== s.projectId || i.sessionId !== s.sessionId) return { kind: "rejected", requestId: i.requestId, code: "session-ended" };
    if (i.reviewRoundId !== s.reviewRoundId) return { kind: "rejected", requestId: i.requestId, code: "stale-review" };
    if (i.expectedRevision !== s.revision) return { kind: "rejected", requestId: i.requestId, code: "revision-conflict" };
    if (i.action === "approve") {
      if (s.phase !== "skeleton") return { kind: "rejected", requestId: i.requestId, code: "invalid-transition" };
      if (i.reviewVersion !== reviewable) return { kind: "rejected", requestId: i.requestId, code: "stale-review" };
      s = { ...s, phase: "fill", approvedVersion: i.reviewVersion, revision: s.revision + 1 };
    } else if (i.action === "reshape") {
      if (s.phase !== "fill") return { kind: "rejected", requestId: i.requestId, code: "invalid-transition" };
      if (i.reviewVersion !== s.approvedVersion) return { kind: "rejected", requestId: i.requestId, code: "stale-review" };
      s = { ...s, phase: "skeleton", approvedVersion: null, revision: s.revision + 1 };
    } else return { kind: "rejected", requestId: i.requestId, code: "invalid-transition" };
    return { kind: "committed", requestId: i.requestId, revision: s.revision, action: i.action, reviewVersion: i.reviewVersion };
  };
  return {
    calls,
    get state() { return { ...s }; },
    commits: () => [...seen.values()].filter((e) => e.result.kind === "committed").length,
    /** Something else changed the authority (another tab, the CLI, a restart). */
    setState(next) { s = { ...next }; },
    setCurrent(v) { reviewable = v; },
    force(result) { forced.push(result); },
    async getState() { calls.getState++; return { ...s }; },
    async submit(intent) {
      calls.submit.push({ ...intent });
      if (forced.length) return forced.shift();
      const prior = seen.get(intent.requestId);
      if (prior) return same(prior.intent, intent) ? prior.result : { kind: "rejected", requestId: intent.requestId, code: "request-reused" };
      const result = decide(intent);
      seen.set(intent.requestId, { intent: { ...intent }, result });
      return result;
    },
  };
}
