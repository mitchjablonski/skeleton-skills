// Strict-tier runtime status (#78): maps RuntimeEvidence from an injected
// verifier to one of unsupported | unverified | active | ended, with plain
// copy and a next step for each.
//
// Fixture phase. The evidence schema is a proposal for Sol's review (see
// test/fixtures/strict-evidence.mjs). Nothing in this release produces
// authenticated evidence, so the only verifier the CLI uses, DEFAULT_VERIFIER,
// never returns active. This module reads no files, settings or environment:
// a project JSON file, a settings check, a dependency check or a browser result
// cannot reach it, and so cannot produce active. Only an injected verifier
// returning fresh evidence bound to the current project and session can.

export const STRICT_STATES = ["unsupported", "unverified", "active", "ended"];
/** Reasons the evidence producer may give for `unverified`. */
export const EVIDENCE_REASONS = ["launcher-absent", "profile-unsupported", "evidence-stale", "evidence-unreadable", "dependency-missing"];
/** Reasons this module adds when it rejects evidence that claims active. */
export const LOCAL_REASONS = ["evidence-mismatch"];

/** The only verifier in this release: strict isn't available, so it is always unsupported. */
export const DEFAULT_VERIFIER = Object.freeze({ verify: () => ({ kind: "unsupported" }) });

const DRIFT = "skel done and skel finalize detect changes outside the fences and refuse to complete. That is detection and refusal: it does not stop files in the workspace from being written.";

const COPY = {
  active: {
    summary: "Strict tier: active. Fresh enforcement evidence matches this project and session.",
    next: "Approve, reshape and finalize go only through the protected human flow; the agent can't run them.",
  },
  unsupported: {
    summary: "Strict tier: not available. This release has no strict enforcement, so skel runs in default mode.",
    next: "Nothing to do: default mode is unchanged. Strict is in development (issue #19).",
  },
  ended: {
    summary: "Strict tier: ended. The strict session is over, so its enforcement evidence no longer counts.",
    next: "Start a new session through the strict launcher to continue in strict mode. Approve, reshape and finalize are refused until status shows active.",
  },
  "unverified:launcher-absent": {
    summary: "Strict tier: not verified. This session wasn't started by the strict launcher, so nothing shows enforcement is running.",
    next: "End this session and start Claude Code again through the strict launcher. Approve, reshape and finalize are refused until status shows active.",
  },
  "unverified:profile-unsupported": {
    summary: "Strict tier: not verified. This client, platform or configuration is not a verified strict profile (the candidate is the Claude Code CLI on verified Linux/WSL setups).",
    next: "Start again on a verified profile. Approve, reshape and finalize are refused here; strict is not switched off for you.",
  },
  "unverified:evidence-stale": {
    summary: "Strict tier: not verified. The enforcement evidence for this session has expired.",
    next: "Restart the session through the strict launcher to get fresh evidence. Approve, reshape and finalize are refused until status shows active.",
  },
  "unverified:evidence-unreadable": {
    summary: "Strict tier: not verified. skel could not read or validate the enforcement evidence.",
    next: "Restart the session through the strict launcher. Don't edit or recreate evidence by hand. Approve, reshape and finalize are refused until status shows active.",
  },
  "unverified:dependency-missing": {
    summary: "Strict tier: not verified. Something the strict launcher needs is missing.",
    next: "Outside this session, install the prerequisite the launcher names, then start again through the launcher. Approve, reshape and finalize are refused until status shows active.",
  },
  "unverified:evidence-mismatch": {
    summary: "Strict tier: not verified. The enforcement evidence is for a different project or session.",
    next: "Start Claude Code through the strict launcher from this project. Evidence from another project or an earlier session doesn't count. Approve, reshape and finalize are refused until status shows active.",
  },
};

const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const time = (v) => (typeof v === "string" && ISO.test(v) ? Date.parse(v) : NaN);

function result(state, reason, extra = {}) {
  const copy = COPY[reason ? `${state}:${reason}` : state];
  return Object.freeze({
    state,
    ...(reason ? { reason } : {}),
    privilegedActions: state === "active" ? "allowed" : "refused",
    summary: copy.summary,
    next: copy.next,
    drift: DRIFT,
    ...extra,
  });
}

/**
 * Map one RuntimeEvidence object to a status, for the current project and
 * session at `now` (ms). `supportedProfiles` lists the enforcement profiles
 * that may be active; an empty list (the default) means none can be.
 */
export function classifyEvidence(evidence, { projectId, sessionId, now = Date.now(), supportedProfiles = [] } = {}) {
  const unreadable = () => result("unverified", "evidence-unreadable");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return unreadable();
  switch (evidence.kind) {
    case "unsupported": return result("unsupported");
    case "ended": return result("ended");
    case "unverified":
      return EVIDENCE_REASONS.includes(evidence.reason) ? result("unverified", evidence.reason) : unreadable();
    case "active": break;
    default: return unreadable();
  }
  const { projectId: p, sessionId: s, enforcementProfile, revision, observedAt, expiresAt } = evidence;
  const observed = time(observedAt), expires = time(expiresAt);
  if (!nonEmpty(p) || !nonEmpty(s) || !nonEmpty(enforcementProfile) || !Number.isSafeInteger(revision) || revision < 0) return unreadable();
  if (Number.isNaN(observed) || Number.isNaN(expires) || expires <= observed || observed > now) return unreadable();
  if (expires <= now) return result("unverified", "evidence-stale");
  // Without a current project and session there is nothing to bind to.
  if (!nonEmpty(projectId) || !nonEmpty(sessionId) || p !== projectId || s !== sessionId) return result("unverified", "evidence-mismatch");
  if (!Array.isArray(supportedProfiles) || !supportedProfiles.includes(enforcementProfile)) return result("unverified", "profile-unsupported");
  return result("active", null, {
    summary: `Strict tier: active. Enforcement profile ${enforcementProfile}, evidence revision ${revision}, valid until ${expiresAt}.`,
    evidence: Object.freeze({ projectId: p, sessionId: s, enforcementProfile, revision, observedAt, expiresAt }),
  });
}

/**
 * Ask `verifier` for evidence and classify it. A verifier that throws or
 * rejects gives evidence-unreadable, never active.
 */
export async function strictStatus({ verifier = DEFAULT_VERIFIER, ...context } = {}) {
  let evidence;
  try { evidence = await verifier.verify({ projectId: context.projectId, sessionId: context.sessionId }); }
  catch { return result("unverified", "evidence-unreadable"); }
  return classifyEvidence(evidence, context);
}

/**
 * For a privileged action (approve, reshape, finalize, ...) in strict mode:
 * null when status is active, else a refusal message saying why and what to
 * do. Not wired into the default approve path.
 */
export function refusePrivileged(status, action) {
  if (status && status.state === "active" && status.privilegedActions === "allowed") return null;
  if (!status || !STRICT_STATES.includes(status.state)) return `refused: ${action} needs strict status active, and the status couldn't be read. Restart the session through the strict launcher.`;
  return `refused: ${action} needs strict status active; it is ${status.state}${status.reason ? ` (${status.reason})` : ""}. ${status.next}`;
}

/**
 * The human `skel status` line, for a project that requested strict. There is
 * no way to request strict yet, so the CLI doesn't print it.
 */
export function strictLine(status) {
  return `strict: ${status.state}${status.reason ? ` (${status.reason})` : ""} — ${status.summary.replace(/^Strict tier: [^.]*\. /, "")} Next: ${status.next}`;
}
