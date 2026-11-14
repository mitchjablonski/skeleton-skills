// Trusted outside-host storage only: no authentication, listener, activation,
// hostile same-user path protection, or network-filesystem durability claim.
// The host owns this directory and its ancestors outside the agent boundary.
// This adapter serializes cooperating processes; it cannot make host content
// observations atomic with workspace writes. Never recover a leftover lock
// automatically: the host must reconcile unknown outcomes before removing it.
// Normal completion removes only this invocation's lock and temporary file.
// Ownership/path checks detect misconfiguration, not hostile path-swap races.
import { createAuthorityRecord, parseAuthorityRecord, planAuthorityTransaction } from "./strict-authority.mjs";
import { authorityFile, requireLinux } from "./strict-authority-file.mjs";
export { inspectAuthorityStore } from "./strict-authority-file.mjs";

const unavailable = () => Object.freeze({ kind: "rejected", code: "unavailable" });

function handle(file) {
  return Object.freeze({
    directory: file.directory,
    /** Host must authenticate the caller and compute trusted facts first.
     * Only the Result is returned, after the entire journal/state is durable.
     * unavailable may follow rename: retry the SAME request ID after recovery.
     */
    submit(intent, trustedFacts) {
      try {
        const release = file.acquireLock();
        try {
          const record = file.read(); // always reread under the process lock
          const plan = planAuthorityTransaction(record, intent, trustedFacts);
          if (plan.persist) file.replace(plan.record);
          // A previous process may have renamed then failed directory fsync.
          // Re-durabilize even an exact retry before reporting its old success.
          else file.sync();
          return plan.result;
        } finally { release(); }
      } catch { return unavailable(); }
    },
  });
}

/** Explicit enrollment only: directory MUST NOT already exist. Never replaces
 * an old/missing/corrupt record in an existing directory. On failure, leave the
 * directory for deliberate host recovery rather than pretending creation failed
 * without effects. Local Linux fsync is required; other filesystems need proof.
 */
export function createAuthorityStore(directory, initialState, storageOperations) {
  requireLinux(); // Unsupported hosts refuse before any filesystem operation.
  const record = createAuthorityRecord(initialState);
  if (!record) throw Error("invalid initial authority state");
  const file = authorityFile(directory, parseAuthorityRecord, storageOperations);
  file.createDirectory();
  const release = file.acquireLock();
  try { file.replace(record); } finally { release(); }
  return handle(file);
}

/** Opens existing authority only; missing/corrupt/symlink records throw. */
export function openAuthorityStore(directory, storageOperations) {
  requireLinux();
  const file = authorityFile(directory, parseAuthorityRecord, storageOperations);
  file.read();
  return handle(file);
}
