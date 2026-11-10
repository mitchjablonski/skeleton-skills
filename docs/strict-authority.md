# Strict authority transaction core (#76)

`lib/strict-authority.mjs` is a pure transaction planner. No production command
loads it. It does not authenticate a human, access private files, lock, persist,
serve requests or activate strict mode. Trusted host facts are not credentials.

The outside host will authenticate the human channel and load its private
record before calling `planAuthorityTransaction(record, intent, facts)`.
The returned `{record, result, persist, replayed}` is a plan, not a receipt.
When `persist` is true, the host must atomically and durably commit the entire
record before returning the result. Concurrent host transactions must serialize
and re-read under the same authority lock; pure planning supplies no CAS or lock.

## Record and replay rules

- Explicit bootstrap creates a skeleton-phase, revision-zero record. This is
  for a new trusted enrollment only. A missing/corrupt enrolled record is a
  refusal, never an invitation to bootstrap or infer no skeleton from public files.
- The record holds initial/current authority state plus ordered journal entries
  containing intent, independently obtained host facts, result and state after.
  Parsing replays all entries and rejects inconsistent histories.
- Exact same-ID/intent retries return the original result before current
  revision/content checks. Different intent with a retained ID is `request-reused`.
  Committed results and terminal rejections are retained. Invalid requests,
  wrong-channel attempts and unavailable host facts do not reserve an ID.
- The 1024-entry cap refuses new transactions without pruning. Existing retries
  still resolve. Compaction/session retirement needs a reviewed outside-host
  recovery design; no automatic expiry or silent journal reset is implemented.
- Journal order differs from authority revision: terminal rejection appends a
  result without advancing the phase revision. Commits advance revision once.

Consistency checking cannot detect a coherently rewritten history. OS isolation
and integrity of private storage are still required. JSON serialization/reload
tests simulate restart inputs; they do not establish durable filesystem commits.

## Host facts and transitions

The host supplies `{contentVersion, nextReviewRoundId, completionVerified}` from
its own checked source/verification process, never from request JSON or a public
page. `contentVersion` is the reviewed skeleton's exterior/fence-set version,
not a hash of newly filled bodies. Current content must be rechecked inside
the protected transition's commit protocol to close content/commit races.

Approve requires current reviewed content. Reshape clears approval, rotates to
a never-used round and records the new reviewable content version. Finalize
requires the approved version and independent completion verification. The
caller must not manufacture completion by passing `true` from an agent report.
Refreshing a changed draft's reviewable version, initial registration, strict
migration/reset, session end and snapshot publication remain separate host-side
operations to specify and test; this core does not silently implement them.

## Next implementation gates

1. Private durable storage and serialized atomic journal/state commits, including
   crash recovery, loss/corruption, request-ID retention and explicit enrollment.
2. Whole-agent launcher isolation of that storage/writer and all equivalent paths.
3. Protected listener serving trusted review UI/snapshots on its own origin, with
   browser-origin/CSRF checks and no public feedback-to-authority bridge.
4. Independent content/completion verification, immutable publication and race
   tests, plus authenticated live evidence and actual-client acceptance in #79.

The default CLI/state stores are unchanged. No containment or durable human
approval claim follows from this planner or its tests.
