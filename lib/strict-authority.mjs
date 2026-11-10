// Pure transaction planning, NOT authentication or persistence. Only a trusted
// outside host may supply records/facts after authenticating its human channel.
// That host must atomically persist the entire returned record before replying,
// serialize concurrent transactions, and verify content/completion independently.
import { parseAuthorityState, parseStrictIntent, parseStrictResult,
  strictIntentConflict, strictIntentIdentity } from "./strict-protocol.mjs";

// No pruning: exhausting this bounded groundwork requires explicit recovery.
// Future compaction must preserve every request-ID/intent/result mapping.
export const MAX_AUTHORITY_JOURNAL_ENTRIES = 1024;

const fields = (value, names) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(k => !names.includes(k))) return null;
  const out = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !("value" in d)) return null;
    out[key] = d.value;
  }
  return out;
};
const id = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const freeze = Object.freeze;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function facts(value) {
  const f = fields(value, ["contentVersion", "nextReviewRoundId", "completionVerified"]);
  return f && id(f.contentVersion) && (f.nextReviewRoundId === null || id(f.nextReviewRoundId))
    && typeof f.completionVerified === "boolean" ? freeze(f) : null;
}
const rejected = (code, intent) => freeze({ kind: "rejected", code,
  ...(intent ? { requestId: intent.requestId } : {}) });

// Deterministic replay uses recorded host facts; their authenticity is outside
// this module. Rejected terminal decisions leave the authority revision intact.
function decide(state, intent, host, usedRounds) {
  let code = strictIntentConflict(state, intent);
  if (!code && intent.action !== "reshape" && host.contentVersion !== intent.reviewVersion) code = "stale-review";
  if (!code && intent.action === "reshape" && (!host.nextReviewRoundId || usedRounds.has(host.nextReviewRoundId))) code = "invalid-transition";
  if (!code && intent.action === "finalize" && host.completionVerified !== true) code = "invalid-transition";
  if (code) return { state, result: rejected(code, intent) };
  const next = freeze({ ...state, revision: state.revision + 1,
    ...(intent.action === "approve" ? { phase: "fill", approvedVersion: intent.reviewVersion }
      : intent.action === "reshape" ? { phase: "skeleton", approvedVersion: null,
        reviewRoundId: host.nextReviewRoundId, reviewVersion: host.contentVersion }
        : { phase: "finalized" }) });
  return { state: next, result: freeze({ kind: "committed", requestId: intent.requestId,
    action: intent.action, reviewVersion: intent.reviewVersion, revision: next.revision }) };
}

/** Bootstrap only: importing/migrating an existing authority is unsupported. */
export function createAuthorityRecord(value) {
  const state = parseAuthorityState(value);
  return state && state.phase === "skeleton" && state.revision === 0
    ? freeze({ protocolVersion: 1, initialState: state, state, journal: freeze([]) }) : null;
}

/** Validate complete ordered history, returning an immutable canonical copy.
 * This checks consistency, never origin, integrity, or human authorization.
 */
export function parseAuthorityRecord(value) {
  try {
    const v = fields(value, ["protocolVersion", "initialState", "state", "journal"]);
    if (!v || v.protocolVersion !== 1 || !Array.isArray(v.journal)) return null;
    const length = Object.getOwnPropertyDescriptor(v.journal, "length")?.value;
    if (!Number.isInteger(length) || length < 0 || length > MAX_AUTHORITY_JOURNAL_ENTRIES) return null;
    let record = createAuthorityRecord(v.initialState);
    const final = parseAuthorityState(v.state);
    if (!record || !final) return null;
    // Reject holes, extra/symbol properties and accessors in the journal array.
    const keys = Reflect.ownKeys(v.journal);
    if (keys.length !== length + 1) return null;
    const seen = new Set(), rounds = new Set([record.state.reviewRoundId]), journal = [];
    for (let index = 0; index < length; index++) {
      const d = Object.getOwnPropertyDescriptor(v.journal, String(index));
      if (!d || !("value" in d) || !d.enumerable) return null;
      const entry = fields(d.value, ["intent", "facts", "result", "stateAfter"]);
      if (!entry) return null;
      const intent = parseStrictIntent(entry.intent), host = facts(entry.facts);
      const result = parseStrictResult(entry.result), after = parseAuthorityState(entry.stateAfter);
      if (!intent || !host || !result || !after || seen.has(intent.requestId)) return null;
      const decision = decide(record.state, intent, host, rounds);
      if (decision.result.code === "unauthorized-channel") return null;
      if (!same(decision.result, result) || !same(decision.state, after)) return null;
      seen.add(intent.requestId); rounds.add(after.reviewRoundId);
      journal.push(freeze({ intent, facts: host, result, stateAfter: after }));
      record = { ...record, state: after };
    }
    if (!same(record.state, final)) return null;
    return freeze({ protocolVersion: 1, initialState: record.initialState, state: final, journal: freeze(journal) });
  } catch { return null; }
}

/** Plan one authenticated request; never writes or authenticates anything.
 * Host facts: contentVersion is the independently computed review/shape version;
 * reshape supplies a fresh nextReviewRoundId and its new review version.
 * completionVerified=true attests that the host checked completed steps AND
 * exterior drift for the approved version. A caller-supplied boolean is no proof.
 * `persist` means the host must commit the returned whole record before reply.
 * Exact retries precede current revision/fact checks, even after restart.
 * Invalid record/intent/host facts do not reserve a request ID.
 */
export function planAuthorityTransaction(value, request, trustedFacts) {
  const record = parseAuthorityRecord(value), intent = parseStrictIntent(request);
  const response = (next, result, persist = false, replayed = false) => freeze({ record: next, result, persist, replayed });
  if (!record) return response(null, rejected("unavailable"));
  if (!intent) return response(record, rejected("invalid-transition"));
  if (record.state.projectId !== intent.projectId || record.state.sessionId !== intent.sessionId)
    return response(record, rejected("unauthorized-channel", intent));
  const prior = record.journal.find(e => e.intent.requestId === intent.requestId);
  if (prior) return strictIntentIdentity(prior.intent) === strictIntentIdentity(intent)
    ? response(record, prior.result, false, true)
    : response(record, rejected("request-reused", intent));
  if (record.journal.length >= MAX_AUTHORITY_JOURNAL_ENTRIES)
    return response(record, rejected("unavailable", intent));
  let host;
  try { host = facts(trustedFacts); } catch {}
  if (!host) return response(record, rejected("unavailable", intent));
  const rounds = new Set([record.initialState.reviewRoundId, ...record.journal.map(e => e.stateAfter.reviewRoundId)]);
  const decision = decide(record.state, intent, host, rounds);
  const entry = freeze({ intent, facts: host, result: decision.result, stateAfter: decision.state });
  return response(freeze({ ...record, state: decision.state, journal: freeze([...record.journal, entry]) }), decision.result, true);
}
