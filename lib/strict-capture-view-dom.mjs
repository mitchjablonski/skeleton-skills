// #77: browser-safe half of the persisted strict capture view.
//
// MOCK ONLY, wired into nothing: no production module imports this, and no
// route, page, server or listener serves it. It does no network, storage,
// timer or event-listener work.
//
// This module must stay loadable by a browser as a plain ES module: no `node:`
// imports, no Buffer, process or require, and only browser-safe relative
// imports (./review-decision.mjs -> ./strict-protocol.mjs). The test suite
// checks that import graph.
//
// The split (docs/strict-capture-view.md):
//   - HOST (lib/strict-capture-view-model.mjs, Node): rebuilds the persisted
//     capture with validateStoredCapture, checks it against the registered V2
//     binding, and emits a plain JSON view model.
//   - BROWSER (this file): structurally re-checks that view model and renders
//     it as text-only DOM. It cannot recompute SHA-256 synchronously and does
//     not try: the digests it shows are the host's. Its checks are defence in
//     depth against a malformed or truncated model, NOT an authenticity check.
//     Authenticity comes from the protected origin that served the model.
//
// It renders every path, fence title and source line through createTextNode.
// Never innerHTML, Markdown, mermaid, URLs or code execution. No buttons,
// links, forms or listeners: this view offers no actions.

import { skelShownProtocol } from "./review-decision.mjs";

export const STRICT_CAPTURE_VIEW_MODEL_SCHEMA = "skel-strict-capture-view/1";

