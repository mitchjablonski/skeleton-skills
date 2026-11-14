// TEST FIXTURE ONLY: an in-memory mock of the proposed private H3 authority
// adapter (docs/strict-human-command-protocol.md), so the page side (#120)
// and the console (#122) can be exercised end to end with codes derived by
// the real codec (lib/strict-human-command.mjs). It is NOT the adapter: no
// durability, isolation, key custody, enrollment or anti-rollback, and no
// per-session attempt cap (only the per-round cap). Strict stays disabled
// and nothing in lib/ or bin/ imports this.
//
// Attempt policy: Codex's candidate-no-recapture-reset-v1 (#124/#133).
// Failures and the key are kept across changed AND unchanged Recapture (V2
// never changes reviewRoundId on Recapture), and a locked round unlocks only
// with a new session. Reshape starts a new round with fresh counters.
// Journal identity is the real humanCommandIdentity (operation included), and
// every operation looks up its exact prior identity before any effect.

import { deriveHumanCode, humanCommandIdentity, parseHumanCommand } from "../../lib/strict-human-command.mjs";

export function createMockH3Authority({ projectId, sessionId, pair, key, maxAttempts = 5, clock = () => new Date(Date.UTC(2026, 10, 14)) }) {
  let round = 1, revision = 0, phase = "skeleton", selected = { ...pair }, approved = null, pending = null;
  let attempts = 0, locked = false, ended = false, dropNextReply = false, lastWireCode = null, codesOverride = null, endEffects = 0;
  const journal = new Map(); // requestId -> { identity, reply }
  const authorityState = () => ({
    protocolVersion: 2, projectId, sessionId, reviewRoundId: `round-${round}`, phase,
    reviewVersion: selected.reviewVersion, captureVersion: selected.captureVersion,
    approvedVersion: approved?.reviewVersion ?? null, approvedCaptureVersion: approved?.captureVersion ?? null, revision,
  });
  const at = () => clock().toISOString().replace(/\.\d{3}Z$/, "Z");
  const finish = (requestId, identity, body) => {
    const reply = Object.freeze({ requestId, ...body });
    journal.set(requestId, { identity, reply });
    if (dropNextReply) { dropNextReply = false; throw new Error("reply lost after commit"); }
    return reply;
  };
  const idOf = (operation, args) => humanCommandIdentity(operation, args).toString("hex");
  const lookup = (requestId, identity) => {
    const hit = journal.get(requestId);
    if (!hit) return null;
    return hit.identity === identity ? hit.reply : Object.freeze({ requestId, kind: "rejected", code: "request-reused" });
  };

  return {
    // --- the console-facing interface (docs/strict-control-console.md) ---
    async verifyAndCommit(args) {
      lastWireCode = args?.code;
      const cmd = parseHumanCommand("verifyAndCommit", args);
      if (!cmd) throw new Error("malformed command");
      const identity = idOf("verifyAndCommit", args);
      const prior = lookup(cmd.requestId, identity); // journal first
      if (prior) return prior;
      if (ended) return finish(cmd.requestId, identity, { kind: "rejected", code: "session-ended" });
      if (locked) return finish(cmd.requestId, identity, { kind: "locked", unlock: "new-session" });
      const allowed = (cmd.action === "approve" && phase === "skeleton") || (cmd.action === "reshape" && phase === "fill"
        && selected.reviewVersion === approved.reviewVersion && selected.captureVersion === approved.captureVersion);
      if (!allowed) return finish(cmd.requestId, identity, { kind: "rejected", code: "invalid-transition" });
      const before = authorityState();
      if (deriveHumanCode(before, cmd.action, key) !== cmd.code) {
        attempts += 1;
        if (attempts >= maxAttempts) locked = true;
        return finish(cmd.requestId, identity, { kind: "mismatch", revision, reviewVersion: selected.reviewVersion,
          captureVersion: selected.captureVersion, attemptsLeft: Math.max(0, maxAttempts - attempts) });
      }
      const oldPair = cmd.action === "approve" ? { ...selected } : { ...approved };
      revision += 1;
      if (cmd.action === "approve") { phase = "fill"; approved = { ...selected }; }
      else { // the host's reshape facts supply the next round's selected pair
        phase = "skeleton"; approved = null; round += 1; attempts = 0; locked = false;
        if (pending) { selected = { ...pending }; pending = null; }
      }
      return finish(cmd.requestId, identity, { kind: "committed", action: cmd.action, revision,
        reviewVersion: oldPair.reviewVersion, captureVersion: oldPair.captureVersion, at: at() });
    },
    async recapture(args) {
      const cmd = parseHumanCommand("recapture", args);
      if (!cmd) throw new Error("malformed command");
      const identity = idOf("recapture", args);
      const prior = lookup(cmd.requestId, identity);
      if (prior) return prior;
      if (ended) return finish(cmd.requestId, identity, { kind: "rejected", code: "session-ended" });
      if (phase !== "skeleton") return finish(cmd.requestId, identity, { kind: "refused", reason: "fill-phase" });
      const next = pending ?? selected;
      const changed = next.reviewVersion !== selected.reviewVersion || next.captureVersion !== selected.captureVersion;
      if (changed) { selected = { ...next }; revision += 1; }
      pending = null; // attempts, lock and key are kept (candidate-no-recapture-reset-v1)
      return finish(cmd.requestId, identity, { kind: "recaptured", changed, revision, ...selected });
    },
    async endSession(args) {
      const cmd = parseHumanCommand("endSession", args);
      if (!cmd) throw new Error("malformed command");
      const identity = idOf("endSession", args);
      const prior = lookup(cmd.requestId, identity); // journal first: a reused id never replaces its entry
      if (prior) return prior;
      ended = true; endEffects += 1;
      return finish(cmd.requestId, identity, { kind: "ended" });
    },
    async state() { return { phase, revision, reviewVersion: selected.reviewVersion, captureVersion: selected.captureVersion }; },

    // --- issuance for the protected page, and test hooks ---
    authorityState,
    /** Codes for the current state, bound to it, as the listener provider serves them. */
    issueCodes() {
      if (codesOverride) return codesOverride(authorityState());
      const s = authorityState();
      if (phase === "skeleton") return { approve: { code: deriveHumanCode(s, "approve", key), revision, ...selected } };
      if (phase === "fill" && selected.reviewVersion === approved.reviewVersion && selected.captureVersion === approved.captureVersion)
        return { reshape: { code: deriveHumanCode(s, "reshape", key), revision, ...approved } };
      return {};
    },
    /** The next recapture will select this pair (stands in for a fresh host capture). */
    stageCapture(next) { pending = { ...next }; },
    /** Fill-phase stand-in for a filled-body capture: the selected pair moves away from the approved one. */
    selectInFill(next) { if (phase !== "fill") throw new Error("not in fill"); selected = { ...next }; },
    /** Make issuance return arbitrary (possibly mis-bound) codes, to test the listener/page checks. */
    overrideCodes(fn) { codesOverride = fn; },
    lastWireCode: () => lastWireCode,
    /** How many times endSession actually executed (an exact retry must not execute again). */
    endEffects: () => endEffects,
    loseNextReply() { dropNextReply = true; },
  };
}
