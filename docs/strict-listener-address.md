# Listener reach on other addresses (X14, #169 / #124 / #75)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

```sh
/usr/bin/python3 -I test/live/strict-listener-address-probe.py
```

## What it shows

This follows the N9 fixture, which covered a loopback listener only. Every
listener here is owned by the fixture:

| Address (label) | Sandbox (`--unshare-net`) | Shared network namespace (positive control) |
| --- | --- | --- |
| `0.0.0.0` listener via `127.0.0.1` | refused | connects |
| `0.0.0.0` listener via the host's own global IPv4 address | no route | connects |
| Dual-stack `[::]` listener via `[::1]` | refused | connects |
| Dual-stack `[::]` listener via `[::ffff:127.0.0.1]` | refused | connects |
| Route to the host gateway (one connect to the discard port) | no route | not attempted |

**What reaches the gateway.** Nothing is sent to the gateway or to any
Windows service. The host-side address lookup uses a UDP `connect`, which
only picks a source address. The sandbox's single TCP attempt fails for lack
of a route before any packet leaves.

The output uses address **labels**, never raw IPs. The exit codes are the
same as the other fixtures:
- **Exit 0:** passed.
- **Exit 1:** a check or positive control failed (scratch is retained).
- **Exit 2:** unsupported: no default route, no IPv6, or Bubblewrap can't
  start a sandbox.

## Limits

- Fixture-owned listeners only, not the real decision listener.
- DNS-rebinding names aren't tested: the sandbox has no resolver and no
  route, so names can't resolve there. That is recorded here, not measured.
- Model egress and AF_VSOCK (#160, which still reaches the Hyper-V host)
  are separate.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3:
- **Sandbox:** the loopback, IPv6-loopback and mapped addresses were
  refused, and the host address had no route.
- **Gateway:** the sandbox had no route to it.
- **Shared network namespace:** all four addresses connected.

Strict remained `unverified`.
