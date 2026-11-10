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

// PROVISIONAL, FOR SOL TO SET (#76): freshness caps applied on top of the
// producer's own expiresAt, so a long-lived or old record can't stay active.
/** Longest allowed `expiresAt - observedAt`; longer is unreadable. */
export const MAX_EVIDENCE_LIFETIME_MS = 10 * 60_000;
/** Oldest allowed `now - observedAt`; older is stale. */
export const MAX_EVIDENCE_AGE_MS = 10 * 60_000;

/** The only verifier in this release: strict isn't available, so it is always unsupported. */
export const DEFAULT_VERIFIER = Object.freeze({ verify: () => ({ kind: "unsupported" }) });

const DRIFT = "skel done and skel finalize detect changes outside the fences and refuse to complete. That is detection and refusal: it does not stop files in the workspace from being written.";

// Appended to unverified and ended copy, depending on whether strict was requested.
const REFUSED = "Approve, reshape and finalize are refused until status shows active.";
const NOT_REQUESTED = "Strict wasn't requested for this project, so default mode applies unchanged.";

const COPY = {
  active: {
    summary: "Strict tier: active. Enforcement reports fresh evidence for this project and session.",
    next: "Enforcement reports that approve, reshape and finalize go only through the protected human flow.",
  },
  // Strict was requested, but this release can't provide it. No quiet fallback.
  "unsupported:requested": {
    summary: "Strict tier: not available. Strict was requested for this project, but this release has no strict enforcement.",
    next: "Approve, reshape and finalize are refused in strict mode, and skel doesn't fall back to default mode on its own. Use a release with strict support, or have the human choose default mode for this project explicitly.",
  },
  unsupported: {
    summary: "Strict tier: not available. This release has no strict enforcement, so skel runs in default mode.",
    next: "Nothing to do: default mode is unchanged. Strict is in development (issue #19).",
  },
  ended: {
    summary: "Strict tier: ended. The strict session is over, so its enforcement evidence no longer counts.",
    next: "Start a new session through the strict launcher to continue in strict mode.",
  },
  "unverified:launcher-absent": {
    summary: "Strict tier: not verified. This session wasn't started by the strict launcher, so nothing shows enforcement is running.",
    next: "End this session and start Claude Code again through the strict launcher.",
  },
  "unverified:profile-unsupported": {
    summary: "Strict tier: not verified. This client, platform or configuration is not a verified strict profile (the candidate is the Claude Code CLI on verified Linux/WSL setups).",
    next: "Start again on a verified profile. Strict is not switched off for you here.",
  },
  "unverified:evidence-stale": {
    summary: "Strict tier: not verified. The enforcement evidence for this session has expired.",
    next: "Restart the session through the strict launcher to get fresh evidence.",
  },
  "unverified:evidence-unreadable": {
    summary: "Strict tier: not verified. skel could not read or validate the enforcement evidence.",
    next: "Restart the session through the strict launcher. Don't edit or recreate evidence by hand.",
  },
  "unverified:dependency-missing": {
    summary: "Strict tier: not verified. Something the strict launcher needs is missing.",
    next: "Outside this session, install the prerequisite the launcher names, then start again through the launcher.",
  },
  "unverified:evidence-mismatch": {
    summary: "Strict tier: not verified. The enforcement evidence is for a different project or session.",
    next: "Start Claude Code through the strict launcher from this project. Evidence from another project or an earlier session doesn't count.",
  },
};

const nonEmpty = (v) => typeof v === "string" && v.length > 0;
// Only the canonical form Date#toISOString writes (YYYY-MM-DDTHH:MM:SS.sssZ):
// the round trip rejects offsets, missing milliseconds and impossible dates
// such as 2026-02-30 or T24:00.
const time = (v) => {
  if (typeof v !== "string") return NaN;
  const ms = Date.parse(v);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== v ? NaN : ms;
};
// Own properties only: nothing comes from a prototype chain.
const own = (obj, key, fallback) => (obj && Object.hasOwn(obj, key) ? obj[key] : fallback);

