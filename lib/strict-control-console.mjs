// #77: PROTOTYPE console logic for the launcher control window under the H3
// proposal (docs/strict-human-channel.md). Mock-only and wired into nothing.
//
// This module is the decision UI's text layer: it turns one typed line into
// fixed-copy output lines, against an injected authority. It does NOT own the
// control process, its PTY or raw mode, bracketed-paste marker stripping, the
// round key, code derivation or verification, the attempt caps or the
// journal: those belong to the launcher and the authority (#75/#76, Codex).
// The authority interface (proposal) is in docs/strict-control-console.md.
// Every reply must echo the request's `requestId`; anything else is malformed.
//
// Rules this console keeps (tests enforce them):
//   - One request in flight at a time. While one is pending, every command
//     except status/help is refused, so replies can't race.
//   - Input: one line of printable ASCII. Any control byte refuses the line
//     and cancels a pending yes/no prompt. Codes are Crockford-normalised.
//   - Output: only fixed copy, 12-hex prefixes of validated digests, integers
//     and a validated UTC timestamp. Raw input and authority-supplied text are
//     never echoed; a malformed or throwing reply is an unknown outcome.
//   - A request whose outcome is unknown is kept with its id and code. While
//     it is kept, a new code is refused; `retry` resends the same request.
//     Answers to a resend that can't settle the original (channel refused,
//     session ended, id reused, mismatch, lock, journal full) keep it too.
//     Only a commit, a definitive first-send refusal, `recapture` or `end`
//     clears it.
//   - `retry`, `recapture` and `end` each need `yes` on its own line.

import { STRICT_REJECTIONS } from "./strict-protocol.mjs";

const freeze = Object.freeze;

export const CONTROL_BANNER = "SKELETON STRICT CONTROL"; // same banner the page names
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const utc = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(v);
const prefix = (d) => `${d.slice(0, 12)}…`;
const PHASES = freeze(["skeleton", "fill", "finalized"]);

