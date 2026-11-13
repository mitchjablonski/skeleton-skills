// #78 / #99: human-facing status and recovery copy for the strict checkpoint
// workflow (stop -> verify stop -> capture -> review -> restart -> check).
//
// PROPOSAL, wired into nothing. The checkpoint report schema below is a
// proposal for the outside supervisor Sol owns (#99); no supervisor emits it
// yet. This module turns one report into what the TRUSTED surfaces show (the
// launcher control window and the protected decision page) plus a separate,
// minimal notice for the agent's untrusted terminal. See
// docs/strict-checkpoint-ux.md.
//
// Rules this copy keeps (tests enforce them):
//   - Never claims containment, safety or a human decision. Strict status is
//     unverified until #79's matrix passes; a checkpoint report is the host's
//     account of its own steps, not evidence that the boundary held.
//   - A refusal never retries, never falls back to default mode and never
//     resumes the old session. The session stays stopped; the next step is
//     the human's, on the control window.
//   - The agent notice never tells the agent how to recover, restart, approve
//     or bypass anything. It only says to wait for the human.
//   - Unknown or malformed reports render as "status unknown", stopped, with
//     no actions beyond ending the session.
//   - Paths and other host values are shown with invisible/reordering
//     characters escaped. Agent-written text is never shown here.

const freeze = Object.freeze;

export const CHECKPOINT_REPORT_VERSION = 1;
export const CHECKPOINT_PHASES = freeze(["running", "stopping", "verifying-stop", "capturing", "awaiting-review",
  "restarting", "checking", "ready-to-deliver", "refused", "ended"]);
export const CHECKPOINT_STAGES = freeze(["scaffold", "fill"]);
export const CHECKPOINT_REFUSALS = freeze(["teardown-unproven", "writer-survived", "capture-refused",
  "store-unavailable", "drift", "restart-unproven", "check-unavailable"]);
export const DRIFT_KINDS = freeze(["member-added", "member-removed", "mode", "exterior", "other-fence", "whole-file",
  "fence-set", "link"]);
// Fixed control-window actions. The decision page only ever offers reopen.
export const CHECKPOINT_ACTIONS = freeze(["reopen-decision-page", "restart-from-approved", "end-session", "show-details"]);

const REPORT_KEYS = freeze(["version", "phase", "stage", "round", "refusal", "detail"]);
const DETAIL_KEYS = freeze(["kind", "path", "line"]);

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const escape = (s) => Array.from(s, (c) => INVISIBLE.test(c) ? `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}` : c).join("");
const ident = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);

function exact(value, names) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((k) => !names.includes(k))) return null;
    const out = {};
    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d || !d.enumerable || !("value" in d)) return null;
      out[k] = d.value;
    }
    return out;
  } catch { return null; }
}

/**
 * Validate a checkpoint report (proposal):
 *   { version: 1, phase, stage: "scaffold"|"fill", round: <opaque id>,
 *     refusal: null | <CHECKPOINT_REFUSALS>,     // only with phase "refused"
 *     detail:  null | { kind, path, line } }     // only with refusal drift or capture-refused
 * detail.kind: a DRIFT_KINDS value for drift, or an upper-case capture code
 * (e.g. CAPTURE_LINK) for capture-refused; path: project-relative or null;
 * line: positive integer or null. Returns a frozen copy or null.
 */
export function parseCheckpointReport(value) {
  const r = exact(value, REPORT_KEYS);
  if (!r || r.version !== CHECKPOINT_REPORT_VERSION || !CHECKPOINT_PHASES.includes(r.phase)) return null;
  if (!CHECKPOINT_STAGES.includes(r.stage) || !ident(r.round)) return null;
  if (r.phase === "refused") { if (!CHECKPOINT_REFUSALS.includes(r.refusal)) return null; }
  else if (r.refusal !== null) return null;
  let detail = null;
  if (r.detail !== null) {
    if (r.refusal !== "drift" && r.refusal !== "capture-refused") return null;
    const d = exact(r.detail, DETAIL_KEYS);
    if (!d) return null;
    if (r.refusal === "drift" ? !DRIFT_KINDS.includes(d.kind) : !(typeof d.kind === "string" && /^CAPTURE_[A-Z_]{1,40}$/.test(d.kind))) return null;
    if (d.path !== null && !(typeof d.path === "string" && d.path.length > 0 && d.path.length <= 4096)) return null;
    if (d.line !== null && !(Number.isSafeInteger(d.line) && d.line > 0)) return null;
    detail = freeze(d);
  } else if (r.refusal === "drift") return null; // a drift refusal must say what drifted
  return freeze({ ...r, detail });
}

