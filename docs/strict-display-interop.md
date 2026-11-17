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

## Gates and positive controls

Each gate has its own positive control, which removes only that gate, so a
probe can't pass merely because nothing worked.

| Gate | Strict sandbox | Positive control |
| --- | --- | --- |
| Environment | `--clearenv`: none of `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `WSL_INTEROP`, `PULSE_SERVER`, `XDG_RUNTIME_DIR` | Without `--clearenv`, all present ones reach the sandbox |
| WSL interop | A Windows MZ binary (bound into the sandbox) exits non-zero with no output. The binfmt handler (`WSLInterop`, flags recorded) still runs, but `/init` finds no interop socket | With `--ro-bind /run/WSL /run/WSL` and `WSL_INTEROP`, the same binary exits 0 with output. The host also runs it |
| Actual pathname sockets | WSLg X11 (`/tmp/.X11-unix/X0`), Wayland, the session bus, and the Pulse and RDP audio sockets: all `ENOENT` (not mounted) | Each socket bind-mounted into an otherwise identical sandbox connects |
| Abstract sockets | Unreachable (`--unshare-net`) | Without `--unshare-net`, they connect |
| AF_VSOCK | **Reachable** (the finding) | Under the seccomp filter: refused |

**Abstract sockets on this host.** It has no actual abstract listeners: the
abstract entries in `/proc/net/unix` are connected clients. The fixture
therefore records the count of actual listeners (0 here). It adds one
throwaway listener, labelled synthetic, so that the network-namespace gate
still has a positive control.

**Retries.** WSLg servers sometimes refuse a burst of connects, or let their
backlog fill. So `ECONNREFUSED` and `EAGAIN` get up to six retries, 200 ms
apart, on the host and in every sandbox. A missing path, or a blocked
namespace, fails the same way every time.

## Output and privacy

The output is bounded public JSON:
- labels, counts, exit statuses and errno names;
- the binfmt flags;
- the kernel, machine and Python version.

It never records:
- the Windows binary's output (it names the Windows user);
- user names, home paths, socket paths or abstract socket names.

Exit codes:
- **Exit 0:** every control behaved as recorded. The vsock finding is
  reported, not failed on.
- **Exit 1:** a gate or a positive control failed (the scratch path is
  reported).
- **Exit 2:** unsupported: not WSL2 x86_64, optimized Python, or a missing
  prerequisite.

## Limits

- Connect-and-close only: no protocol, clipboard or automation semantics.
- Only one vsock port was tried. Other host vsock services weren't
  enumerated, and nothing was sent.
- The seccomp filter is a fixture mitigation. It doesn't cover other
  socket-creating paths a reviewer might find.
- This doesn't decide X13's rescoping (#79). It measures what an "interop
  unreachable from the sandbox" rule would have to establish.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3:
- **Five runs passed.** In each, the environment, interop, six actual
  pathname sockets and the abstract gate all held, with every positive
  control succeeding.
- **vsock:** port 50000 was reachable from the netns sandbox and refused
  under seccomp.

Strict remained `unverified`.
