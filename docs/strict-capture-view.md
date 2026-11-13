# Persisted strict capture view (#77)

The persisted strict capture view renders one validated persisted strict
capture as text-only DOM. It is mock groundwork: nothing in production imports
it, and no route, page, server or listener loads it. None of its modules does
network, filesystem, timer or event-listener work.

## Host/browser split

The canonical validator needs Node (`node:crypto`, Buffer), so the view is
split in two:

| Module | Runs in | Job |
| --- | --- | --- |
| `lib/strict-capture-view-model.mjs` | host (Node) | Rebuild the capture with `validateStoredCapture`, check the pair against the binding, emit a plain JSON **view model** |
| `lib/strict-capture-view-dom.mjs` | browser (plain ES module) | Structurally re-check the view model and render it |
| `lib/strict-capture-view.mjs` | host | Convenience: model then render, same API as before the split |

The browser module's whole import graph is `strict-capture-view-dom.mjs` ->
`review-decision.mjs` -> `strict-protocol.mjs`, with no `node:` imports,
Buffer, process or require. A unit test walks that graph.
`test/live/strict-capture-view-browser.mjs` loads it in real headless Chrome
under `script-src 'self'`, renders a model built from a real capture of a
hostile fixture, and checks that a tampered model refuses. That is a smoke
test against a throwaway loopback server. It is not the protected listener,
and it says nothing about origin checks, authentication or launcher
reachability.

**The browser checks structure, not authenticity.** It cannot recompute
SHA-256 synchronously and does not try, so the digests it shows are the host's.
It refuses models that are malformed, inconsistent or over the limits:

- wrong schema, or extra or missing keys at any level;
- a `shown` that is not exactly the one derived from the binding;
- file paths that are not strictly increasing;
- a `totalBytes` that doesn't match;
- line numbers out of sequence;
- line endings outside the file's mode (fenced files split on CRLF/LF only);
- an end-of-file marker anywhere but the last line;
- line kinds that disagree with the fences;
- a whole file with fences, or a fenced file without them;
- text longer than the file's byte length;
- getters or sparse arrays.

These checks are defence in depth. Authenticity comes only from the protected
origin that served the model.

### View model (`skel-strict-capture-view/1`)

```js
{ schema: "skel-strict-capture-view/1",
  binding,      // exact V2 binding (below)
  shown,        // exact adapter shown context derived from binding
  totalBytes,
  files: [{ path, mode, unixMode, byteLength, rawSha256,
            fences: [{ id, title, openLine, closeLine }],
            display: [{ line, text, ending, kind }] }] }
```

Raw `text` and `exterior` stay on the host. The host returns a deeply frozen,
JSON-stable object. The future listener must send it as an `application/json`
response on its protected origin, never inlined into HTML.

## API

```js
// host
buildStrictCaptureViewModel({ capture, binding, limits? }) -> model   // VIEW_BINDING | VIEW_CAPTURE | VIEW_PAIR
renderStrictCaptureView({ doc, container, capture, binding, limits? })
  -> frozen { shown, binding, isCurrent() }   // or throws StrictCaptureViewError
// browser
parseStrictCaptureViewModel(model, limits?) -> frozen model           // VIEW_BINDING | VIEW_MODEL
renderStrictCaptureViewModel({ doc, container, model, limits? })
  -> frozen { shown, binding, isCurrent() }   // VIEW_DOM | VIEW_BINDING | VIEW_MODEL | VIEW_RENDER
currentStrictCaptureShown(container) -> shown | null
```

All three modules share one `StrictCaptureViewError` class. Browser limits
(`STRICT_CAPTURE_VIEW_LIMITS`) use the same ceilings as
`STRICT_CAPTURE_LIMITS` and can only be lowered.

`binding` is the protected host's registered V2 binding, supplied
independently of the capture. It must have exactly these keys:
`protocolVersion: 2`, `projectId`, `sessionId`, `reviewRoundId` (opaque ids,
same rule as `lib/strict-protocol.mjs`), `phase` (the page phase names
`scaffold | fill | done`, as in `lib/review-decision.mjs`), `reviewVersion` and
`captureVersion` (the expected full 64-hex shape/raw pair), `approvedVersion`
and `approvedCaptureVersion` (both `null` in `scaffold`, both full digests in
`fill`/`done`), and `pendingNotes` (boolean). Extra keys refuse, including
token, secret or "authenticated" fields. Getters, inherited fields and
non-plain objects refuse too.

