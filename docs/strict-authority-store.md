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
