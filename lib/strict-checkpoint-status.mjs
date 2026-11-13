// #78 / #99: human-facing status and recovery copy for the strict checkpoint
// workflow (stop -> verify stop -> capture -> review -> restart -> check).
//
// PROPOSAL, wired into nothing. The checkpoint report schema below is a
// proposal for the outside supervisor Sol owns (#99); no supervisor emits it
// yet and no schema is adopted. This module turns one report into what the
// TRUSTED surfaces show (the launcher control window and the protected
// decision page) plus a minimal notice for the agent's untrusted terminal.
// See docs/strict-checkpoint-ux.md.
//
// Rules this copy keeps (tests enforce them):
//   - Never claims containment, safety, a human decision or delivery. Every
//     status carries NO_CLAIM: a report is the launcher's account of its own
//     steps, not proof the boundary held.
//   - When the stop itself is in doubt (teardown unproven, a process seen
//     alive after the deadline, a file changing in the stopped copy, a fresh
//     session not proven separate, or an unreadable report), the copy says a
//     process may still be running, refuses capture, check and restart, and
//     treats every file the session could reach as untrusted.
//   - Other refusals never retry, fall back to default mode or resume the
//     old session. Restart from approved is offered only for fill-stage
//     causes a clean fresh session can address.
//   - A storage outcome that is unknown is reported as unknown: the request
//     identity is kept for reconciliation, never "nothing was used".
//   - The agent notice only says to wait. Agent-written text is never shown.
//   - Paths are validated project-relative and shown with invisible,
//     combining and reordering characters escaped.

const freeze = Object.freeze;

export const CHECKPOINT_REPORT_VERSION = 1;
export const CHECKPOINT_PHASES = freeze(["running", "stopping", "verifying-stop", "capturing", "awaiting-review",
  "restarting", "checking", "checked", "refused", "ended"]);
export const CHECKPOINT_STAGES = freeze(["scaffold", "fill"]);
export const CHECKPOINT_REFUSALS = freeze(["teardown-unproven", "writer-survived", "restart-unproven", "capture-refused",
  "store-outcome-unknown", "approved-unreadable", "drift", "check-unavailable"]);
export const DRIFT_KINDS = freeze(["member-added", "member-removed", "mode", "exterior", "other-fence", "whole-file",
  "fence-set", "link"]);
export const CHECKPOINT_ACTIONS = freeze(["stop-for-review", "reopen-decision-page", "restart-from-approved",
  "end-session", "show-details"]);

// Phases and refusals that only make sense for one stage.
const FILL_ONLY_PHASES = freeze(["restarting", "checking", "checked"]);
const FILL_ONLY_REFUSALS = freeze(["restart-unproven", "drift", "check-unavailable"]);

// Capture (lib/strict-capture.mjs) and enumeration (lib/strict-enumeration.mjs)
// codes, grouped by what a human can do about them.
export const CONTENT_CODES = freeze({ // something the session wrote; a clean fill restart can address it
  CAPTURE_MARKERS: "a step marker is malformed or a file has no fences",
  CAPTURE_TEXT: "a file isn't valid UTF-8 text or contains NUL",
  CAPTURE_BOM: "a file starts with a byte-order mark",
  CAPTURE_SEPARATOR: "a fenced file uses an ambiguous line separator",
  CAPTURE_LINE_LIMIT: "a file has too many lines",
  CAPTURE_LIMIT: "the project exceeds the capture size limits",
  ENUM_NAME: "a file name isn't supported",
  ENUM_NAME_LIMIT: "a file name is too long",
  ENUM_PATH_LIMIT: "a path is too long",
  ENUM_LIMIT: "the project has too many files",
  ENUM_BYTE_LIMIT: "the project is too large",
});
export const BOUNDARY_CODES = freeze({ // the stopped copy changed: the stop itself is in doubt
  CAPTURE_CHANGED: "a file changed while the stopped copy was being captured",
  ENUM_CHANGED: "the stopped copy changed while it was being listed",
  CAPTURE_MISSING: "a file disappeared from the stopped copy",
});
export const LINK_CODES = freeze({ // probably made by the session, but a link can reach outside it: no restart
  CAPTURE_LINK: "a symlink, hard link or special file was found",
  ENUM_TYPE: "a symlink, device or other special file was found",
});
export const HOST_CODES = freeze({ // a launcher or environment fault: not something a restart fixes
  CAPTURE_ROOT: "the launcher couldn't open the stopped copy",
  CAPTURE_IO: "reading the stopped copy failed",
  CAPTURE_VALIDATION: "the capture request was invalid",
  CAPTURE_DUPLICATE: "the launcher's capture list named a path twice",
  ENUM_UNSUPPORTED_NAMES: "this runtime couldn't list file names as raw bytes",
  // Enumeration maps every non-enumeration error here (EIO, EACCES, procfs
  // failures, a vanished file, a malformed marker), so the cause is lost:
  // never blame the session or offer restart until a typed cause is kept.
  ENUM_UNAVAILABLE: "the stopped copy couldn't be listed, and the cause wasn't kept",
  ENUM_ROOT: "the launcher couldn't open the stopped copy",
  ENUM_DEVICE: "the stopped copy crosses a filesystem boundary",
  ENUM_HANDLES: "the launcher ran out of file handles",
  ENUM_BUDGET: "listing the stopped copy took too long",
  ENUM_LIMITS: "the listing limits were invalid",
  ENUM_POLICY: "the listing policy was invalid",
  ENUM_UNSUPPORTED: "this platform doesn't support listing the stopped copy",
});
const ALL_CODES = freeze({ ...CONTENT_CODES, ...BOUNDARY_CODES, ...LINK_CODES, ...HOST_CODES });