const where = (d) => d && d.path !== null ? ` in ${escape(d.path)}${d.line !== null ? ` at line ${d.line}` : ""}` : "";

const DRIFT_TEXT = {
  "member-added": "A file was added that the approved skeleton doesn't include",
  "member-removed": "A file the approved skeleton includes is missing",
  mode: "A file's mode changed",
  exterior: "Code outside the step fences changed",
  "other-fence": "A step other than the one being filled changed",
  "whole-file": "A context file that must stay unchanged changed",
  "fence-set": "The set of step fences or their titles changed",
  link: "A symlink or hard link appeared where a plain file was expected",
};

const STOPPED = "The session stays stopped. Nothing from this attempt is used.";
const NO_CLAIM = "Strict status remains unverified: this report is the launcher's account of its own steps, not proof that the boundary held.";
const AGENT_WAIT = "The session was stopped by the strict launcher. Wait for the human; do not try to restart, recapture, approve or work around it.";

function phaseCopy(r) {
  const stage = r.stage === "scaffold" ? "skeleton" : "fill";
  switch (r.phase) {
    case "running": return {
      tone: "info", headline: `The agent is working on the ${stage}.`,
      detail: "Nothing is captured while the agent runs. When it says it's ready, stop it from this window to take a snapshot for review.",
      next: "Wait, or stop the session for review.", actions: ["end-session"],
      agent: null };
    case "stopping": return {
      tone: "wait", headline: "Stopping the session for review.",
      detail: "The launcher is ending every process in the session before anything is copied.",
      next: "Wait. Don't edit the project while this runs.", actions: [], agent: AGENT_WAIT };
    case "verifying-stop": return {
      tone: "wait", headline: "Checking that every session process has stopped.",
      detail: "Nothing is captured until the launcher confirms no process from the session is still running.",
      next: "Wait. This window updates when the check finishes.", actions: [], agent: AGENT_WAIT };
    case "capturing": return {
      tone: "wait", headline: `Taking a snapshot of the stopped ${stage}.`,
      detail: "The launcher copies the stopped project privately and captures that copy. The snapshot is stored before anything refers to it.",
      next: "Wait. Don't edit the project while this runs.", actions: [], agent: AGENT_WAIT };
    case "awaiting-review": return {
      tone: "action", headline: `A snapshot of the ${stage} is ready for your review.`,
      detail: "The decision page shows the stored snapshot itself, not the live project. Decisions are made only on that page.",
      next: "Open the decision page from this window and review the snapshot.",
      actions: ["reopen-decision-page", "end-session"], agent: AGENT_WAIT };
    case "restarting": return {
      tone: "wait", headline: "Starting a fresh session from the approved skeleton.",
      detail: "The new session starts from the stored approved snapshot, not from the stopped session's files. The old session is not resumed.",
      next: "Wait. This window updates when the new session is running.", actions: [], agent: null };
    case "checking": return {
      tone: "wait", headline: "Checking the fill against the approved skeleton.",
      detail: "The launcher compares the stopped fill with the approved snapshot: files, modes, code outside the fences, other steps and context files.",
      next: "Wait. This window updates when the check finishes.", actions: [], agent: AGENT_WAIT };
    case "ready-to-deliver": return {
      tone: "action", headline: "The fill passed the checks against the approved skeleton.",
      detail: "Delivering the result to your project isn't available in this prototype yet: how strict delivers output is still an open product decision.",
      next: "Review the final snapshot on the decision page. The stored result is kept; nothing has been written to your checkout.",
      actions: ["reopen-decision-page", "end-session"], agent: AGENT_WAIT };
    case "ended": return {
      tone: "info", headline: "The strict session has ended.",
      detail: "No session process is running. Stored snapshots stay where the launcher keeps them.",
      next: "Start a new strict session from the launcher to continue.", actions: [], agent: null };
    default: return null;
  }
}

