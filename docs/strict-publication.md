# Strict publication specification (#99)

Status: SPEC ONLY. No implementation, activation or selected product contract.
The user-facing choice between managed publication and ordinary-checkout export
remains **OPEN**; Claude will take that choice to the user. The managed contract
below is concrete enough to implement if selected, not authorization to select it.
This specification extends [V2 authority](strict-protocol-v2.md) and
[private captures](strict-capture-store.md); neither already implements publication.

## Two output contracts

**Managed version publication.** The outside host owns a private managed root,
immutable version directories and a single `current` reference on a verified local
Linux filesystem. Import is explicit and leaves the original checkout untouched.
Each run receives a bounded ordinary copy in a disposable writable stage; no
hardlinks into immutable storage. A version manifest binds exact included paths,
raw bytes, supported modes and coverage-policy identity. Its canonical digest is
`outputVersion`; the host verifies content before installing that immutable ID.
Strict state lives outside the project. The first profile omits `.git`, supplies
dependencies separately read-only, and refuses unsupported files, links, mounts
or metadata rather than copying unreviewed exclusions into output.

Publication selects that installed version through one atomic host-controlled
replacement of `current`, followed by parent-directory sync. The pointer contains
project identity, publication ID, sequence and outputVersion. Consumers resolve
through the host, validate the binding and pin one version for their entire read;
repeated path lookups through a moving pointer are not a consistent snapshot.
Clients needing a fixed directory reopen between publications. No independent
authority field can override the recovered pointer selection.
The managed root and raw pointer are not a consumer read interface. The host
serializes selection resolution with publication and blocks new resolutions while
an intent is pending, including after pointer replacement. It exposes the new
selection only after parent sync and durable completion. Readers already pinned
to a previously completed immutable version may finish against that version.

**Ordinary-checkout export.** The host produces an explicit patch/archive or an
explicitly requested merge into an identified checkout, with recorded base and
exact output identities. A patch/archive receipt means artifact creation, not
application. Applying an export requires a fresh base/conflict check and exclusion
of concurrent checkout writers. Ordinary multi-file copying is not atomic;
partial application must be reported and recovered under the export contract.
Git commits or branch updates do not atomically replace a dirty working tree.
Export cannot claim managed publication semantics merely because its source was
immutable. The product decision must specify artifact-only versus checkout
application, conflict handling and recovery before implementing this alternative.

## Preconditions and identities

Before capture, stop accepting requests, revoke/drain run transports, terminate
the whole dedicated process namespace using a stable process handle, and verify
all contained writers have died. Waiting for the CLI or shell alone is insufficient.
Close host write descriptors and finish all import/test workers. Exclude outside
editors, escaped processes, outside MCP writers, passed write descriptors,
unhandled async I/O, interop and unsupported filesystems. Unknown writer lifetime
refuses the checkpoint. Human review occurs only after this verified quiescence.
Copy the stopped stage into private storage and independently capture/validate
that copy. Subsequent tests run against disposable clones, never that candidate.

The approved skeleton remains `(approvedVersion, approvedCaptureVersion)`.
Finalize checks its shape, all permitted step-body transitions and completion
against that retained approved capture. Final filled bytes require a distinct
`finalCaptureVersion`; they must never overwrite or masquerade as the approved
capture. A proposed host publication record binds project/session/round,
approved pair, finalCaptureVersion, outputVersion, coverage policy, verified
completion/check evidence, publication/request ID, predecessor publication and
sequence. These are proposed publication fields, not additions already supported
by V2 envelopes. A finalized V2 reply alone does not assert publication.

## Commit and recovery contract

A single outside host serializes publication for each project. Retained request
IDs bind the entire publication intent; identical retries return the recovered
outcome and differing reuse refuses. The host first durably installs and verifies
the final capture and immutable version. It then durably journals an authenticated
intent naming the expected old pointer and exact new pointer, atomically replaces
`current`, syncs its parent, and durably records completion before returning a
success receipt. Authority finalization and pointer replacement are separate
operations: recovery reconciles both, and never interprets one as proof of the
other. A pending operation exposes neither a new selection nor a successful
publication receipt; the resolution barrier remains held through completion or
refusal and across recovery.

