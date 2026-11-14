# Private human command protocol (candidate v1)

Status: **disabled prototype contract for review; H3 is NOT ADOPTED.** This specification and its pure codec/vectors authorize no authority I/O, launcher integration, real human authentication or strict activation. Possessing a code proves neither a human typed it nor that anyone read the capture. The boundary, protected control process, capture publication, integrity, antirollback and recovery gates remain open.

The separate [pure human authority candidate](strict-human-authority.md) pins `candidate-no-recapture-reset-v1` for executable replay tests: neither changed nor unchanged Recapture resets failures or rotates its key. The possible Recapture reset and lifecycle envelope discussed below remain alternative design proposals, not the behavior of that candidate. No durable writer or console integration is implemented by the pure module.

## Ownership and proposed interface

A future private adapter is enrolled for one immutable project/session context. That context is obtained from protected enrollment, never command input, URLs, workspace files or the browser. Its authority owns the current round, revision, selected and approved pairs, key epoch, request ledger and attempt counters. The agent cannot read or write its implementation, store, sockets, PTY or keys. This document does not establish that isolation.

The console-facing interface remains:

```js
verifyAndCommit({ action, code, requestId })
recapture({ requestId })
endSession({ requestId })
state()
```

Only approve and reshape are code actions. Finalize is absent. Records have exactly the listed own enumerable data properties; accessors, symbols, extra keys, inherited-only fields, unsupported types and throwing proxy traps refuse. No command accepts context, revision, pair, host facts, key, epoch, completion flag, destination or a raw V2 Intent. IDs satisfy `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; the trusted console supplies a fresh CSPRNG-derived ID once, retaining it for retries. IDs are correlation/dedupe values, not credentials.

Replies must echo requestId, as required by strict-control-console.mjs. Result variants and fixed copy are the console's proposal interface, not proof that the private adapter exists. Committed replies echo the actual committed action, OLD Intent pair, resulting revision and trusted UTC commit time. Recapture replies echo the actual selected pair and revision. No exception text, notes, paths, input codes, keys or arbitrary provider messages are returned as diagnostic text.

## Key, epoch and issuance

The proposed production key is exactly 32 bytes sampled by the protected host from Node crypto.randomBytes(32), backed by the operating-system CSPRNG. Sampling failure refuses; there is no weaker fallback. Never derive it from IDs, passwords, time, workspace bytes or a previous key. The fixture key is public test data. The pure deriveHumanCode API accepts exactly 32 bytes in a Buffer or non-shared Uint8Array, copies them synchronously and refuses other types, lengths and SharedArrayBuffer backing. It does not generate or persist keys.

A protected key epoch uniquely identifies one independently sampled key for the enrolled project/session/review round. It is separate from the authority revision. Persist the epoch/key, its round association and counters before issuing a code. Restore the same key/counters on ordinary restart. Missing, corrupt or rolled-back enrolled state refuses rather than silently bootstrapping a new epoch. Explicit recovery/reenrollment needs a separate approved operation.

Approve uses the current selected reviewVersion/captureVersion. Reshape uses approvedVersion/approvedCaptureVersion. The protected page may show a reshape code only when the actual rendered selected pair equals that approved pair. A filled-body capture normally has a different raw captureVersion and must not show that code. Issuance returns the code with the exact project/session/round/revision/pair it describes; one coherent protected read supplies the capture and issuance context. A browser is not allowed to choose the context.

## Exact code encoding

The HMAC input begins with raw ASCII bytes `skel-human-code-v1`, with no NUL, terminator or separator. Append these SEVEN length-prefixed fields in order:

| Position | Field | Canonical bytes |
| --- | --- | --- |
| 1 | action | ASCII approve or reshape, lowercase |
| 2 | projectId | Exact enrolled opaque ASCII ID |
| 3 | sessionId | Exact enrolled opaque ASCII ID |
| 4 | reviewRoundId | Exact authority opaque ASCII ID |
| 5 | revision | ASCII decimal nonnegative safe integer, no sign or leading zero; zero is 0 |
| 6 | reviewVersion | Exactly 64 lowercase ASCII hexadecimal characters, NOT 32 decoded bytes |
| 7 | captureVersion | Exactly 64 lowercase ASCII hexadecimal characters, NOT 32 decoded bytes |

Code-context IDs use existing V2 grammar `[A-Za-z0-9][A-Za-z0-9._:-]{0,255}`. No Unicode normalization is performed. Revision is a JavaScript safe integer from zero through 9007199254740991. Negative zero is refused by this stricter candidate codec; ordinary numeric zero encodes as 0. Each field is UTF-8 encoded after type/grammar validation. Its prefix is its UTF-8 BYTE count as one unsigned four-byte big-endian integer. No JSON serialization participates in this message. No extra epoch field is appended: the epoch chooses the key; changing that rule requires a new approved domain and vectors.

Compute HMAC-SHA256 using the 32 key bytes. Select the first FIVE digest bytes, the first 40 bits in digest/network order. Group bits left-to-right into eight 5-bit unsigned values. Map each value through `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Show uppercase with a hyphen after character four, e.g. QFBF-8QM4. No checksum, modulo reduction, reverse byte order or rightmost-bit truncation is used. The authority compares parsed five-byte code values in constant time after strict validation.

