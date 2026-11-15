# Inherited command channel candidate (#142)

Status: **disabled plumbing, not a human-authenticated channel or supported runtime**. `strict-human-channel.mjs` accepts an already host-owned binary Duplex. It opens no socket pathname, TCP listener, HTTP route, PTY or browser endpoint. No production entrypoint imports it. The trusted host must create and distribute descriptors outside the agent boundary; accepting a Duplex does not prove who owns it.

## Interface and wire bounds

`createHumanCommandServer(endpoint, authority)` binds exactly four synchronous authority methods and returns a host-only `close()`. `createHumanCommandClient(endpoint)` exposes only `verifyAndCommit`, `recapture`, `endSession` and `state`, returning promises. Authority enrollment/context, keys, facts and captures never come from requests. There is no raw V2 submit operation or network handshake.

Each frame is a four-byte unsigned big-endian body length plus canonical UTF-8 JSON, at most 4096 body bytes. Requests are exactly `{version:1, sequence, operation, args}`; responses are exactly `{version:1, sequence, result}`. Mutation args use the existing codec; state args are empty. Sequences start at one, increase once per connection, and are separate from the durable authority request ID. Canonical JSON round-trip validation refuses duplicate keys, spacing/number aliases, BOM and invalid UTF-8. Public results/state are exact allowlisted shapes; keys, arbitrary properties/getters and error text are not serialized.

Candidate connection bounds are 128 calls, one client call in flight, and a 1000ms request/partial-frame deadline. Extra coalesced/pipelined bytes, oversized lengths and bad sequences close the connection. Backpressure closes instead of building an unbounded output queue. A completed earlier request may already be committed when later traffic or a connection fails; framing supplies no rollback. These are prototype bounds, not adopted product policy or latency guarantees.

The authority methods must be synchronous, bounded trusted-host operations. Async declarations are refused and returned promises are not used as answers, but the channel cannot cancel effects a misconfigured method has already started. Deadlines cannot preempt a synchronous host callback. Physical termination and quiescence remain the supervising host's responsibility.

## Unknown outcomes and recovery

Channel loss, malformed replies, a timeout or a host fault returns fixed `rejected/unavailable`. It may follow a durable commit. The transport never retries automatically or reconstructs a command from current state. The console retains its original request ID; a newly bootstrapped connection can query the same enrolled authority with that exact ID and receive its original result. New connection sequence numbers never reset durable counters or command history.

## Actual descriptor fixture

On Linux with system Python, Bubblewrap and a verified regular Node binary:

```sh
/usr/bin/python3 -I test/live/strict-private-channel-probe.py \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

The Python host creates an unnamed socketpair and passes one descriptor to each of two host helpers. A private file injects the fixture code into the control helper; this is not human bootstrap. The server uses the real durable authority store, commits approval, then deliberately loses its reply. A second socketpair and freshly reopened server return the original same-ID result with observation, clock and entropy callbacks configured to fail. One command/core entry and byte-identical history must remain.

While a real channel is live in the host, a separate minimal Bubblewrap worker receives only stdio and a public read control. It must have no extra descriptors, cannot read/create files in the private bootstrap/store/capture paths, and cannot connect to a named endpoint (none exists). These tests cover that bounded fixture configuration, not every path in the actual CLI profile. Neither endpoint is a protected human terminal. Runtime receipts identify selected observations only; the channel client role is explicitly `node-channel-control`, not the pinned Claude CLI.

Helpers remain unreaped through `waitid(...WNOWAIT)` until group cleanup, avoiding numeric process-group reuse before signalling. Cleanup failure refuses success and retains scratch. Exit 2 means invalid arguments/pins/prerequisites; exit 1 means an attempted fixture or cleanup failed; exit 0 means the bounded fixture passed. Output contains bounded public metadata, never private keys or injected codes.

Observed on 2026-11-14: the socketpair/durable-reconnect fixture passed, including lost-reply recovery, one protected observation, unchanged history and separate-worker descriptor/path exclusion. Strict remained `unverified`. Protected control/PTY bootstrap, display/clipboard/automation isolation, general process admission, external integrity/antirollback and supported-profile qualification remain open.
