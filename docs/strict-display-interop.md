# WSL interop, display and vsock reach fixture (N4, #159 / #124 / #75)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on WSL2 (x86_64) with system Python and Bubblewrap:

```sh
/usr/bin/python3 -I test/live/strict-display-interop-probe.py
```

## Headline finding

**AF_VSOCK isn't confined by the network namespace on the measured host.**
From inside `bwrap --unshare-net` (and every other unshare), the sandbox
creates an AF_VSOCK socket and connects to the Hyper-V host (CID 2) on port
50000, exactly as the host can. The fixture only connects and closes; it sends
nothing. So **namespaces alone don't satisfy N4 on WSL2**: every Linux-side
gate below holds, but a host service channel stays reachable.

**Fixture mitigation (not an adopted profile):** a seccomp filter passed via
`bwrap --seccomp` does three things:
- refuses `socket(AF_VSOCK, …)` with `EAFNOSUPPORT`;
- refuses `io_uring_setup` with `ENOSYS`, since io_uring can create sockets
  without the `socket` syscall;
- kills any non-x86_64 or x32 syscall ABI.

Under it, vsock creation and the port-50000 connect both fail. Choosing a real
syscall policy is a design decision for #75/#79.

## Safety: never connect to live desktop sockets

The first version of this fixture connected to, and immediately closed, the
actual WSLg X11 and RDP audio sockets. On the measured host, each such
connect made weston's audio thread read end of file and spawn Xwayland, and
then weston died with SIGPIPE. Thirteen deaths in about 100 seconds made
WSLGd stop restarting it, and the user's Linux GUI apps stayed down until
`wsl --shutdown`. The "flaky" refusals the first version retried were weston
restarting.

So the fixture now:
- checks **actual** WSLg, Pulse and session-bus sockets with `stat()` only,
  and never connects to them;
- makes connect checks **only** against two synthetic listeners it owns, one
  pathname and one abstract;
- doesn't retry anything.

## Gates and positive controls

Each gate has its own positive control, which removes only that gate, so a
probe can't pass merely because nothing worked.

| Gate | Strict sandbox | Positive control |
| --- | --- | --- |
| Environment | `--clearenv`: none of `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `WSL_INTEROP`, `PULSE_SERVER`, `XDG_RUNTIME_DIR` | Without `--clearenv`, exactly the host's keys reach the sandbox |
| WSL interop | A Windows MZ binary (bound into the sandbox) exits non-zero with no output. Setting `WSL_INTEROP` without `/run/WSL` also fails, so the environment variable isn't the gate | With `--ro-bind /run/WSL /run/WSL` alone, the same binary exits 0 with output. The host also runs it |
| Actual sockets (WSLg X11, Wayland, the session bus, Pulse, RDP sink and source) | `stat()` gives `ENOENT`: not mounted | Bind-mounted, each is visible as a socket inode. They are never connected to |
| Mount gate, connect | A synthetic pathname listener: `ENOENT` | Bind-mounted: it connects |
| Network-namespace gate, connect | A synthetic abstract listener: refused | Without `--unshare-net`: it connects |
| AF_VSOCK | **The family is available and the host port is reached** (the finding) | The host itself reaches the port (a positive control for the finding). Under the seccomp filter the family is refused |

**Unsupported when the display sockets are missing.** If WSLg's X11 socket
(or the Wayland socket, when `WAYLAND_DISPLAY` is set) isn't present as a
socket on the host, the run exits 2 instead of passing vacuously. Present and
absent labels are both reported.

**Abstract sockets.** The count of actual abstract listeners on the host is
recorded (taken before the synthetic one exists). None are connected to.

## Output and privacy

The output is bounded public JSON:
- labels, counts, exit statuses and errno names;
- the binfmt flags;
- the kernel, machine and Python version.

It never records:
- the Windows binary's output (it names the Windows user);
- user names, home paths, socket paths or abstract socket names.

Exit codes:
- **Exit 0:** every control behaved as recorded. The vsock findings are
  reported, not failed on; the output never claims N4 is satisfied.
- **Exit 1:** a gate or a positive control failed (the scratch path is
  reported).
- **Exit 2:** unsupported: not WSL2 x86_64, optimized Python, or a missing
  prerequisite. That includes missing display sockets, and a host that can't
  reach the vsock port, so there is no finding to measure.

## Limits

- Actual desktop sockets are shown unreachable by mount absence (stat), not by
  a refused connection. No protocol, clipboard or automation semantics are
  tested.
- Only one vsock port was tried. Other host vsock services weren't
  enumerated, and nothing was sent.
- The seccomp filter is a fixture mitigation. It doesn't cover other
  socket-creating paths a reviewer might find.
- This doesn't decide X13's rescoping (#79). It measures what an "interop
  unreachable from the sandbox" rule would have to establish.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3, with the stat-only version:
- **Gates:** every gate and positive control behaved as recorded. All six
  actual sockets were absent in the strict sandbox and visible when bound.
- **vsock:** the family was available in the netns sandbox, port 50000 was
  reached, and seccomp refused both.
- **WSLg log:** no new lines appeared in `/mnt/wslg/stderr.log` during the
  run.
- **WSLg was down during this run** (weston had been crashed by the first
  version). That doesn't affect the result: stat shows only that the socket
  inodes exist and are visible, not that a server is running.

Strict remained `unverified`.
