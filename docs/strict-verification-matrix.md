# Strict verification matrix (#79)

Status: **tracking document, not evidence of containment.** This is the
#79 release-claim gate in one place. Each row names a requirement, its owner,
the evidence that exists today and what kind of evidence it is. **No row
reaches the bar #79 sets for a strict claim**, which is an actual supported
runtime profile under the real launcher with the real authority. Strict stays
disabled.

`test/strict-verification-matrix.test.mjs` checks that every file this
document cites exists.

## Evidence kinds

| Kind | Means |
| --- | --- |
| **unit** | In `npm test`. CI runs it on Node 20, 22 and 24. Pure or local fixtures. |
| **live-fixture** | An opt-in probe using real binaries (Chrome, Bubblewrap, a pinned CLI) on throwaway fixtures. No real credentials, no model inference, and no launcher or authority. |
| **design** | A reviewed document only. |
| **profile** | Passed on an actual supported runtime profile under the real launcher and authority. **No row has this yet.** |

## Claude-owned rows (browser, control window, skills, status)

| ID | Requirement | Evidence | Kind | Status |
| --- | --- | --- | --- | --- |
| C1 | The decision page binds only through a one-time launcher link. The nonce leaves the URL and history, a reload or spent link is refused, and a stale tab is revoked | `test/live/strict-browser-matrix.mjs` (B1–B5, B12), `test/strict-decision-listener.test.mjs` | live-fixture, unit | fixture only |
| C2 | Hostile same-site and cross-site origins get nothing: CSRF, preflight, form POST, beacon, prefetch, iframe, top-level navigation | `test/live/strict-browser-matrix.mjs` (B6), `test/live/strict-decision-listener-browser.mjs` | live-fixture | fixture only |
| C3 | A malicious skeleton renders inert under the exact CSP and Trusted Types | `test/live/strict-browser-matrix.mjs` (B7), `test/strict-capture-view.test.mjs` | live-fixture, unit | fixture only |
| C4 | A leaked review token, cookie or bogus binding grants nothing. A cookie bomb doesn't take the page down | `test/live/strict-browser-matrix.mjs` (B8), `test/strict-decision-listener.test.mjs` | live-fixture, unit | fixture only |
| C5 | Codes appear only for the rendered capture, after the notes declaration, in fixed chrome. The reshape steps hold, and dropped or mismatched codes are never shown | `test/live/strict-browser-matrix.mjs` (B13–B18), `test/strict-decision-codes.test.mjs` | live-fixture, unit | fixture only; H3 not adopted |
| C6 | Control-window console: input policy, single flight, an unknown outcome keeps the request, same-id retry, recapture and end confirmations, generic mismatch, output never echoes input | `test/strict-control-console.test.mjs` | unit | logic only. The control process, PTY and raw mode don't exist |
| C7 | Page codes, console and codec agree end to end. Journal-first retry, attempt policy (`candidate-no-recapture-reset-v1`) and reshape rotation | `test/strict-h3-mock-flow.test.mjs`, `test/fixtures/strict-h3-mock-authority.mjs` | unit (mock authority) | mock only; not the adapter |
| C8 | Checkpoint status and recovery copy never claims containment. A stop in doubt says a process may be running, and the agent notice only says to wait | `test/strict-checkpoint-status.test.mjs`, `docs/strict-checkpoint-ux.md` | unit, design | copy only; no supervisor report exists |
| C9 | Skills: wait at checkpoints, never handle decision codes, never run privileged equivalents | `skills/skeleton-fill/SKILL.md`, `skills/skeleton/SKILL.md` | design | text only; no live agent run |
| C10 | `skel status` shows unsupported / unverified / active / ended truthfully, and only fresh authenticated evidence gives active | `test/strict-status.test.mjs` | unit | fixture evidence only; no evidence producer |
| C11 | Approve arming, double-click and focus-steal lures | none | — | **not applicable under H3** (no web decision route). It becomes a C6 control-window row if H1 is ever chosen |
| C12 | Real-browser rows on other browsers and WSL networking modes | none | — | **open** (Chrome 143 on Linux/WSL only) |
| C13 | The page opens in a fresh launcher profile with remote debugging off, and an agent-started debugging browser never receives the page | none | — | **open**; needs the #75 launcher |
| C14 | Control-window isolation: a spoofed title on the agent PTY, OSC 52 and OSC 0/1/2 filtered, `TIOCSTI`, pasted escape sequences | `docs/strict-human-channel.md` (gates listed) | design | **open**; needs the #75 control process |

## Codex-owned rows (launcher, authority, enforcement)

These summarize the owner's documents. Codex confirms or corrects their status.

| ID | Requirement | Evidence | Kind | Status |
| --- | --- | --- | --- | --- |
| X1 | Whole-agent boundary: actual CLI Read, Edit and Bash confined to the workspace view | `test/live/strict-client-probe.py`, `docs/strict-client-probe.md` | live-fixture | fixture only |
| X2 | Checkpoint teardown: every namespace writer dies before capture | `test/live/strict-checkpoint-probe.py`, `docs/strict-checkpoint-probe.md` | live-fixture | controlled fixture only |
| X3 | Fill restarts from the stored approved capture, and drift is refused | `test/live/strict-candidate-probe.py`, `test/live/strict-actual-fill-probe.py`, `docs/strict-actual-fill.md` | live-fixture | fixture only |
| X4 | Model egress only through the constrained broker. Negative cases: absolute URLs, CONNECT, rebinding, oversize requests | `test/strict-model-broker.test.mjs`, `test/strict-model-policy.test.mjs`, `test/live/strict-relay-tls-probe.py`, `docs/strict-relay-tls.md` | unit, live-fixture | fixture only; no real credentials |
| X5 | Capture: canonical, bounded, host-owned enumeration; stored immutably before anything refers to it | `test/strict-capture.test.mjs`, `test/strict-enumeration.test.mjs`, `test/strict-capture-store.test.mjs`, `test/strict-recapture-coordinator.test.mjs` | unit | unit only |
| X6 | Authority: V2 transitions, journal replay, private store | `test/strict-authority.test.mjs`, `test/strict-authority-store.test.mjs` | unit | unit only; anti-rollback open |
| X7 | Human-command codec and authority planning (H3 candidate) | `test/strict-human-command.test.mjs`, `test/strict-human-authority.test.mjs`, `docs/strict-human-authority.md` | unit, design | pure only; no writer, enrollment or key custody |
| X8 | Performance baseline (capture, store, authority) | `test/live/strict-capture-benchmark.mjs`, `docs/strict-capture-benchmark.md` | live-fixture | observations; no agreed thresholds |
| X9 | Publication: managed versions or export | `docs/strict-publication.md` | design | **open**; the product choice is the maintainer's |
| X10 | MCP, plugins, hooks, nested CLI, subagents, WSL interop and symlink/mount aliases inside the boundary | none | — | **open** |
| X11 | Anti-rollback anchor for the authority and capture stores | none | — | **open** |

## What a strict claim needs

Every row must reach **profile** on every supported profile, or be explicitly
rescoped by the maintainer. #79 lists the full bar. Until then:

- no release claims strict;
- `skel status` never reports active;
- no row's live-fixture result is presented as containment.