/** Normalise a typed code (case, I/L->1, O->0, spaces/hyphens). Returns "XXXX-XXXX" or null. */
export function normalizeCode(text) {
  if (typeof text !== "string") return null;
  const s = text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== 8 || [...s].some((c) => !CROCKFORD.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * Input policy: a single line of printable ASCII, at most 200 characters. Any
 * control byte (newline, ESC, C1, DEL) or non-ASCII character refuses the
 * whole line. The launcher strips bracketed-paste markers before calling.
 */
export function acceptInput(text) {
  if (typeof text !== "string" || text.length > 200 || /[^\x20-\x7E]/.test(text)) return null;
  return text.trim();
}

/** Own data properties only; a getter, proxy trap or missing key makes it null. */
function read(value, keys) {
  try {
    if (!value || typeof value !== "object") return null;
    const out = {};
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (d && !("value" in d)) return null;
      out[k] = d ? d.value : undefined;
    }
    return out;
  } catch { return null; }
}

const COPY = freeze({
  help: "Commands: approve <code>, reshape <code>, recapture, retry, end, status. Codes come only from the protected decision page.",
  refusedInput: "Input refused: type one line of plain letters, digits, spaces and hyphens. Text with line breaks or control characters is refused whole, and any pending question is cancelled.",
  unknownCommand: "Unknown command. Type help for the list.",
  badCode: "That isn't a decision code. A code is 8 letters and digits, shown on the decision page like K7M2-QX9D.",
  noRequestId: "The launcher couldn't create a request id, so nothing was sent and nothing changed. Try again, or end the session if this repeats.",
  busy: "A request is being sent. Wait for its answer before typing another command.",
  ended: "This strict session has ended. Start a new strict session from the launcher.",
  keptBlocksNew: "An earlier request's outcome is unknown. Type retry to resend that same request, so the service returns its original answer instead of deciding twice. Or type recapture or end to give up on it.",
  nothingToRetry: "There is no request to retry.",
  confirmPrompt: "Type yes to continue or no to cancel.",
  cancelled: "Cancelled. Nothing was sent.",
  recaptureAbandons: "Recapture ends the pending Retry. After that, this window can no longer ask the service for the original answer. Retry first if you want it.",
  endAbandons: "Ending the session ends the pending Retry. Its outcome is recorded as unknown, and a later session can learn it only from the service's journal.",
  endUnknown: "Whether the session ended is unknown. Type end again, or close this window; the launcher then ends the session itself.",
  unknownOutcome: "The service didn't give a usable answer, so whether the request was recorded is unknown. Type retry to resend the same request.",
  malformedReply: "The service's reply was malformed, so whether the request was recorded is unknown. Type retry to resend the same request.",
  stillUnknown: "The service's answer to the resend can't settle whether the earlier send was recorded, so its outcome is still unknown. Type retry to resend it again, or recapture or end to give up on it.",
  recordUnreadable: "The service can't read its records, so whether the request was recorded is unknown, and a retry won't help until the launcher's storage is recovered outside this session. Type end to end the session.",
  journalFull: "Refused: the service's request journal is full, so it accepts no new requests. Nothing was recorded. End the session; a new strict session starts a new journal.",
  locked: freeze({ recapture: "Too many codes didn't match, so this review round accepts no more codes. Nothing was recorded. Type recapture to take a fresh snapshot and start counting again.",
    "new-session": "Too many codes didn't match, so this review round accepts no more codes. Nothing was recorded. Type end, then start a new strict session from the launcher." }),
  recaptureRefused: freeze({ "fill-phase": "Recapture isn't available while the skeleton is being filled. Nothing changed.",
    locked: "Recapture isn't available right now. Nothing changed." }),
  // First-send refusals: the service refused this request and made no change.
  rejectedDecision: freeze({
    "stale-review": "Refused: the review moved on before this request. Nothing was recorded. Reload the decision page and use its current code.",
    "revision-conflict": "Refused: the review changed before this request. Nothing was recorded. Reload the decision page and use its current code.",
    "invalid-transition": "Refused: that decision isn't allowed in the current phase. Nothing was recorded.",
    "unauthorized-channel": "Refused: the service didn't accept this window as the human channel. This request made no change.",
    "session-ended": "Refused: this strict session has ended. This request made no change.",
    "request-reused": "Refused: the service already holds a different request under this id. This request made no change.",
  }),
  rejectedRecapture: freeze({
    "stale-review": "Refused: the review moved on before this recapture. Nothing changed.",
    "revision-conflict": "Refused: the review changed before this recapture. Nothing changed.",
    "invalid-transition": "Refused: recapture isn't allowed in the current phase. Nothing changed.",
    "unauthorized-channel": "Refused: the service didn't accept this window as the human channel. Nothing changed.",
    "session-ended": "Refused: this strict session has ended. Nothing changed.",
    "request-reused": "Refused: the service already holds a different request under this id. Nothing changed.",
  }),
});
export const CONSOLE_COPY = COPY;

/**
 * Create a console bound to an authority (see docs/strict-control-console.md).
 *   newRequestId: () => unique opaque id from a CSPRNG (the launcher's duty;
 *   the console doesn't detect reuse).
 * Returns { banner, handle(text) -> Promise<string[]>, kept(), ended() }.
 */
export function createControlConsole({ authority, newRequestId }) {
  if (!authority || typeof newRequestId !== "function") throw new TypeError("authority and newRequestId required");
  let kept = null;       // { op, action?, code?, requestId, sends } whose outcome is unknown
  let confirming = null; // "retry" | "recapture" | "end"
  let busy = false;
  let ended = false;

  const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
  // A fresh id, or null if the launcher's factory throws or returns junk.
  const nextId = () => { try { const id = newRequestId(); return validId(id) ? id : null; } catch { return null; } };

  async function send(req) {
    req.sends += 1;
    busy = true;
    try {
      const reply = req.op === "decide" ? await authority.verifyAndCommit({ action: req.action, code: req.code, requestId: req.requestId })
        : req.op === "recapture" ? await authority.recapture({ requestId: req.requestId })
        : await authority.endSession({ requestId: req.requestId });
      return interpret(req, reply);
    } catch {
      return keep(req, COPY.unknownOutcome);
    } finally { busy = false; }
  }
  const keep = (req, line) => {
    if (req.op === "end") return [COPY.endUnknown]; // ending abandons any kept request; nothing to retry
    kept = req; return [line];
  };
  const clear = (lines) => { kept = null; return lines; };

  function interpret(req, reply) {
    const r = read(reply, ["kind", "requestId", "action", "code", "revision", "reviewVersion", "captureVersion", "attemptsLeft", "unlock", "changed", "reason", "at"]);
    if (!r || r.requestId !== req.requestId) return keep(req, COPY.malformedReply);
    const resent = req.sends > 1;
    const pair = count(r.revision) && digest(r.reviewVersion) && digest(r.captureVersion);
    if (r.kind === "unavailable" || (r.kind === "rejected" && r.code === "unavailable")) return keep(req, COPY.unknownOutcome);
    if (r.kind === "record-unreadable") return keep(req, COPY.recordUnreadable);

    if (req.op === "end") {
      if (r.kind === "ended") { ended = true; kept = null; return ["The strict session has ended. Start a new strict session from the launcher to continue."]; }
      return [COPY.endUnknown];
    }
    if (req.op === "decide") {
      if (r.kind === "committed" && r.action === req.action && pair && utc(r.at))
        return clear([`Recorded: ${req.action} · shape ${prefix(r.reviewVersion)} · capture ${prefix(r.captureVersion)} · revision ${r.revision} · ${r.at}.`]);
      if (r.kind === "mismatch" && pair && count(r.attemptsLeft)) {
        if (resent) return keep(req, COPY.stillUnknown); // a journaled retry never meets the code check
        return clear(["That code doesn't match the snapshot under review now. Nothing was recorded.",
          `Under review now: shape ${prefix(r.reviewVersion)} · capture ${prefix(r.captureVersion)} · revision ${r.revision}. Compare with the decision page and reload it if they differ.`,
          `${r.attemptsLeft} ${r.attemptsLeft === 1 ? "attempt" : "attempts"} left in this review round.`]);
      }
      if (r.kind === "locked" && Object.hasOwn(COPY.locked, r.unlock)) return resent ? keep(req, COPY.stillUnknown) : clear([COPY.locked[r.unlock]]);
    }
    if (req.op === "recapture") {
      if (r.kind === "recaptured" && typeof r.changed === "boolean" && pair)
        return clear([r.changed
          ? `Recaptured: a new snapshot is under review · shape ${prefix(r.reviewVersion)} · capture ${prefix(r.captureVersion)} · revision ${r.revision}. Reload the decision page.`
          : `Recaptured: the snapshot is unchanged · revision ${r.revision}.`]);
      if (r.kind === "refused" && Object.hasOwn(COPY.recaptureRefused, r.reason)) return resent ? keep(req, COPY.stillUnknown) : clear([COPY.recaptureRefused[r.reason]]);
    }
    if (r.kind === "journal-full") return resent ? keep(req, COPY.stillUnknown) : clear([COPY.journalFull]);
    if (r.kind === "rejected" && STRICT_REJECTIONS.includes(r.code)) {
      const table = req.op === "decide" ? COPY.rejectedDecision : COPY.rejectedRecapture;
      // stale-review, revision-conflict and invalid-transition are checked after the journal's
      // exact-retry lookup, so even on a resend they mean this request was never recorded.
      if (["stale-review", "revision-conflict", "invalid-transition"].includes(r.code)) return clear([table[r.code]]);
      return resent ? keep(req, COPY.stillUnknown) : clear([table[r.code]]);
    }
    return keep(req, COPY.malformedReply);
  }

  async function status() {
    let s;
    try { s = read(await authority.state(), ["phase", "revision", "reviewVersion", "captureVersion"]); } catch { s = null; }
    if (!s || !PHASES.includes(s.phase) || !count(s.revision) || !digest(s.reviewVersion) || !digest(s.captureVersion))
      return ["The service's state is unknown right now (no answer, or a malformed one)."];
    const lines = [`Phase ${s.phase} · shape ${prefix(s.reviewVersion)} · capture ${prefix(s.captureVersion)} · revision ${s.revision}.`];
    if (kept) lines.push("An earlier request's outcome is unknown. Type retry to resend it.");
    if (busy) lines.push("A request is being sent.");
    return lines;
  }

  async function handle(text) {
    const line = acceptInput(text);
    if (line === null) { confirming = null; return [COPY.refusedInput]; }
    const [word, ...rest] = line.split(/\s+/);
    const cmd = (word ?? "").toLowerCase();
    if (cmd === "help") return [COPY.help];
    if (cmd === "status") return status();
    if (busy) return [COPY.busy];
    if (ended) return [COPY.ended];
    if (confirming) {
      const what = confirming; confirming = null;
      if (line.toLowerCase() !== "yes") return [COPY.cancelled];
      if (what === "retry") return kept ? send(kept) : [COPY.nothingToRetry];
      const requestId = nextId(); // before abandoning anything, so a failure keeps the pending retry
      if (!requestId) return [COPY.noRequestId];
      kept = null; // recapture and end both abandon a pending retry
      return send({ op: what, requestId, sends: 0 });
    }
    if (cmd === "") return [];
    if (["retry", "recapture", "end"].includes(cmd) && rest.length) return [COPY.unknownCommand];
    if (cmd === "retry") {
      if (!kept) return [COPY.nothingToRetry];
      confirming = "retry";
      return [`Resend the earlier ${kept.op === "decide" ? kept.action : kept.op} request with the same request id?`, COPY.confirmPrompt];
    }
    if (cmd === "recapture") {
      confirming = "recapture";
      return [...(kept ? [COPY.recaptureAbandons] : []), "Take a fresh snapshot of the stopped project for review?", COPY.confirmPrompt];
    }
    if (cmd === "end") {
      confirming = "end";
      return [...(kept ? [COPY.endAbandons] : []), "End this strict session?", COPY.confirmPrompt];
    }
    if (cmd === "approve" || cmd === "reshape") {
      const code = normalizeCode(rest.join(""));
      if (!code) return [COPY.badCode];
      if (kept) return [COPY.keptBlocksNew];
      const requestId = nextId();
      if (!requestId) return [COPY.noRequestId];
      return send({ op: "decide", action: cmd, code, requestId, sends: 0 });
    }
    return [COPY.unknownCommand];
  }

  return freeze({ banner: CONTROL_BANNER, handle, kept: () => (kept ? freeze({ ...kept }) : null), ended: () => ended });
}
