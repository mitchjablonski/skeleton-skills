# Development-only pinned Claude tool probe

`test/live/strict-client-probe.py` runs a pinned Claude Code CLI in a
disposable Bubblewrap root and points it at a deterministic Messages API mock
running in the same private network namespace. The mock supplies a fixed
five-call sequence: read a fixture in `/work`, edit that fixture, read an
absolute read-only control at `/opt/public-control.txt`, attempt to read an
unmounted private receipt, then run a fixed Bash command that checks both the
edited workspace and unavailable private path. It does not call a model or
contact an external API. The API key is a dummy value accepted only by the
local mock.

From Linux or WSL with Python 3.10+, provide trusted SHA-256 values for both executable files:

```sh
python3 test/live/strict-client-probe.py \
  --client /absolute/path/to/claude \
  --client-sha256 <trusted-64-hex-digest> \
  --node /absolute/path/to/node \
  --node-sha256 <trusted-64-hex-digest>
```

Both paths must be absolute regular executable files, not leaf symlinks. The
harness verifies each digest before launching. Bubblewrap must already be
available on `PATH`; the probe does not install dependencies or change
settings. It accepts no client arguments and fixes the prompt, model label,
tools, permissions, MCP mode, and Claude flags in the inner script.

The outer process runs with an empty environment, closed inherited file
descriptors, no stdin, a 120-second timeout, and process-group cleanup. The
Bubblewrap process requests separate user, PID, network, IPC, and UTS
namespaces; mounts `/usr`, `/lib`, and optional `/lib64` read-only; mounts the
pinned Claude and Node executables read-only; supplies minimal passwd/group
fixtures; and binds only fresh HOME and workspace directories writable. A
private sentinel receipt is created outside those binds and is never mounted.
The inner process reports observed network and PID namespace identifiers for
the outside wrapper and inside probe; the probe fails if either ID is missing
or equal across the boundary. These are observations from this run, not a
general enforcement attestation.

Success requires the CLI process and outer wrapper to exit zero; exactly five
tool results in the fixed order; the workspace read/edit and absolute public
control read to match their fixtures; the private Read to report a missing
path (`ENOENT`/not found); Bash to run and report the workspace control and
private path unavailable; distinct observed network/PID namespace IDs; and
the host-side sentinel receipt to remain unchanged. The private-path result
tests this disposable missing-mount fixture and does not identify a general
policy refusal. The wrapper accepts only the exact expected set of inner
check names and requires every check value to be the boolean `true`; missing,
unexpected, false, or non-boolean checks fail the run. Every success and failure record says
`"strictState":"unverified"`.
JSON output contains only bounded CLI output, endpoint/tool names, and bounded
fixture tool results; API request bodies and credentials are not logged.

## Scope and limits

This demonstrates one actual CLI run with built-in Read, Edit, and Bash tools
against a fixed local API script. It does not exercise or establish containment
of MCP servers, plugins, hooks, subagents, nested clients, WSL interop,
authentication, approval authority, or arbitrary workflows. The broad
read-only `/usr` and library mounts are a development bootstrap convenience,
not a production filesystem allowlist. The network namespace and temporary
fixtures are not a reviewed production launcher profile. The digest check
followed by path bind is not race-free against concurrent replacement of an
executable, so it is not TOCTOU-proof. This probe never activates strict mode
or authorizes release claims.

### Disposable native file tools

Add `--case file-tools` to the pinned probe invocation to qualify native Write, Read, and Edit using only `/work/file-tools.txt` and the local deterministic mock. The sequence is Write, Read, Edit, Read; exact offered tools, result IDs, request order, initial and final bytes are checked. The outer harness independently checks final bytes. The default remains `--case boundary`. This case makes no inference calls and does not qualify upstream authentication.

### Disposable native search tools

Add `--case search-tools` to offer exactly Glob and Grep. The local mock first
calls Glob with `*.txt` in `/work/search-corpus`, then Grep for
`^SEARCH_NEEDLE$` in that corpus's `alpha.txt`, with content output and line
numbers disabled. The exact results must be `/work/search-corpus/alpha.txt`
and `SEARCH_NEEDLE`, respectively, with no extra text. Result IDs and the three
API requests must follow the fixed order. No Bash or write tools are offered.

The disposable corpus contains only `alpha.txt` (`SEARCH_NEEDLE\n`) and
`beta.md` (`SEARCH_CONTROL\n`), where `\n` denotes one LF byte. Both the
inner process and outer harness independently require these exact members and
bytes after the client exits, using no-follow directory/file opens, regular
single-link files, exact sizes, and reads bounded to the expected size plus
one byte. A changed corpus fails the run. The default boundary and file-tools
cases are unchanged. Exact tool-result formatting is pinned-client behavior;
this case does not qualify other CLI versions, authentication, or general
search containment, and always retains `strictState: unverified`.
