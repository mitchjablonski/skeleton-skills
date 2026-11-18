# Authority, listener and directory reach fixture (N9, #124 / #75)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on Linux or WSL2 with system Python and Bubblewrap:

```sh
/usr/bin/python3 -I test/live/strict-link-reach-probe.py
```

## What it shows

Contract negative control N9: the agent can't reach the authority or listener
links, or either directory. The launcher's own processes can. Everything is
synthetic and owned by the fixture:
- a durable-history directory and a scratch directory;
- an authority-link socketpair;
- a loopback TCP listener standing in for the decision-page listener;
- a pathname socket and an abstract socket, standing in for named endpoints.

It never connects to anything it didn't create.

| Gate | Agent (Bubblewrap sandbox) | Positive control (removes only that gate) |
| --- | --- | --- |
| Directories (mount) | Both `ENOENT` | Bind-mounted: both list |
| Pathname endpoint (mount) | `ENOENT` | Bind-mounted: it connects |
| Listener and abstract endpoint (network namespace) | Both `ECONNREFUSED` | With the network namespace shared: both connect |
| Descriptors | None beyond stdio, of any type | The authority socket passed in deliberately is reported as that socket (same inode). A leaked directory descriptor is reported as that directory |
| All of the above | — | The launcher's own unsandboxed process lists both directories, connects to the listener and both endpoints, and completes a bounded request/reply on the authority link |

Each positive control also asserts that **every other gate still holds**, so
it removes exactly one gate. The descriptor scan follows the N3 fixture:
- every descriptor beyond stdio is reported, by type and inode;
- only CPython's `listdir` duplicate may vanish;
- anything else that can't be inspected is a violation.

## Output and bounds

The output is bounded public JSON, with errno names and counts only. The exit
codes are the same as the other fixtures:
- **Exit 0:** passed.
- **Exit 1:** a check or positive control failed. The scratch directory is
  retained, and its path reported.
- **Exit 2:** unsupported. Capability is established by a plain
  `bwrap … /usr/bin/true` run first.

## Limits

- Synthetic stand-ins, not the real launcher, authority or listener.
- Fixture-owned endpoints only. The absence of every named endpoint on a
  real host isn't enumerated.
- Loopback TCP only. The other listener addresses (`0.0.0.0`,
  `[::ffff:127.0.0.1]`, a rebinding name, the WSL host address) and model
  egress are X14 and remain open.
- AF_VSOCK still reaches the Hyper-V host from a network-namespaced sandbox
  on WSL2 (#160). That is a separate, open finding.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3:
- every gate held for the agent;
- every positive control succeeded;
- three runs passed.

Strict remained `unverified`.
