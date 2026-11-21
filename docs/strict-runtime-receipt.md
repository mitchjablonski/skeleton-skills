# Strict runtime receipt

`test/live/strict-runtime-receipt.py` exports `capture_runtime_receipt(client, node, root)` for invocation only after pin validation and owned fixture admission. It returns schema `strict-runtime-receipt/v1`, an exact descriptor, and `fingerprint_sha256`. `ReceiptUnavailable` means required observations could not be collected; callers must refuse that receipt rather than substitute a supported profile.

The fingerprint is SHA-256 of ASCII JSON containing schema and descriptor, with sorted keys and compact separators. It binds Linux kernel release and machine, UID/GID, the client role and entrypoint hash, client/Node/Bubblewrap executable hashes and reported versions, filesystem type, hashed filesystem source and mount options, namespace names, and observed user namespace sysctl values. Every field is required; strings are bounded to 4096 UTF-8 bytes. Source paths are hashed rather than disclosed. The descriptor intentionally excludes credentials and personal configuration.

Metadata commands use argument arrays, no shell, five-second deadlines, a further two-second cleanup deadline, and 64 KiB regular-file output limits. Executable/entrypoint hashing runs in the same bounded child mechanism, refuses nonregular or changed files, and caps each file at 512 MiB. Tools are resolved from `/usr/bin:/bin` and receive a minimal environment. Timeout cleanup signals the still-unreaped helper process group before reaping it. The collector performs no installation or host setting changes. Missing required metadata or unreadable sysctls makes collection unavailable. A kernel without the optional clone-policy file records exactly `not-exposed`; this is neither an enabled flag nor a support verdict. Namespace names and sysctl observations describe prerequisites; they do not prove namespace creation succeeds.

This identifies an observed candidate configuration. It does not qualify runtime support, authenticate a receipt, establish active enforcement, or eliminate executable/mount/kernel TOCTOU changes. No production status integration is included.

Run `python test/live/strict-runtime-receipt.py --self-test` for injected-observation schema, ordering, fingerprint sensitivity, malformed, missing, oversized and unsupported-platform checks.

The default client role is `pinned-cli`. An inherited-channel fixture can explicitly use `node-channel-control` with its fixed worker entrypoint; it never labels that helper as the actual Claude CLI. The fingerprint covers these selected observations, not every library, mount, configuration or executable replacement race. The collector itself does not authenticate its inputs or return a support boolean.

Observed on 2026-11-14: receipt self-tests and the pinned durable-fill fixture passed on the measured WSL2 Linux kernel/ext4 setup with Bubblewrap 0.9.0, Node 20.20.0 and CLI 2.1.323. This kernel's optional clone-policy file was not exposed and was recorded as such. Both fill cases still returned `strictState: unverified` and `completionVerified: false`.
A metadata helper that cannot be reaped after timeout raises ReceiptCleanupFailed; the integrated fixture reports unproven cleanup and retains its scratch rather than claiming cleanup succeeded. These deadlines bound the direct helper; they do not establish descendant quiescence. The collector issues no network requests itself, but executes pinned binaries' version commands unsandboxed. These bounds apply to receipt collection, not to every earlier prerequisite check or later fixture action.

## Launcher selection policy (#193)

The disabled `select_runtime(expected, observe)` helper in
`test/live/strict-runtime-selection.py` compares a trusted, preselected full
receipt with one current observation. It validates both receipts by
recomputing their canonical fingerprints. The selector passes the four
client, entrypoint, Node and Bubblewrap digests from the selected receipt to
the trusted observer, which must check them before running version commands.
An invalid selection skips observation. A changed, invalid or unavailable
observation yields a fixed refusal. A separate cleanup-unproven refusal
tells the launcher to preserve scratch when helper cleanup is uncertain.
Use `observe_pinned_runtime(client, node, root, pins, ...)` as the trusted
observer. It hashes the selected client, entrypoint, Node and Bubblewrap
using the bounded digest helper, and requires all four hashes to match
before starting any version command. It then reads current metadata and
returns a canonical receipt. It translates its own `ReceiptCleanupFailed`
into `{'kind': 'cleanup-unproven'}`, so the selector and observer can load
their modules independently.

An exact match returns the selected fingerprint and leaves process creation
to the launcher. The launcher must source the expected receipt from its
trusted profile configuration and must collect a fresh observation on each
attempt. Synthetic self-tests cover selected receipt comparison, the
pre-version pin ordering, and cleanup refusal. Preflight uses trusted host
paths while observing the runtime. An executable or path replacement
between hashing and execution remains outside the fixture's proof.

## Passive terminal metadata for #79

Run `/usr/bin/python3 -I test/live/strict-terminal-profile-evidence.py` on
the Linux host that supplies the receipt. Record the result as a separate
observation alongside the receipt for that run. The helper reads
`dev.tty.legacy_tiocsti` without terminal input or a settings change. It
reports `0`, `1` or `not-exposed`. An unreadable or malformed value refuses.
Run the same command with `--self-test` for synthetic value, absence and
read-failure checks. This leaves the v1 receipt and selected fingerprint
unchanged.

On 2026-11-21, the WSL2 host reported `0` on kernel
`6.6.87.2-microsoft-standard-WSL2` (`x86_64`). This kernel setting is
passive evidence. N2 and C18 still need the selected terminal's behavioral
evidence before any qualification decision.
