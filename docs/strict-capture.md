# Descriptor-based strict capture prototype (#76)

`captureStrictManifest(rootFd, manifest, limits?)` reads an explicit host-owned
manifest under a pinned Linux directory descriptor. It is not source discovery,
an authority writer or an atomic snapshot. No default CLI/server loads it.

The host opens the registered root with `O_DIRECTORY` and owns that descriptor
for the synchronous call. Each manifest entry is `{path, mode: "fenced"|"whole"}`.
Paths must be relative, unique, valid Unicode without control characters, empty
segments, dot traversal, backslashes or drive prefixes. The reader walks pinned
parent descriptors through `/proc/self/fd`, refusing symlinks on every new open.
Final opens are nonblocking before regular-file checks, so FIFOs cannot hang.
Hardlinks, invalid UTF8/NUL text, missing files, invalid manifests and exceeded
limits refuse the entire capture; no member is silently dropped or truncated.

Defaults cap capture at 256 files, 1 MiB each and 8 MiB total; overrides can only
lower those limits. The manifest is host-owned, not an agent-supplied allowlist.
Authoritative enumeration, exclusion policy and complete source-baseline coverage
still need implementation; reading a supplied list does not establish completeness.

## Captured data and identity

The immutable result contains exact decoded UTF8 text (including a BOM), per-file
raw SHA256, permission mode, exterior lines and parsed fences, plus two full
64-hex SHA256 identities. Canonical ordering, domain separation and independent
byte-length framing bind paths, modes, permissions and member boundaries.

- `shapeVersion` binds exteriors and fence structure. Fenced bodies and CRLF/LF
  differences can change without changing this shape identity.
- `captureVersion` binds exact file bytes and metadata. Body/newline changes do
  change it. The protected host must bind the right complete captured content to
  the shown view and commit; shape equality alone is not exact-byte approval.
- `whole` members retain all text and expose no editable fences, including when
  documentation/context contains example or malformed marker text. `fenced`
  members require valid markers and at least one fence. Only the trusted host
  classifies members; a wrong whole classification restricts edits, not opens them.

The future protected listener serves this captured text, not live claims from
the agent-reachable page. No project scripts, diagram renderer or subprocess is
executed while capturing; only the trusted pure marker parser is called.

## Remaining gates

Before/after descriptor metadata checks detect tested read-time changes, and
pinned intermediates prevent pathname swaps from redirecting the opened walk.
They do not prove an atomic multi-file snapshot or prevent all concurrent writes.
The host still needs a reviewed freeze/stage and commit/publication protocol,
private immutable capture storage, identity/enrollment binding, baseline policy,
anti-rollback and actual supported launcher profile before strict activation.
Neither hash is human authentication or a transition capability.
