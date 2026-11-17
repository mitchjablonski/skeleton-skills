# Strict verification matrix (#79)

Status: **tracking document, not evidence of containment.** This is the
#79 release-claim gate in one place.
- **Rows.** Every acceptance item in #79, plus the "#79 tests" lists in
  [strict-decision-page.md](strict-decision-page.md). Each row gives its
  owner, the evidence that exists today, what kind of evidence it is, and
  when it last ran.
- **The bar.** A strict claim needs an actual supported runtime profile under
  the real launcher with the real authority. **No row reaches that bar.**
- **Gaps.** Most rows are open. Strict stays disabled.

`test/strict-verification-matrix.test.mjs` keeps this document honest:
- the row ids are pinned;
- every cited file exists;
- only known evidence kinds are allowed;
- no Kind or Status cell uses claim words;
- the browser row ids exist in the probe;
- unit-test files are in `npm test`.

## Evidence kinds

| Kind | Means |
| --- | --- |
| **unit** | In `npm test`. CI runs it on Node 20, 22 and 24. Pure or local fixtures. |
| **live-fixture** | An opt-in probe with real binaries (Chrome, Bubblewrap, a pinned CLI) on throwaway fixtures. No real credentials, no model inference, and no launcher or authority. |
| **design** | A reviewed document only. |
| **—** | No evidence yet. |

"Profile" is deliberately not a kind here. A row can only gain it by passing
on an actual supported profile, and the test forbids claiming it.

## Last runs (live-fixture rows owned by Claude)

| Probe | Last run | Environment | Result |
| --- | --- | --- | --- |
| `test/live/strict-browser-matrix.mjs` | 2026-11-14 (UTC) at commit 00dbf19 | Chrome 143.0.7499.192 with sandbox on, Node 20.20.0, Linux (WSL2) | B1–B8 and B12–B18 PASS; B9–B11 not applicable |
| `test/live/strict-decision-listener-browser.mjs` | 2026-11-14 (UTC) at commit 00dbf19 | same | PASS (4 runs) |
| `test/live/strict-capture-view-browser.mjs` | 2026-11-14 (UTC) at commit 00dbf19 | same | PASS |

Codex-owned live probes record their observed runs in their own documents,
which the X rows cite.

## Claude-owned rows (browser, control window, skills, status, recovery)

