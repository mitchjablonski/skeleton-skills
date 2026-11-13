# Actual pinned CLI fill fixture (#99)

This development-only probe connects real Claude Code Read, Edit and Bash tool
execution to the controlled stored-approval fill pipeline. A deterministic local
Messages API supplies fixed tool calls. It performs no model inference and uses
only a dummy API key. Strict status remains `unverified`; approval in this fixture
is a hard-coded mock transition, and completion remains false.

Run on Linux/WSL with system Python under /usr, Bubblewrap supporting --as-pid-1
and --info-fd, enabled namespaces, genuine host procfs and pidfd APIs. The caller
supplies absolute regular executable paths and full trusted SHA256 pins:

```sh
/usr/bin/python3 test/live/strict-actual-fill-probe.py \
  --client /home/mitch/.local/share/claude/versions/2.1.323 \
  --client-sha256 604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

Those paths/digests identify the observed local operator-installed binaries, not
a required release. Leaf symlinks and digest mismatches refuse before launch.
The executable check followed by path bind is not a defense against concurrent
executable replacement. Exit 0 means this controlled experiment passed; exit 1
means an attempted experiment failed; exit 2 means unsupported prerequisites or
invalid pins. Every result includes `strictState: "unverified"`.

The host constructs a fixed disposable skeleton, independently copies/captures
it, durably stores it before a mock authority reference, and mock-approves it
using existing candidate fixture session commands. Private capture and authority
stores stay outside all worker binds. Each case materializes a fresh directory
exclusively from the same persisted approved capture; exact capture equality and
fresh inodes are checked before launch. There is no user-project checkout write.

Each fresh Bubblewrap namespace runs a fixed Python supervisor as PID 1. That
supervisor starts the Node local API and actual pinned CLI and stays alive after
they exit. The namespace has a disposable home/config, readonly pinned binaries
and runtime libraries, writable fresh workspace and separate control directory.
The environment is explicit and empty of inherited user configuration; only the
local dummy API endpoint is configured. The new network namespace exposes no
external connection. No personal configs, credentials or settings are read or
changed. Broad readonly /usr and library binds are development conveniences,
not a production filesystem profile.

The valid case performs Read, selected-body Edit and Bash. The exterior case
adds one fixed exterior Edit after the selected Edit. Bash double-forks a
session-detached synchronous writer, closes its inherited descriptors, retains a
workspace file descriptor and repeatedly overwrites the selected sentinel with
identical filled bytes. A separate bounded control log advances after each
successful source write. The writer outlives the actual CLI and local API.

The host requires the exact successful tool sequence and result/check set,
client exit zero, and a live writer whose log continues growing AFTER client
exit. This demonstrates why CLI exit is insufficient. It then sends SIGKILL
through the stable namespace-init pidfd, waits for every tracked pidfd to exit,
checks no observed live namespace members remain, and waits for Bubblewrap exit.
Only afterward does the host invoke the independent candidate checker on the
exact stopped files. Valid selected-only fill is accepted; exterior drift is
rejected specifically as `FIXTURE_EXTERIOR`. Both checks separately confirm the
selected body changed. No source is reconstructed from tool logs or repaired
after teardown.

The host continuously samples namespace membership while the client runs and
opens pidfds for observed processes. This is controlled fixture evidence, not a
race-free hostile census; short-lived children may exit between observation and
handle acquisition. Holding namespace descriptors prevents identity recycling
between cases. Time, CPU, file sizes, API input, client output and metadata are
bounded. Failed teardown retains scratch; removal requires the existing UUID
ownership marker and realpath containment checks after successful teardown.

On 2026-11-12 the actual pinned executable reported `2.1.323 (Claude Code)`.
The local run passed valid and exterior cases in namespaces
`pid:[4026532234]` and `pid:[4026532236]`, tracking four process pidfds each.
Post-client control-log sizes advanced 16 to 30 and 19 to 33 bytes before
teardown. Both seeds resolved capture
`f9c9501309215c5d9fc30cbd1d7b2ee7832404a8406d22fe28398aa8da45dc4f`.
A wrong client digest separately refused with exit 2 before launch. These are
observations, not stable expected namespace IDs or release qualification.

This fixture does not authenticate a human, exercise actual model decisions,
solve pending asynchronous I/O or external/shared writers, prove arbitrary
hostile containment, enable strict mode, verify completed steps, finalize,
publish or provide rollback guarantees. Existing local tool and controlled
candidate probes remain separate checks. No production command imports these
new files.
