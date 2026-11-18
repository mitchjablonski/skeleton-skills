# Inherited descriptor fixture (N3, #162 / #124 / #75)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on Linux or WSL2 with system Python and Bubblewrap:

```sh
/usr/bin/python3 -I test/live/strict-descriptor-probe.py
```

## What it shows

A worker inside a Bubblewrap sandbox (`--unshare-all --clearenv
--new-session`) enumerates `/proc/self/fd`, skipping its own listing
descriptor. It classifies each descriptor by type only: pipe, socket, tty,
char, file, directory, anon_inode or other. Paths are never recorded.

| Check | Required |
| --- | --- |
| Strict launch | Exactly the allowlist: 0 = `/dev/null` (char), 1 and 2 = the launcher's output files |
| Passed pipe (positive control) | Detected as the only extra descriptor, typed as a pipe |
| Passed socketpair end (positive control) | Detected as the only extra descriptor, typed as a socket |
| Careless launcher (positive control) | An inheritable directory descriptor survives `close_fds=False` and is detected. With `close_fds=True` the result is the allowlist again |
| `--seccomp` program descriptor | Bubblewrap consumes it, and it never reaches the sandbox |

**Finding:** Bubblewrap doesn't scrub inherited descriptors. Whatever the
launcher passes in, or leaves inheritable and unclosed, arrives in the
sandbox at the same number. So the allowlist has to be **enforced by the
launcher**, with explicit `pass_fds` and closing everything else, and N3's
check inside the sandbox is the evidence that it was.

## Output and bounds

The output is bounded public JSON: the allowlist, the observed types, and the
extra descriptors found by each positive control. The exit codes are the
same as the other fixtures:
- **Exit 0:** passed.
- **Exit 1:** a check or positive control failed (the scratch path is
  reported).
- **Exit 2:** unsupported.

## Limits

- The launcher is synthetic. A real launcher's descriptor set, including the
  filtered agent PTY and any channel socketpairs, must be measured on the
  pinned runtime when it exists.
- The authority and listener socketpairs not reaching the agent is N9.
- Types only: two descriptors of the same type aren't distinguished beyond
  their numbers.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3:
- the strict launch matched the allowlist;
- each positive control was detected, as exactly the one leaked descriptor
  with the right type;
- the seccomp descriptor didn't appear.

Strict remained `unverified`.
