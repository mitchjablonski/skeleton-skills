// RuntimeEvidence fixtures for the strict tier (#78), built on the #76
// contract v1 plus the review in #76 (comment 6756302626, item 7).
//
// PROPOSED SCHEMA, FOR SOL'S REVIEW. Nothing here authenticates anything or
// activates strict mode. These objects stand in for what the authenticated
// live-evidence producer (#76) will hand an injected verifier; receiving
// matching JSON is not proof. Sol defines how freshness and lifetime are
// authenticated, and what happens to evidence across a restart.
//
// RuntimeEvidence =
//   { kind: "active", projectId, sessionId, enforcementProfile, revision, observedAt, expiresAt }
//   | { kind: "unverified", reason }   reason: see UNVERIFIED_REASONS
//   | { kind: "unsupported" }
//   | { kind: "ended" }
//
// observedAt and expiresAt are UTC timestamps in the exact form
// Date#toISOString writes (YYYY-MM-DDTHH:MM:SS.sssZ). revision is a
// non-negative integer: the authority revision the evidence was observed at.
// On top of expiresAt, the consumer caps lifetime (expiresAt - observedAt) and
// age (now - observedAt); see MAX_EVIDENCE_* in lib/strict-status.mjs, which
// are provisional values for Sol to set.

export const SCHEMA = "strict-runtime-evidence/proposed-1";

export const UNVERIFIED_REASONS = ["launcher-absent", "profile-unsupported", "evidence-stale", "evidence-unreadable", "dependency-missing"];

// The current project and session a verifier is asked about, and the clock.
export const NOW = Date.parse("2026-11-09T12:00:00.000Z");
export const PROJECT = "example-project";
export const SESSION = "example-session";
export const PROFILE = "linux-wsl-cli-candidate";
// requested must be exactly true for a project that requested strict.
export const CONTEXT = { projectId: PROJECT, sessionId: SESSION, now: NOW, supportedProfiles: [PROFILE], requested: true };

const iso = (ms) => new Date(ms).toISOString();

export const ACTIVE = Object.freeze({
  kind: "active",
  projectId: PROJECT,
  sessionId: SESSION,
  enforcementProfile: PROFILE,
  revision: 4,
  observedAt: iso(NOW - 5_000),
  expiresAt: iso(NOW + 55_000),
});

/** Each fixture with the status it must map to under CONTEXT. Only `active` may be active. */
export const POSITIVE = {
  active: { evidence: ACTIVE, expect: { state: "active" } },
  unsupported: { evidence: { kind: "unsupported" }, expect: { state: "unsupported" } },
  ended: { evidence: { kind: "ended" }, expect: { state: "ended" } },
  ...Object.fromEntries(UNVERIFIED_REASONS.map((reason) => [
    `unverified:${reason}`, { evidence: { kind: "unverified", reason }, expect: { state: "unverified", reason } },
  ])),
};

