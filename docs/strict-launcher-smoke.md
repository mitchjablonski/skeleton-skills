# Strict client smoke harness (development only)

`scripts/dev/strict-client-smoke.py` is a reproducible bootstrap probe for a
specific Linux client executable. It checks the caller-supplied SHA-256, then
runs exactly that executable's fixed `--version` command under Bubblewrap. It
accepts no client arguments, does not call a model, and does not make strict
mode active. Every output record reports `"strictState":"unverified"`,
including refusal and failure records.

Run it from Linux or WSL with Python 3.10+ and `bwrap` already available on `PATH`:

```sh
python3 scripts/dev/strict-client-smoke.py \
  --client /absolute/path/to/client \
  --sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The supplied path must be absolute, executable and a regular file, not a symlink.
The canonical resolved path is reported. A missing
client, malformed digest, digest mismatch, unsupported platform, missing
Bubblewrap or required runtime directories, sandbox failure, timeout, or
nonzero client exit or missing version-like stdout is reported as JSON with a nonzero exit status. The caller
must obtain the digest from a trusted source; this script does not download or
install anything.

Each invocation creates a fresh temporary HOME and workspace. The child gets
an empty environment, closed inherited file descriptors, no stdin, a new
process group, a 30-second timeout, and Bubblewrap's separate user, PID,
network, IPC and UTS namespaces. The CLI executable is mounted read-only at
`/opt/strict-client/client`; `/usr`, `/lib`, and `/lib64` when present are
mounted read-only as runtime roots. No persistent project or host HOME is
mounted writable. `/proc`, `/dev`, `/tmp`, and `/run` are private sandbox instances.
The version output and diagnostics are capped before they are printed.
`requestedIsolation` describes the arguments/environment constructed by the
harness, not measurements of effective mounts, credentials or network access.

## Scope and limits

This is bootstrap evidence only: successful `--version` execution shows that
this client binary can start in this particular disposable Bubblewrap setup.
It does not prove containment of Claude's tools, shell, subagents, MCP servers,
plugins, hooks, nested clients, authentication, transition authority, or any
future process. No host HOME, credentials, host sockets, or model-network
egress are intentionally provided. The client may therefore report missing
authentication or optional integration state in later experiments; this
probe does not solve those requirements.

The read-only bind of broad `/usr` and library roots is a development
bootstrap convenience, not a production filesystem allowlist. A digest check
followed by Bubblewrap's path bind is not race-free against a concurrent
replacement of the source file, so it is not a secure pinning mechanism or a
TOCTOU-proof launcher. Do not use this result to advertise a strict-active
state or to infer that a whole-client boundary has passed acceptance.
