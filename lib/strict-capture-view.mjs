// #77: host-side convenience renderer for ONE validated persisted strict
// capture: buildStrictCaptureViewModel (host, Node) followed by
// renderStrictCaptureViewModel (browser-safe DOM). Same API and refusal
// behaviour as before the split.
//
// MOCK ONLY, wired into nothing: no production module imports this, and it
// performs no network, filesystem, timer or event-listener work. Browsers load
// lib/strict-capture-view-dom.mjs instead and receive the model as JSON from
// the protected host. See docs/strict-capture-view.md.
//
// VIEW_MODEL can only appear here if host and browser rules disagree (a bug).
//
// What it does NOT do: authenticate anyone (the binding is data, not a
// credential), prove the capture is the live workspace, prove the source
// snapshot was atomic, recapture, approve, or satisfy any of
// SKEL_DECISION_V2_ABSENT_GATES.

import { buildStrictCaptureViewModel } from "./strict-capture-view-model.mjs";
import {
  StrictCaptureViewError, clearStrictCaptureView, currentStrictCaptureShown, renderStrictCaptureViewModel,
  strictCaptureDomUsable,
} from "./strict-capture-view-dom.mjs";

export { StrictCaptureViewError, currentStrictCaptureShown };

/**
 * Render one persisted capture into `container`, replacing what was there.
 * Order of checks: VIEW_DOM, VIEW_BINDING, VIEW_CAPTURE, VIEW_PAIR, VIEW_RENDER.
 * Returns a frozen { shown, binding, isCurrent() }. Throws
 * StrictCaptureViewError and leaves the container EMPTY on refusal.
 */
export function renderStrictCaptureView({ doc, container, capture, binding, limits } = {}) {
  if (!strictCaptureDomUsable(doc, container)) {
    clearStrictCaptureView(container);
    throw new StrictCaptureViewError("VIEW_DOM");
  }
  clearStrictCaptureView(container); // the earlier shown context stops being current and leaves the screen now
  const model = buildStrictCaptureViewModel({ capture, binding, limits }); // throws; container already empty
  return renderStrictCaptureViewModel({ doc, container, model });
}
