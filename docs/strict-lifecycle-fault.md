# Synthetic N10 lifecycle fault fixture (#154 / #124 / #99)

Status: opt-in development fixture only. No production entrypoint imports it.
There is no real launcher, authority, console, listener, enrollment or
supported runtime profile. Strict remains `unverified` even after a pass.

Run on Linux or WSL2 with system Python and Bubblewrap:

```sh
/usr/bin/python3 -I test/live/strict-lifecycle-fault-probe.py
/usr/bin/python3 -I test/live/strict-lifecycle-fault-probe.py --inject-unproven  # must fail
```

## What it shows

The host plays the launcher from the
[bootstrap contract](strict-protected-bootstrap.md) ("Supervision and stop").
It checks one rule: **physical stop comes first and doesn't depend on the
authority.**

**The namespace.** A Bubblewrap PID namespace (`--unshare-all
--die-with-parent`) holds four members:
- Bubblewrap's init (namespace PID 1);
- the worker, which is Bubblewrap's main command;
- a fixed child that leads its own process group (the agent group);
- an escapee that double-forks into a new session, outside that group.

The host finds every member by its pid-namespace inode, opens a pidfd on
each one, and then re-checks the inode and the `NSpid` mapping, so each handle
is known to belong to a namespace member. It also checks the group and
session layout described above.

**The authority stub.** It receives an `endSession` request, confirms on a
separate status pipe that the request is outstanding, and then blocks. It
replies only after the host writes to a release pipe. Its reply carries the
`CLOCK_MONOTONIC` time at which it was released.

**Proven stop.** The host kills the namespace init through its pidfd and makes
no authority call. A stop counts as proven only when every member's pidfd
reports exit **and** a `/proc` scan finds no live process left in the
namespace. All of this must happen within 2 seconds. An authority timeout or
an `admissions-revoked` reply never counts as evidence of a stop.

| Scenario | Fault | Also required |
| --- | --- | --- |
| Authority stall | The request is still unanswered 300 ms after it was sent | The stub is still alive and still hasn't replied after the proven stop. Its reply comes only after release, and its release time is later than the stop |
| Authority exit | The stub is killed; the authority link reaches end of file | No reply is possible; the stop is proven anyway |
| Control loss | The control stand-in hangs up; the control link reaches end of file | As for authority stall: the authority is held through the stop and replies only afterwards |
| Launcher crash | A launcher stand-in that started Bubblewrap is killed with SIGKILL | The host does nothing else. The namespace, the outer Bubblewrap process and the stand-in must all exit through parent death alone |

**Negative control.** Killing the agent's process group, which is what a
launcher tracking only the agent's group might do, must **not** count as a
stop. The fixture requires the check to fail, naming the worker, init and the
escapee as survivors. It then stops the namespace properly.

**Injected failure.** `--inject-unproven` replaces the launcher's stop step
with that same group kill. The run must report `stop-unproven`, name the
survivors, exit 1 and retain the scratch directory. The retained directory
holds only helper stderr files. There is no durable history in this fixture.

## Output and bounds

The output is bounded public JSON, with the same exit codes as the other
fixtures:
- **Exit 0:** passed.
- **Exit 1:** a scenario, the negative control or cleanup failed. A failed
  cleanup overrides success, and the scratch path is reported.
- **Exit 2:** unsupported arguments or prerequisites, including an optimized
  interpreter, which would silently remove the assertions.

**Bounds:**
- Helpers get CPU and file-size limits.
- Each record and status read has a deadline.
- The whole run is bounded at 60 seconds.

**Cleanup:**
1. Kill every namespace init and every helper's session.
2. Require every pidfd that was opened to report exit.
3. Rescan each namespace inode and require it to be empty.

## Limits

- A stand-in, not a launcher. The faults are the stand-in events in the
  contract's table. They aren't an injected failure at each bootstrap step,
  so X18's "no fallback at every step" stays open.
- The inode scan sees live processes only. A zombie has already given up its
  namespaces, so zombies are caught by their pidfds, not the scan.
- No hostile coverage of ptrace, cgroup escape or nested user namespaces.
  Parent-death handling for a real authority, console or listener isn't
  covered either. Under candidate A the console isn't a child at all.
- Window selection, listener issuance and runtime qualification are separate
  gates.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3:
- **Normal runs:** all four scenarios passed, each proven stop taking 2.4 to
  3.4 ms. The negative control named worker, init and escapee as survivors,
  and five repeat runs passed.
- **Injected run:** reported `stop-unproven` and retained only stderr files.
- **Leaks:** no helper process was left running after any run.

Strict remained `unverified`.