const REPORT_KEYS = freeze(["version", "phase", "stage", "round", "refusal", "detail"]);
const DETAIL_KEYS = freeze(["kind", "path", "line"]);

// Invisible, format, separator, surrogate, combining and default-ignorable
// characters are shown as \u{...} so a path can't hide or fake characters.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{M}\p{Default_Ignorable_Code_Point}]/u;
const escape = (s) => Array.from(s, (c) => HIDDEN.test(c) ? `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}` : c).join("");
const ident = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
// Project-relative: same rules as safePath in lib/strict-capture.mjs
// (UTF-8 byte limit; no backslash, control, format or line/paragraph separators).
const relPath = (p) => typeof p === "string" && p.length > 0 && Buffer.byteLength(p, "utf8") <= 4096
  && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(p)
  && !/[\uD800-\uDFFF]/u.test(p) && !p.startsWith("/") && !/^[A-Za-z]:/.test(p)
  && p.split("/").length <= 64 && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

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
 * Validate a checkpoint report (proposal, not adopted):
 *   { version: 1, phase, stage: "scaffold"|"fill", round: <opaque id>,
 *     refusal: null | <CHECKPOINT_REFUSALS>,   // only with phase "refused"
 *     detail:  null | { kind, path, line } }   // drift and capture-refused (required for both)
 * restarting/checking/checked and restart-unproven/drift/check-unavailable
 * need stage "fill". detail.kind is a DRIFT_KINDS value (drift) or a known
 * CAPTURE_/ENUM_ code (capture-refused); path is project-relative or null;
 * line is a positive integer, only with a path. Returns a frozen copy or null.
 */
