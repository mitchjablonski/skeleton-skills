# Control-window console logic (#77, H3 proposal)

Status: **prototype, wired into nothing.** `lib/strict-control-console.mjs`
is the text layer of the launcher control window from
[strict-human-channel.md](strict-human-channel.md). It turns one typed line
into fixed-copy output lines, against an injected authority.

What it doesn't own (#75/#76, Codex):

- the control process;
- its PTY and raw mode, and isolation from `TIOCSTI`;
- the round key and code derivation and verification;
- the attempt caps;
- the journal.

Strict stays disabled.

## Authority interface (proposal)

Every reply echoes the request's `requestId`. A reply without it, or with
another id, is malformed and the outcome is unknown. Replies are read as own
data properties only, so a getter or a proxy trap is also malformed.

```js
verifyAndCommit({ action, code, requestId }) ->
  { kind: "committed", requestId, action, revision, reviewVersion, captureVersion, at }   // at: UTC ISO
  { kind: "mismatch", requestId, revision, reviewVersion, captureVersion, attemptsLeft }
  { kind: "locked", requestId, unlock: "recapture" | "new-session" }
  { kind: "rejected", requestId, code }                  // STRICT_REJECTIONS
  { kind: "journal-full", requestId }                    // R4: no new requests
  { kind: "record-unreadable", requestId }               // R3: outcome unknown, retry won't help
  { kind: "unavailable", requestId }                     // or a throw: outcome unknown
recapture({ requestId }) ->
  { kind: "recaptured", requestId, changed, revision, reviewVersion, captureVersion }
  { kind: "refused", requestId, reason: "fill-phase" | "locked" }
  (plus rejected / journal-full / record-unreadable / unavailable as above)
endSession({ requestId }) -> { kind: "ended", requestId }
state() -> { phase, revision, reviewVersion, captureVersion }
```

**Order of checks.** The authority looks up an exact same-ID retry in its
journal **before** checking the lock, the attempt cap, the current code or
the revision. So a resend gets its original answer, and a `mismatch` or
`locked` reply to a resend should never happen. If one does arrive, the
console keeps the request and says the outcome is still unknown.

**Request ids.** The launcher's `newRequestId` must return a unique id from a
CSPRNG. The console doesn't detect reuse. If the factory throws or returns an
invalid id, nothing is sent, and a pending retry is never abandoned. The
replacement id is generated before `recapture` or `end` clears the kept
request.

## Rules (enforced by `test/strict-control-console.test.mjs`)

- **One request in flight.** While one is pending, every command except
  `status` and `help` is refused, so replies can't race.
- **Input.**
  - One line of printable ASCII, at most 200 characters.
  - Line breaks, ESC, C1, DEL and non-ASCII characters refuse the whole line.
  - A refused line also cancels any pending yes/no question.
  - The launcher strips bracketed-paste markers before calling.
  - Codes are Crockford-normalized.
- **Commands.**
  - `approve <code>` and `reshape <code>` send at once with a fresh id.
  - `retry`, `recapture` and `end` each need `yes` on its own line. Anything
    else cancels, and extra words after these commands are refused.
  - `status` and `help`.
- **Kept requests.** A throw, `unavailable`, `record-unreadable`, or a
  malformed or mismatched reply keeps the request with its id and code.
  - While a request is kept, a new code is refused. `retry` resends the same
    id and code.
  - On a resend, some answers can't settle the original:
    - `unauthorized-channel`, `session-ended` and `request-reused`;
    - `mismatch`, `locked` and `journal-full`.

    These keep the request, with the copy "outcome is still unknown".
  - `stale-review`, `revision-conflict` and `invalid-transition` are checked
    after the journal lookup. So even on a resend they mean the request was
    never recorded, and they clear it.
  - Only a commit, a definitive first-send refusal, `recapture` or `end`
    clears a kept request. `recapture` and `end` warn first.
- **First-send refusals.** They say "this request made no change". Decision
  copy and recapture copy are separate.
- **Mismatch.** The copy is generic. It shows the current prefixes, the
  revision and the attempts left. It never echoes the code and has no history
  oracle.
- **End.** After `end` is confirmed, every command except `status` and `help`
  is refused. If the end has an unknown outcome, the console says so and
  asks for `end` again.
- **Output.**
  - Output is only fixed copy, validated 12-hex prefixes, integers and a
    validated UTC timestamp. The echo comes from the committed reply.
  - Raw input and authority-supplied text never appear in it.
