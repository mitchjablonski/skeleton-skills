# Strict tier: how a decision is accepted as the human's (#77 / #76)

Status: **design proposal, not adopted and not authorized for implementation.**
This revision folds in Codex's design review and an independent Claude
adversarial review of the first draft. **It does not solve human
authentication.** It narrows what a decision proves and lists the gates
that must hold first. Strict stays disabled.

## The question

The strict tier needs approve, reshape and finalize to come from the human,
not the agent. The docs list what must not authenticate a decision:

- a deny rule;
- `UserPromptExpansion`;
- a permission prompt;
- a browser-carried secret;
- the review token.

None of them says what does. The prototype listener (#106) is read-only on
purpose until this is settled.

## Assumptions (gates, not facts)

- **The agent** controls the workspace, the review origin and its own terminal.
  #75 must prove that no agent path can reach any of these:
  - the listener and the launcher's private sockets;
  - the human's browser profile;
  - the control window, including its PTY, session and descriptors, and
    injection through `TIOCSTI` or procfs;
  - display, clipboard and accessibility channels: X11, Wayland and WSLg
    sockets and environment variables, and OSC 52 clipboard reads;
  - desktop automation.
- **The control window** is a fresh terminal or window that only the launcher
  owns, with its own PTY, session and file descriptors.
- **The protected page** is on its own origin, opened from the control window.
  Script on the review origin can't read it.
- **The human's own session** (host processes, extensions) is trusted. Malware
  there is out of scope.

## Options

| Option | Decision travels | What a successful decision shows | Costs |
|---|---|---|---|
| **H0. Type `approve` in the control window, no code** | Control window → authority | Someone at the control window chose to approve the version it displayed | No link to the protected page: the window can't tell whether that snapshot was ever open (#66) |
| **H1. Click on the protected page** | Page → `POST` decision route | The request came from the launcher-opened tab | A decision route with the full CSRF, clickjacking, arming and confirm stack. Anything that can drive the browser can approve |
| **H2. Code from the control window, typed into the page** | Page → decision route | Also that the actor could see the control window | Keeps every H1 cost and adds friction |
| **H3. Code from the page, typed into the control window** (proposed) | Control window → authority. No web decision route | The typist had a code the authority issued to the protected tab for **that exact snapshot, action and revision** | One typed command per decision, and the gates below |

**What a code proves, and what it doesn't.** Possessing a valid code doesn't
prove a human typed it, that the page was open when it was typed, or that
anyone read the bytes. It proves only that the code issued to the protected
tab for that state reached the control window, and that nothing in between
was allowed. Compared with H0, H3 adds one property: the decision is tied to
a code that was shown only with that snapshot, which is the #66 property.
Whether that is worth the friction is the maintainer's call.

## Proposed design (H3)

### Issuing and showing codes

- **The authority owns the round key.** It creates `roundKey` for each review
  round, keeps it in its private store, and rotates it on reshape. The agent,
  the review page, the URL and the listener never see it. On restart:
  - an authority that persists the key keeps outstanding codes valid until
    the revision moves;
  - one that doesn't simply invalidates them, and the human reloads the page.
- **Codes have a versioned, domain-separated encoding.**
  `code = trunc40(HMAC-SHA256(roundKey, "skel-human-code-v1" ‖ lp(action) ‖ lp(projectId) ‖ lp(sessionId) ‖ lp(reviewRoundId) ‖ lp(revision) ‖ lp(shapeVersion) ‖ lp(captureVersion)))`
  - `lp` length-prefixes each field.
  - The output is shown as 8 Crockford base32 characters in two groups of
    four.
  - **The pair depends on the action.** Approve uses the selected pair.
    Reshape uses the **approved** pair.
- **Codes travel with the capture they bind.** The listener returns the codes
  in the same `/api/view` response as the capture and its versions.
  - The page shows a code only if its versions match the capture that tab
    rendered.
  - It prints both version prefixes and the revision beside the code.
  - A Re-read that brings a different capture replaces the view and its codes
    together. A tab never shows a code for bytes it isn't showing.
- **Approve waits for the notes declaration.** The approve code appears only
  after the human picks "I have no unsent notes on this version" (C5). The
  choice is display-only and needs no POST. "I have notes" shows no code.
- **Reshape takes an extra step.** In the fill phase, the reshape code
  appears only after a page-side extra step, so the destructive code never
  sits beside the others.
- **Codes sit in fixed chrome.** The code block is outside the scrolling
  capture area and looks clearly different from it. The page names the
  control window's banner (below) and says not to paste the code anywhere
  else, such as the agent's terminal or Copy/Send feedback.
- **Finalize is out of v1.** The page shows the approved exteriors, not the
  filled bodies. So a finalize code would prove only the phase and revision,
  not that anyone saw what is being finalized. Finalize waits until the
  checked final capture (#99) can be rendered and bound. Until then it stays
  unoffered, as today.

### Typing and verifying

- **The control window has a fixed, distinctive banner.** Agent terminals can
  set titles and draw prompts, so the page tells the human that nothing is
  decided unless the bannered window echoes it.
- **Input policy:**
  - one command per line;
  - printable ASCII only;
  - Crockford normalization (case, I/L→1, O→0, hyphens and spaces ignored);
  - bracketed paste is accepted only when it contains no newline, escape or
    control bytes;
  - raw input is never echoed back.
- **Output policy:** the window prints only launcher-generated text: fixed
  copy, hex digests, revisions and opaque ids. It never prints paths, fence
  titles, notes or any other agent-influenced text.
- **Commands:**
  - **`approve <code>` and `reshape <code>`.** The window sends
    `{action, code, requestId}` to the authority. Before committing, it
    echoes the shape and capture version prefixes and the revision from the
    authority's reply.
  - **`recapture`.** No code is needed, because the page isn't involved. It
    is a deliberate command that needs its own typed confirmation line. If
    a Retry is pending, it shows the existing copy: "Recapture ends the
    pending Retry. After that, this page can no longer ask the service for
    the original answer. Retry first if you want it." The first real review
    is a human Recapture, per the decision page doc (C4).
  - **`retry`.** It resends the kept Intent with its original request id.
  - **`status`.**
  - Each code-less command needs confirmation on its own line.
- **One verification is one atomic step in the authority.** The authority
  serializes the following:
  1. look up the current state;
  2. check the action is allowed;
  3. recompute the expected code for that exact action, revision and pair,
     and compare in constant time;
  4. build the Intent from that **same** state (expected revision and pair);
  5. commit with its revision CAS;
  6. journal the result under `requestId`.

  The Intent is never rebuilt from a later read, and there is no other
  raw-Intent writer.
- **Mismatches give a generic message, with bounded attempts.**
  - A mismatch says only "That code doesn't match the snapshot under review
    now." It then shows the current version prefixes and revision, so the
    human can compare them with the page.
  - No history oracle: it doesn't say whether the code was stale, for
    another action or mistyped.
  - After N failures in a round (proposed N = 5) the round stops accepting
    codes until the human runs `recapture` or the launcher reopens the
    review. A global cap per session applies too.
  - 40 bits gives a finite, probabilistic guess and collision chance. The
    caps, and the agent's inability to type into the window, keep online
    guessing out of reach. The doc makes no stronger claim.
- **Retry is not retyping.** While a kept Intent with an unknown outcome
  exists, a new code for the same action is refused, and the window points
  to `retry`. That way a self-made commit is never reported as "an older
  snapshot".
  - Exact same-id retries return the journaled result.
  - The code is part of the journaled request, so a different code under
    the same id is refused as a reused request.
- **Kept Intents live in the control-window process,** so they survive page
  reloads. That improves on the current R6 behavior. If the control window
  closes while an Intent is pending, the launcher ends the session and
  records the outcome as unknown. The next session resolves it only through
  the journal.
- **The envelope changes.** If the authority verifies the code, the V2 Intent
  grows a field, or the authority gains a separate verify-and-intend
  operation. Either is a protocol change Sol must approve.
  `lib/strict-protocol.mjs` rejects extra fields today.

### The web side still matters

H3 removes the web decision route, but the page stays security-critical. It
still decides two things:

- which bytes a code is shown beside (integrity);
- who can read the codes (confidentiality).

These keep their importance:

- the rendering rules (C3);
- the request checks and nonce binding tested in #106 and #111;
- tab revocation;
- `no-store`.

A code stays valid until the revision moves, even after the tab is revoked
or reopened. Anyone who observes a code before then can use it.

## What changes in existing work

- **The listener.** `/api/view` adds a `codes` field, `{ action: code }`,
  carrying the versions and revision each code binds to. There is still no
  decision POST.
- **The page app.** It gains the notes declaration, the reshape extra step,
  fixed-chrome codes, version prefixes and the banner name.
- **`lib/review-decision.mjs`.** The controller logic (version checks, kept
  intents, retry, R5–R7 copy) moves into the control-window process. The
  browser DecisionChannel is retired, or stays mock-only.
- **#79.** Rows B9–B11 become control-window rows:
  - stale code;
  - cross-action code;
  - a code from another round;
  - agent-terminal and skeleton-text lures ("approve XXXX-XXXX");
  - pasted escape sequences and multi-line paste;
  - OSC 52 clipboard replacement;
  - the attempt cap;
  - retry after a lost reply;
  - retyping during a pending retry;
  - recapture during a pending retry;
  - closing the control window mid-decision;
  - a spoofed control-window title on the agent terminal.

  New launch-refusal rows are needed for the X11/Wayland/WSLg sockets and
  environment variables, and for OSC 52 reads.
- **#78.** The checkpoint copy (#110) already sends the human to the control
  window. `awaiting-review` would name the commands.

## Gates before implementation (Sol, #75/#76)

- **The authority:**
  - owns the round key and its lifecycle (creation, rotation on reshape,
    restart behavior);
  - performs serialized verify, build-Intent and CAS on exact state;
  - is the only Intent writer.
- **Protocol:** an approved change for the code-carrying Intent or the verify
  operation, with request-id dedupe that includes the code.
- **The control process:** a fresh, isolated PTY, session and descriptors,
  with real evidence that the agent can't reach it through `TIOCSTI`,
  procfs, the PTY, display servers, the clipboard or automation.
- **Caps:** bounded attempts, with the invalidation behavior specified.
- **Carried over:** the existing boundary, capture, anti-rollback and
  recovery gates. This design depends on them and settles none of them.

## Costs, stated plainly

- **Friction.** One typed command per decision, plus Recapture and its
  confirmations.
- **Accessibility.** Moving between a browser and a terminal, and reading and
  typing an 8-character code.
- **WSL.** The outside launcher has to open a window it alone owns (for
  example a separate terminal started outside the agent's session) and prove
  no agent PTY shares it.
- **Clipboard.** Copy and paste is the natural path. The input policy and the
  OSC 52 refusal exist for it.

## Questions for the maintainer

1. Is H3's extra property over H0 (the decision tied to a code shown only
   with that snapshot) worth one typed code per decision? H0 is a typed
   command with no code. H1 is a click plus a confirm.
2. Should the control window be a separate terminal or a small native window
   (WSLg on WSL)?
3. Is finalize out of v1, until the checked final capture can be shown?
