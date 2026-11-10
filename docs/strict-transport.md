# Strict tier: review transport topology (#77)

Status: **proposal, mock only.** This describes where the strict tier's human decisions should travel and the logic of the human decision UI. Nothing here is enforced. The launcher boundary (#75) and private transition authority (#76) belong to Codex/Sol; #82 merged the protocol schema (`lib/strict-protocol.mjs`) and the boundary plan ([docs/strict-boundary.md](strict-boundary.md)), but no launcher, writer or human listener exists yet. `lib/review-decision.mjs` is the decision-UI logic that the **listener-served** page will use. It ships in the package, because `lib/` does, but nothing loads it: not the review page, not `skel serve`, not any CLI command. Only the tests import it, against mocks (`test/fixtures/strict-results.mjs`). **This PR makes no containment claim.**

Parent: #19. Contract: #76 and its schema in `lib/strict-protocol.mjs` (#82). This document follows [docs/strict-boundary.md](strict-boundary.md); where they differ, that plan wins.

## 1. Two channels, two kinds of capability

**The review server stays a source and feedback channel.** `skel serve` (`bin/skel.mjs`, page in `lib/review-client.js`) is reachable by the agent and by anything that can read its token. The token sits in `.skeleton/serve.json`, in the terminal and in the transcript (design.md R8). The token grants exactly two things: reading the skeleton (`GET /api/data`, `/api/version`) and, in Send mode, posting feedback (`POST /api/feedback`). It is **a read/feedback capability, never authority.** Copy/Send feedback, including an "APPROVED" verdict in that feedback, is a message to the agent. It can't change a phase in strict mode.

