// #77: host half of the persisted strict capture view (Node only).
//
// MOCK ONLY, wired into nothing: no production module imports this. It does
// no network, filesystem, timer or listener work itself.
//
// It rebuilds ONE persisted capture with validateStoredCapture, checks the
// recomputed shape/raw pair against the protected host's registered V2
// binding, and returns a plain, frozen, JSON-serializable view model for the
// browser-safe renderer (lib/strict-capture-view-dom.mjs). Only fields the
// view shows are copied: raw `text` and `exterior` stay on the host.
//
// The eventual protected outside listener must source the binding from its own
// registered V2 authority state, load the capture from the immutable store by
// the bound captureVersion, and send the model as an application/json response
// on its protected origin (never inlined into HTML). See
// docs/strict-capture-view.md. Nothing here authenticates anyone.

import { validateStoredCapture } from "./strict-capture.mjs";
import { skelShownProtocol } from "./review-decision.mjs";
import {
  STRICT_CAPTURE_VIEW_MODEL_SCHEMA, StrictCaptureViewError, parseStrictCaptureBinding, strictShownFor,
} from "./strict-capture-view-dom.mjs";

const freeze = Object.freeze;

/**
 * Build the browser view model for one persisted capture.
 *   capture: the persisted capture object (lib/strict-capture-store.mjs).
 *   binding: the registered V2 binding (exact keys; see the DOM module).
 *   limits:  optional lower STRICT_CAPTURE_LIMITS for validation.
 * Returns a deeply frozen plain object { schema, binding, shown, totalBytes,
 * files }. Throws StrictCaptureViewError VIEW_BINDING, VIEW_CAPTURE or
 * VIEW_PAIR, in that order.
 */
export function buildStrictCaptureViewModel({ capture, binding, limits } = {}) {
  const bound = parseStrictCaptureBinding(binding);
  if (!bound) throw new StrictCaptureViewError("VIEW_BINDING");
  let cap;
  try { cap = validateStoredCapture(capture, limits === undefined ? {} : limits); } catch { throw new StrictCaptureViewError("VIEW_CAPTURE"); }
  if (cap.shapeVersion !== bound.reviewVersion || cap.captureVersion !== bound.captureVersion) throw new StrictCaptureViewError("VIEW_PAIR");
  const shown = strictShownFor(bound); // digests equal the validated capture's after the pair match
  if (skelShownProtocol(shown) !== 2) throw new StrictCaptureViewError("VIEW_BINDING");
  const files = cap.files.map((f) => freeze({
    path: f.path, mode: f.mode, unixMode: f.unixMode, byteLength: f.byteLength, rawSha256: f.rawSha256,
    fences: freeze(f.fences.map((x) => freeze({ id: x.id, title: x.title, openLine: x.openLine, closeLine: x.closeLine }))),
    display: freeze(f.display.map((l) => freeze({ line: l.line, text: l.text, ending: l.ending, kind: l.kind }))),
  }));
  return freeze({ schema: STRICT_CAPTURE_VIEW_MODEL_SCHEMA, binding: bound, shown, totalBytes: cap.totalBytes, files: freeze(files) });
}
