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

```js
verifyAndCommit({ action, code, requestId }) ->
  { kind: "committed", action, revision, reviewVersion, captureVersion }
  { kind: "mismatch", revision, reviewVersion, captureVersion, attemptsLeft }
  { kind: "locked", unlock: "recapture" | "new-session" }
  { kind: "rejected", code }          // STRICT_REJECTIONS
  { kind: "unavailable" }             // or a throw: outcome unknown
recapture({ requestId }) ->
  { kind: "recaptured", changed, revision, reviewVersion, captureVersion }
  { kind: "refused", reason: "fill-phase" | "locked" }
  { kind: "unavailable" }             // or a throw: outcome unknown
state() -> { phase, revision, reviewVersion, captureVersion }
```

The authority looks up an exact same-ID retry in its journal **before**
checking the current code and revision, so a retry gets its original answer.

## Rules (enforced by `test/strict-control-console.test.mjs`)

- **Input.** One line of printable ASCII, at most 200 characters.
  - Line breaks, ESC, C1 controls and non-ASCII characters refuse the whole
    line.
  - A bracketed paste that contains any control byte is refused whole.
  - Codes are Crockford-normalized: case, I and L become 1, O becomes 0, and
    spaces and hyphens are dropped.
- **Commands.**
  - `approve <code>` and `reshape <code>` send at once with a fresh request
    id.
  - `retry` and `recapture` each need `yes` on its own line. Anything else
    cancels.
  - `status` and `help`.
- **Unknown outcomes.** A throw, `unavailable`, `rejected: unavailable`, or a
  malformed or mismatched reply means the outcome is unknown. The request is
  kept with its request id and code.
  - While a request is kept, a new code for any action is refused, and the
    console points to `retry`. `retry` resends the same id and code.
  - `recapture` with a kept request warns: "Recapture ends the pending
    Retry. …"
  - Definitive refusals, a mismatch and a lock all drop the kept request.
- **Mismatch.** The copy is generic: "That code doesn't match the snapshot
  under review now. Nothing was recorded."
  - It shows the current shape and capture prefixes, the revision and the
    attempts left.
  - It never echoes the code, and never says whether the code was stale, for
    another action or mistyped.
- **Echo.** The echo comes from the committed reply: action, prefixes,
  revision.
- **Output.**
  - Output is only fixed copy, 12-hex prefixes of validated digests, and
    integers.
  - Raw input and authority-supplied text never appear in it.
  - A reply with extra text in a digest or code is treated as malformed, and
    the outcome is unknown.
