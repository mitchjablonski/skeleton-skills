# Outside mock broker / actual CLI relay fixture (#75)

This opt-in development experiment runs the actual pinned Claude CLI inside a
fresh PID/network namespace, with only a loopback HTTP shim connected through
one inherited socketpair endpoint to an outside-host mock broker. The outside
process imports `createMockModelBroker`; the worker receives neither that
implementation nor its private capture/authority store. There is no external
network, real DNS/TLS adapter, real credential or model inference. Every result
retains `strictState: "unverified"` and completion remains false.

```sh
/usr/bin/python3 test/live/strict-relay-probe.py \
  --client /home/mitch/.local/share/claude/versions/2.1.323 \
  --client-sha256 604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

Linux/WSL prerequisites and runtime pin checks match the actual-fill probe:
system /usr Python, Bubblewrap with --as-pid-1/--info-fd, namespaces, genuine
procfs and pidfd APIs. Absolute executable files and full caller-trusted digests
are required; leaf symlinks refuse. This does not defeat concurrent executable
replacement. Exit 0 means the fixed experiment passed, 1 an attempted failure,
and 2 an unsupported prerequisite or invalid pin. No settings are installed or
changed, and personal credentials/configuration are not read.

## Descriptor and protocol ownership

Python creates an anonymous AF_UNIX socketpair, not a filesystem socket. Only
one endpoint is explicitly inherited by Bubblewrap, the fixed namespace PID1
Python supervisor, and its Node loopback shim. Actual CLI spawn uses only
explicit stdin/stdout/stderr; the shim also observes that its relay socket
identity is absent from the CLI's initial fd table. The endpoint is deliberately
an adversarial request ingress, not a secret or an authentication credential.
A duplicated endpoint still reaches the same outside broker and its private
counters/revocation state. No arbitrary socket or host file handle is accepted.

The opposite endpoint goes only to the outside Node host. Its separate stdin
is a private Python-to-host control pipe; it is not inherited or bound into the
worker. Host STOP closes the broker authoritatively. Python deliberately keeps
one test alias of the worker endpoint until after proven namespace teardown,
then sends a late valid request through it: BROKER_CLOSED must refuse without
another provider send. Closing just the shim descriptor is not treated as
revocation. Parent aliases/endpoints and host processes are closed on all paths.

Each wire message is a four-byte unsigned big-endian length followed by JSON.
Request exact keys are `version`, `id`, `request`; the nested record permits only
`method`, `target`, `rawHeaders`, `bodyBase64`. Version is 1, IDs are sequential
bounded correlation values, and body bytes must have canonical base64 encoding.
There is no destination, DNS answer, CA, proxy, key, budget or transport field.
Responses carry only bounded policy codes or the broker's safe response metadata
and body. Credentials and original incoming headers are never returned.

The host checks the declared 2 MiB frame ceiling before allocating the declared
body or parsing JSON, caps retained input, enforces a two-second partial-frame
deadline, five-second socket inactivity limit, 32 frames per endpoint, one active
broker admission and 128 KiB queued reply bytes. Malformed frames, oversized
lengths, incomplete frames and closed channels revoke active work. These are
fixed fixture ceilings, not a general-purpose multiplexed RPC protocol. The
HTTP shim forwards actual raw header pairs, preserving duplicate detection, and
refuses transfer/upgrade/trailer framing before forwarding. It accepts no model
choice of destination or external endpoint.

## Actual data path and evidence

The host creates a fixed private skeleton, stores its independent capture before
mock approval, and seeds a fresh workspace exclusively from that stored pair.
Only the disposable home/config, workspace and control directory are writable
inside the worker. Broad readonly /usr/libraries remain development conveniences.
The outside broker uses the existing fixed public-address/TLS identity simulator
and a distinctive public dummy upstream key. The worker uses a different dummy
key; success shows where the host adds its dummy, not real-key secrecy.

Before launching the CLI, the shim submits an absolute malicious destination and
an oversized request body through the relay. They must refuse specifically as
MODEL_TARGET and MODEL_BODY_LIMIT without provider calls. The real CLI then
performs Read, selected-body Edit and Bash through the outside broker. Fixed
simulated responses use bounded buffered SSE because this actual CLI requests
streaming responses; this is not live incremental streaming/backpressure
qualification. A fixed 300 ms provider latency preserves the broker's rolling
rate limits. The immutable response allowance is 64 KiB/request and 1 MiB/session;
other admission ceilings remain those of the disabled broker.

Bash tests an actual uniquely named outside private sentinel path is absent,
then double-forks a synchronous writer retaining the workspace descriptor. The
host verifies the tool-result IDs and read/Bash receipts without logging their
contents. That writer must advance after CLI exit. Python then kills namespace
PID1 through its stable pidfd and requires every tracked pidfd exited, no
observed live members and Bubblewrap exit before independent candidate capture.
The stopped selected-only fill must pass. The outside sentinel stays unchanged.
Source is never reconstructed from tool output or repaired after teardown.

Separate disposable host sessions exercise a declared oversized frame, an extra
destination override field and an incomplete frame. Each requires its intended
RELAY_FRAME_BYTES, RELAY_FRAME or RELAY_PARTIAL_TIMEOUT refusal with zero provider
sends. These are synthetic ingress checks, not additional actual CLI runs.

On 2026-11-12 a pinned Linux run reported Claude Code 2.1.323, four outside
provider requests, and namespace pid:[4026532234]. A detached writer's control
log advanced 47 to 60 bytes after CLI exit; all six observed process pidfds
exited before candidate capture. Late ingress after host revocation refused
BROKER_CLOSED with provider sends still four. Both malformed-frame sessions and
the partial-frame deadline test passed. Counts and namespace IDs are observations.

Diagnostics include only fixed codes, counters, safe targets and booleans. They
do not serialize bodies, tool results, inbound/upstream dummy keys or the private
sentinel value. Cleanup uses existing UUID-marker/realpath containment checks;
unproven namespace death retains scratch instead of deleting writable storage.
This does not qualify arbitrary hostile containment, race-free process census,
pending async I/O, real network/TLS or monetary spend controls, human authority,
completion, publication or rollback safety. Strict remains disabled.
