# Trusted-host authority storage prototype (#76)

`lib/strict-authority-store.mjs` adds filesystem persistence to the pure planner.
No CLI, listener or hook loads it. It is not a private-authority boundary by
itself: the outside host must own the directory and all ancestors, authenticate
callers and compute trusted facts. Same-user hostile path replacement, content
capture/commit races, anti-rollback and live evidence remain unresolved.

## API and durability

- `createAuthorityStore(directory, initialState)` is explicit new enrollment.
  The directory must not exist. Creation failure leaves any effects for deliberate
  recovery; it never removes or overwrites an existing enrollment.
- `openAuthorityStore(directory)` requires an existing valid record. Missing,
  corrupt, symlink and nonregular records refuse. The host must never turn an
  open failure into automatic creation or infer enrollment from public files.
- `store.submit(intent, trustedFacts)` exclusively creates a lock directory,
  re-reads and validates authority while locked, then plans the transaction.
  Existing locks refuse with `unavailable`; no expiration or automatic cleanup.
  The lock records its holder's PID, boot ID and process start time durably.
  Normal completion removes this invocation's lock; a crashed holder's lock stays.
- A changed record is written to an exclusively created temporary file, fsynced,
  renamed over the record, and the directory is fsynced. Before any result is
  returned, the store directory and its parent are synced, including on exact
  retries. This also closes a failed initial enrollment-parent sync on recovery.
- Any write/sync/lock failure returns `unavailable`. It can follow a rename;
  retry the same request ID after host recovery. Never infer that nothing committed.
  Retried committed records are re-synced before returning the retained result.

Only Linux is accepted. Local-filesystem fsync semantics must still be verified
for each supported profile; there is no network/mounted-filesystem durability
claim. No weaker Windows fallback is provided. The injected fsync/rename operation
seam is trusted-host test dependency injection, not a request flag or public API
for bypassing durability.

Directory and record ownership must match the effective user, without group or
other write access. Ancestors must be root/user-owned, non-symlink directories,
without group/other write except sticky shared ancestors such as `/tmp`. These
checks catch misconfiguration; they do not close hostile path-swap races or
replace the launcher boundary.

## Outside-host recovery

`inspectAuthorityStore(directory)` never mutates the store. It reports an absent,
held, abandoned or unknown lock, holder identity, and validated temporary-file
name candidates. Boot/start-time checks avoid treating a reused PID as the
original holder. A missing/invalid holder is unknown, not safe to expire.

1. Use the trusted outside control channel. If the matching holder is live, wait;
   never remove its lock. Stop all authority writers before any manual recovery.
2. Investigate unknown holders. Even an abandoned hint is not authorization to
   delete: reconcile the current record and any unknown request outcome first.
   Missing/corrupt authority still refuses; do not bootstrap or promote a temp.
3. With writers stopped and the complete record validated, the host operator may
   remove only the abandoned lock's `holder.json`, then its empty lock directory,
   and individually verified orphan `.authority-<uuid>.tmp` files. Never delete
   `authority.json`, its journal, or the enrollment to bypass refusal.
4. Reopen and retry the original request ID. The adapter re-reads and re-syncs
   before reporting a retained result. No automatic lock cleanup or temp promotion
   is implemented. Journal-full recovery/compaction remains a separate design.

After real filesystem I/O errors, the host must stop submissions and investigate
storage health before retrying. A later successful fsync is not an independent
proof that earlier writeback errors were harmless. Supported filesystem/error
semantics and host quarantine policy remain production-integration gates; the
fault-injection tests do not simulate power loss or establish those properties.

## Scope of the tests

Tests cover reopened committed/rejected retries, explicit create/open refusal,
stale-lock preservation, symlink/nonregular records, competing processes and
injected failures before/after rename and during file/directory/enrollment-parent
sync. They demonstrate filesystem adapter behavior on the tested Linux runtime,
not power-loss testing or a protected storage location.

Restoring an older valid record can still forget request IDs. This adapter has
no independent monotonic generation/anti-rollback mechanism. The enrollment
registry, session lifecycle, journal compaction, outside human listener and
whole-agent protection remain gates before strict activation. Source observations
are not made atomic with workspace edits by this storage lock.
