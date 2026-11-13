// #77: PROTOTYPE console logic for the launcher control window under the H3
// proposal (docs/strict-human-channel.md). Mock-only and wired into nothing.
//
// This module is the decision UI's text layer: it turns one typed line into
// fixed-copy output lines, against an injected authority. It does NOT own the
// control process, its PTY or raw mode, the round key, code derivation or
// verification, the attempt caps or the journal: those belong to the launcher
// and the authority (#75/#76, Codex). The authority interface here is a
// proposal for that contract:
//
//   authority.verifyAndCommit({ action, code, requestId }) -> one of
//     { kind: "committed", action, revision, reviewVersion, captureVersion }
//     { kind: "mismatch", revision, reviewVersion, captureVersion, attemptsLeft }
//     { kind: "locked", unlock: "recapture" | "new-session" }
//     { kind: "rejected", code: <STRICT_REJECTIONS> }
//     { kind: "unavailable" }            // or a throw: outcome unknown
//   authority.recapture({ requestId }) -> one of
//     { kind: "recaptured", changed, revision, reviewVersion, captureVersion }
//     { kind: "refused", reason: "fill-phase" | "locked" }
//     { kind: "unavailable" }            // or a throw: outcome unknown
//   authority.state() -> { phase, revision, reviewVersion, captureVersion }
//
// Rules this console keeps (tests enforce them):
//   - Input: one line, printable ASCII only. A bracketed paste with a newline
//     or any control byte is refused whole. Codes are Crockford-normalised.
//   - Output: only fixed copy, 12-hex prefixes of validated digests,
//     integers and validated opaque ids. Raw input is never echoed, and a
//     malformed authority reply is reported as an unknown outcome.
//   - A request whose outcome is unknown is kept with its request id. While it
//     is kept, a new code for any action is refused: `retry` resends it. This
//     keeps a self-made commit from being reported as a mismatch.
//   - `retry` and `recapture` each need `yes` on its own line. Recapture with a
//     kept request warns that it ends the pending retry.
//   - The echo of a decision comes from the committed reply, after commit.

import { STRICT_REJECTIONS } from "./strict-protocol.mjs";

const freeze = Object.freeze;

export const CONTROL_BANNER = "SKELETON STRICT CONTROL"; // same banner the page names
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const prefix = (d) => `${d.slice(0, 12)}…`;

