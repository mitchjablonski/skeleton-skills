# Model-channel request policy prototype (#75)

`lib/strict-model-policy.mjs` is a pure validator, not a model broker, proxy,
credential service or launcher. It performs no DNS, socket, TLS or upstream
request and is not loaded by production code. No credentials are accepted or
attached by this module.

The current profile fixes the destination to `api.anthropic.com:443`, allows
only POST Messages/count_tokens routes with an optional exact beta query, and
caps UTF8 JSON at 1 MiB (host overrides may only lower the cap). Endpoint and
version-header references are the official [API overview](https://platform.claude.com/docs/en/api/overview)
and [token-count API](https://platform.claude.com/docs/en/api/http/messages/count_tokens).
This is not a claim of end-to-end Claude CLI compatibility or OAuth support.

Request normalization rejects absolute URLs, CONNECT, alternate targets,
forwarding/authority overrides, malformed or duplicate header names, bad content
length/type and oversized bodies. It constructs fresh fixed-destination headers
instead of forwarding client credentials, cookies or hop headers. Incoming
loopback Host values support an eventual inside adapter; they never select an
outgoing destination. The raw HTTP adapter must reject duplicates/ambiguity
before converting raw headers to an object; this function cannot recover lost
header information.

JSON is validated for UTF8, BOM refusal, top-level object, size and depth, then
kept as immutable text. It is never merged into trusted configuration, executed
or used to fetch body URLs. Nested `constructor`/`__proto__` data are harmless
opaque payload and are not blacklisted. No API schema or cost permission follows
from valid JSON.

## Address and transport boundary

The address helper accepts canonical public IPv4 answers only and refuses the
entire list if any answer is private, reserved, unusual or unsupported. IPv6,
including mapped forms, is explicitly unsupported in this prototype. The caller
must obtain actual resolver answers; this helper does not resolve names or stop
DNS rebinding by itself.

The outside broker still must pin the vetted connected address, verify TLS with
the fixed original hostname/SNI, disable redirects, and keep the model socket
separate from the private human listener. The pure no-redirect helper alone
does not enforce transport behavior. No general CONNECT, arbitrary URL or host
loopback bridge may be exposed.

Before any real credential use, implement and test model/token/spend limits,
request rate/concurrency/timeouts, response-size/stream limits, credential
lifecycle and the actual launcher profile. Those controls are not supplied here.
The first transport tests must use a deterministic mock provider and private
listener sentinel, with no real credentials or paid inference. Nothing in this
policy establishes strict-active state or authorizes an approval transition.
