# Isolated real TLS lab

This disabled opt-in fixture exercises actual Node TLS and HTTP against a local
HTTPS server inside a fresh disposable user/network namespace. It uses only a
fixed dummy upstream key and performs no external DNS, internet or model call.
Every result retains `strictState: "unverified"`. No production command imports
the lab transport; there is no production adapter or strict-mode activation.

```sh
/usr/bin/python3 test/live/strict-tls-lab.py \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

Requires system `/usr` Python on Linux/WSL, Bubblewrap, `/usr/sbin/ip`, OpenSSL,
enabled user/network namespaces and namespace-local NET_ADMIN/NET_BIND_SERVICE.
The supplied absolute regular executable is SHA256-checked before launch; leaf
symlinks and mismatches refuse. That check followed by path bind is not protection
against concurrent executable replacement. Missing capabilities or namespace
support refuse; there is no host-network or localhost fallback.

The Python host creates a private temporary CA, unrelated CA, and correctly named,
wrong-name and expired server certificates using fixed OpenSSL commands. No
certificate or key is installed in OS trust stores, browser profiles or settings.
Only fixture server keys and public CA certificates enter the read-only fixture
bind; CA signing keys remain outside. All temporary files are removed afterward.

Before changing an address or launching Node, the inner supervisor checks its
network namespace differs from the host's, its only interface is `lo`, and every
existing IPv4/IPv6 route is on `lo`. It brings up that interface and assigns
`8.8.8.8/32` locally, then rechecks there is no outside interface route or default
route. This public-looking address exists only in the new namespace. Namespace
UID/GID 0 map to the caller; the two added networking capabilities apply inside
the disposable namespace. No host network configuration is modified.

`lib/strict-model-tls-lab.mjs` is a lab-only trusted transport for the disabled
mock broker. It supplies fixed host-owned resolver answers; this is **TLS-only
evidence, not a real DNS/rebinding implementation**. Connection settings are
guarded at construction and again before connecting: a required host namespace
identifier must differ from current procfs, `/proc/net/dev` must show only lo,
and procfs IPv4/IPv6 route tables must have no outside/usable default route.
Linux's non-UP reject-only `::/0` sentinel on lo is allowed. These
trusted-harness checks prevent accidental use on an ordinary network; they do
not authenticate hostile same-user code. Connection settings are
restricted to the fixture literal `8.8.8.8`, port 443, fixed SNI/certificate name
`api.anthropic.com`, HTTP/1.1 ALPN, and `rejectUnauthorized: true`. The private CA
is passed explicitly to this connection. The transport uses Node's default
`tls.checkServerIdentity`; it never installs a permissive verifier or disables
verification through an environment/global setting. Application HTTP starts only
after `secureConnect`; the broker compares the actual remote address and TLS
observations before attaching its dummy key or sending request bytes. The
already-verified TLS socket is used for exactly one HTTP request, with no pool,
retry or redirect follow. Close and abort destroy that socket and its agent.

The matrix requires these exact outcomes, each with one connection attempt:

| Case | Required code | Server application requests |
|---|---|---:|
| Correct chain/name and JSON | success, exact response bytes | 1 |
| Wrong certificate name | BROKER_TLS | 0 |
| Untrusted certificate chain | BROKER_TLS | 0 |
| Expired certificate | BROKER_TLS | 0 |
| Actual peer differs from broker-selected address | BROKER_PEER | 0 |
| Redirect toward loopback | MODEL_REDIRECT_REFUSED | 1, no second request |
| Stalled TLS handshake | BROKER_TIMEOUT | 0 |
| Stalled response | BROKER_TIMEOUT | 1 |

The peer mismatch case is a host-selected fault: its resolver reports another
public address while a wrapper deliberately connects to the actual fixture
address. The returned peer is read from the real TLS socket, not fabricated.
The broker must refuse the mismatch before HTTP. TLS rejection cases cannot
satisfy the test through an unrelated parser failure because the valid request
and working server configuration are shared controls and exact codes/counts are
asserted. Successful HTTP cases assert the server saw the fixed SNI and dummy key;
failure-before-send cases assert zero application requests. Both timeout cases
also require an observed transport abort.

Broker handshake and total request deadlines are lowered to 200/250 ms. The
supervisor bounds Node runtime to 30 seconds, CPU to 30 seconds and output files
to 16 KiB. The outside wrapper bounds namespace runtime to 45 seconds and kills
its process group on timeout. Node destroys accepted server sockets during each
case's cleanup, including incomplete TLS handshakes. No arbitrary subprocess,
worker, browser or hostile runtime is exercised by this lab.

An actual WSL run on 2026-11-12 with the pinned Node 20.20.0 passed all eight
rows. Earlier missing namespace-local capabilities refused before serving TLS;
the fixture did not relax its isolation. These observations are not production
qualification. Real DNS resolution/pinning, launcher crossings, credential storage,
streaming/backpressure, durable monetary reservations, human authentication,
completion, publication and rollback protection remain separate gates.