| ID | Requirement | Evidence | Kind | Status |
| --- | --- | --- | --- | --- |
| C1 | The decision page binds only through a one-time launcher link. The nonce leaves the URL and history, a reload or spent link is refused, and a stale tab is revoked | `test/live/strict-browser-matrix.mjs` (B1–B5, B12), `test/strict-decision-listener.test.mjs` | live-fixture, unit | fixture only |
| C2 | A hostile **same-site** origin (another 127.0.0.1 port) gets nothing: form POST, no-cors and CORS fetches, preflight, prefetch, iframe, top-level navigation. Wrong Host, missing Fetch Metadata and duplicate Host are refused | `test/live/strict-browser-matrix.mjs` (B6), `test/live/strict-decision-listener-browser.mjs`, `test/strict-decision-listener.test.mjs` | live-fixture, unit | fixture only. A real cross-site origin, a DNS-rebinding name in a real browser, and an old browser without Fetch Metadata are open |
| C3 | A malicious skeleton renders inert under the exact served CSP and Trusted Types | `test/live/strict-browser-matrix.mjs` (B7), `test/strict-capture-view.test.mjs` | live-fixture, unit | fixture only |
| C4 | A leaked review token, cookie or bogus binding grants nothing. A cookie bomb doesn't take the page down | `test/live/strict-browser-matrix.mjs` (B8), `test/live/strict-decision-listener-browser.mjs`, `test/strict-decision-listener.test.mjs` | live-fixture, unit | fixture only |
| C5 | Codes appear only for the rendered capture, after the notes declaration, in fixed chrome. The reshape steps hold, and dropped or mismatched codes are never shown | `test/live/strict-browser-matrix.mjs` (B13–B18), `test/strict-decision-codes.test.mjs` | live-fixture, unit | fixture only; H3 not adopted |
| C6 | Control-window console: input policy, single flight, an unknown outcome keeps the request, same-id retry, recapture and end confirmations, generic mismatch, output never echoes input | `test/strict-control-console.test.mjs`, `test/strict-control-store.test.mjs` | unit | text logic and durable-store fixture only. The control process, PTY and raw mode don't exist |
| C7 | Page codes, console and codec agree end to end. Journal-first retry, attempt policy (`candidate-no-recapture-reset-v1`), reshape rotation | `test/strict-h3-mock-flow.test.mjs`, `test/fixtures/strict-h3-mock-authority.mjs` | unit | against a mock authority only; not the adapter |
| C8 | Checkpoint status and recovery copy never claims containment. A stop in doubt says a process may be running, and the agent notice only says to wait | `test/strict-checkpoint-status.test.mjs`, `docs/strict-checkpoint-ux.md` | unit, design | copy only; no supervisor report exists |
| C9 | Skills: wait at checkpoints, never handle decision codes, never run privileged equivalents | `skills/skeleton-fill/SKILL.md`, `skills/skeleton/SKILL.md` | design | text only; no live agent run |
| C10 | `skel status` distinguishes unsupported / unverified / active / ended, and only evidence the verifier accepts gives active. Missing, stale or unreadable evidence removes active | `test/strict-status.test.mjs` | unit | fixture verifier only. No evidence producer exists, and authenticating evidence is open |
| C11 | Approve arming, double-click and focus-steal lures | none | — | not applicable under H3 (no web decision route); it would become a control-window row under H1 |
| C12 | Duplicate actions and retry dedupe through the real transport | `test/strict-control-console.test.mjs`, `test/strict-h3-mock-flow.test.mjs`, `test/strict-human-channel.test.mjs`, `test/strict-control-store.test.mjs`, `test/live/strict-private-channel-probe.py` | unit, live-fixture | pairwise only: console with the durable store (same-id retry), the #145 channel with a mock journal (duplicate sequences never dispatch twice), and the channel with the store in the probe (a fixture client, not the console). No test runs the console over the real channel. The protected launcher, control PTY and decision UI path are open |
| C13 | Source changes between review and commit: edits between steps, and a hostile review page showing A while the workspace holds B. The decision binds the stored capture, not the live files | `test/strict-capture-view.test.mjs`, `test/strict-h3-mock-flow.test.mjs`, `docs/strict-decision-page.md` | unit, design | binding logic only: the decision binds the rendered capture and refuses a swapped pair. "Review page shows A while the workspace holds B" is untested. The protected capture, freeze and real launcher are open |
| C14 | Recovery: crash then retry returns the original result; the listener stops mid-request; a lost historical outcome; reload after `unavailable`; a full journal | `test/strict-control-console.test.mjs`, `test/strict-h3-mock-flow.test.mjs`, `test/strict-control-store.test.mjs`, `test/strict-human-channel.test.mjs`, `test/live/strict-private-channel-probe.py` | unit, live-fixture | covered, pairwise: lost approval and end replies recovered with original ids across an in-process store reopen (console with store); a lost reply over a fresh channel with a mock journal; and the approval only across a fresh socketpair plus store reopen in the probe (deliberate exit, not a crash). Plus the journal-full copy. No evidence yet for a real crash, the listener stopping mid-request, a lost historical outcome in the decision UI, or reload after `unavailable` |
| C15 | In-session CLI transitions refuse in strict, even when active | `test/strict-status.test.mjs` | unit | helper only, not wired into the CLI (open) |
| C16 | Forged, replayed or other-key evidence is refused. A deleted `.skeleton/` shows `state-diverged` | none | — | open; no evidence producer |
| C17 | The agent's terminal can't fake "strict: active", an origin or a reopen prompt, and none of it reaches the control channel | `docs/strict-decision-page.md`, `docs/strict-protected-bootstrap.md` | design | open: contract negative controls N3, N8 and N11; needs the #75 control channel |
| C18 | Control-window isolation: a spoofed title on the agent PTY, OSC 52 and OSC 0/1/2 filtered, `TIOCSTI`, pasted escape sequences | `docs/strict-human-channel.md`, `docs/strict-protected-bootstrap.md`, `test/live/strict-pty-separation-probe.py`, `docs/strict-pty-separation.md` | design, live-fixture | bounded PTY/devpts, descriptor/procfs and synthetic socket/environment fixture only. TIOCSTI outcomes do not establish isolation causality on a kernel that disables it. Actual display/automation, escape filtering, streaming paste and the protected control process remain open |
| C19 | Real-browser rows on other browsers and WSL networking modes | none | — | open (Chrome 143 on Linux/WSL only); outside the #147 contract |
| C20 | The page opens in a fresh launcher profile with remote debugging off, and an agent-started debugging browser never receives the page | `docs/strict-protected-bootstrap.md` | design | open: contract bootstrap step 6 and negative control N5; needs the #75 launcher |

