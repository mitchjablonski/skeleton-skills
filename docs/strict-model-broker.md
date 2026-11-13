# Disabled mock model broker

`lib/strict-model-broker.mjs` is host-only orchestration around the existing
pure model-request policy. Nothing in production starts or imports it. It has
no listener, network implementation, resolver, TLS implementation, real API key,
launcher, monetary admission, or strict-mode activation. Success and snapshots
retain `strictState: "unverified"`.

```js
createMockModelBroker({ transport, sessionBudget?, now? })
  -> { submit(request), snapshot(), close() }
```

`submit` accepts `{ method, target, body, headers? }` or the same object with
`rawHeaders: [name, value, ...]` instead of `headers`. Both together refuse.
For an actual HTTP adapter, use the raw pairs before parser normalization:
duplicate case-insensitive names, ambiguous transfer framing, trailers, upgrades
and Expect refuse. The record form cannot recover duplicates already discarded
by an HTTP parser. The existing policy validates exact targets, JSON bytes,
headers and the fixed upstream profile; its `MODEL_*` refusal codes are retained.
Input is copied and validated synchronously before any asynchronous work.

The trusted transport must implement:

```js
resolve(host, { signal }) -> Promise<IPv4[]>
connect({ address, port, servername, rejectUnauthorized, alpn, signal })
  -> Promise<{
    peerAddress,
    tls: { authorized, hostname, servername, alpn },
    request({ method, target, headers, body, signal })
      -> Promise<{ status, rawHeaders, body: AsyncIterable<Uint8Array> }>,
    close()
  }>
```

These dependencies are trusted host implementations, captured once at
construction. They must honor AbortSignal and close promptly; arbitrary
noncooperative code or synchronous event-loop blocking is outside the experiment.
There is exactly one DNS call, all answers must pass the public-IPv4 policy,
and one connection to the first approved literal address. No redirects, retries,
address fallback, pool, proxy, or second lookup exists. The reported peer must
match that address. TLS observations must name `api.anthropic.com`, report
authorization, use the fixed SNI and HTTP/1.1 ALPN. Only after those checks does
the broker send a rebuilt request with the fixed dummy key
`strict-mock-upstream-dummy-only`. This is not a credential configuration API.

Responses permit JSON, or SSE for messages only; count_tokens requires JSON.
Redirect statuses and any Location header (including an empty value) refuse. Compressed responses,
unsupported framing, invalid or excessive headers, and oversized bodies refuse.
Response lengths must match actual bytes when supplied. Only content-type is
returned; Set-Cookie and other upstream headers are not exposed. Bodies are read
sequentially with deadlines and copied into a bounded Buffer, including SSE.
Empty chunks refuse, and chunk counts are capped so immediately resolved tiny
chunks cannot indefinitely starve deadline timers through microtasks.
This buffering does not yet provide incremental SSE delivery to a real CLI.

Ceilings (`STRICT_MOCK_BROKER_LIMITS`) may only be lowered through plain data:

| Limit | Default |
|---|---:|
| In-flight requests; queue | 1; none |
| Admissions/session; rolling second | 16; 4 |
| Request bytes | 1 MiB |
| Response header bytes | 32 KiB |
| Response bytes/request; session reservation | 2 MiB; 8 MiB |
| Response chunks/request | 4096 |
| DNS; connection/TLS timeout | 2 s; 2 s |
| Total request; session lifetime | 10 s; 60 s |

Admission synchronously reserves a request slot and the full maximum response
size before the first await. Reservations are never refunded, including on
failure: with defaults, response reservation limits the session to four attempts.
This conservative fixture budget bounds resources, not dollars. The total timer
spans every phase and aborts the transport; phase timers also cover DNS/connect.
Close aborts active work, refuses future requests and waits up to 100 ms for job
settlement. Connection close and iterator return are invoked without waiting on
untrusted cleanup promises. A late connection after cancellation is closed.

`snapshot()` returns only frozen status and counters: `strictState`, `closed`,
`inFlight`, `admitted`, `reservedResponseBytes`, `receivedResponseBytes`.
Success is `{ ok: true, strictState, status, headers, body: Buffer }`.
Failure is `StrictModelBrokerError` with a bounded fixed `code`; raw dependency
messages, bodies, header values and credentials are not returned in diagnostics.
The body Buffer is caller-owned output, not an immutable object.

`test/fixtures/strict-model-transport.mjs` is a socket-free DNS/TLS/HTTP simulator
with fixed JSON/SSE responses and host-selected fault settings. Its private test
evidence intentionally records dummy request headers and bytes for assertions;
that evidence is never broker diagnostics and must not be treated as a safe
production log. Passing tests proves orchestration against this trusted simulator,
not actual DNS pinning, TLS certificate verification or hostile containment.

Before a real API adapter: review the launcher crossing and FD/socket exposure,
isolate implementation/config/key storage from every agent path, exercise actual
DNS/peer/TLS behavior in an isolated no-internet lab, implement incremental
response/backpressure and cancellation, and enforce durable model/token/currency
reservations with restart and unknown-outcome rules. The current policy accepts
arbitrary JSON-object economic fields and does not enforce model or max_tokens
spend limits. Real API access and credentials remain absent. This work provides
no human authentication, completion, publication, antirollback or activation.
