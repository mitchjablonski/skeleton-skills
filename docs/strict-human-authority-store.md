# Private human authority storage candidate

Status: **disabled trusted-host prototype** for #124/#99. This adapter persists the pure `candidate-no-recapture-reset-v1` record. No CLI, hook, listener or console uses it. It supplies neither human authentication nor the protected boundary for its keys, source, dependencies or directory. H3 and strict activation remain unadopted.

## Construction and public methods

`createHumanAuthorityStore(directory, {state, policy}, protectedDependencies)` enrolls a fresh V2 skeleton at revision zero. The directory must not exist. The initial selected capture must already be in the protected immutable capture store and match both digests. Creation samples an independent 32-byte key and epoch ID; failure does not justify automatic retry with a new enrollment.

`openHumanAuthorityStore(directory, {projectId, sessionId}, protectedDependencies)` opens that exact enrolled context. It never creates missing records, imports old V2 history, replaces a missing key or resets counters. Legacy `authority.json`, mixed namespaces, corrupt records and context mismatches refuse. This is a new format, not an in-place migration.

The frozen handle exposes only:

```js
verifyAndCommit({action, code, requestId})
recapture({requestId})
endSession({requestId})
state()
```

Method inputs are the existing exact codec envelopes. They accept no facts, state, keys, context, timestamps, observer, destination, raw V2 intent or durability options. Malformed input refuses before any lock or effects. Mutation failures return fixed `rejected/unavailable`; a failure may follow a commit, so retain and retry the original request ID after outside storage-health review. Exceptions from protected dependencies are not returned as diagnostic text.

`state()` returns only `{phase, revision, reviewVersion, captureVersion, admissions}`. It exposes no key, code, epoch or command history and performs no transition, capture, issuance or counter reset. Read failure returns unavailable. Its admission field is not the existing console state contract; console integration requires a separate review.

## Protected dependencies

Construction captures synchronous host-owned functions once:

- `captureStore.get(captureVersion)` and `.put(capture)` are the immutable durable capture-store operations.
- `observeUnderLock()` returns an independently observed stored-capture manifest from a host-owned quiescent or immutable source. It is not called with worker facts or command data.
- `clock()` supplies the canonical UTC string, defaulting to the host clock's ISO representation.
- `roundId()` and `epochId()` supply protected opaque identities, defaulting to `crypto.randomUUID`.
- `keyBytes()` supplies exactly 32 independent private bytes, defaulting to `crypto.randomBytes(32)`. Fixed public fixture keys are test-only.
- `storageOperations` is the existing trusted fsync/rename fault-injection seam, never a request flag or production bypass.

These handles are privileged capabilities, not an authentication mechanism. The future service must authenticate its channel before calling the adapter and keep the implementation, handles, keys and store inaccessible to the worker. Synchronous observation is a host contract; this module cannot prove bounded execution or freeze a mutable workspace.

## One-record transaction

The fixed internal backend writes only `human-authority.json`, sharing the existing holder/lock and durability protocol. No request chooses a filename or supplies a writer callback. The legacy `authority.json` adapter keeps its separate format and public API.

Each operation takes the sole lock and rereads the complete human record, checks its enrolled context, then calls the shared pure preparation helper. Preparation and final planning use the same eligibility/code/cap rules; `unavailable` is never interpreted as permission to observe.

Exact request lookup precedes current admissions, phase, counters, capacity, keys and new effects. An exact retry returns the retained original result/time/pair. Changed reuse refuses without replacing its entry. Neither path calls the observer, clock, round/epoch generator or key generator. Before acknowledging a historical result, the adapter validates its referenced immutable captures and completes the file, directory and parent durability barriers. Missing or tampered blobs return unavailable without altering the old result.

A new no-core outcome (mismatch, lock, precondition refusal, capacity result or logical end) gets one host timestamp, with no observation or new key. Its complete result and counter/liveness effect are journaled together when command capacity permits. Command-full cannot reserve a new ID, including a new end request, but historical exact retries still resolve.

An eligible core operation validates existing selected/approved capture references, observes under the same lock, validates and durably publishes the resulting capture, then derives its V2 facts. It never obtains a raw store handle or calls `store.submit`. Capture publication precedes every new authority reference; an orphan capture after a later fault is acceptable and is not garbage-collected automatically.

The existing pure V2 planner supplies a preflight for the exact prepared intent and those facts. Only a committed Reshape preflight generates a fresh key and epoch; other results consume no key or epoch. A proposed round ID may be generated for an eligible matched Reshape before preflight, but is installed only by a committed transition. The final human planner must produce the same V2 record as the preflight.

The whole next envelope—commands, original results, V2 history, counters, epochs and admissions—is replaced atomically as one file. Temporary write/fsync, rename, record-directory sync, own lock cleanup, and directory/parent sync must complete before any answer escapes. Historical/nonpersisting outcomes also resync the record. Any failed barrier returns unavailable, even if the new file is visible.

## Policy and recovery

Changed and unchanged Recapture retain round/key/counters. Approve also retains counters. Only committed Reshape changes round/key and resets round failures; session failures remain. A capped decision uses `unlock: 'new-session'`. A restart or reenrollment attempt is not an automatic recovery/reset mechanism.

`endSession` returns `admissions-revoked`: it closes new decision admission and journals the original answer. It invokes no supervisor and proves no process died. The independent supervising host must retain a physical stop path even when the command ledger is full. Do not turn this reply into the existing console's `ended` reply or use it to satisfy capture/check/restart teardown gates.

A leftover holder lock always refuses writers. There is no expiry, automatic unlink, temp promotion, repair, journal eviction or key regeneration. Stop writers, reconcile unknown outcomes and inspect storage health through the protected outside-host recovery process before deliberate cleanup. Never reenroll an existing directory to bypass refusal. A successful later fsync is not proof that earlier writeback errors were harmless.

Only Linux local-filesystem directory-fsync behavior is supported by this candidate. Tests of injected failures and process reopen are not power-loss or storage-device qualification. Hostile same-user path swaps, rollback/integrity protection, protected channel/enrollment, real capture quiescence, supervisor evidence and production storage recovery remain separate gates. No real credentials, network admission, publication or strict activation follows from this adapter.
