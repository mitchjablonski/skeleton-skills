# Strict directory manager (bootstrap step 2)

`lib/strict-directories.mjs` is a **disabled prototype**. Only
`test/strict-directories.test.mjs` imports it, and no launcher uses it. It
implements the contract's "Durable history versus scratch" rules
([strict-protected-bootstrap.md](strict-protected-bootstrap.md)).

## Durable history

`prepareDurableHistory(root, { firstEnrollment })`:
- **Reopen (the default).** The root and its `authority/` and `captures/`
  subdirectories must already exist, be private and be ours. Nothing is
  created. Missing or incomplete history refuses, so a new history is never
  started silently.
- **First enrollment** (`firstEnrollment: true`). The root must not exist,
  and that includes a dangling symlink. The layout is created with mode
  `0700`, and the root and its parent are fsynced.

## Scratch

`createScratch(path, { durable })` creates exactly that directory, fresh.
- An existing path or a dangling symlink refuses.
- It must not overlap durable history in either direction.
- The returned handle **keeps the directory open** until removal. That pins
  its inode, so a directory recreated at the same path can never pass the
  identity check.

`remove()` deletes the scratch only if the path is still the directory that
was created. Otherwise it returns `{ removed: false, retained, reason }` and
leaves everything in place:
- `scratch-replaced`: swapped for a symlink or another directory;
- `removal-failed` or `removal-unproven`;
- `scratch-overlaps-durable`.

Durable history is never touched. `retain()` releases the handle and keeps
the scratch.

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

Every refusal is a `DirectoryRefusal` with a fixed `code`, and includes no
path or input in the message.

## Limits

- It doesn't detect rollback. Anti-rollback is a separate gate (X11).
- It checks a crashed holder's lock only through the stores'
  `inspectAuthorityStore`. Recovery after a crash goes through the
  outside-host process.
- It isn't wired into any launcher. The runtime-integration inventory
  (#184) lists what still depends on it.