## Order of checks (atomic refusal)

For `renderStrictCaptureView` (host convenience):

1. The DOM handles must be usable (`VIEW_DOM`). The container's previous shown
   context stops being current, and the container is emptied at once (in the
   same synchronous call, so nothing is painted in between).
2. The binding is validated (`VIEW_BINDING`).
3. The capture is rebuilt with `validateStoredCapture` before any element is
   created (`VIEW_CAPTURE`). Tampered display lines, fence titles, line endings,
   digests, sizes or extra fields refuse. Validation limits can only be lowered.
4. The recomputed `shapeVersion`/`captureVersion` must equal the binding's pair
   exactly (`VIEW_PAIR`). A same-shape capture with different raw bytes refuses.
5. The view is built detached and then swapped in with one
   `container.replaceChildren(view)`. Any DOM failure is `VIEW_RENDER`.

`renderStrictCaptureViewModel` (browser) runs the same steps with step 2-4
replaced by `parseStrictCaptureViewModel` (`VIEW_BINDING`, then `VIEW_MODEL`).

On any refusal the container is emptied and nothing is current.
No stale capture stays visible, and no old shown context stays usable.

## Rendering

Every path, fence title and source line goes through `createTextNode`. The
renderer never uses `innerHTML`, never parses Markdown and never runs mermaid
or other code. Only fixed element tags and fixed or numeric attributes are used.
Paths are never put in attributes. There are no buttons, links, forms or
listeners: the view offers no actions.

The layout shows:

- **Identity rows:** protocol, project, session, round, phase, full shape and
  raw digests, the approved pair (or "none"), the file count and total bytes.
- **Coverage:** every path in canonical order with its `[whole]`/`[fenced]`
  mode.
- **Per file:** path, mode, octal unix mode, bytes, full raw SHA-256 and line
  count, then fences (id, line range, title) or a whole-file note.
- **Source lines:** line number, kind (`exterior`/`marker`/`body`), text, and
  an explicit ending label: `LF`, `CRLF`, `CR`, `VT`, `FF`, `NEL`, `LS`, `PS`,
  or `EOF (no line ending)`. Raw differences such as CRLF vs LF are visible. A
  line holding control, format, separator or non-ASCII space characters (for
  example bidi overrides or tabs) also gets an escaped `\u{…}` rendering.

## Shown context for the V2 decision adapter

`shown` is frozen and has exactly the adapter's schema: `{ phase,
reviewVersion, approvedVersion, pendingNotes, protocolVersion: 2,
captureVersion, approvedCaptureVersion }`. The digests come from the capture
that was validated and rendered, after the pair match. Phase, approved pair and
notes come only from the explicit binding. The renderer never reads current
authority state and never infers the raw capture from it.
`skelShownProtocol(shown)` must return 2, or the render refuses.

A later render into the same container, or a refusal, makes the earlier
handle's `isCurrent()` false, and `currentStrictCaptureShown` then returns the
new shown (or `null`). Integrators must pass only the current shown to the
decision controller (`setShown`) and drop it whenever it stops being current.

## Limitations

- **No authentication.** The binding is data, not a credential. Rendering
  proves nothing about who supplied it or who is looking. The outside listener
  must authenticate the human and the control channel on its protected origin,
  and must source the binding from its own registered V2 authority state for
  that project/session/round.
- **Static snapshot.** The view shows a stored capture, not the live
  workspace. It does not prove the source files were read atomically, frozen,
  complete for any policy, or still current. `validateStoredCapture` proves
  only internal consistency, not origin.
- **No actions here.** There is no recapture, approve or reshape, and no URLs,
  tokens, secrets or live-state claims. Decisions stay with
  `lib/review-decision.mjs` and the authority.
- **Open gates.** None of `SKEL_DECISION_V2_ABSENT_GATES` is satisfied:
  listener-authenticated origin, capture persistence integration, capture
  freeze and anti-rollback remain open.
- **Host duties.** The host must load the capture from the immutable store by
  the bound `captureVersion`, keep the rendering page free of project-supplied
  scripts, and apply its own CSP. Sizes are bounded only by the validator's
  `STRICT_CAPTURE_LIMITS`. A large valid capture still makes a large DOM.
