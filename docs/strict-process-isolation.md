# Process isolation evidence fixture (#172 / #124 / #75)

This opt-in development fixture collects passive evidence that a Bubblewrap
worker runs under the isolation controls the launcher intends. It attempts no
attach, memory read or descriptor take, and signals nothing but its own
sandbox. Strict stays `unverified` after a pass.

```sh
/usr/bin/python3 -I test/live/strict-process-isolation-probe.py
```

The launcher starts one worker (user, PID, IPC, net and UTS namespaces, a cgroup
namespace where available,
`--die-with-parent`, `--new-session`, an empty environment). The worker reports
its own PID, `NSpid`, PID and user namespace identities, `CapEff` and
`NoNewPrivs`, then waits for EOF so the launcher can look at it while it runs.

The launcher follows the children named by the owned Bubblewrap process
and its single-threaded descendants. It checks parentage at each step and
reads each process through its opened proc directory. Exactly one worker
must match the reported inner PID and PID namespace. It refuses with
`ownership-ambiguous` if more than one process matches, `worker-not-found` if
none does, and `worker-evidence-missing` or `status-field-missing` if any
report or `/proc` field is absent. The report is read from the raw pipe with
the fixture timeout and a 1 KiB cap, so a partial or oversized line refuses
instead of hanging. Extra output or a report writer that remains open
after the wrapper exits also fails the check. It then requires:

| Check | Meaning |
| --- | --- |
| `pidns_agrees`, `userns_agrees` | The worker's view and the launcher's view name the same namespaces. The worker is located by its PID namespace, so `pidns_agrees` is a re-read that fails closed if the pid was reused in between |
| `pidns_private`, `userns_private` | Both differ from the launcher's |
| `nspid_levels` | The host sees two PID levels, the worker only its own |
| `capeff_zero` | No effective capabilities, from both views |
| `no_new_privs` | Set, from both views |
| `same_host_uid` | Every host uid of the worker is the launcher's |
| `single_uid_map` | Exactly one uid mapping, onto the launcher's uid, count 1 |

`yama_ptrace_scope`, the worker's `Seccomp` mode and `cgroupns_private`
(`--unshare-cgroup-try` skips silently where unsupported) are recorded as
observations. If cgroup namespace metadata is unavailable,
`cgroupns_private` is null. The private PID namespace is the gate the
fixture relies on (see [PID visibility](strict-process-reach.md)).

Mutation checks on WSL2 each fail for the expected reason: no `--unshare-pid`
gives `worker-not-found`, `--cap-add CAP_SYS_PTRACE` fails `capeff_zero`, a
duplicated match gives `ownership-ambiguous`, and a report missing a field
gives `worker-evidence-missing`.

The output is one JSON object with fixture status labels. `wrapper_exit`
records the subprocess reap, including on refusal. Exit 0 requires the
checks, clean wrapper exit and EOF on the report pipe. Exit 1 means a
check failed or evidence was refused. Exit 2 means the platform is
unsupported or Bubblewrap couldn't start.

This is evidence about the fixture's own sandbox configuration. It says
nothing about the real launcher profile, the console or the authority, and it
doesn't test whether any access attempt is refused.