/** Normalise a typed code (case, I/L->1, O->0, spaces/hyphens). Returns "XXXX-XXXX" or null. */
export function normalizeCode(text) {
  if (typeof text !== "string") return null;
  const s = text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== 8 || [...s].some((c) => !CROCKFORD.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Input policy: a single line of printable ASCII. Paste must also hold no newline or control byte. */
export function acceptInput(text, { paste = false } = {}) {
  if (typeof text !== "string" || text.length > 200) return null;
  if (/[^\x20-\x7E]/.test(text)) return null; // also refuses \n, \r, ESC, C1, non-ASCII
  if (paste && /[\x00-\x1F\x7F]/.test(text)) return null;
  return text.trim();
}

const COPY = freeze({
  help: "Commands: approve <code>, reshape <code>, recapture, retry, status. Codes come only from the protected decision page.",
  refusedInput: "Input refused: type one line of plain letters, digits, spaces and hyphens. Pasted text with line breaks or control characters is refused whole.",
  unknownCommand: "Unknown command. Type help for the list.",
  badCode: "That isn't a decision code. A code is 8 letters and digits, shown on the decision page like K7M2-QX9D.",
  keptBlocksNew: "An earlier request's outcome is unknown. Type retry to resend that same request, so the service returns its original answer instead of deciding twice.",
  nothingToRetry: "There is no request to retry.",
  confirmPrompt: "Type yes to continue or no to cancel.",
  cancelled: "Cancelled. Nothing was sent.",
  recaptureAbandons: "Recapture ends the pending Retry. After that, this window can no longer ask the service for the original answer. Retry first if you want it.",
  unknownOutcome: "The service didn't give a usable answer, so whether the request was recorded is unknown. Type retry to resend the same request.",
  malformedReply: "The service's reply was malformed, so whether the request was recorded is unknown. Type retry to resend the same request.",
  locked: { recapture: "Too many codes didn't match, so this review round accepts no more codes. Type recapture to take a fresh snapshot and start counting again.",
    "new-session": "Too many codes didn't match, so this review round accepts no more codes. End this session and start a new strict session from the launcher." },
  recaptureRefused: { "fill-phase": "Recapture isn't available while the skeleton is being filled. Nothing changed.",
    locked: "Recapture isn't available right now. Nothing changed." },
  rejected: {
    "stale-review": "Refused: the review moved on before this request. Nothing was recorded. Reload the decision page and use its current code.",
    "revision-conflict": "Refused: the review changed before this request. Nothing was recorded. Reload the decision page and use its current code.",
    "invalid-transition": "Refused: that decision isn't allowed in the current phase. Nothing was recorded.",
    "unauthorized-channel": "Refused: the service didn't accept this window as the human channel. Whether an earlier send of this request was recorded is unknown.",
    "session-ended": "Refused: this strict session has ended. Whether an earlier send of this request was recorded is unknown.",
    unavailable: "The service is unavailable, so whether the request was recorded is unknown. Type retry to resend the same request.",
    "request-reused": "Refused: that request id was already used for a different request. Whether the original was recorded is unknown.",
  },
});
export const CONSOLE_COPY = COPY;

function validState(s) {
  return s && typeof s === "object" && ["skeleton", "fill", "finalized"].includes(s.phase) && count(s.revision)
    && digest(s.reviewVersion) && digest(s.captureVersion);
}

/**
 * Create a console bound to an authority (proposal interface above).
 *   newRequestId: () => opaque id string (the launcher supplies it).
 * Returns { banner, handle(text, { paste }) -> Promise<string[]>, kept() }.
 */
export function createControlConsole({ authority, newRequestId }) {
  if (!authority || typeof newRequestId !== "function") throw new TypeError("authority and newRequestId required");
  let kept = null;       // { op: "decide"|"recapture", action?, code?, requestId } with unknown outcome
  let confirming = null; // "retry" | "recapture"

  const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
  const nextId = () => { const id = newRequestId(); if (!validId(id)) throw new Error("bad request id"); return id; };

  async function send(req) {
    let reply;
    try {
      reply = req.op === "decide"
        ? await authority.verifyAndCommit({ action: req.action, code: req.code, requestId: req.requestId })
        : await authority.recapture({ requestId: req.requestId });
    } catch { kept = req; return [COPY.unknownOutcome]; }
    return interpret(req, reply);
  }

  function interpret(req, r) {
    const k = r && typeof r === "object" ? r.kind : null;
    if (req.op === "decide" && k === "committed" && r.action === req.action && count(r.revision) && digest(r.reviewVersion) && digest(r.captureVersion)) {
      kept = null;
      return [`Recorded: ${req.action} · shape ${prefix(r.reviewVersion)} · capture ${prefix(r.captureVersion)} · revision ${r.revision}.`];
    }
    if (req.op === "decide" && k === "mismatch" && count(r.revision) && digest(r.reviewVersion) && digest(r.captureVersion) && count(r.attemptsLeft)) {
      kept = null; // a definitive refusal: nothing recorded
      return ["That code doesn't match the snapshot under review now. Nothing was recorded.",
        `Under review now: shape ${prefix(r.reviewVersion)} · capture ${prefix(r.captureVersion)} · revision ${r.revision}. Compare with the decision page and reload it if they differ.`,
        `${r.attemptsLeft} ${r.attemptsLeft === 1 ? "attempt" : "attempts"} left in this review round.`];
    }
    if (req.op === "decide" && k === "locked" && Object.hasOwn(COPY.locked, r.unlock)) { kept = null; return [COPY.locked[r.unlock]]; }
    if (req.op === "recapture" && k === "recaptured" && typeof r.changed === "boolean" && count(r.revision) && digest(r.reviewVersion) && digest(r.captureVersion)) {
      kept = null;
      return [r.changed
        ? `Recaptured: a new snapshot is under review · shape ${prefix(r.reviewVersion)} · capture ${prefix(r.captureVersion)} · revision ${r.revision}. Reload the decision page.`
        : `Recaptured: the snapshot is unchanged · revision ${r.revision}.`];
    }
    if (req.op === "recapture" && k === "refused" && Object.hasOwn(COPY.recaptureRefused, r.reason)) { kept = null; return [COPY.recaptureRefused[r.reason]]; }
    if (k === "rejected" && STRICT_REJECTIONS.includes(r.code)) {
      // unavailable is an unknown outcome; the others are definitive refusals of this send.
      kept = r.code === "unavailable" ? req : null;
      return [COPY.rejected[r.code]];
    }
    if (k === "unavailable") { kept = req; return [COPY.unknownOutcome]; }
    kept = req;
    return [COPY.malformedReply];
  }

  async function status() {
    let s;
    try { s = await authority.state(); } catch { return ["The service didn't answer, so the current state is unknown."]; }
    if (!validState(s)) return ["The service's state reply was malformed, so the current state is unknown."];
    const lines = [`Phase ${s.phase} · shape ${prefix(s.reviewVersion)} · capture ${prefix(s.captureVersion)} · revision ${s.revision}.`];
    if (kept) lines.push("An earlier request's outcome is unknown. Type retry to resend it.");
    return lines;
  }

  async function handle(text, { paste = false } = {}) {
    const line = acceptInput(text, { paste });
    if (line === null) return [COPY.refusedInput];
    if (confirming) {
      const what = confirming; confirming = null;
      if (line.toLowerCase() !== "yes") return [COPY.cancelled];
      if (what === "retry") { if (!kept) return [COPY.nothingToRetry]; return send(kept); }
      kept = null; // recapture abandons any pending retry
      return send({ op: "recapture", requestId: nextId() });
    }
    const [word, ...rest] = line.split(/\s+/);
    const cmd = (word ?? "").toLowerCase();
    if (cmd === "" ) return [];
    if (cmd === "help") return [COPY.help];
    if (cmd === "status") return status();
    if (cmd === "retry") {
      if (rest.length) return [COPY.unknownCommand];
      if (!kept) return [COPY.nothingToRetry];
      confirming = "retry";
      return [kept.op === "decide" ? `Resend the earlier ${kept.action} request with the same request id?` : "Resend the earlier recapture request with the same request id?", COPY.confirmPrompt];
    }
    if (cmd === "recapture") {
      if (rest.length) return [COPY.unknownCommand];
      confirming = "recapture";
      return [...(kept ? [COPY.recaptureAbandons] : []), "Take a fresh snapshot of the stopped project for review?", COPY.confirmPrompt];
    }
    if (cmd === "approve" || cmd === "reshape") {
      const code = normalizeCode(rest.join(""));
      if (!code) return [COPY.badCode];
      if (kept) return [COPY.keptBlocksNew];
      return send({ op: "decide", action: cmd, code, requestId: nextId() });
    }
    return [COPY.unknownCommand];
  }

  return freeze({ banner: CONTROL_BANNER, handle, kept: () => (kept ? freeze({ ...kept }) : null) });
}
