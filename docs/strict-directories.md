# Strict directory manager (bootstrap step 2)

`lib/strict-directories.mjs` is a **disabled prototype**. Only
`test/strict-directories.test.mjs` imports it, and no launcher uses it. It
implements the contract's "Durable history versus scratch" rules
([strict-protected-bootstrap.md](strict-protected-bootstrap.md)).

**Threat model.** The agent can't reach either directory: that's N9. A
same-uid process that is still running can always race path operations.
That is why scratch removal requires the caller to have stopped every
writer first (the launcher's physical stop comes before cleanup).

## Durable history

`prepareDurableHistory(root, { firstEnrollment })`:
- **Reopen (the default).** The root must hold **exactly** `authority/` and
  `captures/`. Each must be private, ours, not a symlink, on the root's
  device and on an allowed filesystem.
  Nothing is created. Missing, incomplete or unexpected entries refuse.
- **First enrollment** (`firstEnrollment: true`). An exclusive mkdir
  creates the private root. The manager fsyncs it and its parent and returns
  the absent leaf paths. The store constructors create `authority/` and
  `captures/`. An incomplete enrollment is retained for outside-host
  inspection. Reopen refuses incomplete layout, and a new enrollment attempt
  refuses the existing root.
- **Enrollment itself** (the record and its binding) is validated by the
  authority store in step 3, not by this module. A laid-out but empty
  history is not an enrolled one.

## Scratch

`createScratch(path, { durable })` creates exactly that directory, fresh:
- an existing path or a dangling symlink refuses;
- it must not overlap durable history in either direction;
- after creation, the **opened directory** is checked (private, ours), and
  the path must still name it. The filesystem is checked on both the parent
  and the new directory;
- a failure during creation closes the handle. Cleanup removes an empty
  directory only if the path still identifies the pinned directory;
- the handle **keeps the directory open** until removal, which pins its
  inode.

`remove({ writersStopped: true })` refuses until the caller asserts that
every writer into the scratch has exited. It then rechecks the ancestors and
requires the path to still be the directory that was created. It deletes
with its own walk, which **unlinks symlinks without following them** and
refuses to descend onto a **different device**. A bind mount of the same
filesystem shares the device. Keep the mount namespace stable and free of
nested mounts before removal.

Any other outcome returns `{ removed: false, retained, reason }`. A failed
walk can leave a partially cleaned scratch. The reason is one of:
- `writers-not-stopped`;
- `unsafe-ancestor`;
- `scratch-missing`;
- `scratch-replaced`;
- `removal-failed`;
- `removal-unproven`;
- `released`.

On a refusal the handle stays held, so `remove()` can be retried.
`retain()` keeps the scratch and releases the handle, and any `remove()`
after that returns `released`. Durable history is never touched.

## Checks on every path

- **Path:** Linux only, absolute and canonical.
- **Ancestors:** every ancestor is a real directory, owned by root or us,
  and not writable by others unless sticky.
- **The directory:** it is ours, private (no group or other permissions) and
  not a symlink.
- **Filesystem allowlist** (`statfs` type):
  - durable history: ext2/3/4, XFS or Btrfs only;
  - scratch: those, plus tmpfs.

  WSL's `/mnt/*` (9p/drvfs), NFS, SMB and FUSE are refused.

Every refusal, including a wrapped filesystem error (`io-error`), is a
`DirectoryRefusal` with a fixed `code`, and includes no path or input in the
message.

## Limits

- It doesn't detect rollback. Anti-rollback is a separate gate (X11).
- Removal is only safe once writers have stopped; it can't defend against a
  live same-uid writer.
- It isn't wired into any launcher. The runtime-integration inventory
  (#184) lists what still depends on it.
