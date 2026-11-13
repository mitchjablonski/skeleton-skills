# Combined actual CLI relay and real TLS lab (#99 / #75)

This opt-in experiment joins the actual-CLI socketpair relay to the real TLS
lab without internet, real credentials or model inference. It uses two sibling
Bubblewrap user/PID/mount/network namespaces. The service contains the broker,
TLS adapter and fixed HTTPS provider; the worker contains the loopback shim,
actual pinned CLI and tool children. Capture/authority storage, signing keys and
the service STOP pipe stay with the parent. Strict remains `unverified` and
approval is a hard-coded mock transition, not a human decision.

```sh
/usr/bin/python3 test/live/strict-relay-tls-probe.py \
  --client /home/mitch/.local/share/claude/versions/2.1.323 \
  --client-sha256 604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

Requirements match the independent relay and TLS probes: system /usr Python on
Linux/WSL, Bubblewrap with PID1/info-fd support, pidfds, genuine procfs, ip and
openssl. Caller-trusted absolute executable files and full digests are required.
No dependencies, trust-store settings or personal configuration are installed or
changed. The fixture executable check is not race-proof against concurrent
replacement. Exit 0 is controlled success, 1 attempted failure, 2 unsupported
prerequisites or invalid pins. No weaker profile or host-network fallback exists.

The service setup runs as uid0 inside its own user namespace, with only its
explicit NET_ADMIN/NET_BIND_SERVICE additions. It verifies lo-only interfaces,
adds 8.8.8.8/32 to lo and verifies no usable default/outside route. Its actual TLS
adapter independently checks the service netns differs from the real parent's
netns and rechecks interfaces/routes before connecting. The worker gets no such
capability additions. Parent procfs observations confirm a different worker
net/user namespace, lo-only routing and CapEff zero. Parent holds namespace
handles across cases to prevent identity recycling.

Only the service receives a minimal readonly five-module tree, server leaf key,
leaf certificate and fixture trust certificates. CA signing keys/configuration
remain unmounted in parent scratch. The worker receives no broker/adapter code,
repository root, CA, TLS key, service namespace handle, private stores or service
control pipe. Its only ingress is the existing inherited anonymous socketpair
endpoint passed through worker PID1 to the shim; actual CLI stdio excludes it.
The shim again observes that its socket identity is absent from the CLI's
initial fd table. Correlation IDs confer no authority, and duplicating an
endpoint cannot reset the same service broker's counters or revocation state.

The existing relay host is now import-safe. It exports only fixture helpers for
the fixed Read/Edit/Bash response generator and bounded ingress runner; its
standalone mock entry remains available. The service injects the host-chosen
real TLS transport directly. No transport, CA, address, scenario or budget
configuration is added to worker frames. Existing raw-header preservation,
2 MiB frame cap, partial-frame deadline, admission and queued-reply bounds stay
in the shared runner. Known TLS/peer/redirect codes survive as fixed refusal
codes; unknown dependency errors stay generic.

The valid row first seeds new exclusive workspace files from the stored approved
capture. Actual CLI Read/Edit/Bash traffic crosses the relay, broker and real TLS
connection to 8.8.8.8:443 with normal certificate verification, fixed SNI
api.anthropic.com and HTTP/1.1. Responses are bounded buffered SSE with explicit
Content-Length, not incremental streaming qualification. Fixed 300 ms provider
latency respects the existing rolling request rate. The dummy upstream key is
checked only at the fixture server after peer/TLS validation; no key values,
body text, tool results or PEM material are logged.

Bash proves the uniquely named parent-private sentinel path is absent and starts
a detached synchronous writer. Its log must advance after the actual CLI exits.
Stable worker PID1 pidfd teardown, all tracked exits, no observed live members
and Bubblewrap exit precede independent stopped-source capture. The resulting
selected-only fill must pass. Parent then sends STOP over its private service
pipe. Broker close and service socket cancellation complete before the ack.
A deliberately retained parent alias of ingress must get BROKER_CLOSED with no
additional provider request. Service Node exits; then service PID1 teardown
requires all service pidfds exited and no live namespace members before cleanup.
Both PID1 supervisors self-expire and all waits/output/resources are bounded.
A failed death gate retains scratch under existing UUID/realpath ownership rules.

The actual-CLI valid row is the positive control for three fresh service rows:

| Row | Expected result | HTTP / dummy credential |
| --- | --- | --- |
| Actual CLI, trusted fixture CA | Four TLS model requests; accepted fill | Four requests, key checked on each |
| Unrelated CA | BROKER_TLS | Zero HTTP requests/key |
| Approved DNS answer 8.8.4.4, actual fixture peer 8.8.8.8 | BROKER_PEER | Zero HTTP requests/key |
| Valid TLS with 302 redirect | MODEL_REDIRECT_REFUSED | One authenticated request; no follow-up |

Negative rows use a bounded synthetic ingress client so retries by an actual
CLI cannot mask the intended refusal. Redirect refusal happens after the first
request and cannot demonstrate pre-send credential withholding. Every row uses
real TLS, exact refusal/count checks, fresh service namespaces, socket cleanup,
authoritative broker close and stable service PID1 teardown.

Service evidence counts accepted TCP connections, completed server-side TLS
connections and TLS client errors. The untrusted row must reach at least one
actual TCP connection, complete zero secure connections and produce a TLS error,
with zero HTTP requests or dummy key. It cannot pass through connection refusal
alone. The pinned combined valid profile requires exactly four requests, four
TCP/secure connections, four matching peer/SNI entries and zero TLS errors.
Resolver and connection counts must match in every row; the independent relay's
broader request-count tolerance remains unchanged.

An initial pinned Linux run on 2026-11-12 passed all four rows. CLI reported
2.1.323, four real TLS requests observed peer 8.8.8.8 and SNI api.anthropic.com,
and the detached writer advanced 41 to 55 bytes after client exit. Worker netns
net:[4026532303] differed from service net:[4026532234] and parent; worker CapEff
was zero. Both certificate and peer rows sent zero HTTP requests. Redirect sent
one with no retry. Namespace IDs/counts are observations, not release constants.

Run the independent `strict-relay-probe.py` and `strict-tls-lab.py` as regression
controls. This combined fixture does not prove race-free hostile census,
arbitrary runtime containment, pending async I/O or external writers, monetary
spend control, genuine human authorization, completed work, publication or
rollback safety. No production command imports the combined fixture.
