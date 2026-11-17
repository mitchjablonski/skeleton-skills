# Control-terminal input parser (#151)

Status: **disabled prototype.** `lib/strict-control-input.mjs` is pure,
imports nothing, and nothing in `lib/` or `bin/` loads it. It doesn't make a
terminal trusted. Raw mode, terminal ownership, human origin and output
escape filtering are separate gates (see
[strict-protected-bootstrap.md](strict-protected-bootstrap.md), N6–N8).

## What it does

It turns raw terminal bytes, delivered in arbitrary chunks, into whole-line
events for the console ([strict-control-console.md](strict-control-console.md)).
The console still interprets commands and normalises codes. The parser never
calls the authority.

```js
const input = createControlInput();      // maxLine defaults to 200, may only be lowered
input.push(bytes)  // -> frozen array of events
input.end()        // end of input: an unfinished line is rejected, never submitted
input.reset()      // drop all state silently
```

Events are frozen and exact:
- `{ type: "line", text }`: a validated line, at an Enter typed outside a paste;
- `{ type: "rejected", reason }`: one per bad line, at its Enter or at `end()`;
- `{ type: "interrupt" }`: Ctrl-C (the line is also cleared).

Reasons are generic and never contain input: `unsupported-byte`, `escape`,
`paste-content`, `malformed-paste`, `overflow`, `incomplete`.

**Trust assumption.** Bracketed-paste markers are framing supplied by a
trusted terminal. They don't prove that a human pressed Enter, and the parser
is no defence against synthetic input written to that terminal; that is the
terminal-isolation gate's job.

## Rules

- **Nothing is emitted before the whole line is validated.** So an invalid
  suffix can never follow an accepted prefix.
- **Typed input.** Printable ASCII (0x20–0x7E) is appended. Enter is CR or LF,
  and CRLF counts once, including across chunks. Backspace (0x08) and DEL
  (0x7F) delete the last character; Ctrl-U clears the line. Any other control
  byte, any non-ASCII byte, or any escape sequence other than the paste
  markers rejects the line.
- **Bracketed paste** (`ESC [200~` … `ESC [201~`). The markers may span any
  chunk boundary. Pasted bytes must all be printable ASCII. A pasted newline,
  CR, tab, ESC, C1, DEL or non-ASCII byte rejects the whole line, so a
  multi-line paste can never become several commands. **Pasting never
  submits;** an Enter typed outside the paste is required. A start marker
  inside a paste, or an end marker outside one, rejects the line.
- **Nested pastes are counted.** An inner end marker never resumes typed
  input inside the outer paste; the paste ends only when the depth returns
  to zero, and the whole line is rejected. Nesting deeper than 8 **latches**
  the parser: everything is discarded until `end()` or `reset()`.
- **Inside a paste, Enter and Ctrl-C are paste content.** They reject the line
  and never submit or interrupt, because pasted bytes can't be trusted to
  signal anything. A paste ends only at its end marker, `end()` or `reset()`.
  Printable pasted bytes keep filling the line until it overflows. A host
  should call `reset()` on its own timeout so an unclosed paste (including a
  hand-typed start marker) can't leave the console stuck.
- **Broken escape sequences.** A prefix that turns out not to be a paste
  marker rejects the line and its bytes are dropped. The byte that broke it
  is judged afresh: `ESC ESC[200~` still starts a paste, and Esc followed by
  Enter or Ctrl-C still submits the rejection or interrupts.

## Limits

| Item | Bound |
| --- | --- |
| Line buffer | at most `maxLine` characters (200, the console's limit); longer is `overflow` |
| Escape buffer | at most 6 bytes (the marker length); a non-marker prefix is dropped at once, and the byte that broke it is re-judged |
| Unclosed paste | no buffering beyond the line limit; bytes are judged one at a time |
| Paste nesting | depth at most 8; deeper latches until `end()`/`reset()` |
| Chunk | at most 16384 bytes per `push`, checked by the intrinsic length before any copy. Only a real `Uint8Array` (or Buffer) is accepted, checked by the intrinsic `Symbol.toStringTag` getter. Bytes are copied through intrinsic `buffer`/`byteOffset`/`byteLength` getters into a fresh array, without species, iterators, `constructor` or own-property lookups. Other typed arrays, proxies, array-likes and strings throw `TypeError` |

## Recovery

- **API errors latch.** A chunk that isn't a `Uint8Array`, is too large or has
  a detached buffer throws, clears the line, and makes every later `push`
  throw until `end()` or `reset()`. A valid prefix is never kept across an
  error.
- **Options** must be omitted or a plain object whose only key is an own
  data property `maxLine`; anything else throws `TypeError` (no getters run).

- After a rejected line, the next line starts clean.
- Ctrl-U clears a poisoned line without a rejection event.
- `end()` reports one `incomplete` if anything was pending, then starts clean.
- `reset()` drops everything without an event.

## Tests

`test/strict-control-input.test.mjs` feeds every vector whole, byte by byte,
and split at every offset, and requires identical events from all three. It
also checks the bounds, the event shapes and the isolation guard.
