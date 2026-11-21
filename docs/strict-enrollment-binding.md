# Binding protected launch to an enrollment (#178)

**Disabled design for #124 and #99.** This proposes a host-side prerequisite
for the readiness check. It grants no strict activation, supported profile or
human authentication. The existing descriptor fixture checks public state
consistency. The acceptance cases below are requirements for independent
launcher tests.

## What the launcher must establish

Before starting any helper, the trusted launcher selects the intended
`{projectId, sessionId}`, private durable history location and protected
dependencies from its own enrollment configuration outside the agent. A
workspace path, environment supplied by the agent, peer reply or record
discovered at the candidate location cannot supply the expected identity.
The launcher checks the private directory's ownership, restrictive mode
(0700), filesystem and separation from agent mounts. Scratch is fresh per
launch and has a separate lifetime. Only the designated authority opens the
private authority record. Keys, codes, tokens and tab bindings stay out of
enrollment, session, handoff and diagnostic metadata.

The launcher must associate the intended enrollment with one supervised
authority child incarnation, its successful store open, and one end of the
specific unnamed socketpair it created for that child. It retains host-owned
references sufficient to establish socket and process identity through
handoff and supervision. A pathname, descriptor number, PID, reported
project/session label or allowlisted reply cannot establish that chain.
The control end goes once to the intended supervised console. Consume the
handoff once, close unintended descriptor copies and prevent inheritance
across exec except at the designated peer. Retaining provenance must never
keep a stray peer descriptor alive and mask disconnect. Neither the agent
nor a named rendezvous can supply a replacement endpoint.

Separate **staging a descriptor** in the trusted console from **admitting
commands** from its terminal. Staging can happen before open is confirmed
only if the console is still in bootstrap and can issue just the readiness
call. The launcher must establish the intended enrollment, child and pair
before staging. A confirmation from that console is needed before the
launcher permits commands or agent admission.

## Proposed bootstrap order

1. Perform protected-bootstrap preflight and establish the private locations
   and expected enrollment above. On explicit first enrollment only, store
   the initial immutable capture before creating the authority store with
   matching full V2 state and policy in a previously absent store directory.
   Never convert a failed open or partial creation into a fresh enrollment.
2. Create the unnamed pair and bind this launch's one-use handoff to its
   peers. Start the pinned, trusted authority child with the designated
   endpoint and expected context. Its only serving path on reopen must
   successfully call `openHumanAuthorityStore(directory, expectedContext,
   protectedDependencies)` and attach the returned handle to that endpoint.
   The analogous first-create path checks its selected context before serving.
   A failed open exits without serving, even if another store is available.
3. Stage the other end in the intended bootstrap console and perform the existing
   `state()` call there. With the child and endpoint provenance already
   established, a successful call confirms progress past the open in that
   particular trusted child. Process creation, elapsed time, an unrelated
   helper's success or a reply from an arbitrary Duplex cannot confirm it.
   The launcher needs a protected way to observe the designated console's
   result. The console keeps that client's sequence state after the check.
   A launcher must not spend sequence 1 itself and pass the same stream to a
   fresh console client. The [launcher binding fixture](strict-launcher-binding-fixture.md)
   exercises an inherited console-to-launcher report pipe. The supported-runtime
   reporting mechanism remains open.
4. Compare the exact allowlisted `phase`, `revision`, `reviewVersion` and
   `captureVersion` with the launcher's independently expected values and
   require live admissions. Missing, unavailable, malformed, revoked or
   mismatched state refuses launch. Even a byte-identical match says nothing
   on its own about enrollment or human presence.
5. Complete listener and other bootstrap gates. Under supervision, check
   that both original peers and this binding remain valid immediately before
   agent admission. An observed loss cancels admission. A peer can exit
   between that check and spawn or immediately afterwards. Invalidate the
   binding and physically stop the whole agent namespace on loss, including
   an agent racing with cancellation. Confirm teardown independently of any
   authority response. Cleanup uncertainty retains scratch and refuses success.

The host-side `lib/strict-launch-admission.py` gate implements the state and
spawn ordering for a single owned generation. It snapshots the selected
state, checks enrollment and pipe provenance by launcher object identity,
consumes each report at most once, and requires verified materialization of
the exact capture pair. It checks peer liveness again before spawn. The
stored-capture and namespace fixtures exercise this gate. A supported
launcher still needs to establish the objects and pipe outside the agent,
apply the other bootstrap gates, and supervise a namespace after spawn.

Prefer this fixed open-before-serve order because it uses the existing four
operations (`state`, `verifyAndCommit`, `recapture`, `endSession`). The
order gives evidence only when the launcher controls the code path, child
and pair. If a chosen launcher cannot observe that sequence, refuse. A
separate private child-to-launcher readiness acknowledgement could report
open completion, but its provenance, lifetime, one-use delivery and failure
vectors need independent cross-review before implementation. This proposal
adds no wire field, handshake, fifth operation or production entry point.

## Peer loss, recovery and planned restart