**Human decisions go to a separate human-channel listener.** The outside launcher (#75) starts this listener outside the agent's network namespace, and it passes requests to the private authority (#76), which is its only downstream. **The listener also serves the human decision UI, on its own protected origin, and that page never executes scripts the project supplies** (Sol's ruling; strict-boundary.md trust map). The agent-reachable review page never hosts the decision UI and never submits an Intent. The listener accepts a single request shape, the v1 Intent, and serves AuthorityState for the decision UI's reads. It has no general-purpose surface: no command execution, no signing service, no passthrough.

Why a separate listener can be unreachable from the agent: in the #19 network spike ([comment 6649092826](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6649092826)), Claude Code 2.1.318 on WSL ran its sandboxed Bash in its own network namespace (`net:[4026532371]` inside, `net:[4026531840]` outside). An outside WSL loopback request couldn't reach a listener inside the sandbox. **That is one transport test on one WSL CLI/runtime, not proof.** It measured outside-to-inside. The reverse direction, sandboxed code reaching a host loopback listener, is what this topology relies on. It follows from the separate namespace and matches the [sandboxing docs](https://code.claude.com/docs/en/sandboxing#a-command-fails-to-reach-a-server-on-localhost), but that spike didn't measure it. The spike also didn't cover a browser, macOS, Desktop or IDE clients.

The same evidence carries a limit: the spike sandboxed **Bash only**. Built-in Read/Edit/Write and MCP/hook paths run outside the Bash sandbox ([#19 comment 6660216797](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6660216797); the [sandboxing docs](https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox) list what runs outside it). With only a Bash sandbox, a tool path outside it, such as a local MCP server, could reach a host loopback listener. The human listener is unreachable from the agent only if #75's whole-agent launcher contains every agent path. This topology depends on #75, so it can't replace it.

## 2. Who can reach what

"Agent tools" means every agent path under #75's launcher: CLI, built-in tools, shell, subagents, MCP, plugins and hooks.

| Principal | Review server (`skel serve`, read/feedback) | Human-channel listener (Intent only) | Private authority (state, commit) |
|---|---|---|---|
| **Agent tools** (inside #75's boundary) | **Yes.** Reads source, and in Send mode posts feedback. Holds the token. | **No.** The listener is in the launcher's namespace. *Unproven until #75 shows it for every tool path.* | **No.** It can read only the public verifier snapshot, which may expose only non-capability AuthorityState. |
| **Browser** (the human's) | **Yes**, with the token from the link. The review page there has no decision UI. | **Yes**: it loads the decision UI from the listener's own origin, reads AuthorityState there and submits an Intent there. How it gets there is open question 1. | **No**, not directly. The listener's answer is the only thing it gets back. |
| **Outside launcher** (#75) | Starts nothing here today. The agent runs `skel serve`. | **Starts it** and owns its lifetime and binding. | Starts it or connects to it, and passes no capability to the agent. |
| **Private authority** (#76) | No. It doesn't trust the review server or feedback. | Doesn't call it. The listener calls the authority, which is the listener's only downstream. | Itself. Per #76 it authenticates the channel *and* independently recomputes and verifies the reviewed content, checks the revision and phase transition, and commits atomically. |

Code, diagrams and comments shown on either page stay untrusted data, wherever they're shown.

## 3. What this topology rules out

- **No approval endpoint on the agent-reachable server.** The review server's routes stay `/`, `/assets/review.js`, `/api/data`, `/api/version` and `/api/feedback`. `test/strict-transport.test.mjs` pins that list.
- **No generic command or signing bridge.** The human listener is not a proxy, a shell, a "sign this blob" service or a way to forward requests to the authority. It accepts one Intent shape, and the authority checks it.
- **No browser-carried authority secret.** The page holds no key or bearer token that grants approval. Whatever authenticates the human channel can't be something the page could leak to the agent through Copy/Send, the DOM or storage. The decision module uses no review token, no storage and no network of its own (tested). A mock `submit` authenticates no one.
- **Feedback isn't promoted.** Copy/Send, approve-with-comments (#71) and the review token never become an Intent.

## 4. The decision UI logic, against the mock

`lib/review-decision.mjs` is an ES module holding the decision UI's logic and a text-only renderer. The page the human listener serves will use it. It talks to a `DecisionChannel`:

```
DecisionChannel = { getState(): Promise<AuthorityState>, submit(intent: Intent): Promise<Result> }
```

In production both calls go to the human listener. **The authoritative pre-send read and every re-read come from the listener**, never from the public verifier copy, which may expose only non-capability AuthorityState (strict-boundary.md). Every AuthorityState, Intent and Result passes through `lib/strict-protocol.mjs` (`parseAuthorityState`, `parseStrictIntent`, `parseStrictResult`), so there is one schema.

- **Nothing is wired in.** Nothing in `lib/` or `bin/` imports the module, and the review page's served script is still exactly `review-poll.js + review-feedback.js + review-progress.js + review-client.js` (tested). Default Copy/Send behaviour is unchanged.
- **Each decision is fixed at the click.** The version and the AuthorityState snapshot an Intent names are captured synchronously when the human presses the button. After every wait (the pre-send read, the submit, the post-commit read), the UI checks that the page hasn't moved and the decision is still the one in flight. Otherwise it stops before sending, or reports the answer without re-enabling anything.
- **The UI shows exactly what a decision names:** project, session, review round, phase, revision, the version shown, the authority's version under review and the approved version. All of it is drawn as text nodes; the schema's opaque IDs also exclude markup.
- **Approve is offered only when the shown version is the one under review and no notes on it are pending.** The page's version must equal `AuthorityState.reviewVersion`. A kept Retry is the one exception: it resends the original intent unchanged, without this check, and the authority answers with the original Result, `stale-review` or `revision-conflict`; whatever it answers goes through the same confirmation as any commit. Approve with comments stays feedback (#71). Reshape names the currently approved version. Finalize is in `STRICT_ACTIONS`, but the UI doesn't offer it.
- **No optimistic approval.** "Approved" appears only when both hold:
  - a `committed` Result whose `requestId`, `action`, `reviewVersion` and advanced `revision` all match the intent; and
  - a re-read AuthorityState in the same project, session and round, **at the committed revision or later**, showing phase `fill` with `approvedVersion` equal to the intent's `reviewVersion`. A state older than the commit proves nothing about it.

  If the commit is echoed but the re-read state doesn't confirm it (older, different, or unreadable), the page says the service recorded the request but the current state differs, shows that state, and holds actions. If the page moved to another version while the request was in flight, the answer is reported ("the page changed while sending") and nothing is shown as approved (#66). A malformed answer fails closed.
- **`unavailable` and a lost answer are the same: an unknown outcome.** Neither is proof that nothing happened; the authority's durable same-ID dedupe is what settles it (strict-boundary.md). After either, the UI keeps that exact intent, re-reads AuthorityState for display, and offers two things: **Retry**, which resends the same intent with the same `requestId`, and **Re-read**. Retry skips the pre-send revision check, because the first attempt may have advanced the revision; the authority returns the original Result, which then goes through the same confirmation as any commit. Re-read shows the current state and keeps the outcome marked unconfirmed. The copy never says "nothing was approved" for an unknown outcome.
- **Notes hold Retry.** While notes on the shown version are pending, a kept approve is offered disabled, with the reason, and can't be sent. It is never dropped, because its outcome is unknown; Re-read stays beside it.
- **A page move ends the decision.** It discards the kept intent, so a request for the old version is never resent, even one whose outcome is unknown (Re-read then shows whether it took effect), and it survives any answer still in flight: the status stays stale and actions stay disabled until Re-read. Re-read is hidden and does nothing while a request is in flight.
- **Stale state holds actions.** Before sending a new request, the UI re-reads AuthorityState. If the revision, round, session, phase, version under review or approved version moved, nothing is sent. The new state is displayed, and actions stay disabled until the human presses Re-read.
- **Inconsistent state fails closed.** Whatever `parseAuthorityState` refuses (for example `fill` without an approved version, or a path-like ID) shows no identity and no actions.
- **Each rejection gets its own recovery copy.** `stale-review`, `revision-conflict`, `invalid-transition` and `request-reused` re-read the state and hold actions. `unavailable` is handled as an unknown outcome (above). `session-ended` and `unauthorized-channel` turn decisions off for the page, and re-reading doesn't turn them back on.
- **Mounting** twice in one container with the same channel returns the first mount and applies a changed `shown` through `setShown`; a different channel or request-id maker throws.

## 5. Contract as used here

The contract is `lib/strict-protocol.mjs` (#82). `test/fixtures/strict-results.mjs` holds no schema of its own: its AuthorityStates, Intents and Results all pass the module's parsers, and its mock authority uses `strictIntentConflict` and `strictIntentIdentity`. What the UI relies on:

- `AuthorityState = {projectId, sessionId, reviewRoundId, phase, reviewVersion, approvedVersion, revision}`, with opaque authority-assigned IDs. It is non-capability.
- `committed` echoes `{requestId, action, reviewVersion, revision}`; a `rejected` Result may omit `requestId`.
- Same requestId with the same intent returns the original Result; a different intent is `request-reused`.
- `unavailable` can be a lost committed reply; retry uses the same requestId.
- Approve names the current `reviewVersion`; reshape and finalize name the approved version.

**Assumed by this PR, beyond the schema:** the page maps its phase names to AuthorityState's (scaffold to skeleton, fill to fill, done to finalized), and the UI treats a re-read at a revision below the committed one as unconfirmed.

## 6. Open questions for Sol

Proposed answers, plus status and recovery integration (#78), are in [docs/strict-decision-page.md](strict-decision-page.md): (a) is question 1, (b) is question 2, (c) is question 3 and (d) is question 4. They are proposals for Sol's review and decide nothing.

1. **How does the browser reach the human listener's origin?** For example a launcher-bound loopback port in the host namespace, or something native. How does the human learn its address, given strict-boundary.md says the address need not be secret but its inaccessibility from the agent must be proved?
2. **How are origin and CSRF bound** on the listener, without any secret the page carries?
3. **How does the listener-served page know what the human is looking at?** The decision UI compares the shown version with `AuthorityState.reviewVersion`. If the source is still read on the agent-reachable review page, how does the listener page learn the shown version and pending notes without trusting that page?
4. **How long is a requestId kept,** and what does recovery answer for a requestId it can't find after a restart?

## 7. What this PR does NOT prove

- **No containment.** Nothing here keeps the agent away from any listener. That is #75's job.
- **No human-origin authentication.** A mock channel accepts whatever it's given. Calling `submit` proves nothing about who called it.
- **No origin/CSRF protection.** It can't be tested until Sol's listener exists, so this PR has no such tests rather than fake ones. #77's acceptance asks for browser tests of allowed and disallowed origins, CSRF, a leaked feedback/read token and agent-origin requests. Those remain to do.
- **No browser reachability.** Nothing shows that a real browser can reach the human listener under a supported boundary. #77 requires that before activation.
- **No real browser run.** The UI tests use a DOM stand-in, not a browser.
- **The route pin is a source-text check.** The test that pins the review server's routes reads `bin/skel.mjs`. A route added in another file, or through a router that never names `req.url`, wouldn't be caught.
- **No durability or concurrency.** The mock authority models the expected answers and nothing more.
- **One WSL transport test.** The cited netns evidence is a single transport test on one WSL runtime, not a general guarantee.
