# Strict tier: review transport topology (#77)

Status: **proposal, mock only.** This describes where the strict tier's human decisions should travel and what the review page does with them. Nothing here is enforced. The launcher boundary (#75) and private transition authority (#76) belong to Codex/Sol and don't exist yet. The decision UI in this PR (`lib/review-decision.js`) ships in the package, because `lib/` does, but nothing loads it: not the review page, not `skel serve`, not any CLI command. Only the tests run it, against a mock of contract v1 (`test/fixtures/strict-results.mjs`). **This PR makes no containment claim.**

Parent: #19. Contract: #76, as amended by the Claude/Opus review comment on #76.

## 1. Two channels, two kinds of capability

**The review server stays a source and feedback channel.** `skel serve` (`bin/skel.mjs`, page in `lib/review-client.js`) is reachable by the agent and by anything that can read its token. The token sits in `.skeleton/serve.json`, in the terminal and in the transcript (design.md R8). The token grants exactly two things: reading the skeleton (`GET /api/data`, `/api/version`) and, in Send mode, posting feedback (`POST /api/feedback`). It is **a read/feedback capability, never authority.** Copy/Send feedback, including an "APPROVED" verdict in that feedback, is a message to the agent. It can't change a phase in strict mode.

**Human decisions go to a separate human-channel listener.** The outside launcher (#75) starts this listener outside the agent's network namespace, and it passes requests to the private authority (#76), which is its only downstream. It accepts a single request shape, the v1 Intent. It has no general-purpose surface: no command execution, no signing service, no passthrough.

Why a separate listener can be unreachable from the agent: in the #19 network spike ([comment 6649092826](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6649092826)), Claude Code 2.1.318 on WSL ran its sandboxed Bash in its own network namespace (`net:[4026532371]` inside, `net:[4026531840]` outside). An outside WSL loopback request couldn't reach a listener inside the sandbox. **That is one transport test on one WSL CLI/runtime, not proof.** It measured outside-to-inside. The reverse direction, sandboxed code reaching a host loopback listener, is what this topology relies on. It follows from the separate namespace and matches the [sandboxing docs](https://code.claude.com/docs/en/sandboxing#a-command-fails-to-reach-a-server-on-localhost), but that spike didn't measure it. The spike also didn't cover a browser, macOS, Desktop or IDE clients.

The same evidence carries a limit: the spike sandboxed **Bash only**. Built-in Read/Edit/Write and MCP/hook paths run outside the Bash sandbox ([#19 comment 6660216797](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6660216797); the [sandboxing docs](https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox) list what runs outside it). With only a Bash sandbox, a tool path outside it, such as a local MCP server, could reach a host loopback listener. The human listener is unreachable from the agent only if #75's whole-agent launcher contains every agent path. This topology depends on #75, so it can't replace it.

## 2. Who can reach what

"Agent tools" means every agent path under #75's launcher: CLI, built-in tools, shell, subagents, MCP, plugins and hooks.

| Principal | Review server (`skel serve`, read/feedback) | Human-channel listener (Intent only) | Private authority (state, commit) |
|---|---|---|---|
| **Agent tools** (inside #75's boundary) | **Yes.** Reads source, and in Send mode posts feedback. Holds the token. | **No.** The listener is in the launcher's namespace. *Unproven until #75 shows it for every tool path.* | **No.** It can read only the public verifier snapshot. |
| **Browser** (the human's) | **Yes**, with the token from the link. | **Yes**, by a route Sol defines (open question 1). It may submit an Intent and read AuthorityState. | **No**, not directly. The listener's answer is the only thing it gets back. |
| **Outside launcher** (#75) | Starts nothing here today. The agent runs `skel serve`. | **Starts it** and owns its lifetime and binding. | Starts it or connects to it, and passes no capability to the agent. |
| **Private authority** (#76) | No. It doesn't trust the review server or feedback. | Doesn't call it. The listener calls the authority, which is the listener's only downstream. | Itself. Per #76 it authenticates the channel *and* independently recomputes and verifies the reviewed content, checks the revision and phase transition, and commits atomically. |

Code, diagrams and comments shown on either page stay untrusted data, wherever they're shown.

## 3. What this topology rules out

- **No approval endpoint on the agent-reachable server.** The review server's routes stay `/`, `/assets/review.js`, `/api/data`, `/api/version` and `/api/feedback`. `test/strict-transport.test.mjs` pins that list.
- **No generic command or signing bridge.** The human listener is not a proxy, a shell, a "sign this blob" service or a way to forward requests to the authority. It accepts one Intent shape, and the authority checks it.
- **No browser-carried authority secret.** The page holds no key or bearer token that grants approval. Whatever authenticates the human channel can't be something the page could leak to the agent through Copy/Send, the DOM or storage. The decision module uses no review token, no storage and no network of its own (tested). A mock `submit` authenticates no one.
- **Feedback isn't promoted.** Copy/Send, approve-with-comments (#71) and the review token never become an Intent.

## 4. The decision UI against the mock

`lib/review-decision.js` is a plain page script that talks to a `DecisionChannel`:

```
DecisionChannel = { getState(): Promise<AuthorityState>, submit(intent: Intent): Promise<Result> }
```

- **Production wiring passes no channel.** The module isn't loaded or served, so the page shows no decision UI. The served script is still exactly `review-poll.js + review-feedback.js + review-progress.js + review-client.js` (tested), and default Copy/Send behaviour is unchanged.
- **Each decision is fixed at the click.** The version and the AuthorityState snapshot an Intent names are captured synchronously when the human presses the button. After every wait (the pre-send read, the submit, the post-commit read), the UI checks that the page hasn't moved and the decision is still the one in flight; otherwise it stops before sending, or reports the answer without re-enabling anything.
- **The UI shows exactly what a decision names:** project, session, review round, phase, revision, the version shown and the approved version. All of it is drawn as text nodes.
- **Approve appears only when no notes on the shown version are pending.** Approve with comments stays feedback. Reshape names the currently approved version.
- **No optimistic approval.** "Approved" appears only when both hold: a `committed` Result whose `requestId`, `action`, `reviewVersion` and advanced `revision` all match the intent, and a re-read AuthorityState in the same project, session and round showing phase `fill` with `approvedVersion` equal to the intent's `reviewVersion`. If the commit is echoed but the re-read state differs or can't be read, the page says the service recorded the request but the current state differs, shows that state, and holds actions. If the page moved to another version while the request was in flight, the answer is reported ("the page changed while sending") and nothing is shown as approved (#66). A malformed answer fails closed.
- **Duplicate submits are safe.** A second click while a request is in flight returns the same request. After `unavailable` or a lost answer (the submit threw), the UI keeps that exact intent; after a lost answer it also re-reads AuthorityState for display. The only action then offered is Retry, which resends the same intent with the same `requestId`, skipping the pre-send revision check because the first attempt may have advanced the revision. The authority's idempotency returns the original Result, which then goes through the same confirmation as any commit. A page move discards the kept intent, so a request for the old version is never resent. **Notes hold Retry** just as they hold a new approve: while notes on the shown version are pending, a kept approve is offered disabled, with the reason, and can't be sent. After `unavailable`, which means the request was never processed, notes appearing drop the kept approve. After a lost answer it may have landed, so it is kept but held, and Re-read is offered beside Retry so the human can check the current state; the outcome stays unconfirmed until Retry gets the service's answer.
- **Stale state holds actions.** Before sending a new request, the UI re-reads AuthorityState. If the revision, round, session, phase or approved version moved, or the page now shows another version, nothing is sent. The new state is displayed, and actions stay disabled until the human presses Re-read. A page move while a request is in flight survives that request's answer: the status stays stale, nothing is kept for retry, and actions stay disabled. Re-read is hidden and does nothing while a request is in flight.
- **Inconsistent state fails closed.** An AuthorityState is accepted only if it is as strict as the fixtures' validator: `skeleton` has `approvedVersion: null`, and `fill` and `finalized` name one. Anything else shows no identity and no actions.
- **Each rejection gets its own recovery copy.** `stale-review`, `revision-conflict`, `invalid-transition` and `request-reused` re-read the state and hold actions. `unavailable` offers a retry with the same request. `session-ended` and `unauthorized-channel` turn decisions off for the page, and re-reading doesn't turn them back on.

## 5. Contract assumptions (for Sol's review)

`test/fixtures/strict-results.mjs` is marked as a **proposed schema**. It adds the following to v1 as posted in #76. Everything except the last three items comes from the review comment on #76:

- `AuthorityState = {projectId, sessionId, reviewRoundId, phase: skeleton|fill|finalized, approvedVersion|null, revision}`. It is public and carries no capability.
- `committed` echoes `{action, reviewVersion}`.
- The `request-reused` code. Same requestId with the same intent returns the original Result; same requestId with a different intent is refused.
- For reshape and finalize, `reviewVersion` is the currently approved version.
- **Assumed beyond the review comment:**
  - A `rejected` Result may carry `requestId`. It's optional, because a transport-level `unavailable` may not know it.
  - `unavailable` means "not processed", so the authority doesn't record it against the requestId, and a retry with the same id is processed fresh.
  - The Intent keeps `protocolVersion: 1` from Sol's fixture comment.

## 6. Open questions for Sol

1. **How does the browser reach the human listener?** It could be a second loopback port bound by the launcher in the host namespace, a separate origin, or something native. Whichever it is, which origin does the page run in, and how does it learn the listener's address without the agent being able to learn or spoof it?
2. **How are origin and CSRF bound?** What does the listener check: Origin/Host, a per-launch secret held outside the page, or user presence? It must not depend on a secret the page carries, because the agent can influence what the page renders. Also: can the agent-reachable review page ever be the document that submits, or must the decision UI be served by the human listener itself?
3. **What does `getState` expose?** Is AuthorityState read through the human listener only, or also from the public verifier snapshot? The UI assumes it carries no capability either way.
4. **Is idempotency durable?** Does a recorded requestId survive authority restart? How long is it kept? Is `unavailable` ever recorded?
5. **How does the UI learn the shown version is reviewable?** The UI sends `reviewVersion` and relies on the authority recomputing content and answering `stale-review`. Should AuthorityState also carry the authority's current reviewable version, so the page can warn before submitting?
6. **What happens with `replace` and `migrate`?** These are still open from the review comment. The UI offers neither.

## 7. What this PR does NOT prove

- **No containment.** Nothing here keeps the agent away from any listener. That is #75's job.
- **No human-origin authentication.** A mock channel accepts whatever it's given. Calling `submit` proves nothing about who called it.
- **No origin/CSRF protection.** It can't be tested until Sol's listener exists, so this PR has no such tests rather than fake ones. #77's acceptance asks for browser tests of allowed and disallowed origins, CSRF, a leaked feedback/read token and agent-origin requests. Those remain to do.
- **No browser reachability.** Nothing shows that a real browser can reach the human listener under a supported boundary. #77 requires that before activation.
- **No real browser run.** The UI tests use a DOM stand-in, not a browser.
- **The route pin is a source-text check.** The test that pins the review server's routes reads `bin/skel.mjs`. A route added in another file, or through a router that never names `req.url`, wouldn't be caught.
- **No durability or concurrency.** The mock authority models the expected answers and nothing more.
- **One WSL transport test.** The cited netns evidence is a single transport test on one WSL runtime, not a general guarantee.
