// #77: decision codes on the protected page, PROTOTYPE for the H3 proposal in
// docs/strict-human-channel.md (not adopted). Browser-safe: imports nothing.
//
// The authority (#76, Sol) will derive codes from a private round key and
// verify them in one serialized step. This module never derives, verifies or
// stores codes. It only checks that codes the host sent are well formed and
// bound to exactly the capture this tab rendered, so the page never shows a
// code beside bytes it isn't showing. Codes are typed by the human into the
// launcher control window, which does not exist yet; no code is ever sent
// from the page.

const freeze = Object.freeze;

/** The control window's fixed banner, named on the page (proposal). */
export const CONTROL_BANNER = "SKELETON STRICT CONTROL";
// 8 Crockford base32 characters in two groups of four.
export const DECISION_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
// Actions a code may be offered for, by page phase. Finalize is out of v1.
export const CODE_ACTIONS_BY_PHASE = freeze({ scaffold: freeze(["approve"]), fill: freeze(["reshape"]), done: freeze([]) });
const ENTRY_KEYS = freeze(["code", "revision", "reviewVersion", "captureVersion"]);

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
 * Check host-sent codes against an already parsed view model (from
 * parseStrictCaptureViewModel). Returns a frozen { approve?, reshape? } where
 * each entry is { code, revision, reviewVersion, captureVersion }, or null.
 * Rules: only actions allowed in the page phase; approve binds the selected
 * pair and is never offered while the binding says notes are pending; reshape
 * binds the approved pair; every entry names the same revision.
 */
export function parseDecisionCodes(raw, model) {
  if (!model || !model.binding) return null;
  const b = model.binding;
  const allowed = CODE_ACTIONS_BY_PHASE[b.phase];
  if (!allowed) return null;
  let keys;
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    keys = Reflect.ownKeys(raw);
  } catch { return null; }
  if (keys.some((k) => !allowed.includes(k))) return null;
  const out = {};
  let revision = null;
  for (const action of keys) {
    const e = exact(Object.getOwnPropertyDescriptor(raw, action)?.value, ENTRY_KEYS);
    if (!e || typeof e.code !== "string" || !DECISION_CODE_RE.test(e.code)) return null;
    if (!Number.isSafeInteger(e.revision) || e.revision < 0) return null;
    if (revision !== null && e.revision !== revision) return null;
    revision = e.revision;
    const [rv, cv] = action === "approve" ? [b.reviewVersion, b.captureVersion] : [b.approvedVersion, b.approvedCaptureVersion];
    if (e.reviewVersion !== rv || e.captureVersion !== cv) return null;
    if (action === "approve" && b.pendingNotes) return null;
    out[action] = freeze(e);
  }
  return freeze(out);
}

/** The control-window command text for an entry, e.g. "approve K7M2-QX9D". */
export const commandFor = (action, entry) => `${action} ${entry.code}`;
/** The short binding shown beside a code. */
export const bindingLine = (entry) =>
  `shape ${entry.reviewVersion.slice(0, 12)}… · capture ${entry.captureVersion.slice(0, 12)}… · revision ${entry.revision}`;