export class StrictCaptureViewError extends Error {
  constructor(code) {
    const text = {
      VIEW_DOM: "document/container unusable",
      VIEW_BINDING: "binding malformed or unsupported",
      VIEW_CAPTURE: "persisted capture failed canonical validation",
      VIEW_PAIR: "capture does not match the bound shape/raw capture pair",
      VIEW_MODEL: "view model malformed or over its limits",
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
const count = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;

export const STRICT_CAPTURE_BINDING_KEYS = freeze(["protocolVersion", "projectId", "sessionId", "reviewRoundId", "phase",
  "reviewVersion", "captureVersion", "approvedVersion", "approvedCaptureVersion", "pendingNotes"]);
const PAGE_PHASES = freeze(["scaffold", "fill", "done"]); // review-decision.mjs page phase names
const SHOWN_KEYS = freeze(["phase", "reviewVersion", "approvedVersion", "pendingNotes", "protocolVersion",
  "captureVersion", "approvedCaptureVersion"]);
const MODEL_KEYS = freeze(["schema", "binding", "shown", "totalBytes", "files"]);
const FILE_KEYS = freeze(["path", "mode", "unixMode", "byteLength", "rawSha256", "fences", "display"]);
const FENCE_KEYS = freeze(["id", "title", "openLine", "closeLine"]);
const LINE_KEYS = freeze(["line", "text", "ending", "kind"]);

// Same ceilings as STRICT_CAPTURE_LIMITS (lib/strict-capture.mjs, which this
// module cannot import). A caller may only lower them.
export const STRICT_CAPTURE_VIEW_LIMITS = freeze({ maxFileLines: 32768, maxTotalLines: 131072, maxFiles: 256,
  maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 });

const ENDINGS = freeze({ "\n": "LF", "\r\n": "CRLF", "\r": "CR", "\v": "VT", "\f": "FF",
  "\u0085": "NEL", " ": "LS", " ": "PS", "": "EOF (no line ending)" });
const FENCED_ENDINGS = freeze(["\n", "\r\n", ""]); // fenced files split on CRLF/LF only
const KINDS = freeze(["exterior", "marker", "body"]);
// Characters a reader can't see or that can reorder text: shown escaped too.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;
const escapeInvisible = (s) => Array.from(s, (c) => c !== " " && INVISIBLE.test(c)
  ? `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}` : c).join("");

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

/** Dense array of own data elements, no extra properties, length <= max; or null. */
function list(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  if (value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return null;
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !("value" in d)) return null;
    out.push(d.value);
  }
  return out;
}

/**
 * Validated frozen copy of a registered V2 binding, or null. Exact keys only;
 * token/secret/"authenticated" fields refuse. This is data, not authentication.
 */
export function parseStrictCaptureBinding(value) {
  let b;
  try { b = plain(value, STRICT_CAPTURE_BINDING_KEYS); } catch { return null; }
  if (!b || b.protocolVersion !== 2 || !ident(b.projectId) || !ident(b.sessionId) || !ident(b.reviewRoundId)) return null;
  if (!PAGE_PHASES.includes(b.phase) || !digest(b.reviewVersion) || !digest(b.captureVersion) || typeof b.pendingNotes !== "boolean") return null;
  if (b.phase === "scaffold") {
    if (b.approvedVersion !== null || b.approvedCaptureVersion !== null) return null;
  } else if (!digest(b.approvedVersion) || !digest(b.approvedCaptureVersion)) return null;
  return freeze(b);
}

/** The adapter's frozen V2 shown context for a binding. Host and browser both use this. */
export function strictShownFor(binding) {
  return freeze({
    phase: binding.phase, reviewVersion: binding.reviewVersion, approvedVersion: binding.approvedVersion,
    pendingNotes: binding.pendingNotes, protocolVersion: 2, captureVersion: binding.captureVersion,
    approvedCaptureVersion: binding.approvedCaptureVersion,
  });
}

function viewLimits(value) {
  if (value === undefined) return STRICT_CAPTURE_VIEW_LIMITS;
  let given = null;
  try { given = value && typeof value === "object" ? plain(value, Object.keys(value)) : null; } catch {}
  if (!given || Object.keys(given).some((k) => !Object.hasOwn(STRICT_CAPTURE_VIEW_LIMITS, k))) return null;
  const out = { ...STRICT_CAPTURE_VIEW_LIMITS, ...given };
  for (const k of Object.keys(out)) if (!Number.isSafeInteger(out[k]) || out[k] < 1 || out[k] > STRICT_CAPTURE_VIEW_LIMITS[k]) return null;
  return out;
}

function parseFile(value, lim, budget) {
  const f = plain(value, FILE_KEYS);
  if (!f || typeof f.path !== "string" || f.path.length < 1 || f.path.length > 4096 || f.path.includes("\0")) return null;
  if (f.mode !== "whole" && f.mode !== "fenced") return null;
  if (!count(f.unixMode, 0o7777) || !count(f.byteLength, lim.maxFileBytes) || !digest(f.rawSha256)) return null;
  const rawLines = list(f.display, lim.maxFileLines);
  const rawFences = list(f.fences, lim.maxFileLines);
  if (!rawLines || rawLines.length < 1 || !rawFences) return null;
  budget.lines += rawLines.length;
  if (budget.lines > lim.maxTotalLines) return null;
  const display = [];
  let chars = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const l = plain(rawLines[i], LINE_KEYS);
    if (!l || l.line !== i + 1 || typeof l.text !== "string" || typeof l.ending !== "string" || !KINDS.includes(l.kind)) return null;
    if (!(l.ending in ENDINGS) || (f.mode === "fenced" && !FENCED_ENDINGS.includes(l.ending))) return null;
    if ((l.ending === "") !== (i === rawLines.length - 1)) return null; // only the last line lacks an ending
    chars += l.text.length + l.ending.length;
    if (chars > f.byteLength) return null; // UTF-16 code units never exceed UTF-8 bytes
    display.push(freeze(l));
  }
  const fences = [];
  let after = 0;
  for (const raw of rawFences) {
    const x = plain(raw, FENCE_KEYS);
    if (!x || typeof x.id !== "string" || x.id.length < 1 || x.id.length > 256 || typeof x.title !== "string" || x.title.length > 4096) return null;
    if (!Number.isSafeInteger(x.openLine) || !Number.isSafeInteger(x.closeLine)) return null;
    if (x.openLine <= after || x.closeLine <= x.openLine || x.closeLine > display.length) return null;
    after = x.closeLine;
    fences.push(freeze(x));
  }
  // Line kinds must agree with the fences: markers at fence bounds, bodies
  // strictly inside, exterior everywhere else. A whole file has no fences.
  if (f.mode === "whole" ? fences.length !== 0 : fences.length < 1) return null;
  const expect = display.map(() => "exterior");
  for (const x of fences) {
    expect[x.openLine - 1] = "marker"; expect[x.closeLine - 1] = "marker";
    for (let n = x.openLine; n < x.closeLine - 1; n++) expect[n] = "body";
  }
  if (display.some((l, i) => l.kind !== expect[i])) return null;
  return freeze({ path: f.path, mode: f.mode, unixMode: f.unixMode, byteLength: f.byteLength, rawSha256: f.rawSha256,
    fences: freeze(fences), display: freeze(display) });
}

/**
 * Structurally validate a view model (e.g. JSON.parse of the host's response)
 * and return a frozen copy. Throws StrictCaptureViewError: VIEW_BINDING for the
 * binding, VIEW_MODEL for anything else. Not an authenticity check: digests
 * are carried, not recomputed.
 */
export function parseStrictCaptureViewModel(value, limits) {
  const lim = viewLimits(limits);
  if (!lim) throw new StrictCaptureViewError("VIEW_MODEL");
  let m, shown, rawFiles;
  try { m = plain(value, MODEL_KEYS); } catch { m = null; }
  if (!m || m.schema !== STRICT_CAPTURE_VIEW_MODEL_SCHEMA) throw new StrictCaptureViewError("VIEW_MODEL");
  const binding = parseStrictCaptureBinding(m.binding);
  if (!binding) throw new StrictCaptureViewError("VIEW_BINDING");
  try { shown = plain(m.shown, SHOWN_KEYS); rawFiles = list(m.files, lim.maxFiles); } catch { shown = rawFiles = null; }
  const expected = strictShownFor(binding);
  if (!shown || SHOWN_KEYS.some((k) => shown[k] !== expected[k]) || skelShownProtocol(expected) !== 2) throw new StrictCaptureViewError("VIEW_MODEL");
  if (!rawFiles || rawFiles.length < 1 || !count(m.totalBytes, lim.maxTotalBytes)) throw new StrictCaptureViewError("VIEW_MODEL");
  const budget = { lines: 0 };
  const files = [];
  let bytes = 0, prev = null;
  try {
    for (const raw of rawFiles) {
      const f = parseFile(raw, lim, budget);
      // Canonical order: strictly increasing by code unit, so no duplicates.
      if (!f || (prev !== null && !(prev < f.path))) throw new StrictCaptureViewError("VIEW_MODEL");
      prev = f.path; bytes += f.byteLength; files.push(f);
    }
  } catch { throw new StrictCaptureViewError("VIEW_MODEL"); }
  if (bytes !== m.totalBytes) throw new StrictCaptureViewError("VIEW_MODEL");
  return freeze({ schema: m.schema, binding, shown: expected, totalBytes: m.totalBytes, files: freeze(files) });
}

// Per container: the token of its latest successful render, or absent.
const CURRENT = new WeakMap();

/** True when `doc`/`container` have the few DOM methods the view uses. */
export function strictCaptureDomUsable(doc, container) {
  try {
    return !!doc && typeof doc.createElement === "function" && typeof doc.createTextNode === "function"
      && !!container && typeof container === "object" && typeof container.replaceChildren === "function";
  } catch { return false; }
}

/** Make the container's earlier render stop being current, and empty it. */
export function clearStrictCaptureView(container) {
  try { CURRENT.delete(container); } catch {}
  try { container.replaceChildren(); } catch {}
}

function buildView(doc, model) {
  const { binding, files: modelFiles } = model;
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
    ["Shape version (bound and recomputed by the host)", binding.reviewVersion],
    ["Raw capture version (bound and recomputed by the host)", binding.captureVersion],
    ["Approved shape version", binding.approvedVersion ?? "none"],
    ["Approved raw capture version", binding.approvedCaptureVersion ?? "none"],
    ["Files", String(modelFiles.length)], ["Total bytes", String(model.totalBytes)],
  ]);
  identity.setAttribute("data-capture-identity", "");

  const coverage = el("ol", "coverage", ...modelFiles.map((f) => el("li", null,
    el("span", "path", f.path), " ", el("span", "mode", `[${f.mode}]`))));
  coverage.setAttribute("data-capture-coverage", "");

  const files = modelFiles.map((f, index) => {
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
        el("span", "line-ending", ENDINGS[l.ending]));
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
    el("p", "notice", "This is a stored snapshot the host validated against its own digests, not a live view of the workspace. "
      + "It does not prove the files were read atomically, does not authenticate anyone and offers no actions."),
    identity, el("h3", null, "Coverage"), coverage, ...files);
  view.setAttribute("data-strict-capture", "");
  return view;
}

