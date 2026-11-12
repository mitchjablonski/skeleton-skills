# Persisted strict capture view (#77)

`lib/strict-capture-view.mjs` is a pure, optional DOM renderer for one
validated persisted strict capture. It is mock groundwork: nothing in
production imports it, and no route, page, server or listener loads it. It does
no network, filesystem, timer or event-listener work.

This is a Node-host DOM prototype, tested with a fake DOM. Its canonical
validator imports Node built-ins and uses Buffer; a browser cannot import this
module directly. Browser delivery and real-browser rendering tests require a
separate reviewed host/browser split. These tests do not establish browser UX
or reachability under the launcher boundary.

## API

```js
renderStrictCaptureView({ doc, container, capture, binding, limits? })
  -> frozen { shown, binding, isCurrent() }   // or throws StrictCaptureViewError
currentStrictCaptureShown(container) -> shown | null
```

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

1. The DOM handles must be usable (`VIEW_DOM`). The container's previous shown
   context stops being current at once.
2. The binding is validated (`VIEW_BINDING`).
3. The capture is rebuilt with `validateStoredCapture` before any element is
   created (`VIEW_CAPTURE`). Tampered display lines, fence titles, line endings,
   digests, sizes or extra fields refuse. Validation limits can only be lowered.
4. The recomputed `shapeVersion`/`captureVersion` must equal the binding's pair
   exactly (`VIEW_PAIR`). A same-shape capture with different raw bytes refuses.
5. The view is built detached and then swapped in with one
   `container.replaceChildren(view)`. Any DOM failure is `VIEW_RENDER`.

On any refusal after step 1, the container is emptied and nothing is current.
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