export function parseCheckpointReport(value) {
  const r = exact(value, REPORT_KEYS);
  if (!r || r.version !== CHECKPOINT_REPORT_VERSION || !CHECKPOINT_PHASES.includes(r.phase)) return null;
  if (!CHECKPOINT_STAGES.includes(r.stage) || !ident(r.round)) return null;
  if (r.phase === "refused") { if (!CHECKPOINT_REFUSALS.includes(r.refusal)) return null; }
  else if (r.refusal !== null) return null;
  if (r.stage !== "fill" && (FILL_ONLY_PHASES.includes(r.phase) || FILL_ONLY_REFUSALS.includes(r.refusal))) return null;
  let detail = null;
  if (r.detail !== null) {
    if (r.refusal !== "drift" && r.refusal !== "capture-refused") return null;
    const d = exact(r.detail, DETAIL_KEYS);
    if (!d) return null;
    if (r.refusal === "drift" ? !DRIFT_KINDS.includes(d.kind) : !(typeof d.kind === "string" && Object.hasOwn(ALL_CODES, d.kind))) return null;
    if (d.path !== null && !relPath(d.path)) return null;
    if (d.line !== null && !(d.path !== null && Number.isSafeInteger(d.line) && d.line > 0)) return null;
    detail = freeze(d);
  } else if (r.refusal === "drift" || r.refusal === "capture-refused") return null; // these must say what
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

export const NO_CLAIM = "Strict status remains unverified: this report is the launcher's account of its own steps, not proof that the boundary held.";
export const AGENT_WAIT = "Stopped by the strict launcher. Wait for the human.";
const NOT_USED = "Nothing from this attempt is used.";
const MAYBE_RUNNING = "A session process may still be running. Capture, checks and restart are refused, and every file the session could reach is untrusted, from before and after the stop.";
const END_DOESNT_PROVE = "End the session to ask the launcher to stop it again; that doesn't prove every process is gone. If this repeats, the launcher's platform profile may not support strict.";
const PAGE_ELSEWHERE = "Use the launcher's control window for the next step.";

const PHASES = {
  running: (stage) => ({ tone: "info", headline: `The agent is working on the ${stage}.`,
    detail: "Nothing is captured while the agent runs. When it says it's ready, stop it from this window to take a snapshot for review.",
    next: "Wait, or stop the session for review.", actions: ["stop-for-review", "end-session"], agent: null }),
  stopping: () => ({ tone: "wait", headline: "Stopping the session for review.",
    detail: "The launcher has asked every process in the session to end. Nothing is copied until it confirms they have.",
    next: "Wait. Don't edit the project while this runs.", actions: [], agent: AGENT_WAIT }),
  "verifying-stop": () => ({ tone: "wait", headline: "Checking that every session process has exited.",
    detail: "Nothing is captured until the launcher confirms no process from the session is still running.",
    next: "Wait. This window updates when the check finishes.", actions: [], agent: AGENT_WAIT }),
  capturing: (stage) => ({ tone: "wait", headline: `Taking a snapshot of the stopped ${stage}.`,
    detail: "The launcher copies the stopped project privately, lists and captures that copy, and stores the snapshot before anything refers to it.",
    next: "Wait. Don't edit the project while this runs.", actions: [], agent: AGENT_WAIT }),
  "awaiting-review": (stage) => ({ tone: "action", headline: `A snapshot of the ${stage} is ready for your review.`,
    detail: "The decision page shows the stored snapshot itself, not the live project. Decisions are made only on that page.",
    next: "Open the decision page from this window and review the snapshot.", page: "Review the stored snapshot on this page.",
    actions: ["reopen-decision-page", "end-session"], agent: AGENT_WAIT }),
  restarting: () => ({ tone: "wait", headline: "Starting a fresh fill session from the approved skeleton.",
    detail: "The new session is built from the stored approved snapshot, not from the stopped session's files. The old session is not resumed.",
    next: "Wait. This window updates when the new session is running.", actions: [], agent: null }),
  checking: () => ({ tone: "wait", headline: "Checking the fill against the approved skeleton.",
    detail: "The launcher compares the stopped fill with the approved snapshot: files, modes, code outside the fences, other steps and context files.",
    next: "Wait. This window updates when the check finishes.", actions: [], agent: AGENT_WAIT }),
  checked: () => ({ tone: "info", headline: "The fill passed the checks against the approved skeleton.",
    detail: "In this prototype the checked result is not durably stored and not handed to your project: storing and delivering it are future steps, and how strict delivers output is still an open product decision.",
    next: "Nothing has been written to your checkout. End the session when you're done.", actions: ["end-session"], agent: AGENT_WAIT }),
  ended: () => ({ tone: "info", headline: "The launcher reports the session ended.",
    detail: "If an earlier report said a session process couldn't be confirmed stopped, that still stands: this report doesn't prove every process is gone.",
    next: "Start a new strict session from the launcher to continue.", actions: [], agent: null }),
};

function refusal(r) {
  const d = r.detail, fill = r.stage === "fill";
  const restart = (ok) => ok && fill ? ["restart-from-approved", "show-details", "end-session"] : ["show-details", "end-session"];
  const restartNext = (ok, otherwise) => ok && fill ? "Restart the fill from the approved skeleton, or end the session." : otherwise;
  switch (r.refusal) {
    case "teardown-unproven": return { boundary: true,
      headline: "The stop was requested, but the launcher couldn't confirm every session process exited.",
      detail: MAYBE_RUNNING, next: END_DOESNT_PROVE, actions: restart(false) };
    case "writer-survived": return { boundary: true,
      headline: "A session process was seen still running after the stop deadline.",
      detail: MAYBE_RUNNING, next: END_DOESNT_PROVE, actions: restart(false) };
    case "restart-unproven": return { boundary: true,
      headline: "The fresh fill session couldn't be confirmed separate from the stopped one.",
      detail: MAYBE_RUNNING, next: END_DOESNT_PROVE, actions: restart(false) };
    case "capture-refused": {
      if (Object.hasOwn(BOUNDARY_CODES, d.kind)) return { boundary: true,
        headline: `The snapshot was refused: ${BOUNDARY_CODES[d.kind]}${where(d)} (${d.kind}).`,
        detail: MAYBE_RUNNING, next: END_DOESNT_PROVE, actions: restart(false) };
      const content = Object.hasOwn(CONTENT_CODES, d.kind), link = Object.hasOwn(LINK_CODES, d.kind);
      if (link) return {
        headline: `The snapshot was refused: ${ALL_CODES[d.kind]}${where(d)} (${d.kind}).`,
        detail: `The session probably created it, but a link or special file can point outside the project, so strict doesn't offer a restart. ${NOT_USED}`,
        next: "End the session. Don't follow or open the link outside the launcher.", actions: restart(false) };
      return {
        headline: `The snapshot was refused: ${ALL_CODES[d.kind]}${where(d)} (${d.kind}).`,
        detail: `${content ? "This is something the session wrote." : "A clean restart doesn't fix this."} ${NOT_USED}`,
        next: restartNext(content, fill ? "End the session and check the launcher's environment." : content
          ? "End the session; the skeleton needs to be rewritten in a new session." : "End the session and check the launcher's environment."),
        actions: restart(content) };
    }
    case "store-outcome-unknown": return {
      headline: "The launcher couldn't confirm whether the snapshot was stored.",
      detail: "The storage step may or may not have completed. The launcher keeps the request's identity so it can reconcile the outcome later; a reload or a re-read here can't settle it.",
      next: "End the session. The launcher must reconcile its storage before this snapshot can be reviewed. Don't repair its files by hand.",
      actions: restart(false) };
    case "approved-unreadable": return {
      headline: "The approved skeleton couldn't be read or didn't match its record.",
      detail: "Every new session and request refuses until the launcher's storage is recovered outside this session. Nothing is rebuilt from the project's files.",
      next: "End the session and recover the launcher's storage. Don't repair its files by hand.", actions: restart(false) };
    case "drift": {
      if (d.kind === "link") return {
        headline: `${DRIFT_TEXT.link}${where(d)}.`,
        detail: `The session probably created it, but a link can point outside the project, so strict doesn't offer a restart. ${NOT_USED}`,
        next: "End the session. Don't follow or open the link outside the launcher.", actions: restart(false) };
      return {
        headline: `${DRIFT_TEXT[d.kind]}${where(d)}.`,
        detail: `The fill may change only the body of the step being filled. ${NOT_USED}`,
        next: restartNext(true), actions: restart(true) };
    }
    case "check-unavailable": return {
      headline: "The fill couldn't be checked against the approved skeleton.",
      detail: `An unchecked fill is never handed over or treated as passing. ${NOT_USED}`,
      next: restartNext(true), actions: restart(true) };
    default: return null;
  }
}

/**
 * Render a checkpoint report for the trusted surfaces. Returns frozen
 * { phase, stage, refusal?, boundaryInDoubt?, tone, headline, detail, next,
 *   pageNext, actions, agentNotice, note }. `next` is for the control window;
 * `pageNext` is for the decision page, which only ever offers reopen. A
 * malformed report renders as status unknown, possibly still running.
 */
export function checkpointStatus(report) {
  const r = parseCheckpointReport(report);
  if (!r) return freeze({
    phase: "unknown", stage: null, tone: "refused",
    headline: "The checkpoint status couldn't be read.",
    detail: "The launcher's report was missing or malformed, so this window doesn't know what the session is doing. Treat the session as possibly still running and nothing as approved.",
    next: "End the session from this window.", pageNext: PAGE_ELSEWHERE, actions: freeze(["end-session"]),
    agentNotice: AGENT_WAIT, note: NO_CLAIM });
  if (r.phase === "refused") {
    const c = refusal(r);
    return freeze({ phase: "refused", stage: r.stage, refusal: r.refusal, boundaryInDoubt: c.boundary === true, tone: "refused",
      headline: c.headline, detail: c.detail, next: c.next, pageNext: PAGE_ELSEWHERE, actions: freeze([...c.actions]),
      agentNotice: AGENT_WAIT, note: NO_CLAIM });
  }
  const c = PHASES[r.phase](r.stage === "scaffold" ? "skeleton" : "fill");
  return freeze({ phase: r.phase, stage: r.stage, tone: c.tone, headline: c.headline, detail: c.detail, next: c.next,
    pageNext: c.page ?? PAGE_ELSEWHERE, actions: freeze([...c.actions]), agentNotice: c.agent, note: NO_CLAIM });
}