/**
 * Render one view model into `container`, replacing what was there.
 *   doc:       a Document (createElement/createTextNode).
 *   container: an Element with replaceChildren.
 *   model:     the host's view model, e.g. JSON.parse of its response.
 *   limits:    optional lower STRICT_CAPTURE_VIEW_LIMITS.
 * Returns a frozen { shown, binding, isCurrent() }. Throws
 * StrictCaptureViewError and leaves the container EMPTY on refusal.
 */
export function renderStrictCaptureViewModel({ doc, container, model, limits } = {}) {
  try { CURRENT.delete(container); } catch {} // any earlier shown context stops being current now
  const refuse = (code) => {
    clearStrictCaptureView(container);
    throw new StrictCaptureViewError(code);
  };
  if (!strictCaptureDomUsable(doc, container)) refuse("VIEW_DOM");
  let parsed;
  try { parsed = parseStrictCaptureViewModel(model, limits); } catch (e) { refuse(e?.code === "VIEW_BINDING" ? "VIEW_BINDING" : "VIEW_MODEL"); }
  let view;
  try { view = buildView(doc, parsed); } catch { refuse("VIEW_RENDER"); }
  try { container.replaceChildren(view); } catch { refuse("VIEW_RENDER"); }
  const token = {};
  const { shown, binding } = parsed;
  CURRENT.set(container, { token, shown });
  return freeze({ shown, binding, isCurrent: () => CURRENT.get(container)?.token === token });
}

/** The shown context of the container's latest successful render, or null. */
export function currentStrictCaptureShown(container) {
  try { return CURRENT.get(container)?.shown ?? null; } catch { return null; }
}
