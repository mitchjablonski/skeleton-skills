# Launcher-side process reach fixture (#172 / #124 / #75)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

```sh
/usr/bin/python3 -I test/live/strict-process-reach-probe.py
```

## What it shows

#152 left broader ptrace and process-vm reach open. This fixture measures it.

**The stand-in.** A host-side process stands in for the console or the
authority. It holds a random 32-byte secret in memory, received over stdin
and **never on its command line**, and a private pipe descriptor. Each
worker gets the secret's SHA-256 to compare reads against, plus the hex for
searching `/proc` text. Those arrive in the worker's own argv, never the
stand-in's.

**The attempts.** From a Bubblewrap sandbox running under the same uid, the
agent targets the stand-in's **host** pid with:
- `ptrace(PTRACE_ATTACH)`;
- `process_vm_readv`;
- reading `/proc/<pid>/mem`;
- `pidfd_open`, then `pidfd_getfd`;
- reading `/proc/<pid>/cmdline` and `/proc/<pid>/environ`, which must not
  contain the secret.

| Sandbox | Visible | Attach | `process_vm_readv` | `/proc/<pid>/mem` | `pidfd_open` / `pidfd_getfd` | cmdline / environ |
| --- | --- | --- | --- | --- | --- | --- |
| With a pid namespace (the agent) | no | `ESRCH` | `ESRCH` | `ENOENT` | `ESRCH` / — | `ENOENT` |
| Without a pid namespace (visibility control) | yes | refused | refused | refused | must succeed / refused | readable without the secret, or refused |

**Two layers:**
1. **The pid namespace** hides the process entirely.
2. **Credentials and Yama** (here `ptrace_scope` = 1, recorded in the output)
   still refuse every access once the process is visible. Each access must
   return a real errno name, so an unexpected or partial result fails the
   run. `pidfd_open` must succeed there, so that `pidfd_getfd` is really
   attempted. The errnos are recorded rather than pinned, because they
   depend on the Yama scope.

**Positive control for the /proc text check.** A second stand-in that does
carry the secret on its command line, and in its environment, must have its
cmdline reported as `contains-secret`. Its environ must be either
`contains-secret` or refused; here it is refused under Yama.

**Positive control for the access paths.** The probe itself, as the
stand-in's parent, reads the secret with `process_vm_readv` and takes the
descriptor with `pidfd_getfd`. A sibling worker outside the sandbox is
refused under Yama scope 1, which is recorded as an observation.

The output has errno names only, never the secret. The exit codes are the
same as the other fixtures:
- **Exit 0:** passed.
- **Exit 1:** a check or positive control failed (scratch is retained).
- **Exit 2:** unsupported: not x86_64 Linux, or Bubblewrap can't start a
  sandbox.

## Limits

- A stand-in process, not the real console or authority.
- The access refusals depend on the measured kernel's Yama scope and LSMs.
  On a host with `ptrace_scope` = 0, the visible-stand-in check would fail
  (exit 1), because same-uid access is then allowed. There, only the pid
  namespace protects the process.
- No hostile coverage beyond these paths, such as `kcmp`.

Observed on 2026-11-18 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3, with Yama `ptrace_scope` = 1:
- **With a pid namespace:** every attempt failed with `ESRCH` or `ENOENT`.
- **Without one:** the stand-in was visible, but attach, `process_vm_readv`
  and `pidfd_getfd` were refused with `EPERM`. `/proc/<pid>/mem` and
  `environ` were refused with `EACCES`, and `cmdline` held no secret.
- **The parent** read the secret and took the descriptor.

Strict remained `unverified`.
