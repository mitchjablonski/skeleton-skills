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
| With a pid namespace (the agent) | no | not attempted | not attempted | not attempted | not attempted | not attempted |
| Without a pid namespace (visibility control) | yes | refused | refused | refused | must succeed / refused | readable without the secret, or refused |

**What each run shows:**
1. **With a pid namespace:** a **visibility-only** check. The stand-in's
   host pid number must not be visible in the agent's namespace. If it were,
   it could name a different, namespace-local process. So the fixture
   refuses on that uncertainty rather than addressing whatever the number
   names. No process-specific operation is attempted there.
2. **Without a pid namespace:** before any operation, the worker confirms
   the number still names the owned stand-in. Its cmdline must carry a
   random, non-secret token passed at launch; otherwise the worker refuses.
   Then the stand-in is visible, and every access
   must be an observed **permission refusal** (`EPERM` or `EACCES`). A
   generic or partial result fails the run. `pidfd_open` must succeed there,
   so that `pidfd_getfd` is really attempted. The stand-in's `/proc` text can
   be readable here: cmdline is, and it holds no secret. The Yama scope is
   recorded (here 1), but an observed refusal doesn't establish Yama as its
   cause. The fixture describes this measured configuration only and
   doesn't predict other hosts.

**Positive control for the /proc text check.** It has its own plan: only its
pid and the text to search for, with no memory address or descriptor
borrowed from the first stand-in. A second stand-in that does
carry the secret on its command line, and in its environment, must have its
cmdline reported as `contains-secret`. Its environ must be either
`contains-secret` or refused; here it is refused under Yama.

**Positive control for the access paths.** The probe itself, as the
stand-in's parent, reads the secret with `process_vm_readv` and takes the
descriptor with `pidfd_getfd`. Every descriptor read is bounded in time, so
an empty pipe can't hang the run. A sibling worker outside the sandbox is
refused under Yama scope 1, which is recorded as an observation.

The output has errno names only, never the secret. The exit codes are the
same as the other fixtures:
- **Exit 0:** passed.
- **Exit 1:** a check or positive control failed (scratch is retained).
- **Exit 2:** unsupported: not x86_64 Linux, or Bubblewrap can't start a
  sandbox.

## Limits

- A stand-in process, not the real console or authority.
- The refusals are observed on this configuration only. A host with
  different ptrace policy, for example Yama `ptrace_scope` = 0, may allow
  same-uid access. The visible-stand-in check would then fail (exit 1).
- No hostile coverage beyond these paths, such as `kcmp`.

Observed on 2026-11-18 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3, with Yama `ptrace_scope` = 1:
- **With a pid namespace:** the stand-in's number wasn't visible.
- **Without one:** the stand-in was visible, but attach, `process_vm_readv`
  and `pidfd_getfd` were refused with `EPERM`. `/proc/<pid>/mem` and
  `environ` were refused with `EACCES`, and `cmdline` held no secret.
- **The parent** read the secret and took the descriptor.

Strict remained `unverified`.
