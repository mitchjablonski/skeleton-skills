# Bounded host enumeration prototype (#94)

`enumerateStrictManifest(rootFd, STRICT_ENUMERATION_POLICY, lowerableLimits)`
uses a fixed `all-regular-text-v1` policy. It discovers every regular file,
including dotfiles, unknown suffixes and files omitted from agent suggestions.
No project settings, Git ignores, suffix rules or supplied candidate list can
remove a member. Exactly named `.git`, `node_modules` and `.skeleton`
**directories** are excluded at any depth and individually reported. Their
contents are neither visited nor verified. A symlink with an excluded name
refuses. All other binary/invalid UTF8, NUL, BOM, oversized, unreadable or
unsupported members refuse the whole result; nothing is silently dropped.

The immutable result contains a sorted `{path,mode}` manifest, sorted explicit
exclusions, fixed full policy identity and observed coverage counters. A file
with actual comment-prefixed SKEL marker candidates is `fenced` only after the
capture parser validates it. Other text is `whole`. The implementation reuses
`captureStrictManifest` for bounded no-follow reads and text validation; it
reads candidate files twice and counts both reads in inspected-byte limits.
An empty tree yields an empty manifest; the existing capture API refuses empty
captures. First-capture/empty-draft lifecycle remains a separate host decision.

## Traversal and bounds

Linux only, requiring a host-owned pinned `O_DIRECTORY` root descriptor and
genuine, immutable host procfs at `/proc`. Each child is inspected relative to
its held parent descriptor. Directories open with `O_DIRECTORY|O_NOFOLLOW`;
file reads use the capture reader's `O_NOFOLLOW|O_NONBLOCK` and regular-file,
single-link checks. Unsupported types, links, invalid UTF8/control/format names
and observed device changes refuse. Equal `st_dev` does not rule out bind mounts.
Directory and file metadata comparisons refuse observed namespace/content
changes. No subprocess, Git operation or project executable runs in enumeration.

Directory entries stream through `opendirSync` with `encoding:'buffer'` and
`bufferSize:1`; non-Buffer names refuse rather than falling back to replacement
UTF8 decoding or an allocating whole-directory read. This was probed on WSL
Node 20.20.0. Public Node does not expose `fdopendir` or the directory stream's
underlying descriptor; its identity relies on opening the trusted procfs link
to a root/parent descriptor the host never closes or reuses during this call.

Defaults bound visits (4096, including excluded roots), files (256), directories
(256), depth (32), open handles (67, including host root and directory streams),
individual names (255 bytes), paths (4096 bytes), total names (1 MiB), individual
file reads (1 MiB), total inspected bytes (8 MiB), enumeration operations (32768)
and elapsed time (5 seconds). Limits may only decrease. The operation counter
covers enumeration calls; capture reader internals have their separate byte and
line bounds. Elapsed checks occur between synchronous calls and cannot interrupt
blocked kernel I/O. No partial manifest is returned on exhaustion. Excluded
subtree contents do not consume visit/byte limits because they are not inspected.

## Remaining gates

Only a typed `StrictCaptureError` with code `CAPTURE_MARKERS` from the capture
parser becomes `ENUM_MARKERS`, after a bounded fresh metadata check against the
original named entry. Observed drift takes precedence as `ENUM_CHANGED`; a
failed metadata read remains unavailable. These checks do not prove atomicity
or detect every same-tick mutation. All other
unexpected capture/runtime/I/O errors retain conservative `ENUM_UNAVAILABLE`,
including missing or changed files and objects that merely claim a marker code.
The checkpoint copy may offer a fresh fill restart for `ENUM_MARKERS`; it never
offers restart for uncertain `ENUM_UNAVAILABLE`. No partial manifest is returned.

This is neither an atomic directory snapshot nor an assertion about all
workspace bytes. Concurrent insertions can escape observation, regular files
can be replaced between observations, and same-size writes can yield torn bytes.
A pinned renamed directory remains attached to its inode, not necessarily under
the current root pathname. Metadata comparisons cannot prove stability.

The separate capture pass may observe a different tree and fail, or observe
different bytes without an observable metadata change. A successful manifest
never binds later content merely by naming it. Production approval needs an
externally enforced freeze or immutable stage spanning enumeration AND capture,
then reviewed publication/commit, capture persistence, enrollment, anti-rollback
and actual launcher profile checks. Policy identity is not a content hash,
capability or approval. This module is not loaded by the default CLI/server and
does not activate strict mode.
