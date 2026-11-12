// #77: a pure, optional DOM renderer for ONE validated persisted strict capture.
//
// MOCK ONLY, wired into nothing: no production module imports this, and it
// performs no network, filesystem, timer or event-listener work. This is a
// Node-host DOM prototype: its validator imports Node built-ins, so browsers
// cannot load it directly. Browser delivery requires a separate reviewed split.
// The eventual protected outside listener must supply the binding
// from its own registered V2 state. See docs/strict-capture-view.md.
//
// What it does:
//   - Refuses unless the DOM handles, the binding and the capture are all
//     valid. The capture is rebuilt with validateStoredCapture BEFORE anything
//     is rendered, and its shape/raw digests must equal the binding's pair.
//   - Builds the whole view detached, then swaps it in with one
//     container.replaceChildren(view). On any refusal it clears the container
//     instead, so no stale capture or shown context stays visible or active.
//   - Renders every path, fence title and source line through createTextNode.
//     Never innerHTML, Markdown, mermaid, URLs or code execution. No buttons,
//     links, forms or listeners: this view offers no actions.
//   - Returns a frozen V2 `shown` context for lib/review-decision.mjs built
//     ONLY from the validated capture it rendered plus the binding's explicit
//     phase/approved/notes metadata. It never reads current authority state.
//
// What it does NOT do: authenticate anyone (the binding is data, not a
// credential), prove the capture is the live workspace, prove the source
// snapshot was atomic, recapture, approve, or satisfy any of
// SKEL_DECISION_V2_ABSENT_GATES.

import { validateStoredCapture } from "./strict-capture.mjs";
import { skelShownProtocol } from "./review-decision.mjs";

export class StrictCaptureViewError extends Error {
  constructor(code) {
    const text = {
      VIEW_DOM: "document/container unusable",
      VIEW_BINDING: "binding malformed or unsupported",
      VIEW_CAPTURE: "persisted capture failed canonical validation",
      VIEW_PAIR: "capture does not match the bound shape/raw capture pair",
      VIEW_RENDER: "rendering failed",
    }[code] ?? "";
    super(`${code} ${text}`);
    this.name = "StrictCaptureViewError";
    this.code = code;
  }
}

const freeze = Object.freeze;
const ident = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const BINDING_KEYS = freeze(["protocolVersion", "projectId", "sessionId", "reviewRoundId", "phase",
  "reviewVersion", "captureVersion", "approvedVersion", "approvedCaptureVersion", "pendingNotes"]);
const PAGE_PHASES = freeze(["scaffold", "fill", "done"]); // review-decision.mjs page phase names

/** Own enumerable data properties of a plain object with exactly `names`. */
function plain(value, names) {
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
}

/** Validated frozen copy of the registered V2 binding, or null. Not authentication. */
function parseBinding(value) {
  let b;
  try { b = plain(value, BINDING_KEYS); } catch { return null; }
  if (!b || b.protocolVersion !== 2 || !ident(b.projectId) || !ident(b.sessionId) || !ident(b.reviewRoundId)) return null;
  if (!PAGE_PHASES.includes(b.phase) || !digest(b.reviewVersion) || !digest(b.captureVersion) || typeof b.pendingNotes !== "boolean") return null;
  if (b.phase === "scaffold") {
    if (b.approvedVersion !== null || b.approvedCaptureVersion !== null) return null;
  } else if (!digest(b.approvedVersion) || !digest(b.approvedCaptureVersion)) return null;
  return freeze(b);
}

const ENDINGS = freeze({ "\n": "LF", "\r\n": "CRLF", "\r": "CR", "\v": "VT", "\f": "FF",
  "\u0085": "NEL", " ": "LS", " ": "PS", "": "EOF (no line ending)" });
// Characters a reader can't see or that can reorder text: shown escaped too.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;
const escapeInvisible = (s) => Array.from(s, (c) => c !== " " && INVISIBLE.test(c)
  ? `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}` : c).join("");

// Per container: the token of its latest successful render, or absent.
const CURRENT = new WeakMap();

function usableDom(doc, container) {
  try {
    return !!doc && typeof doc.createElement === "function" && typeof doc.createTextNode === "function"
      && !!container && typeof container === "object" && typeof container.replaceChildren === "function";
  } catch { return false; }
}

