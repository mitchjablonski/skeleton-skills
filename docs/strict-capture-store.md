# Immutable private capture storage (#76)

This trusted-host Linux prototype stores captures before an authority transaction
references them. It supplies no authentication, listener, host isolation,
anti-rollback or atomic workspace capture/commit mechanism. It is not loaded by
the default CLI or review server.

`createCaptureStore(directory)` explicitly enrolls a new namespace; an existing
directory refuses. `openCaptureStore(directory)` never repairs or promotes
files. The host owns the directory and its ancestors outside the agent boundary.
Ownership/write-mode/ancestor checks detect misconfiguration, not hostile path
replacement races.

`put(capture)` reconstructs canonical text, display, fences and full identities
before writing. It exclusively creates and fsyncs a temporary file, publishes
with a no-overwrite hard link, removes its temporary alias, then validates and
syncs the blob, directory and parent before success. Existing IDs must contain
the exact valid capture; corrupt blobs are not overwritten. Concurrent identical
publication may transiently refuse safely and can be retried after inspection.

`get(captureVersion)` requires a full lowercase digest, a regular single-link
owned blob and bounded UTF8 JSON. It rebuilds all derived data and compares it,
not just the raw digest: a corrupted display array cannot silently change what
the human sees. It verifies the requested identity and re-syncs before returning.
The namespace alone does not authorize a caller to fetch another project's
capture; the future protected service must check the registered binding.

## Ordering and recovery

The host must durably store the selected capture **before** journal/authority
commit. A crash before authority commit can leave an unreferenced blob, never
an approval. Missing/corrupt referenced captures refuse; no fallback to live
workspace or public state. Captures and authority references are not made one
atomic transaction by this adapter.

A crash between link and unlink can leave a two-link blob/temp pair. Reads
refuse until deliberate outside-host recovery, with all writers stopped and the
alias independently verified. No automatic garbage collection, expiry, temp
promotion or repair is implemented. Real filesystem I/O errors require storage
health investigation; re-sync success does not prove earlier errors harmless.
Older backup rollback remains undetectable without a separate trusted anchor.

The 128 MiB serialized-blob cap is additional to capture file/byte/line caps.
Local-filesystem durability needs profile verification; network/mounted storage
and production activation are not claimed. Tests include publication races and
injected failures, not actual power-loss testing.
