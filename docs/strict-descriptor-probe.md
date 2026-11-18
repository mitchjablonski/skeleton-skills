# Inherited descriptor fixture (N3, #162 / #124 / #75)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on Linux or WSL2 with system Python and Bubblewrap:

```sh
/usr/bin/python3 -I test/live/strict-descriptor-probe.py
```

## What it shows

A worker inside a Bubblewrap sandbox (`--unshare-all --clearenv
--new-session`) enumerates `/proc/self/fd`. For each descriptor it reports
its type and identity, never a path: the inode for a pipe or socket, and the
device numbers for a char device.

**Allowlist, by type and identity:**
- fd 0 is `/dev/null` (char device 1:3);
- fds 1 and 2 are **the launcher's own pipes**, matched by pipe inode against
  the launcher's read ends.

So a real writable file on fd 1, or another char device on fd 0, is a
violation even though those numbers are allowed.

**Descriptors that can't be inspected count as violations.** The one
exception is the descriptor right after the worker's listing descriptor:
CPython's `os.listdir(fd)` works on a duplicate of it and closes that before
returning. More than one such descriptor also counts as a violation.

| Check | Required |
| --- | --- |
| Strict launch | No violations |
| Passed pipe (positive control) | Exactly that descriptor flagged, as a pipe |
| Passed socketpair end (positive control) | Exactly that descriptor flagged, as a socket |
| Regular file on stdout (positive control) | fd 1 flagged as a file |
| Careless launcher (positive control) | With `close_fds=False`, an inheritable directory descriptor is the only violation. With `close_fds=True`, there are none |
| `--seccomp` program descriptor | The program is loaded, shown by a denied `uname()`, and its descriptor never reaches the sandbox |

**Finding (Bubblewrap 0.9.0):** Bubblewrap passes inherited descriptors
through at the same number, except the ones named in its own options, which
it consumes (`--seccomp` is shown here). Whatever else the launcher passes
in, or leaves inheritable and unclosed, arrives in the sandbox. So the
allowlist has to be **enforced by the launcher**, with explicit `pass_fds`
and closing everything else. N3's check inside the sandbox is the evidence
that it was.

## Output and bounds

The output is bounded public JSON: the allowlist, the observed types, and the
extra descriptors found by each positive control. The exit codes are the
same as the other fixtures:
- **Exit 0:** passed.
- **Exit 1:** a check or positive control failed (the scratch path is
  reported).
- **Exit 2:** unsupported.

## Limits

- **What is measured:** a CPython worker's descriptor snapshot, taken after
  interpreter startup and including the seccomp result. The pinned agent
  runtime (Node), and the descriptors it opens or inherits at its own
  startup, must be measured separately once it is chosen.
- **Ambient descriptors:** before any launch, the fixture makes its own extra
  inheritable descriptors non-inheritable, and counts them. So the
  careless-launcher control carries only the one descriptor it planted.
- **Capability first:** a plain `bwrap … /usr/bin/true` run establishes
  capability. A failing or malformed worker after that is exit 1, not
  "unsupported".

- The launcher is synthetic. A real launcher's descriptor set, including the
  filtered agent PTY and any channel socketpairs, must be measured on the
  pinned runtime when it exists.
- The authority and listener socketpairs not reaching the agent is N9.
- Files, directories and sockets other than the allowlisted pipes are
  identified by type and number only. Any of them is already a violation.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3, Bubblewrap 0.9.0:
- the strict launch matched the allowlist;
- each positive control was detected, as exactly the one leaked descriptor
  with the right type;
- the seccomp program was loaded, and its descriptor didn't appear.

Strict remained `unverified`.
