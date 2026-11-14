# Pure private human authority candidate

Status: **disabled pure prototype, not an authority service or adopted H3 policy**. `strict-human-authority.mjs` models a fresh private record and deterministic command planning. It performs no enrollment I/O, key generation, capture, observation, persistence, authentication, listener operation or process termination. The caller must not acknowledge a plan as committed without the separately reviewed one-file durable transaction. Existing V2 store and console APIs remain unchanged.

## Explicit Recapture policy

The sole supported prototype policy is `candidate-no-recapture-reset-v1`. Enrollment supplies positive bounded `roundMismatchCap`, `sessionMismatchCap`, `commandCap` and `authorityCap`; no production values are selected by default.

Both changed and unchanged Recapture preserve the review round, key epoch and mismatch counters. This follows V2: changed Recapture advances revision and selected digests, but never changes `reviewRoundId`. A capped decision returns `locked` with `unlock: 'new-session'`; Recapture cannot unlock it. Successful Reshape installs a fresh round and supplied independent key epoch, resets the round counter, and retains the session counter. Approve also retains the key and both counters, so skeleton failures carry into fill. Restart, exact retry, rejected Reshape and logical closure reset nothing. A matching code followed by a terminal V2 refusal spends a command slot and a core slot, but no mismatch attempt or new epoch.

This selects a rule for this disabled candidate only. It does not adopt the earlier proposal that confirmed Recapture can reset failures. That alternative requires an explicit new round/reset protocol and a separate review. Reenrollment is not an automatic reset operation, and this module cannot prove safe new-session recovery or reconcile historical unknown requests across sessions.

## Pure interface

- `createHumanAuthorityRecord({state, policy, epoch})`: fresh V2 skeleton, revision zero, empty history only. An epoch has `epochId`, `reviewRoundId` and exactly 32 key bytes as lowercase `keyHex`. Keys are host-supplied; consistency is not entropy or origin proof.
- `parseHumanAuthorityRecord(value)` and `replayHumanAuthorityRecord(value)`: return a canonical immutable record or refuse. Replay reconstructs all history rather than trusting serialized counters, current state or claimed effects.
- `prepareHumanAuthorityCommand(record, command)` returns an exact retained result, a no-core disposition, or the exact derived core intent; it exposes no keys or expected code and grants no authority to observe on `unavailable`.
- `planHumanAuthorityCommand(record, command, trustedEffect)`: accepts the exact canonical output of `parseHumanCommand`. Returns `{record, result, persist, replayed}`. A trusted effect supplies canonical `at` and exact `evidence`; it is an internal host input, never a public command field.

Public commands contain only their canonical operation/version, request ID, and action/code where applicable. They cannot supply project/session, revision, pairs, keys, facts or V2 intents. The pure effect seam is not a safe public ingress API.

## Record and replay contract

The exact record contains format `skel-private-human-record-v1`, immutable context and policy, fresh initial authority/epoch, ordered epochs and commands, complete V2 authority history, and derived current epoch/counters/admissions. Each command entry retains its canonical command and full identity bytes, pre-command observed context, evidence, original public result and time. Private key material and input codes must never appear in diagnostics or public state.

Evidence is one of `no-core`, `core` (one derived V2 intent and trusted facts), or successful `reshape` (the same plus the next epoch). The expected intent is constructed from the replay pre-state and must equal any supplied intent. Approve names the selected pair; Reshape names the old approved pair while its host facts install the new selected pair. Only the existing V2 planner decides core transitions.

Every appended V2 journal entry must have exactly one owning command. A mismatch or logical end cannot own a core entry. Replay rejects missing/extra core entries, duplicate request IDs or epochs, altered commands/codes/identities/results/counters, mismatched facts/intents and derived-state disagreement. Historical private keys are retained inside this bounded record so replay can recompute past HMAC comparisons rather than trust a serialized verification flag. This is a deliberate prototype tradeoff, not a key-erasure guarantee; the whole record needs protected ownership. Replay proves internal consistency only; a coherent rewritten or rolled-back record remains outside its guarantees.

## Ordering and capacity

Exact historical request lookup precedes current admissions, phase, attempt caps, key/code comparison, capacity and trusted effects. A matching identity returns its original result; changed reuse refuses without replacing or recounting the original. Code aliases have one canonical identity. Malformed commands reserve no ID.

For a new mutation, command capacity precedes admission and operation checks. A wrong code consumes one command slot and one round/session failure, with no V2 entry. A matched decision or eligible Recapture needs a core slot; a logical end does not. Core-full may be journaled in an available command slot. Command-full cannot reserve a new ID or evict history, but historical retries still resolve. New logical end cannot overflow the command cap; independent supervising-host physical stop must remain available.

The planner never invokes an observer or storage. A future coordinator must authenticate before lookup, observe only eligible new operations under its serialized lifetime, durably publish referenced immutable captures before the record, and commit the complete record before acknowledging. Historical reference integrity checks must not become a new mutable workspace observation or replace the original ledger outcome.

## Logical closure and console boundary

`endSession` here means durable-plan admission revocation, not death: its result is `admissions-revoked`. New mutations after revocation refuse; exact old requests still replay. No supervisor is called. The existing console's `ended` result must not be fabricated from this bit. Console support and read-state admission display require a separately reviewed adapter/change before integration.

The console already accepts lockout guidance `unlock: 'new-session'`. Its alternative `unlock: 'recapture'` remains compatibility for another proposed policy; this candidate never emits it. No console is connected to this planner.

## Disabled storage adapter and remaining gates

The separate [disabled storage adapter](strict-human-authority-store.md) provides the one-file candidate transaction, using shared pure preparation rather than a second writer. It is not runtime-wired or authenticated. Production durability qualification, protected enrollment/channel/key ownership, bounded independent quiescent observation, capture integrity and availability, unknown durability outcomes, storage health/recovery, external antirollback and verified supervisor teardown remain required. No raw V2 submit path may bypass the future private command transaction. No strict activation, publication, real credentials or production containment follows from this module.