function result(state, reason, requested, extra = {}) {
  const copy = COPY[reason ? `${state}:${reason}` : state === "unsupported" && requested ? "unsupported:requested" : state];
  const tail = state === "unverified" || state === "ended" ? ` ${requested ? REFUSED : NOT_REQUESTED}` : "";
  return Object.freeze({
    state,
    ...(reason ? { reason } : {}),
    requested,
    // Only for a project that requested strict: in default mode nothing is refused.
    ...(requested ? { privilegedActions: state === "active" ? "allowed" : "refused" } : {}),
    summary: copy.summary,
    next: copy.next + tail,
    drift: DRIFT,
    ...extra,
  });
}

/**
 * Map one RuntimeEvidence object to a status, for the current project and
 * session at `now` (ms). Options (own properties only):
 * - `supportedProfiles`: enforcement profiles that may be active; empty (the
 *   default) means none can be.
 * - `requested`: must be exactly `true` for a project that requested strict.
 *   Anything else (false, absent, "yes", 1) shows as not requested, with no
 *   `privilegedActions`, and refusePrivileged still refuses.
 * - `maxLifetimeMs`, `maxAgeMs`: the freshness caps (defaults above).
 */
export function classifyEvidence(evidence, options = {}) {
  try { return classify(evidence, options); }
  // A throwing getter or proxy is unreadable evidence, never an exception.
  catch {
    let requested = false;
    try { requested = own(options, "requested") === true; } catch {}
    return result("unverified", "evidence-unreadable", requested);
  }
}

function classify(evidence, options) {
  const projectId = own(options, "projectId"), sessionId = own(options, "sessionId");
  const now = own(options, "now", Date.now()), supportedProfiles = own(options, "supportedProfiles", []);
  const requested = own(options, "requested") === true;
  const maxLifetime = own(options, "maxLifetimeMs", MAX_EVIDENCE_LIFETIME_MS), maxAge = own(options, "maxAgeMs", MAX_EVIDENCE_AGE_MS);
  const status = (state, reason, extra) => result(state, reason, requested, extra);
  const unreadable = () => status("unverified", "evidence-unreadable");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return unreadable();
  const field = (k) => own(evidence, k);
  switch (field("kind")) {
    case "unsupported": return status("unsupported");
    case "ended": return status("ended");
    case "unverified": {
      const reason = field("reason"); // once: a getter may answer differently each time
      return EVIDENCE_REASONS.includes(reason) ? status("unverified", reason) : unreadable();
    }
    case "active": break;
    default: return unreadable();
  }
  const p = field("projectId"), s = field("sessionId"), enforcementProfile = field("enforcementProfile");
  const revision = field("revision"), observedAt = field("observedAt"), expiresAt = field("expiresAt");
  const observed = time(observedAt), expires = time(expiresAt);
  if (!nonEmpty(p) || !nonEmpty(s) || !nonEmpty(enforcementProfile) || !Number.isSafeInteger(revision) || revision < 0) return unreadable();
  // No clock-skew allowance: evidence observed even 1ms in the future fails closed.
  if (Number.isNaN(observed) || Number.isNaN(expires) || expires <= observed || observed > now) return unreadable();
  if (!(expires - observed <= maxLifetime)) return unreadable();
  if (!(now - observed <= maxAge) || expires <= now) return status("unverified", "evidence-stale");
  // Without a current project and session there is nothing to bind to.
  if (!nonEmpty(projectId) || !nonEmpty(sessionId) || p !== projectId || s !== sessionId) return status("unverified", "evidence-mismatch");
  if (!Array.isArray(supportedProfiles) || !supportedProfiles.includes(enforcementProfile)) return status("unverified", "profile-unsupported");
  return status("active", null, {
    summary: `Strict tier: active. Enforcement reports profile ${enforcementProfile} for this project and session, evidence revision ${revision}, valid until ${expiresAt}.`,
    evidence: Object.freeze({ projectId: p, sessionId: s, enforcementProfile, revision, observedAt, expiresAt }),
  });
}