| Crash/failure boundary | Required recovery |
|---|---|
| Before candidate/capture durability | No publication; quarantine incomplete objects; recapture only through a new verified operation. |
| Durable objects, no intent | Unselected orphan; never infer approval or select it automatically. |
| Durable intent, pointer still old | Validate intent, predecessor, all referenced objects and authority facts; if valid, complete the exact authorized replacement, parent sync and completion record. Missing or invalid facts refuse; recovery does not choose whether to publish a valid intent. |
| Replacement occurred, parent sync uncertain | Block selection resolution, inspect the persisted pointer after restart and validate the intent, predecessor, objects and authority facts. For exact old/new states with valid evidence, complete the exact authorized replacement if needed, parent sync and completion record. Otherwise refuse. No success inferred from an interrupted syscall. |
| New pointer durable, completion absent | Block selection resolution, validate exact intent/new pointer, referenced objects and authority facts, and append durable recovered completion before exposing the selection; preserve the same publication/request identity. Missing or invalid evidence refuses. |
| Completion durable, response lost | Exact retry returns retained success; never publish twice. |
| Missing/corrupt object, unexpected pointer or conflicting journal | Refuse reads/publication requiring that state; require explicit outside-host investigation. Never rebuild authority from live files. |
| Export interrupted mid-application | Report partial checkout application; use recorded base/output and explicit export recovery, never a managed success receipt. |

Recovery runs before admitting any reader resolution or new publication. A valid
pending intent must deterministically complete its exact authorized selection;
missing, invalid or conflicting evidence refuses resolution and publication
requiring that state. Recovery cannot expose a pending selection, substitute a
different output or treat the old pointer as cancellation of a valid intent.
No automatic rollback, temporary-file promotion or garbage collection is implied.
Retention must preserve every object needed by pending intents, selected versions,
receipts and recovery; reclamation needs a separate reviewed policy.

## Trust and acceptance

Host code, ancestors, stores, journal and pointer remain unreachable from the
agent boundary, including through descriptors and sockets. Same-UID chmod alone
is not isolation. Authentication of the protected human channel is required;
valid envelopes, terminal nonces and capture hashes are not human authentication.
Host compromise/root and rollback of the entire host backup remain outside the
provided protection. A local authenticated journal detects tampering only within
its trust assumptions; antirollback needs an independent monotonic trusted anchor.
Crash/fsync evidence applies only to the measured kernel/filesystem/storage
profile, not universal power-loss durability. Review evidence does not prove a
human read the bytes.

Acceptance before any publication claim requires a reproducible fixture run:

- Verify whole-namespace teardown against daemonized grandchildren, tool servers,
  long-running writers and PID reuse; missing evidence refuses capture.
- Approve exact persisted skeleton bytes through the protected channel; restart
  fresh for fill; reject exterior/member/mode drift and unauthorized body edits.
- Capture exact final bytes separately, verify completion, isolate test writes,
  and demonstrate that the immutable version cannot change through agent aliases.
- Inject every crash boundary above, including lost replies; verify deterministic
  request replay, refusal of corrupt/missing objects and consistent pinned reads.
- Pause after pointer replacement and before parent sync/completion; verify new
  reader resolutions remain blocked, previously pinned readers retain their old
  version, and restart completes valid intents before admitting any resolution.
- For managed selection, prove old-or-new atomic pointer visibility and durable
  recovery on the selected profile. For export, demonstrate base conflicts and
  partial-application reporting under the explicitly chosen export contract.

A deterministic mock-provider vertical slice is useful evidence, not real-user
activation. Production additionally requires actual client/profile adversarial
checks, protected human-channel deployment and broker credential/network/spend
limits. The output-contract decision and those gates remain explicit blockers.
