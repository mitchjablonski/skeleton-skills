// Contract validation only. No I/O, credentials, authentication, state writes,
// listener, or production integration. Valid JSON is never transition authority.

export const STRICT_PROTOCOL_VERSION = 1;
export const STRICT_ACTIONS = Object.freeze(["approve", "reshape", "finalize"]);
export const STRICT_REJECTIONS = Object.freeze([
  "stale-review", "revision-conflict", "invalid-transition",
  "unauthorized-channel", "session-ended", "unavailable", "request-reused",
]);

// Read data properties only: validation must not invoke untrusted accessors.
function record(value, fields) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(k => !fields.includes(k))) return null;
    const out = Object.create(null);
    for (const key of fields) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable) return null;
      out[key] = d.value;
    }
    return out;
  } catch { return null; }
}

// Opaque identifiers, never paths, URLs, shell commands or secrets. The authority
// assigns canonical project/session IDs; the browser must not invent them.
const id = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const revision = v => Number.isSafeInteger(v) && v >= 0;
const binding = v => id(v.projectId) && id(v.sessionId) && id(v.reviewRoundId);
const copy = v => Object.freeze({ ...v });

/** Return a frozen validated copy, or null. This does not authenticate its source. */
export function parseStrictIntent(value) {
  const v = record(value, ["protocolVersion", "requestId", "action", "projectId",
    "sessionId", "reviewRoundId", "reviewVersion", "expectedRevision"]);
  return v && v.protocolVersion === 1 && id(v.requestId) && STRICT_ACTIONS.includes(v.action)
    && binding(v) && id(v.reviewVersion) && revision(v.expectedRevision)
    ? copy(v) : null;
}

/** Public non-capability state. Read it from the human authority for decisions. */
export function parseAuthorityState(value) {
  const v = record(value, ["projectId", "sessionId", "reviewRoundId", "phase",
    "reviewVersion", "approvedVersion", "revision"]);
  if (!v || !binding(v) || !id(v.reviewVersion) || !revision(v.revision)) return null;
  if (v.phase === "skeleton") {
    if (v.approvedVersion !== null) return null;
  } else if (v.phase === "fill" || v.phase === "finalized") {
    if (!id(v.approvedVersion)) return null;
  } else return null;
  return copy(v);
}

/** Committed replies echo the actual committed intent, not browser expectations. */
export function parseStrictResult(value) {
  // Probe kind without invoking an accessor, then validate the entire envelope.
  let kind;
  try { kind = Object.getOwnPropertyDescriptor(value, "kind")?.value; } catch { return null; }
  if (kind === "committed") {
    const v = record(value, ["kind", "requestId", "action", "reviewVersion", "revision"]);
    return v && v.kind === "committed" && id(v.requestId) && STRICT_ACTIONS.includes(v.action) && id(v.reviewVersion)
      && revision(v.revision) && v.revision > 0 ? copy(v) : null;
  }
  if (kind === "rejected") {
    // Transport failures may not know a request ID. Unknown outcomes remain
    // unavailable, not proof the writer did nothing. Retry uses the same ID.
    const v = record(value, ["kind", "code", "requestId"])
      ?? record(value, ["kind", "code"]);
    return v && v.kind === "rejected" && STRICT_REJECTIONS.includes(v.code)
      && (!Object.hasOwn(v, "requestId") || id(v.requestId)) ? copy(v) : null;
  }
  return null;
}

/** Stable deduplication key material; writer must store this with the result. */
export function strictIntentIdentity(value) {
  const v = parseStrictIntent(value);
  if (!v) return null;
  return JSON.stringify([v.protocolVersion, v.requestId, v.action, v.projectId,
    v.sessionId, v.reviewRoundId, v.reviewVersion, v.expectedRevision]);
}

/** Pure preconditions, NOT authorization. Call only after private-channel auth.
 * The writer must also verify content and atomically compare/commit revision.
 */
export function strictIntentConflict(state, intent) {
  const s = parseAuthorityState(state), i = parseStrictIntent(intent);
  if (!s || !i) return "invalid-transition";
  if (s.projectId !== i.projectId || s.sessionId !== i.sessionId) return "unauthorized-channel";
  if (s.reviewRoundId !== i.reviewRoundId) return "stale-review";
  if (s.revision !== i.expectedRevision) return "revision-conflict";
  if (s.revision === Number.MAX_SAFE_INTEGER) return "invalid-transition";
  const version = i.action === "approve" ? s.reviewVersion : s.approvedVersion;
  if (version !== i.reviewVersion) return "stale-review";
  if (i.action === "approve" ? s.phase !== "skeleton" : s.phase !== "fill") return "invalid-transition";
  return null;
}