Forty bits provide finite collision/guess resistance. Key secrecy, input isolation and durable rate/attempt limits are mandatory gates; this is no absolute proof against replay or an agent who can reach the control process.

## Normalization and console parity

For an admitted command line, first apply strict-control-console.mjs acceptInput: at most 200 characters, all printable ASCII 0x20 through 0x7e; trim surrounding ASCII spaces. Reject newline, tab, ESC, DEL, C1, non-ASCII and bracketed-paste control markers before normalization. The launcher must strip framing markers safely before handing accepted paste content to the console; multiline content remains refused whole.

For the isolated code token, impose the same 200-character printable-ASCII bound BEFORE processing. Uppercase ASCII letters; remove ASCII spaces and hyphens; map I and L to 1 and O to 0; require exactly eight characters from the Crockford alphabet above; emit XXXX-XXXX. U, punctuation other than hyphen, remaining controls and Unicode refuse. This matches console122's admitted input path, rather than its exported normalizeCode helper's broader standalone whitespace removal. The wire console already sends canonical codes, but the private adapter canonicalizes again so admitted alias spellings have the same identity. Command names, actions and IDs are not case-normalized by the private protocol.

## Canonical private envelopes and identity bytes

The pure codec exposes parseHumanCommand(operation, value), normalizeHumanCode(value), humanCommandIdentity(operation, value), encodeHumanCodeMessage(state, action) and deriveHumanCode(state, action, key). HUMAN_COMMAND_VERSION is human-code-v1. parseHumanCommand takes the called method name and its exact raw argument record; it returns an internal canonical envelope:

```js
{ operationVersion: "human-code-v1", operation: "verifyAndCommit", action, code, requestId }
{ operationVersion: "human-code-v1", operation: "recapture", requestId }
{ operationVersion: "human-code-v1", operation: "endSession", requestId }
```

The future adapter creates the operation discriminator from the called method, never trusts a second caller-supplied operation selector. Its method arguments retain their exact schemas above. Canonical verifyAndCommit envelopes contain normalized code. Recapture and endSession have no action/code fields.

Identity bytes begin with raw ASCII `skel-human-command-v1`, followed by exactly FIVE LP32BE UTF-8 fields: operationVersion, operation, requestId, action-or-empty, normalized-code-or-empty. For recapture and endSession the final two fields are empty strings, each encoded with its own zero-length prefix. Project/session context scopes the ledger externally and is never command input. Thus a request ID reused across operations or with another action/code has a different identity. Use full identity bytes or a full SHA-256 plus retained canonical envelope; never a short hash or code alone. This byte format is an explicit candidate separate from strictIntentIdentity, not a silent V2 extension.

The pure command codec returns canonical data/bytes only. It does not generate keys/IDs, authenticate a channel, access records, derive current-state Intents, accept a command economically or commit any result.

## Journal-first transaction and failure counting

Before lookup, perform bounded envelope validation/normalization and authenticate the immutable private channel. Then hold ONE serialization/storage lock across the operation:

0. Read the complete protected command record and find requestId BEFORE current liveness, phase, round, epoch, code, revision, attempt-cap or host-fact checks. An identical canonical identity returns its stored result without rechecking or recounting. Different identity refuses request-reused without replacing the original. Historical success is acknowledged only after required durability barriers; unreadable records refuse. This precedence also applies after restart, reshape, session end and journal exhaustion.
1. Only an absent ID proceeds. Refuse new IDs if the bounded ledger is full. Check enrollment/liveness, current phase and attempt limits, then capture one current authority state/key epoch. No authority state is obtained from command input. Select the pair by action and recompute the code from that exact state.
2. A new, validly shaped wrong code produces a generic mismatch and atomically journals its result plus ONE failure-counter increment. An exact failed-request retry returns the same outcome and does not count again. A new bad-code ID counts separately. A same-ID differing reuse does not recount or mutate its original entry. Invalid envelopes do not reserve IDs or consume cryptographic mismatch counters; separate bounded ingress/rate controls must prevent malformed-input work from exhausting resources.
3. A match creates an expanded V2 Intent from THAT SAME state, revision and selected/approved pair, using the retained requestId. Independent host facts come only from the protected coordinator. Perform revision CAS and existing transition checks; do not read current state again to fabricate a newer Intent. Publish referenced immutable captures before committing authority references. Atomically persist the authority transition, command result/identity, counters, key changes and lifecycle state before replying. An uncertain durability outcome stays unknown; a reread is not evidence the original request failed.

