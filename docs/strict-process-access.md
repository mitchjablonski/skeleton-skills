# Launcher-side process access fixture (#172 / #124 / #75)

This opt-in development fixture checks that a Bubblewrap worker can't attach
to, read the memory of, or take a descriptor from a host-side process owned by
the same user. It follows the [PID visibility fixture](strict-process-reach.md),
which covers naming only. Strict stays `unverified` after a pass.

```sh
/usr/bin/python3 -I test/live/strict-process-access-probe.py
```

## Setup

The launcher starts a fixed Python stand-in for a launcher-side process (the
console or authority) and sends it 32 random bytes on stdin. The stand-in
keeps them in a memory buffer and in a private `memfd`, then reports only the
buffer address, the descriptor number and the memfd inode. The launcher pings
the stand-in before and after every worker and sends it `SIGCONT` each time,
so a stop left by an attach can't hide.

## Observations

| Who | Attempts | Required |
| --- | --- | --- |
| Agent worker: user, PID, net, IPC and UTS namespaces, same uid | `process_vm_readv`, `/proc/<pid>/mem`, `pidfd_open` + `pidfd_getfd`, `ptrace(PTRACE_ATTACH)`, all against the stand-in's **host** PID | Every attempt refused, and the PID is absent from the worker's `/proc` |
| Shared-PID control: the same sandbox without `--unshare-pid` | The same | The PID is visible (`pidfd_open` succeeds). The access results are recorded, not required |
| Launcher control: the stand-in's parent | The same reads, then attach, `waitpid` and detach | Both memory reads return the secret; the taken descriptor has the reported inode and reads back the secret; attach stops the stand-in and detach succeeds |

The launcher control runs the same read and attach code as the worker, so a
wiring bug can't pass as a refusal.

Measured on WSL2 (kernel 6.6, `kernel.yama.ptrace_scope` = 1):

| Attempt | Agent worker | Shared-PID control |
| --- | --- | --- |
| `process_vm_readv` | `ESRCH` | `EPERM` |
| `/proc/<pid>/mem` | `ENOENT` | `EACCES` |
| `pidfd_open` | `ESRCH` | succeeds |
| `pidfd_getfd` | not attempted | `EPERM` |
| `ptrace(PTRACE_ATTACH)` | `ESRCH` | `EPERM` |

These show two separate gates. The private PID namespace means the agent
can't name the process at all. Without it, Yama's relational scope still
refuses a non-ancestor, because the worker's capabilities belong to its own
user namespace, not the stand-in's. The fixture records
`yama_ptrace_scope` as an observation. On a host with scope 0 the shared-PID
control would succeed, which is why the PID namespace, not Yama, is the
required gate.

If the host PID number names a process inside the private namespace, the
worker records `numeric-collision`, touches nothing, and the fixture fails.

## Output

One JSON object with errno names and fixture status labels. The secret is
never printed; the launcher also fails a worker whose output contains its hex
form. Exit 0 means every required observation and cleanup succeeded. Exit 1
means a check or fixture operation failed. Exit 2 means the platform is
unsupported (not Linux, no `os.pidfd_open`, optimized Python) or Bubblewrap
couldn't start one of the sandboxes.

## Scope

This covers a fixture-owned stand-in in the fixture's sandbox configuration.
It doesn't establish anything about the real console or authority, the
launcher's actual sandbox profile, other process-access paths (signals,
`/proc/<pid>/environ` or `fd/`, cgroup or BPF access, `TIOCSTI`; see #152 for
the terminal), or hosts without unprivileged user namespaces.
