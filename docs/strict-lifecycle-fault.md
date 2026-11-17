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

**The authority stub.** It receives an `endSession` request and confirms on a
separate status pipe that the request is outstanding. Then it watches both
the authority link and a release pipe, counting every byte that arrives on the
link. It replies only after the host writes to the release pipe. The reply
carries the byte count and its receive and release times.

**Proven stop.** The host kills the namespace init through its pidfd. A stop
counts as proven only when every member's pidfd reports exit **and** a `/proc`
scan finds no live process left in the namespace. Both bounds are timed from
the moment the fault is detected:
- the kill must be issued within 50 ms;
- the stop must be proven within 2 seconds.

So any wait on the authority before stopping fails the run. An authority
timeout or an `admissions-revoked` reply never counts as evidence of a stop.

**No authority call, observed.** The stub, not the host's code, reports that
it saw zero bytes on the authority link between the request and the release.
The host requires that count to be zero. The release itself is written only
after the proven stop, so "reply after stop" holds by construction. The real
evidence is that the stub was still alive and silent when the stop was proven.

**The scan and inaccessible processes.** Processes of other users, and older
processes of our own that can't be inspected (such as the user's systemd
manager), are skipped. One of our own processes that started after the
namespace and still can't be inspected might be a member, so it makes the
stop unproven.

| Scenario | Fault | Also required |
| --- | --- | --- |
| Authority stall | The request is still unanswered 300 ms after it was sent | The stub is still alive and silent after the proven stop, and it saw no bytes before release |
| Authority exit | The stub is killed; the authority link reaches end of file | No reply is possible; the stop is proven anyway |
| Control loss | The control stand-in hangs up; the control link reaches end of file | As for authority stall |
| Launcher crash | A launcher stand-in that started Bubblewrap is killed with SIGKILL | The host does nothing else. The outer Bubblewrap process and the namespace must exit through parent death alone, within 2 seconds of the kill |

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
- **Normal runs:** all four scenarios passed. Each kill was issued at once
  after the fault, and each stop was proven 2.7 to 3.7 ms after it. The
  negative control named worker, init and escapee as survivors, and repeat
  runs passed.
- **Injected run:** reported `stop-unproven` and retained only stderr files.
- **Leaks:** no helper process was left running after any run.
- **Review mutations:** each of these now fails the run:
  - waiting 1.5 s before the kill;
  - writing to the authority link before the stop;
  - releasing the stub before the stop;
  - dropping `--die-with-parent`.

Strict remained `unverified`.