Latch any authority or console fault for this run. Invalidate every
outstanding handoff for the failed peer and reject delayed ready reports.
Stop independently of revocation, keep admissions unknown until confirmed
and preserve durable history. No automatic failover or fallback starts an
agent. With the current four methods, keep a lost result unknown after
authority loss, even if it was committed. Use outside-host reconciliation
without sending the command again.

Once an independently reviewed **history-only guard** exists, the launcher
may attempt one protected reopen to reconcile the exact retained request
against the same enrollment. Re-establish the child, pair and successful
open. Observe a readable `state()` from the bound peer before considering
reconciliation. Revoked admissions still forbid launch but can coexist
with an existing recorded result.

The authority must resolve only a committed entry matching the original
operation, arguments and request ID, under the authority's protection.
Absence, mismatch or uncertainty refuses. The existing four operations do
not offer lookup-only semantics: submitting the same request without a
journal entry can make a fresh observation and commit. Do not use an
ordinary retry on a faulted reopen. A separate, independently reviewed
history-only guard that cannot race a mutation is required before this
protected path can be enabled. Until then, preserve the unknown outcome and
use outside-host reconciliation. A leftover holder lock or unhealthy
storage also requires that recovery. A historical result resolves that
command alone.

Loss of the console can lose the in-memory request. Never invent an ID,
overwrite a record, regenerate a key or issue a replacement decision.

A healthy planned #99 checkpoint keeps the authority and console processes.
Prove the old namespace quiescent and complete the checkpoint gates before
starting a fresh agent namespace from the verified stored approved bytes.
A fresh state check must still agree with the expected checkpoint even when
the same healthy peer connection is preserved.
The [stored capture admission fixture](strict-capture-admission.md) exercises
that sequence with an owned leaf and the existing authority and console.
A planned replacement connection between the same healthy peers still needs
a freshly created pair, one-use handoff and readiness check. A previous
connection's sequence or readiness cannot carry forward. An actual peer
fault, unproven teardown or unreadable approved capture forbids restart.

## Independent acceptance cases

Use two private enrollments with different identities and identical public
state. Record launches with an independent child-start marker, stops with a
namespace census and history changes by comparing private record and capture
bytes. Observe peer/open provenance outside the service under test. Pair each
injected failure with a working launch through the same harness.

`test/strict-human-authority-store.test.mjs` covers the storage part of the
wrong-enrollment case for both context fields. Equal public state does not
allow the wrong-context open or a later replacement to satisfy `state()`.
The launcher binding fixture exercises provenance and exact capture for owned
fixture children. The [authority-child adapter](strict-authority-child.md)
adds a separate one-shot recovery fixture around the host history guard.
Both leave supported-runtime supervision and restart open.

| Setup or fault | Required observation |
| --- | --- |
| Correct private location, enrolled child and original pair | Valid state and all remaining gates admit exactly the intended sentinel. Readiness leaves durable bytes unchanged. |
| Select A, give its authority B's store, or substitute B's already-open child and pair | Wrong-context open refuses in the first case. Missing child/pair provenance refuses the second even when B returns exactly A's public state. |
| Replay a consumed handoff or delayed ready report after replacement, including reuse of the numeric fd or PID | No admission. Only the current supervised incarnation and designated pair can satisfy the check. |
| Counterfeit peer answers correctly without opening the intended store | No admission even with well-formed live state. Independently inject open failure into the designated child and verify it never serves. |
| Correct child returns unavailable, malformed, mismatched or revoked state, or never answers | No agent starts. No mutation or fresh enrollment occurs. |
| Exit either peer before readiness, after reply before admission, or racing agent start | Old handoffs become unusable. Observed pre-admission loss yields no start. In the race, any started agent's namespace is stopped and all members accounted for. |
| Lose the authority before or after commit, with the current four methods | No protected command retry in either case. The result stays unknown and the agent stays stopped. The outside-host recovery path is required. |
| Future history-only guard: committed reply is lost before the authority fails | The exact retained request resolves only its recorded result, without new observation, key, timestamp or journal entry. The agent stays stopped. |
| Future history-only guard: authority fails before commit, or history is mismatched, invalid or locked | Reconciliation refuses. The result stays unknown, with no new observation, key, timestamp or journal entry. |
| Healthy checkpoint with different live-workspace and stored approved bytes | After proven teardown only the stored approved bytes seed the fresh namespace. Original authority and console persist. A replacement pair must pass fresh checks. Breaking any gate prevents restart. |
| Missing, mixed, corrupt or wrong-context durable state, or cleanup failure | No overwrite, automatic repair or key regeneration. Preserve history and report unproven cleanup. Inspect exported metadata for secret leakage. |

This assumes trusted host processes and protected dependencies. Directory
permissions and ordered startup do not defend against a hostile same-UID
host process or detect storage rollback. Choosing the control terminal,
qualifying a supported profile, establishing external integrity and
proving the supervisor and reporting mechanisms remain separate work.

Related contracts: [protected bootstrap](strict-protected-bootstrap.md),
[inherited command channel](strict-human-channel-transport.md),
[durable authority](strict-human-authority-store.md) and
[checkpoint outcomes](strict-checkpoint-ux.md).
