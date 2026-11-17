# Synthetic Linux PTY separation fixture (#149 / #124 / #99)

Status: opt-in development fixture only. No production entrypoint imports it.
It creates no authority, enrollment, decision code, authenticated human channel
or supported runtime profile. Strict remains `unverified` even after a pass.

Run on Linux or WSL2 with system Python and Bubblewrap:

```sh
/usr/bin/python3 -I test/live/strict-pty-separation-probe.py
```

The host creates a real raw control PTY; its helper becomes a session leader,
acquires the controlling terminal on descriptors 0–2 and echoes random fixture bytes. Its session is created by the host before Python starts. A minimal
Bubblewrap worker has separate PID/mount/network namespaces, a fresh `/dev`
and devpts, an empty environment and initially only descriptors 0–2. It creates
its own PTY/session and demonstrates a roundtrip plus reopening its own procfs
descriptor. Actual device/inode/rdev identity must differ from control; matching
PTY path numbers or numeric PID collisions never count as control access.

The worker attempts the control PTY path, host PID descriptor and procfs-root
path. Any opened object must have a different identity. TIOCSTI ioctl outcomes
are recorded, including on its own controlling terminal. A kernel that disables
TIOCSTI globally supplies no evidence that session isolation caused denial.
Control remains alive, has no extra bytes, and repeats its host-only roundtrip.

Three throwaway Unix listeners stand in for display/session endpoints. Host
connections are positive controls; agent pathname connections must fail. Six
synthetic display/WSL environment entries supplied to Bubblewrap must disappear
after its explicit environment clearing. This is pathname/environment fixture
evidence, not actual X11, Wayland, WSLg, clipboard or automation isolation.

Output is bounded public JSON. Exit 2 means unsupported arguments/prerequisites;
exit 1 means an attempted fixture or cleanup failed; exit 0 means this bounded
fixture passed. Helpers have CPU/file/wall bounds. Leaders remain unreaped with
`waitid(WNOWAIT)` until process-group SIGKILL, then bounded reaping. A deliberate
same-group sleeping descendant survives its leader's exit; the host opens its
pidfd and requires it alive before group cleanup and stopped afterward, with a
bounded pidfd readiness check. Linux `pidfd_open` is required. Cleanup
failure overrides success and reports the retained scratch path. Successful output
records bounded kernel, machine, Python and devpts observations; oversized mount
metadata is refused. The own-PTY child is explicitly
reaped; hostile descendants escaping sessions and lifecycle death cascades are
outside this slice. The sleeping-descendant control covers only that supervised
same-process-group case.

Observed on 2026-11-16: the fixture passed on WSL2 kernel
`6.6.87.2-microsoft-standard-WSL2`, x86_64, system Python 3.12.3. Both host
roundtrips, the own-terminal/procfs controls, distinct terminal identities,
synthetic socket/environment exclusion and supervised descendant shutdown passed.
The own-terminal TIOCSTI attempt returned errno 5; that is an observation, not
evidence that isolation caused denial. An injected reap failure separately
confirmed cleanup refusal and scratch retention. Strict remained `unverified`.
Linux namespace availability must be checked
on each WSL setup. Windows terminal ownership, broader ptrace/process-vm reach,
actual CLI admission, browser profile C20, OSC filtering, raw-console policy,
human bootstrap and supported-profile qualification remain open.