/**
 * Ask `verifier` for evidence and classify it. A verifier that throws or
 * rejects gives evidence-unreadable, never active.
 */
export async function strictStatus(options = {}) {
  const { verifier: _ignored, ...context } = options; // own enumerable properties only
  const verifier = own(options, "verifier", DEFAULT_VERIFIER);
  let evidence;
  try { evidence = await verifier.verify({ projectId: own(context, "projectId"), sessionId: own(context, "sessionId") }); }
  catch { return classifyEvidence(null, context); }
  return classifyEvidence(evidence, context);
}

/**
 * For a privileged action (approve, reshape, finalize, ...) in strict mode:
 * null when status is active for a project that requested strict, else a refusal message saying why and what to
 * do. Not wired into the default approve path.
 *
 * A copy helper for status display, NOT a gate. It must not be used as the
 * gate for in-boundary CLI transitions (`skel approve`, `skel reshape`,
 * `skel finalize` run inside the boundary): it allows them when status is
 * active, and status inside the boundary is advice the agent can forge
 * (docs/strict-decision-page.md (e)). Use refuseInBoundaryTransition there.
 */
export function refusePrivileged(status, action) {
  if (status && status.requested === true && status.state === "active" && status.privilegedActions === "allowed") return null;
  if (!status || !STRICT_STATES.includes(status.state)) return `refused: ${action} needs strict status active, and the status couldn't be read. Restart the session through the strict launcher.`;
  return `refused: ${action} needs strict status active; it is ${status.state}${status.reason ? ` (${status.reason})` : ""}. ${status.next}`;
}

/** The transitions that, in strict mode, go only through the protected human flow. */
export const IN_BOUNDARY_TRANSITIONS = Object.freeze(["approve", "reshape", "finalize"]);

/**
 * The gate for an in-boundary CLI transition (`skel approve`, `skel reshape`,
 * `skel finalize`) run inside the strict boundary. In a project that requested
 * strict (`status.requested === true`) it ALWAYS refuses, whatever the state,
 * active included: in strict those transitions go only through the protected
 * human decision page, and a CLI inside the boundary is never a strict writer
 * (docs/strict-decision-page.md (e)). It refuses whatever `action` it is given
 * there, so a misspelt or unexpected name can't slip through.
 *
 * Returns null only when the status shows strict wasn't requested: a status
 * with a known state and `requested === false`. A missing or malformed status
 * (no known state, or `requested` that isn't a boolean) is refused, since it
 * doesn't show that strict wasn't requested.
 *
 * Do not use refusePrivileged for this: it allows when status is active.
 * Not wired into bin/skel.mjs: there is no way to request strict yet, so
 * default mode is unchanged.
 */
export function refuseInBoundaryTransition(status, action) {
  const readable = !!status && typeof status === "object" && STRICT_STATES.includes(status.state) && typeof status.requested === "boolean";
  if (readable && status.requested === false) return null;
  const state = readable ? `strict status is ${status.state}${status.reason ? ` (${status.reason})` : ""}` : "strict status couldn't be read";
  return `refused: ${action} can't run from inside the session in a strict project, even when strict status is active (${state}). In strict mode approve, reshape and finalize go only through the protected human decision page, opened from the strict launcher's control window, not from this terminal.`;
}

/**
 * The human `skel status` line, for a project that requested strict. There is
 * no way to request strict yet, so the CLI doesn't print it.
 */
export function strictLine(status) {
  return `strict: ${status.state}${status.reason ? ` (${status.reason})` : ""} — ${status.summary.replace(/^Strict tier: [^.]*\. /, "")} Next: ${status.next}`;
}
