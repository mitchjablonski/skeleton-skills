// TEST FIXTURE ONLY: an in-memory mock of the proposed private H3 authority
// adapter (docs/strict-human-command-protocol.md), so the page side (#120)
// and the console (#122) can be exercised end to end with codes derived by
// the real codec (lib/strict-human-command.mjs). It is NOT the adapter: no
// durability, isolation, key custody, enrollment or anti-rollback. Strict
// stays disabled and nothing in lib/ or bin/ imports this.

import { deriveHumanCode, parseHumanCommand } from "../../lib/strict-human-command.mjs";

export function createMockH3Authority({ projectId, sessionId, pair, key, maxAttempts = 5, clock = () => new Date(Date.UTC(2026, 10, 14)) }) {
  let round = 1, revision = 0, phase = "skeleton", selected = { ...pair }, approved = null, pending = null;
  let attempts = 0, locked = false, ended = false, dropNextReply = false;
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
  const lookup = (requestId, identity) => {
    const hit = journal.get(requestId);
    if (!hit) return null;
    return hit.identity === identity ? hit.reply : Object.freeze({ requestId, kind: "rejected", code: "request-reused" });
  };

  return {
    // --- the console-facing interface (docs/strict-control-console.md) ---
    async verifyAndCommit(args) {
      const cmd = parseHumanCommand("verifyAndCommit", args);
      if (!cmd) throw new Error("malformed command");
      const identity = `${cmd.action}|${cmd.code}`;
      const prior = lookup(cmd.requestId, identity); // journal first
      if (prior) return prior;
      if (ended) return finish(cmd.requestId, identity, { kind: "rejected", code: "session-ended" });
      if (locked) return finish(cmd.requestId, identity, { kind: "locked", unlock: phase === "skeleton" ? "recapture" : "new-session" });
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
      else { phase = "skeleton"; approved = null; round += 1; attempts = 0; locked = false; }
      return finish(cmd.requestId, identity, { kind: "committed", action: cmd.action, revision,
        reviewVersion: oldPair.reviewVersion, captureVersion: oldPair.captureVersion, at: at() });
    },
    async recapture(args) {
      const cmd = parseHumanCommand("recapture", args);
      if (!cmd) throw new Error("malformed command");
      const prior = lookup(cmd.requestId, "recapture");
      if (prior) return prior;
      if (phase !== "skeleton") return finish(cmd.requestId, "recapture", { kind: "refused", reason: "fill-phase" });
      const next = pending ?? selected;
      const changed = next.reviewVersion !== selected.reviewVersion || next.captureVersion !== selected.captureVersion;
      if (changed) { selected = { ...next }; revision += 1; }
      pending = null; attempts = 0; locked = false;
      return finish(cmd.requestId, "recapture", { kind: "recaptured", changed, revision, ...selected });
    },
    async endSession(args) {
      const cmd = parseHumanCommand("endSession", args);
      if (!cmd) throw new Error("malformed command");
      ended = true;
      return finish(cmd.requestId, "end", { kind: "ended" });
    },
    async state() { return { phase, revision, reviewVersion: selected.reviewVersion, captureVersion: selected.captureVersion }; },

    // --- issuance for the protected page, and test hooks ---
    authorityState,
    /** Codes for the current state, bound to it, as the listener provider serves them. */
    issueCodes() {
      const s = authorityState();
      if (phase === "skeleton") return { approve: { code: deriveHumanCode(s, "approve", key), revision, ...selected } };
      if (phase === "fill" && selected.reviewVersion === approved.reviewVersion && selected.captureVersion === approved.captureVersion)
        return { reshape: { code: deriveHumanCode(s, "reshape", key), revision, ...approved } };
      return {};
    },
    /** The next recapture will select this pair (stands in for a fresh host capture). */
    stageCapture(next) { pending = { ...next }; },
    loseNextReply() { dropNextReply = true; },
  };
}
