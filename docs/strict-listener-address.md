# Listener reach on other addresses (X14, #169 / #124 / #75)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

```sh
/usr/bin/python3 -I test/live/strict-listener-address-probe.py
```

## What it shows

This follows the N9 fixture, which covered a loopback listener only. Every
listener here is owned by the fixture:

| Address (label) | Sandbox (`--unshare-net`), exact | Shared network namespace (positive control) |
| --- | --- | --- |
| `0.0.0.0` listener via `127.0.0.1` | `ECONNREFUSED` | connects |
| `0.0.0.0` listener via `0.0.0.0` | `ECONNREFUSED` | connects |
| `0.0.0.0` listener via the default-route interface's address | `ENETUNREACH` | connects |
| Dual-stack `[::]` listener via `[::1]` | `ECONNREFUSED` | connects |
| Dual-stack `[::]` listener via `[::]` | `ECONNREFUSED` | connects |
| Dual-stack `[::]` listener via `[::ffff:127.0.0.1]` | `ECONNREFUSED` | connects |

**Who answered the positive controls.** The fixture's own listeners must
have accepted exactly those connections: three each.

**Routes.** The **same sandbox worker** that makes the connections first reads
its own IPv4 and IPv6 route tables, and connects only if neither shows a
default route. So the route prerequisite gates exactly those attempts, in
the same namespace. An unreadable, truncated or malformed table makes the
worker refuse (the run fails); it never counts as "no routes".

**Controls for the gate itself:**
- **Gate control:** a worker that does see a default route, in the shared
  namespace, must stop before connecting, reporting only its routes.
- **Parser controls:** synthetic tables are fed to the same reader. A real
  IPv6 `::/0` must count 1, a reject `::/0` must count 0, and an IPv4
  default must count 1. A short IPv6 or IPv4 row, or an IPv4 row with a non-hex field, must refuse.

`/proc/net/route` shows only the main IPv4 table. A default route in
another table, selected by an `ip rule`, wouldn't be seen. That is low risk
in a fresh namespace, and is noted here as a limit. The kernel's own unreachable `::/0` entries on `lo`,
flagged `RTF_REJECT`, block traffic, so they don't count. As a positive
control, the same reader in the shared namespace must see the host's default
route. A sandbox with a default route is stopped before any connect. A
sandbox with only a subnet-specific route would pass this check, and its
interface-address connect could then reach the fixture's own WSL listener,
but not the gateway or Windows. The host-side
address lookup uses a UDP `connect`, which only picks a source address.

The output uses address **labels**, never raw IPs. The exit codes are the
same as the other fixtures:
- **Exit 0:** passed.
- **Exit 1:** a check or positive control failed. The output names the
  failed check, and scratch is retained.
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
- **Sandbox:** no default route. Every loopback-local address was refused,
  and the interface address had no route.
- **Shared network namespace:** all six addresses connected, and the
  fixture's listeners accepted exactly those connections.

Strict remained `unverified`.