const MIN = 60_000;
/** Evidence that looks active but must never be. `context` overrides CONTEXT for that case. */
export const NEGATIVE = {
  expired: { evidence: { ...ACTIVE, observedAt: iso(NOW - 120_000), expiresAt: iso(NOW - 60_000) }, expect: { state: "unverified", reason: "evidence-stale" } },
  "expires-exactly-now": { evidence: { ...ACTIVE, expiresAt: iso(NOW) }, expect: { state: "unverified", reason: "evidence-stale" } },
  "wrong-project": { evidence: { ...ACTIVE, projectId: "another-project" }, expect: { state: "unverified", reason: "evidence-mismatch" } },
  "wrong-session": { evidence: { ...ACTIVE, sessionId: "an-earlier-session" }, expect: { state: "unverified", reason: "evidence-mismatch" } },
  "unsupported-profile": { evidence: { ...ACTIVE, enforcementProfile: "macos-desktop" }, expect: { state: "unverified", reason: "profile-unsupported" } },
  "observed-in-future": { evidence: { ...ACTIVE, observedAt: iso(NOW + 10_000), expiresAt: iso(NOW + 70_000) }, expect: { state: "unverified", reason: "evidence-unreadable" } },
  "over-long-lifetime": { evidence: { ...ACTIVE, observedAt: iso(NOW - 5_000), expiresAt: iso(NOW + 11 * MIN) }, expect: { state: "unverified", reason: "evidence-unreadable" } },
  "producer-says-2000-to-2999": { evidence: { ...ACTIVE, observedAt: "2000-01-01T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }, expect: { state: "unverified", reason: "evidence-unreadable" } },
  // Under the default caps this is already an over-long lifetime; with the
  // lifetime cap lifted, the age cap alone makes it stale.
  "old-evidence": { evidence: { ...ACTIVE, observedAt: iso(NOW - 11 * MIN), expiresAt: iso(NOW + MIN) }, context: { maxLifetimeMs: 60 * MIN }, expect: { state: "unverified", reason: "evidence-stale" } },
  "observed-1ms-in-future": { evidence: { ...ACTIVE, observedAt: iso(NOW + 1), expiresAt: iso(NOW + MIN) }, expect: { state: "unverified", reason: "evidence-unreadable" } },
  "expires-before-observed": { evidence: { ...ACTIVE, observedAt: iso(NOW - 1_000), expiresAt: iso(NOW - 2_000) }, expect: { state: "unverified", reason: "evidence-unreadable" } },
};

/** Malformed evidence: every one is unreadable, never active. */
export const MALFORMED = {
  null: null,
  undefined: undefined,
  string: "active",
  array: [ACTIVE],
  "no-kind": { projectId: PROJECT, sessionId: SESSION },
  "unknown-kind": { kind: "enforcing" },
  "kind-case": { ...ACTIVE, kind: "Active" },
  "missing-projectId": (({ projectId, ...e }) => e)(ACTIVE),
  "missing-sessionId": (({ sessionId, ...e }) => e)(ACTIVE),
  "missing-profile": (({ enforcementProfile, ...e }) => e)(ACTIVE),
  "missing-revision": (({ revision, ...e }) => e)(ACTIVE),
  "missing-observedAt": (({ observedAt, ...e }) => e)(ACTIVE),
  "missing-expiresAt": (({ expiresAt, ...e }) => e)(ACTIVE),
  "empty-projectId": { ...ACTIVE, projectId: "" },
  "numeric-sessionId": { ...ACTIVE, sessionId: 7 },
  "negative-revision": { ...ACTIVE, revision: -1 },
  "fractional-revision": { ...ACTIVE, revision: 1.5 },
  "string-revision": { ...ACTIVE, revision: "4" },
  "unparseable-expiresAt": { ...ACTIVE, expiresAt: "tomorrow" },
  "numeric-expiresAt": { ...ACTIVE, expiresAt: NOW + 60_000 },
  "offset-not-Z": { ...ACTIVE, expiresAt: ACTIVE.expiresAt.replace("Z", "+00:00") },
  "no-milliseconds": { ...ACTIVE, observedAt: ACTIVE.observedAt.replace(/\.\d{3}Z$/, "Z") },
  "impossible-date": { ...ACTIVE, observedAt: "2026-02-30T12:00:00.000Z" },
  "hour-24": { ...ACTIVE, observedAt: "2026-11-09T24:00:00.000Z" },
  "lowercase-t": { ...ACTIVE, observedAt: ACTIVE.observedAt.replace("T", "t") },
  "unverified-no-reason": { kind: "unverified" },
  "inherited-fields": Object.create(ACTIVE),
  "unverified-unknown-reason": { kind: "unverified", reason: "because" },
};

/** A verifier that returns `evidence` as is. Tests only: the real one is Sol's (#76). */
export const fixtureVerifier = (evidence) => ({ verify: () => evidence });
/** A verifier whose read fails. */
export const throwingVerifier = { verify: () => { throw new Error("evidence channel closed"); } };