## Codex-owned rows (launcher, authority, enforcement)

These summarize the owner's documents. Codex confirms or corrects their
status.

| ID | Requirement | Evidence | Kind | Status |
| --- | --- | --- | --- | --- |
| X1 | The actual contained CLI's tools stay inside the workspace view | `test/live/strict-client-probe.py`, `docs/strict-client-probe.md` | live-fixture | one fixed run of Read, Edit and Bash; the doc calls these observations, not attestation. Write, shell/interpreter/copy launches, process/socket/descriptor paths, direct private-authority attempts and discovered public URLs/tokens are open |
| X2 | Checkpoint teardown: every namespace writer dies before capture | `test/live/strict-checkpoint-probe.py`, `docs/strict-checkpoint-probe.md` | live-fixture | controlled fixture only |
| X3 | Fill restarts from the stored approved capture, and drift is refused | `test/live/strict-candidate-probe.py`, `test/live/strict-actual-fill-probe.py`, `docs/strict-actual-fill.md`, `docs/strict-candidate-integration.md`, `test/live/strict-durable-fill-probe.py`, `docs/strict-durable-fill.md` | live-fixture | fixture only; older probes use mock transitions. The durable-fill fixture uses the human-authority store with host-injected approval, exact stored-byte reseeding and bounded private-path denial; human/channel and supported-runtime evidence remain open |
| X4 | The model broker refuses bad requests: absolute URLs, CONNECT, rebinding, oversize requests | `test/strict-model-broker.test.mjs`, `test/strict-model-policy.test.mjs`, `test/live/strict-relay-tls-probe.py`, `test/live/strict-tls-lab.py`, `docs/strict-relay-tls.md` | unit, live-fixture | fixture only; no real credentials. DNS rebinding is checked only by the mock and unit policy; the live TLS fixture uses fixed answers, not live DNS rebinding. That the broker is the only way out belongs to X14 and is open |
| X5 | Capture: canonical, bounded, host-owned enumeration, stored immutably before anything refers to it. Hostile-capture cases from the decision page doc's (c) list | `test/strict-capture.test.mjs`, `test/strict-enumeration.test.mjs`, `test/strict-capture-store.test.mjs`, `test/strict-recapture-coordinator.test.mjs` | unit | unit only |
| X6 | Authority: V2 transitions, journal replay, private store | `test/strict-authority.test.mjs`, `test/strict-authority-store.test.mjs` | unit | unit only; anti-rollback open |
| X7 | Human-command codec, authority planning and durable record (H3 candidate) | `test/strict-human-command.test.mjs`, `test/strict-human-authority.test.mjs`, `test/strict-human-authority-store.test.mjs`, `docs/strict-human-authority.md`, `docs/strict-human-authority-store.md` | unit, design | disabled durable candidate. Linux fault, reopen and contention tests exist. Protected enrollment, channel and key custody, console wiring, anti-rollback and a run on a supported setup are open |
| X8 | Performance baseline (capture, store, authority) | `test/live/strict-capture-benchmark.mjs`, `docs/strict-capture-benchmark.md` | live-fixture | observations; no thresholds adopted |
| X9 | Publication: managed versions or export | `docs/strict-publication.md` | design | open; the product choice is the maintainer's |
| X10 | MCP, plugins, hooks, nested CLI, subagents, WSL interop and symlink/mount aliases inside the boundary | none | — | open |
| X11 | Anti-rollback anchor for the authority and capture stores | none | — | open |
| X12 | A published profile matrix (OS, filesystem, client, runtime, tools, MCP, network), with strict refused on anything unsupported | none | — | open |
| X13 | Launch refusals: interop enabled, a `/mnt/*` mount other than the workspace, a visible session bus, browser openers | `docs/strict-protected-bootstrap.md` | design | open: contract negative controls N4, N10; no test yet. The contract proposes, without adopting, rescoping to interop unreachable from the sandbox, which needs a maintainer decision (#79) |
| X14 | Agent reach: the listener, internal sockets, loopback aliases (`0.0.0.0`, `[::ffff:127.0.0.1]`, a rebinding name) and the WSL host address are unreachable from every agent path, including the model egress | `docs/strict-protected-bootstrap.md` | design | open: contract negative controls N3, N5, N9; no test yet |
| X15 | Host git doesn't run agent-written `core.fsmonitor`, hooks or filters, including Windows git on `/mnt/c` | `test/live/strict-host-git-config-probe.py`, `docs/strict-host-git-config-probe.md` | live-fixture | fixed Linux Git 2.43.0 source-discovery fixture only: global/local helper positive controls, neutral membership comparison and no helper sentinels during discovery. Windows Git, mounted-path behavior and broader configuration mechanisms remain open |
| X16 | The review forward is host-to-agent only and gives the agent no outbound path | none | — | open |
| X17 | Protected host assets unchanged; cleanup and process shutdown verified after every run | `docs/strict-checkpoint-probe.md`, `docs/strict-capture-benchmark.md`, `test/live/strict-pty-separation-probe.py`, `docs/strict-pty-separation.md`, `test/live/strict-lifecycle-fault-probe.py`, `docs/strict-lifecycle-fault.md` | live-fixture | per-probe fixture cleanup only, including a pidfd-observed same-group sleeping descendant after its leader exits. The N10 fixture adds a synthetic Bubblewrap PID-namespace stop: pidfds on init, worker, agent-group child and a session-escaping descendant plus an empty pid-ns inode scan, and a launcher stand-in SIGKILL cascade. A real launcher's cascade (authority, console, listener parent-death) and a whole-run host-asset check remain open |
| X18 | Malformed evidence and forbidden fallback: the launcher never silently falls back to unconstrained mode | `docs/strict-protected-bootstrap.md`, `test/live/strict-lifecycle-fault-probe.py`, `docs/strict-lifecycle-fault.md` | design, live-fixture | open: contract negative control N10. A synthetic fixture shows the physical stop is proven before a held authority request may reply, on authority stall, authority exit and control loss, with a group-kill negative control and an injected unproven stop. Injected failure at each real bootstrap step remains open |

## Process requirements

- **Cross-review.** Each side cross-reviews the other's evidence before a
  row moves (#79).
- **Fixture-only labels.** The Kind column marks fixture-only tests as such.
- **Thresholds.** Performance thresholds must be agreed before claiming
  acceptable overhead (X8).

## What a strict claim needs

Every row must pass on every supported profile, once X12 defines them, or be
explicitly rescoped by the maintainer. #79 lists the full bar. Until then:

- no release claims strict;
- `skel status` never reports active;
- no live-fixture result is presented as containment.