Candidate limits for later product approval are five mismatches per round and twenty per session, shared across actions/tabs/connections. No restart resets counters. A deliberate confirmed skeleton Recapture may reset round failures, including unchanged capture, but never session failures. Fill unlocking/session replacement requires separately approved lifecycle policy. Caps and their values are not adopted by this specification.

## Candidate protected record wrapping V2

A future schema could wrap, rather than alter in place, the existing V2 authority record:

```text
format: skel-private-human-record-v1
context: immutable projectId/sessionId
authority: complete existing parseAuthorityRecord V2 record
lifecycle: live | ending | ended, with historical unknown-outcome references
keyEpochs: current epoch/key/round and explicit recovery metadata
attempts: durable round and session counters
commands: bounded ordered entries containing canonical envelope + identity,
          observed context/epoch/revision/pair, expanded V2 Intent when relevant,
          original result/time, and counter/lifecycle effects
```

This is a proposed transaction/replay envelope, not an implemented parser or storage format. Validate bounded exact schemas, uniqueness, replay consistency and cross-record references. Candidate shared command cap is 1024 terminal commands, and existing V2 authority journal remains capped at 1024 entries; either cap refuses new work without evicting old results. Mismatch entries consume command capacity even though they create no V2 Intent. Recapture consumes both command and V2 capacity. Capacity and recovery rules need separate approval.

Existing planAuthorityTransaction parses its whole V2 history, journals terminal decisions, and resolves exact V2 retries before current facts/revision checks. Existing store.submit obtains supplied host facts before its internal lock and cannot express code/epoch/counter/lifecycle state. There is no safe implementation by first verifying a code in one store and later calling raw submit in another. The wrapper needs its own validated replay and durable transaction design. Never expose an alternate raw-Intent writer that bypasses the private operation.

## Recapture, reshape, end and read-only state

Recapture is a deliberate confirmed control command on a host-owned quiescent project copy. Persist its capture before its authority reference. Unchanged Recapture retains the authority revision but journals an outcome and may reset round failure allowance; changed Recapture advances revision as V2 specifies. Fill-phase Recapture refuses. Confirmed abandonment of a kept request does not prove it did nothing or erase its historical ledger entry. Recapture has its own ID and exact same-ID recovery.

Reshape already names the OLD approved pair in current strictIntentConflict and review-decision.mjs. Its protected host facts install a NEW selected pair and round; its committed result echoes the OLD Intent pair, not a fabricated current-state Intent. Rotate the round/key epoch and clear approval in the same reviewed transition. A selected fill raw capture differing from the approved raw pair is a page-display mismatch, not permission to change core reshape semantics. New code-carrying private envelopes, record replay and coordinator ordering require separate protocol changes; the existing approved-pair rule must be preserved.

endSession first durably revokes new admissions and records lifecycle ending before asking the supervisor to terminate session processes. It must not claim process death from a ledger bit, a console message, a disconnected socket or a journaled end request. Require independent supervisor evidence for any stopped/dead assertion. Exact end retries return the original journaled outcome; repeated distinct end IDs may request idempotent termination while preserving earlier unknown outcomes. The console remains in its ending gate while termination outcome is unknown. Only a definitive adapter reply may say ended, and its documented meaning must distinguish logical session closure from proven process teardown. A launcher must still refuse capture/check/restart whenever teardown is unproven.

state() has no command envelope/ID and makes no transition, capture, key rotation, counter reset, journal reservation or unknown-outcome reconciliation. It returns a validated snapshot from protected state: phase, revision, selected reviewVersion and captureVersion. It is neither evidence an earlier command committed nor process-death evidence. Its transport may authenticate/read and complete already-required durability barriers, but must not repair/rebuild authority state from workspace bytes. Concurrent console status reads never grant admission or abandon kept commands.

## Recovery and conformance gates

Keep the original canonical request and ID after unavailable/lost/malformed replies. Resend never reconstructs a current-state request. Full ledgers resolve old exact IDs; they refuse new ones. Key loss, corrupt history, storage rollback or failed durability refuses until outside recovery. New sessions cannot relabel historical unknown requests as their own; cross-session reconciliation requires an explicit protected lookup policy. Code/key expiration cannot suppress journal lookup. Closing the control window with a pending request ends the session with its outcome recorded as unknown, not invented as a negative result.

The sibling fixture strict-human-code-vectors.json contains PUBLIC test keys and deterministic message/digest/code vectors plus normalization and private-envelope identities. They pin encoding only. Independent implementations must reproduce complete message bytes, HMAC digest and displayed code, including revision zero/max-safe and aliases. Tests must separately cover wrong types/IDs/hash case, key length, changed context/action/pair, request reuse, failed retry counted once, stale/parallel decisions, full ledgers, unknown storage outcomes, restart/key epochs, end liveness versus teardown, and approved-old versus installed-new reshape pairs.

Nothing here proves protected-channel origin, human intent, containment, real network safety, monetary admission, completion, publication or rollback safety. Mitch retains H3-versus-H0/H1, terminal-versus-native, finalize scope and product recovery decisions.
