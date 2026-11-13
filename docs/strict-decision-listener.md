# Prototype protected decision listener (#77)

Status: **prototype, wired into nothing.** No production module imports or
starts `lib/strict-decision-listener.mjs`, and no launcher exists to run it.
It has **no decision route**: no approve, reshape, finalize, Recapture or
submit. It authenticates no human. Strict stays disabled.

It implements the request checks from
[docs/strict-decision-page.md](strict-decision-page.md) section (b), so they
can be tested over raw HTTP and in a real browser. It also serves the
read-only capture view from [docs/strict-capture-view.md](strict-capture-view.md).

## Pieces

| File | Runs in | Job |
| --- | --- | --- |
| `lib/strict-decision-listener.mjs` | host (Node) | Loopback HTTP server: request checks, nonce/tab binding, fixed assets, view reads |
| `lib/strict-decision-app.mjs` | browser | Consume the fragment nonce, bind the tab, fetch and render the view, Re-read |
| `lib/strict-decision.css` | browser | Fixed, project-independent styles |

```js
createDecisionListener({ provider, now?, observe? })
  -> { start() -> Promise<{ origin }>, mintNavigation() -> url, close(), origin }
```

- `provider.read()` returns `{ binding, capture }`: the registered V2 binding
  and the persisted capture it names. In production this must come from the
  protected V2 authority store and the immutable capture store (#76). The
  prototype takes whatever it is given, so a mock provider proves plumbing
  only.
- `mintNavigation()` stands in for the launcher control channel's
  open/reopen. It returns `http://127.0.0.1:<port>/#n=<nonce>`. Each mint
  invalidates every earlier nonce and the live tab.
- `observe` receives `{ method, url, status, code }` per request, for probes.
  It never receives headers or bodies.

## Request rules

Every request:

- **Server checks:**
  - HTTP/1.1 only.
  - There must be exactly one `Host` header, and it must be exactly
    `127.0.0.1:<port>`. Any other host gets 421, including `localhost`,
    `0.0.0.0`, `[::1]`, other loopback addresses and rebinding names.
  - The request header limit is 1 MiB (`MAX_HEADER_BYTES`). Cookies ignore
    the port, so any `127.0.0.1` origin can plant cookies that reach this
    listener. Browsers allow about 180 cookies of 4 KiB per host, so Node's
    16 KiB default would let a cookie bomb from the review origin take the
    page down.
- **Fetch Metadata is required:**
  - A request without `Sec-Fetch-Site` gets 403. There is no fallback to
    `Origin`.
  - The document (`GET /`) needs `Sec-Fetch-Site: none`, `Sec-Fetch-Mode:
    navigate` and `Sec-Fetch-Dest: document`. So framing, same-site
    navigation, links from the review origin and reloads are refused. A
    refused document gets a static, script-free 403 page that says to reopen
    from the control window, with the same headers.
  - Every other request needs `same-origin`. A fixed asset also needs the
    right `Sec-Fetch-Dest` (`script` or `style`).
- **POST rules:** the only POST route is `POST /api/bind`. It needs exactly
  `Origin: http://127.0.0.1:<port>` and an `application/json` body of at most
  1 KiB, `{ "nonce": … }` with no other keys.
- **Methods and CORS:**
  - No CORS headers are ever sent.
  - `OPTIONS` (preflight) and every method other than GET/POST are refused.
  - Unknown paths get 404, including traversal and project-looking paths.
- **Cookies** are ignored and grant nothing, up to the header limit.
- **Failure handling:** token comparisons check the 43-character base64url
  shape before the constant-time compare, so a non-ASCII value can't throw.
  An unexpected error in a handler becomes a 500, never a process exit.
- **Response headers:**
  - the CSP from the design doc, with `require-trusted-types-for 'script'`
    and `frame-ancestors 'none'`;
  - `X-Frame-Options: DENY`;
  - `Cache-Control: no-store`;
  - `Referrer-Policy: no-referrer`;
  - `Cross-Origin-Resource-Policy: same-origin` and
    `Cross-Origin-Opener-Policy: same-origin`;
  - `nosniff`.

**Binding.** `POST /api/bind` consumes the one-time nonce. A nonce is valid
for 2 minutes, only the latest minted one is valid, and comparison is
constant-time. A successful bind returns a fresh tab binding. The page keeps
that binding only in module memory and sends it as `x-skel-tab`. Only the
latest bound tab is live: a new bind or mint revokes the old one.

**Reads.** `GET /api/view` returns `{ view, codes }`: the host-built view model and any decision codes (below). `GET /api/state`
returns `{ binding }`. Both need the live tab binding. A provider failure
returns `503 { error: "unavailable" }`, or the `VIEW_*` code for a capture or
pair refusal. Exception text is never echoed.

**The page.** The app reads `#n=<nonce>` and replaces history with `/`
before any request, then binds. History and the browser's history store no
longer hold the nonce. The page's own navigation timing entry
(`performance.getEntriesByType("navigation")`) still names the original URL.
Only same-origin script can read it, and by then the nonce is spent. A reused, expired or missing link shows
"Reopen the decision page from the launcher's control window." and nothing
else. A revoked tab says it is no longer the live decision page. A malformed
model leaves the view empty. Re-read is a GET that changes nothing.

## Evidence

- **`test/strict-decision-listener.test.mjs`** is in `npm test` and makes raw
  HTTP requests against an ephemeral loopback port. Its 12 tests cover:
  - Host variants, a duplicate `Host`, HTTP/1.0 and absolute-form targets;
  - Fetch Metadata combinations, the static refusal page, asset destinations
    and traversal;
  - Origin and content-type refusals;
  - nonce reuse, supersession and expiry, and tab revocation;
  - an oversized body cut off without consuming the nonce;
  - non-ASCII tab and nonce values refused without crashing the process;
  - a cookie bomb of about 700 KiB still served;
  - provider failures without leaks;
  - absent decision routes, preflight, other methods, CORS headers and
    cookies;
  - a check that nothing in `lib/` or `bin/` loads the listener or the app.

  A mutation check confirmed that the cookie-bomb and non-ASCII tests fail
  against the pre-fix code.
- **`node test/live/strict-decision-listener-browser.mjs`** is an opt-in
  probe that needs a local Chrome. It passed on headless Chrome 143 (Linux
  WSL, Node 20.20):
  1. The minted URL binds and renders the capture. The hostile fence title
     stays text, with no `<img>`.
  2. The same URL again is refused, and nothing is shown.
  3. A hostile page on another loopback port tries a CORS bind, a no-cors
     bind, `sendBeacon`, CORS and no-cors view reads, an iframe and finally a
     top-level navigation onto the listener, using a fresh valid nonce. Every
     request that reached the listener was refused. The listener log shows
     both the iframe and the navigation documents refused (`document-site`),
     and the nonce was still unconsumed afterwards.
  4. Another `127.0.0.1` origin plants about 160 KB of cookies. The real page
     in the same browser profile still binds and renders.

## Decision codes (H3 proposal, prototype)

This section prototypes the page side of
[strict-human-channel.md](strict-human-channel.md). That design is **not
adopted**, and the control window that would accept codes doesn't exist. No
code is derived, verified or sent here.

- **Response shape.** `GET /api/view` returns `{ view, codes }`.
  `provider.read()` may return `codes`: `{ approve | reshape: { code,
  revision, reviewVersion, captureVersion } }`. Because they come from the
  same read as the capture, codes always travel with the capture they bind.
- **Checks.** `lib/strict-decision-codes.mjs` is browser-safe, has no imports
  and is used by both the listener and the page.
  - The codes must be canonical Crockford `XXXX-XXXX`.
  - Only phase-allowed actions are accepted: approve in scaffold, reshape in
    fill, none in done. Finalize is out of v1.
  - Approve binds the selected pair and is never accepted while the binding
    says notes are pending. Reshape binds the approved pair.
  - Every code names the same revision.
- **Refusals.** The listener refuses the whole view with `503 codes` if the
  codes don't match. The page re-checks them against the capture it actually
  rendered and shows none if they don't match.
- **The panel** sits in fixed chrome: sticky, double-bordered and outside
  `#view`.
  - The approve code appears only after "I have no unsent notes on this
    version". "I have notes" shows no code.
  - The reshape code appears only after "Show the reshape code" plus an
    acknowledgement, and unchecking hides it.
  - Each code shows its shape and capture version prefixes and revision. The
    panel names the control window's banner (`SKELETON STRICT CONTROL`) and
    says never to paste the code anywhere else.
  - Every load rebuilds the panel, so a declaration never carries over to
    another capture.
- **Browser rows** in `test/live/strict-browser-matrix.mjs`:
  - **B13:** the code is hidden until the notes choice and sits outside the
    capture, and a skeleton lure ("approve ZZZZ-ZZZZ") stays inside the
    capture.
  - **B14:** a Re-read with a different capture resets the declaration.
  - **B15:** the reshape steps.

  Mutations that showed the approve code without the declaration, or ignored
  the reshape acknowledgement, failed B13/B14 and B15.

## Not shown (still open)

- **Agent reachability.** The prototype binds `127.0.0.1` in whatever network
  namespace runs it. That the agent can't reach it depends on the #75
  launcher.
- **The control channel and browser opening:** a fresh profile, remote
  debugging off and reopen (#75).
- **The source of truth:** the binding and capture must come from the
  protected stores (#76). The provider is trusted here.
- **Browser coverage:**
  - reload as a user experiences it (the raw response is covered);
  - double-click and focus-steal arming;
  - Fetch Metadata on other browser versions.

  These are the #79 browser rows.
- **Decisions.** There is no decision route, so a click can't be called human.
  Adding one needs the protected human channel reviewed first (#99).
