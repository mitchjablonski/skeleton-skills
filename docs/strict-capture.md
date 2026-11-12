# Descriptor-based strict capture prototype (#76)

`captureStrictManifest(rootFd, manifest, limits?)` reads an explicit host-owned
manifest under a pinned Linux directory descriptor. It is not source discovery,
an authority writer or an atomic snapshot. No default CLI/server loads it.

The host opens the registered root with `O_DIRECTORY` and owns that descriptor
for the synchronous call. Each manifest entry is `{path, mode: "fenced"|"whole"}`.
Paths must be relative, unique, valid Unicode without control/format/line-separator characters, empty
segments, dot traversal, backslashes or drive prefixes. The reader walks pinned
parent descriptors through `/proc/self/fd`, refusing symlinks on every new open.
Final opens are nonblocking before regular-file checks, so FIFOs cannot hang.
Depth is capped at 64 segments. Hardlinks, BOM files, invalid UTF8/NUL text, missing files, invalid manifests and exceeded
limits refuse the entire capture; no member is silently dropped or truncated.

Defaults cap capture at 256 files, 1 MiB each and 8 MiB total; overrides can only
lower those limits. Display allocation is also capped at 32,768 lines per file
and 131,072 total, counted before display objects are allocated. The manifest is
host-owned, not an agent-supplied allowlist.
Authoritative enumeration, exclusion policy and complete source-baseline coverage
still need implementation; reading a supplied list does not establish completeness.

## Captured data and identity

The immutable result contains exact decoded UTF8 text (BOMs are refused), per-file
raw SHA256, permission mode, exterior lines and parsed fences, plus two full
64-hex SHA256 identities. Canonical ordering, domain separation and independent
byte-length framing bind paths, modes, permissions and member boundaries.

- `shapeVersion` binds exact exteriors, their line endings and fence structure.
  Fenced body changes can preserve the shape; LF/CRLF exterior differences do not.
- `captureVersion` binds exact file bytes and metadata. Body/newline changes do
  change it. The protected host must bind the right complete captured content to
  the shown view and commit; shape equality alone is not exact-byte approval.
- `whole` members retain all text and expose no editable fences, including when
  documentation/context contains example or malformed marker text. `fenced`
  members require valid markers and at least one fence. Only the trusted host
  classifies members; a wrong whole classification restricts edits, not opens them.

Each file exposes host-parsed `display` entries `{line,text,ending,kind}` where
kind is exterior, marker or body, and fences include `openLine`/`closeLine`.
The protected page must consume that mapping, not run a second marker parser.
Fenced files permit LF and paired CRLF only: lone CR, VT, FF, NEL, LS and PS
refuse anywhere, so they cannot draw a fake fence boundary. Whole-file context
has no active fences and retains every byte in its identity; its display mapping
must retain all visual line separators explicitly. Rejoining text+ending gives
the exact captured text, including final-line behavior.

The future protected listener serves this captured text, not live claims from
the agent-reachable page. No project scripts, diagram renderer or subprocess is
executed while capturing; only the trusted pure marker parser is called.

Failures are `StrictCaptureError` objects with stable `code`, safe relative
`path` and `line` when known; native errno may appear as `reason`. Raw host root
and `/proc` paths are not exposed. Rendering code should map these fields to
typed recovery copy rather than parse free-form error messages.

The stable codes are `CAPTURE_ROOT` (unsupported/invalid root descriptor),
`CAPTURE_VALIDATION`, `CAPTURE_DUPLICATE`, `CAPTURE_LIMIT` (file/byte/options),
`CAPTURE_LINE_LIMIT`, `CAPTURE_LINK` (symlink/hardlink/nonregular member),
`CAPTURE_MISSING`, `CAPTURE_IO`, `CAPTURE_CHANGED`, `CAPTURE_TEXT` (UTF8/NUL),
`CAPTURE_BOM`, `CAPTURE_SEPARATOR`, and `CAPTURE_MARKERS`. Policy errors assign
codes where detected; filesystem errors map by errno, never by filename/message
keywords. This distinction matters for typed recovery instructions.

## Remaining gates

Before/after descriptor metadata checks detect observable read-time changes, and
pinned intermediates prevent pathname swaps from redirecting the opened walk.
They can miss same-size writes within a filesystem timestamp tick and accept
torn bytes that never coexisted as a complete file. The hash still binds exactly
the captured/rendered bytes, not an atomic source observation. They do not prove
an atomic multi-file snapshot or prevent all concurrent writes.
An [immutable capture-store primitive](strict-capture-store.md) now rebuilds and
persists validated captures. The host still needs its protected-service
integration, a reviewed freeze/stage and commit/publication protocol,
identity/enrollment binding, complete enumeration and baseline policy,
anti-rollback and actual supported launcher profile before strict activation.
Neither hash is human authentication or a transition capability.
The descriptor traversal assumes genuine host-controlled procfs and does not
enforce a no-mount-crossing policy; supported-root filesystem/profile validation
is still a launcher gate. Prototype v1 intents do not carry `captureVersion`.
[Protocol v2](strict-protocol-v2.md) adds the pair to parsers, authority and
journal replay. The [opt-in V2 adapter](strict-v2-adapter.md) validates shown
captures and exact-pair confirmation, but is not production-wired. The protected
decision path stays disabled until its host requires V2 and completes the
remaining integration gates.
