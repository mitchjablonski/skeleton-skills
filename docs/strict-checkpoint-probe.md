# Development-only checkpoint teardown probe

Run on Linux or WSL with system Python 3.10+ under `/usr`, Bubblewrap supporting
`--as-pid-1` and `--info-fd`, enabled user/PID namespaces, readable host `/proc`,
and kernel/Python pidfd open and signal support:

```sh
/usr/bin/python3 test/live/strict-checkpoint-probe.py
```

The probe installs nothing, uses no provider credentials, performs no model or
network calls, and never enables strict mode. Every output record includes
`"strictState":"unverified"`. Exit 0 means this experiment passed; exit 1 means
an attempted experiment failed; exit 2 means an unsupported prerequisite or
invalid invocation. Namespace denial and unsupported Bubblewrap options fail
the attempted launch explicitly rather than substituting process-group-only
containment.

Each of two rounds launches a disposable Bubblewrap PID namespace with the
inner Python process as PID 1. Its two double-forked grandchildren detach into
new sessions, outlive their launching processes, and continuously append to
separate files through open descriptors. The harness obtains Bubblewrap's
host child PID, opens a pidfd, and verifies the referenced process corresponds
to PID 1 in a distinct namespace. It checks the complete observed namespace
membership contains that init plus the two writers and opens writer pidfds.
Both writers must have been adopted by namespace init, and both stage files
must grow before teardown.

Some host processes (including systemd user services) expose readable status
but deny namespace symlink reads. The census excludes such an entry only when
its `NSpid` list proves it is at or above the host's namespace depth and thus
cannot be in the newly nested fixture namespace. An inaccessible nested entry
still fails the probe. Missing or unreadable status evidence also fails;
permission denial alone never means a process is outside the fixture.

The harness sends SIGKILL through the stable namespace-init pidfd. It requires
all three pidfds to become readable (process exit), no observed non-zombie
members of that namespace, and Bubblewrap to exit before its first host read
of candidate file contents. A short second read must match. File-size and
readiness metadata inspections before teardown are not candidate content
reads. The second round uses a new stage directory and must report a distinct
namespace identifier, demonstrating a fresh restart rather than reuse of the
terminated worker. Numeric PIDs are used for discovery, not as cached kill
targets. Launch and wait phases have eight-second deadlines; inner fixtures
self-expire after twenty seconds. A child file-size limit of 8 KiB and CPU
limit of ten seconds bound fixture files and diagnostics; host diagnostic
output is additionally truncated to 8 KiB per round.

This is a controlled fixture, not hostile-code containment or a production
supervisor. Its read-only `/usr` and library binds are broad development
conveniences. It does not establish a race-free hostile process census, verify
an arbitrary runtime or inherited descriptors, or implement candidate
validation, sealed promotion, rollback, approval, or durable publication.
Pidfd readiness and no live fixture writers do not prove that previously
submitted asynchronous I/O has completed or cannot modify storage later.
The experiment uses synchronous writes and does not solve pending asynchronous
I/O, external writers, shared services, or storage durability. Passing cannot
authorize publication or a strict-mode claim.

## Observed local run

On 2026-11-12, an actual WSL run with `/usr/bin/python3` 3.12.3 and installed
Bubblewrap passed both rounds. The reported namespace identifiers were
`pid:[4026532229]` and `pid:[4026532230]`; each round tracked three pidfds,
observed both writers advance, and confirmed all tracked processes exited and
no live namespace members remained before candidate content reads. Candidate
sizes were `[28,27]` and `[26,26]` bytes. The result retained
`"strictState":"unverified"`. Namespace IDs and byte counts are observations,
not expected constants or release qualification.