function refusalCopy(r) {
  const d = r.detail;
  const restart = r.stage === "fill" ? ["restart-from-approved", "show-details", "end-session"] : ["show-details", "end-session"];
  switch (r.refusal) {
    case "teardown-unproven": return {
      headline: "Some session processes couldn't be confirmed stopped, so nothing was captured.",
      detail: `A snapshot is only taken once every process in the session is known to have exited. ${STOPPED}`,
      next: "End the session. If this repeats, the launcher's platform profile may not support strict.", actions: ["show-details", "end-session"] };
    case "writer-survived": return {
      headline: "A session process was still running after the stop, so nothing was captured.",
      detail: `A process from the session outlived the stop. That is exactly what the check exists to catch. ${STOPPED}`,
      next: "End the session, and don't trust files the session could have written since the stop.", actions: ["show-details", "end-session"] };
    case "capture-refused": return {
      headline: `The snapshot was refused${where(d)}.`,
      detail: `${d ? `The capture reported ${d.kind}. ` : ""}Strict captures only plain, single-linked UTF-8 files with well-formed step markers. ${STOPPED}`,
      next: r.stage === "fill" ? "Restart the fill from the approved skeleton, or end the session." : "End the session; the skeleton needs to be rewritten in a new session.",
      actions: restart };
    case "store-unavailable": return {
      headline: "The launcher couldn't store or reread the snapshot.",
      detail: `Its private storage didn't respond as expected. A snapshot that isn't durably stored is never reviewed or used. ${STOPPED}`,
      next: "End the session and check the launcher's storage location. Don't repair its files by hand.", actions: ["show-details", "end-session"] };
    case "drift": return {
      headline: `${DRIFT_TEXT[d.kind]}${where(d)}.`,
      detail: `The fill may change only the body of the step being filled. ${STOPPED}`,
      next: "Restart the fill from the approved skeleton, or end the session.", actions: restart };
    case "restart-unproven": return {
      headline: "The fresh session couldn't be confirmed separate from the stopped one.",
      detail: `The fill only starts in a new session built from the approved snapshot. ${STOPPED}`,
      next: "End the session.", actions: ["show-details", "end-session"] };
    case "check-unavailable": return {
      headline: "The fill couldn't be checked against the approved skeleton.",
      detail: `An unchecked fill is never handed over or treated as passing. ${STOPPED}`,
      next: "Restart the fill from the approved skeleton, or end the session.", actions: restart };
    default: return null;
  }
}

/**
 * Render a checkpoint report for the trusted surfaces.
 * Returns frozen { phase, stage, tone, headline, detail, next, actions,
 * agentNotice, note }. A malformed report renders as status unknown.
 */
export function checkpointStatus(report) {
  const r = parseCheckpointReport(report);
  if (!r) return freeze({
    phase: "unknown", stage: null, tone: "refused",
    headline: "The checkpoint status couldn't be read.",
    detail: "The launcher's report was missing or malformed, so this window doesn't know what the session is doing. Treat the session as stopped and nothing as approved.",
    next: "End the session from this window.", actions: freeze(["end-session"]), agentNotice: AGENT_WAIT, note: NO_CLAIM });
  if (r.phase === "refused") {
    const c = refusalCopy(r);
    return freeze({ phase: "refused", stage: r.stage, refusal: r.refusal, tone: "refused", headline: c.headline, detail: c.detail,
      next: c.next, actions: freeze([...c.actions]), agentNotice: AGENT_WAIT, note: NO_CLAIM });
  }
  const c = phaseCopy(r);
  return freeze({ phase: r.phase, stage: r.stage, tone: c.tone, headline: c.headline, detail: c.detail, next: c.next,
    actions: freeze([...c.actions]), agentNotice: c.agent, note: NO_CLAIM });
}
