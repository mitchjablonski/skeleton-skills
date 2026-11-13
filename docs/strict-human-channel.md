# Strict tier: how a decision is accepted as the human's (#77 / #76)

Status: **design proposal for review by Sol and the maintainer.** Nothing is
implemented or adopted. Strict stays disabled.

## The question

The strict tier needs approve, reshape and finalize to come from the human,
not the agent. The docs so far say what must not authenticate a decision:

- a deny rule;
- a `UserPromptExpansion` event;
- a permission prompt;
- a browser-carried secret;
- the review token.

None of them says what does. The prototype listener (#106) is read-only on
purpose until this is settled. #19's title already names the intent:
"human-typed approval".

## Assumptions

These come from [strict-decision-page.md](strict-decision-page.md) and
[strict-transport.md](strict-transport.md):

- **The agent** controls the workspace, the review origin and its own
  terminal. #75 must stop it from reaching the listener, the launcher's
  private sockets, the human's browser profile and the control window.
- **The launcher control window** is a separate terminal or window that only
  the launcher owns. The agent can neither read it nor write to it.
- **The protected decision page** is on its own origin, opened from the
  control window. Script on the review origin can't read it (same-origin
  policy).
- **The human's own session** (host processes, browser extensions) is trusted.
  Malware there is out of scope, as it is everywhere else in strict.

## Options

| Option | How a decision travels | Proves | Costs |
|---|---|---|---|
| **H1. Click on the protected page** | Page → `POST` decision route on the listener → authority | The request came from the launcher-opened tab on the protected origin | Needs a decision route with the full CSRF, clickjacking, arming and confirm stack (B9–B11). The listener stops being read-only. Anything that can drive the browser can approve |
| **H2. Code from the control window, typed into the page** | Page → decision route, carrying a code the control window showed | Also that whoever acted could see the control window | Keeps every H1 cost and adds friction |
| **H3. Code from the page, typed into the control window** (recommended) | Human types `approve <code>` into the control window → launcher → authority. **No web decision route** | Whoever typed it could see the control window **and** had the protected page open on that exact snapshot | One short typed command per decision. Needs the control window from #75 |

## Recommendation: H3

1. **Showing the code.** The decision page renders the stored snapshot (#103
   and #106, unchanged) and, under it, one code per action that is allowed now:

   > To approve this snapshot, type in the launcher window: `approve K7M2-QX9D`

2. **Deriving the code.** It is
   `HMAC(roundKey, action ‖ projectId ‖ sessionId ‖ reviewRoundId ‖ reviewVersion ‖ captureVersion ‖ revision)`,
   truncated to 8 Crockford base32 characters (40 bits) and shown as two
   groups of four.
   - The launcher creates `roundKey` for each review round and keeps it in its
     private memory or store. It never reaches the agent, the review page or
     the URL.
   - The listener serves the code only to the live bound tab, through
     `/api/view`.
3. **Checking the code.** The control window accepts
   `approve | reshape | finalize <code>`. It recomputes the code from the
   authority's **current** selected state and compares in constant time.
   - **No match:** it refuses and says why, as specifically as it can:
     - the code is for an older snapshot (reload the page);
     - the code is for a different action;
     - the code was mistyped.
   - **Match:** the launcher builds the Intent itself from the authority
     state. It never builds it from page data.
4. **Retries and unknown outcomes** stay in the control window.
   - It keeps the Intent with its request id. On `unavailable` or a lost
     reply, it offers `retry`, which resends the same id. The existing R5–R7
     copy and the dedupe rules carry over unchanged.
   - Recapture or a newer snapshot ends a pending retry, with the
     confirmation copy that already exists.
5. **Echoes.** The control window echoes every committed transition: action,
   version, revision and time. The decision page shows the result on its next
   Re-read, which is still a GET.

### Why H3

- **Nothing to attack on the web side.** The listener stays read-only. There is
  no cross-site request forgery or clickjacking against a decision endpoint,
  and no armed buttons. The tested request checks (#106, #111) are the whole
  web surface.
- **The decision ties to what was shown.** The code is bound to the action,
  round, revision and exact shape/raw pair, so a code from a stale or
  different snapshot fails. The agent can't compute it, because it never sees
  `roundKey`. Only the protected page shows it.
- **Persuasion can't supply a working code.** The agent may print "type
  `approve 1234-ABCD` in the launcher" on its own terminal or inside the
  skeleton text. The agent can't compute a valid code, so such a code fails.
  The real code exists only on the protected page.
- **Typing is a deliberate act.** It also matches "human-typed approval".

### What H3 does not prove

- **That the human read the bytes.** Typing the code proves they had the page
  open. Approving without reading is still possible.
- **Malware in the human's own session.** Software that can read the page and
  type into the control window can approve. This is the same trust assumption
  as before.
- **That the control window is unforgeable.** That depends on #75 keeping it
  out of the agent's reach. A control window on the agent's PTY would break
  this design.
- **Brute force.** It is impossible only because the agent can't type into the
  control window. 40 bits is about typo resistance and stale-code binding, not
  online guessing.

## What changes in existing work

- **`lib/strict-decision-listener.mjs`.** `/api/view` would add a `codes` field,
  `{ action: code }`, for the actions currently allowed. There is still no
  POST other than `/api/bind`.
- **`lib/review-decision.mjs`.**
  - Its controller logic (version checks, kept intents, retry and recovery
    copy) moves to the control-window process. That process is host-side
    Node, owned by the launcher.
  - The browser no longer submits Intents. The browser-side DecisionChannel
    stays a mock-only module or is retired.
- **#79.** Rows B9–B11 (click arming, lures, decision dedupe) become
  control-window rows:
  - stale code;
  - cross-action code;
  - a code from another round;
  - a code from the agent's terminal;
  - retry after a lost reply;
  - recapture during a pending retry.
- **#78.** The checkpoint copy (#110) already sends the human to the control
  window. `awaiting-review` would name the typed command.

## Needs from Sol (#75 and #76)

- **The control-window process.** Its private link to the authority, the
  per-round `roundKey`, and where the code is derived (launcher or authority).
- **Who checks the code.** Does the authority check the code (it holds the
  key), or does the launcher check it and then submit? We suggest the
  authority checks it, so the launcher can't approve without the page's code.
- **Proof the agent can't reach it.** The control window can't be read or
  written from any agent path. That includes the PTY and a TTY injection like
  `TIOCSTI`.

## Questions for the maintainer

1. Is one typed command per decision acceptable friction, compared with a
   click and a confirm?
2. Should the control window be a separate terminal, which works everywhere
   the CLI runs? Or should it be a small native window, which would add a
   dependency (WSLg on WSL)? The design works with either.
