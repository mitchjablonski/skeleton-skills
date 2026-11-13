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
  - The `Host` header must be exactly `127.0.0.1:<port>`. Any other host gets
    421, including `localhost`, `0.0.0.0`, `[::1]`, other loopback addresses
    and rebinding names.
- **Fetch Metadata is required:**
  - A request without `Sec-Fetch-Site` gets 403. There is no fallback to
    `Origin`.
  - The document (`GET /`) needs `Sec-Fetch-Site: none`, `Sec-Fetch-Mode:
    navigate` and `Sec-Fetch-Dest: document`. So framing, same-site
    navigation and links from the review origin are refused.
  - Every other request needs `same-origin`. A fixed asset also needs the
    right `Sec-Fetch-Dest` (`script` or `style`).
- **POST rules:** the only POST route is `POST /api/bind`. It needs exactly
  `Origin: http://127.0.0.1:<port>` and an `application/json` body of at most
  1 KiB, `{ "nonce": … }` with no other keys.
- **Methods and CORS:**
  - No CORS headers are ever sent.
  - `OPTIONS` (preflight) and every method other than GET/POST are refused.
  - Unknown paths get 404, including traversal and project-looking paths.
- **Cookies** are ignored and grant nothing.
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

**Reads.** `GET /api/view` returns the host-built view model. `GET /api/state`
returns `{ binding }`. Both need the live tab binding. A provider failure
returns `503 { error: "unavailable" }`, or the `VIEW_*` code for a capture or
pair refusal. Exception text is never echoed.

**The page.** The app reads `#n=<nonce>` and replaces history with `/`
before any request, then binds. A reused, expired or missing link shows
"Reopen the decision page from the launcher's control window." and nothing
else. A revoked tab says it is no longer the live decision page. A malformed
model leaves the view empty. Re-read is a GET that changes nothing.

## Evidence

- **`test/strict-decision-listener.test.mjs`** is in `npm test` and makes raw
  HTTP requests against an ephemeral loopback port. It covers every rule
  above:
  - Host variants, Fetch Metadata combinations, asset destinations and
    traversal;
  - Origin and content-type refusals, nonce reuse, supersession and expiry,
    and tab revocation;
  - provider failures without leaks;
  - absent decision routes, preflight, other methods, CORS headers and
    cookies;
  - a check that nothing in `lib/` or `bin/` loads the listener or the app.
- **`node test/live/strict-decision-listener-browser.mjs`** is an opt-in
  probe that needs a local Chrome. It passed on headless Chrome 143 (Linux
  WSL, Node 20.20):
  1. The minted URL binds and renders the capture. The hostile fence title
     stays text, with no `<img>`.
  2. The same URL again is refused, and nothing is shown.
  3. A hostile page on another loopback port tries a CORS bind, a no-cors
     bind, `sendBeacon`, CORS and no-cors view reads, and an iframe, using a
     fresh valid nonce. Every request that reached the listener was refused,
     the frame was unreadable, and the nonce was still unconsumed afterwards.

## Not shown (still open)

- **Agent reachability.** The prototype binds `127.0.0.1` in whatever network
  namespace runs it. That the agent can't reach it depends on the #75
  launcher.
- **The control channel and browser opening:** a fresh profile, remote
  debugging off and reopen (#75).
- **The source of truth:** the binding and capture must come from the
  protected stores (#76). The provider is trusted here.
- **Browser coverage:**
  - hash stripping as observed in history, and reload behavior;
  - double-click and focus-steal arming;
  - Fetch Metadata on other browser versions.

  These are the #79 browser rows.
- **Decisions.** There is no decision route, so a click can't be called human.
  Adding one needs the protected human channel reviewed first (#99).