function buildView(doc, binding, cap) {
  const el = (tag, cls, ...kids) => {
    const e = doc.createElement(tag);
    if (cls) e.setAttribute("class", cls);
    for (const k of kids) e.append(typeof k === "string" ? doc.createTextNode(k) : k);
    return e;
  };
  const rows = (pairs) => el("dl", "rows", ...pairs.flatMap(([k, v]) => [el("dt", null, k), el("dd", null, v)]));

  const identity = rows([
    ["Protocol", "2 (exact capture)"],
    ["Project", binding.projectId], ["Session", binding.sessionId], ["Review round", binding.reviewRoundId],
    ["Phase", binding.phase],
    ["Shape version (bound and recomputed)", cap.shapeVersion],
    ["Raw capture version (bound and recomputed)", cap.captureVersion],
    ["Approved shape version", binding.approvedVersion ?? "none"],
    ["Approved raw capture version", binding.approvedCaptureVersion ?? "none"],
    ["Files", String(cap.files.length)], ["Total bytes", String(cap.totalBytes)],
  ]);
  identity.setAttribute("data-capture-identity", "");

  const coverage = el("ol", "coverage", ...cap.files.map((f) => el("li", null,
    el("span", "path", f.path), " ", el("span", "mode", `[${f.mode}]`))));
  coverage.setAttribute("data-capture-coverage", "");

  const files = cap.files.map((f, index) => {
    const meta = rows([
      ["Path", f.path], ["Mode", f.mode], ["Unix mode", f.unixMode.toString(8).padStart(4, "0")],
      ["Bytes", String(f.byteLength)], ["Raw SHA-256", f.rawSha256], ["Lines", String(f.display.length)],
    ]);
    const fences = f.fences.length
      ? el("ol", "fences", ...f.fences.map((x) => el("li", null,
        `Fence ${x.id} (lines ${x.openLine}–${x.closeLine}): `, el("span", "fence-title", x.title))))
      : el("p", "fences-none", f.mode === "whole" ? "Whole-file context: no editable fences." : "No fences.");
    fences.setAttribute("data-capture-fences", "");
    const lines = el("ol", "source", ...f.display.map((l) => {
      const li = el("li", `line ${l.kind}`,
        el("span", "line-number", String(l.line)), " ",
        el("span", "line-kind", l.kind), " ",
        el("code", "line-text", l.text), " ",
        el("span", "line-ending", ENDINGS[l.ending] ?? "UNKNOWN"));
      li.setAttribute("data-line", String(l.line));
      if (INVISIBLE.test(l.text.replaceAll(" ", ""))) {
        li.setAttribute("data-line-invisible", "");
        li.append(doc.createTextNode(" "), el("span", "line-escaped", `escaped: ${escapeInvisible(l.text)}`));
      }
      return li;
    }));
    lines.setAttribute("data-capture-source", "");
    const section = el("section", "capture-file", el("h3", null, el("span", "path", f.path)), meta, fences, lines);
    section.setAttribute("data-capture-file", String(index));
    return section;
  });

  const view = el("section", "panel strict-capture",
    el("h2", null, "Persisted strict capture (static snapshot)"),
    el("p", "notice", "This is a stored snapshot validated against its own digests, not a live view of the workspace. "
      + "It does not prove the files were read atomically, does not authenticate anyone and offers no actions."),
    identity, el("h3", null, "Coverage"), coverage, ...files);
  view.setAttribute("data-strict-capture", "");
  return view;
}

/**
 * Render one persisted capture into `container`, replacing what was there.
 *   doc:       a Document (createElement/createTextNode).
 *   container: an Element with replaceChildren.
 *   capture:   the persisted capture object (lib/strict-capture-store.mjs).
 *   binding:   the protected host's registered V2 binding, supplied
 *              independently of the capture: { protocolVersion: 2, projectId,
 *              sessionId, reviewRoundId, phase: scaffold|fill|done,
 *              reviewVersion, captureVersion, approvedVersion,
 *              approvedCaptureVersion, pendingNotes }. Exact keys only.
 *   limits:    optional lower STRICT_CAPTURE_LIMITS for validation.
 * Returns a frozen { shown, binding, isCurrent() }. Throws
 * StrictCaptureViewError and leaves the container EMPTY on refusal.
 */
export function renderStrictCaptureView({ doc, container, capture, binding, limits } = {}) {
  CURRENT.delete(container); // any earlier shown context stops being current now
  const refuse = (code) => {
    try { container.replaceChildren(); } catch {}
    throw new StrictCaptureViewError(code);
  };
  if (!usableDom(doc, container)) refuse("VIEW_DOM");
  const bound = parseBinding(binding);
  if (!bound) refuse("VIEW_BINDING");
  let cap;
  try { cap = validateStoredCapture(capture, limits === undefined ? {} : limits); } catch { refuse("VIEW_CAPTURE"); }
  if (cap.shapeVersion !== bound.reviewVersion || cap.captureVersion !== bound.captureVersion) refuse("VIEW_PAIR");
  const shown = freeze({
    phase: bound.phase, reviewVersion: cap.shapeVersion, approvedVersion: bound.approvedVersion,
    pendingNotes: bound.pendingNotes, protocolVersion: 2, captureVersion: cap.captureVersion,
    approvedCaptureVersion: bound.approvedCaptureVersion,
  });
  if (skelShownProtocol(shown) !== 2) refuse("VIEW_BINDING");
  let view;
  try { view = buildView(doc, bound, cap); } catch { refuse("VIEW_RENDER"); }
  try { container.replaceChildren(view); } catch { refuse("VIEW_RENDER"); }
  const token = {};
  CURRENT.set(container, { token, shown });
  return freeze({ shown, binding: bound, isCurrent: () => CURRENT.get(container)?.token === token });
}

/** The shown context of the container's latest successful render, or null. */
export function currentStrictCaptureShown(container) {
  try { return CURRENT.get(container)?.shown ?? null; } catch { return null; }
}
