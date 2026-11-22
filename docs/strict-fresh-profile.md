# Fresh browser data directory fixture (C20 first slice, #77 / #79)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on Linux or WSL2 with Node, system Python, Bubblewrap and Chrome or
Chromium:

```sh
node test/live/strict-fresh-profile-probe.mjs
```

## What it shows

Bootstrap step 6 and matrix row C20: the decision page opens in a fresh,
launcher-owned browser data directory with remote debugging off, and the
agent can't reach the listener the page talks to. It reuses the existing
read-only [decision listener](strict-decision-listener.md) and the pipe CDP
client in `test/live/cdp-pipe.mjs`.

**Listener.** The existing listener starts on loopback with a fixed fixture
capture (the same hostile-title file the listener browser probe uses), and
the fixture mints the one-time URL the same way.

**Browser data directory.** The fixture creates a scratch root (mkdtemp,
0700) and then `browser-data` inside it with an exclusive `mkdir`, so an
existing path is refused. Before launch it checks that the directory is
empty, a real directory (not a symlink), owned by the fixture's uid, mode
0700, and not under HOME or any default Chrome or Chromium location.

**Browser.** Headless Chrome starts in its own session with
`--remote-debugging-pipe` and no TCP debugging flag. Its environment is only
`HOME` (the scratch root), `PATH` and `DBUS_SESSION_BUS_ADDRESS=disabled:`.
There are no display variables, so WSLg is never touched; the fixture also
checks the browser's `/proc/<pid>/environ` for them. Chrome's own sandbox is
preferred, with `--no-sandbox` used only if it can't start; the choice is
recorded.

**Remote debugging off**, checked once after launch and again after rendering:
- no `DevToolsActivePort` file anywhere under the scratch root;
- no browser process command line carries `--remote-debugging-port` or
  `--remote-debugging-address`, and the browser's carries
  `--remote-debugging-pipe`;
- no TCP listener is held by the browser. The browser's processes are its
  session, its process tree, the fixture's own children (reparented helpers)
  and any process naming the scratch root. The fixture collects the
  listening (`0A`) inodes from `net/tcp` and `net/tcp6` of every network
  namespace seen through those pids. It then reads each process's
  `/proc/<pid>/fd` socket inodes. The intersection must be empty, and an
  unreadable descriptor table fails the run instead of being skipped;
- **self control:** the same method, applied to the fixture's own pid, finds
  the decision listener it holds.

**Positive rendering.** Over the pipe, the browser navigates to the one-time
URL. The page must show the stored capture with status "Showing stored
capture", render the hostile title as text with no `<img>` and no script run,
and strip the hash. The listener must log `/api/bind` and `/api/view` 200.

| Gate | Agent (Bubblewrap, `--unshare-net`) | Positive control (same worker, shared network namespace) |
| --- | --- | --- |
| Listener origin | `ECONNREFUSED`; the listener logs nothing | Connects; `GET /` gets an HTTP status (any) and the listener logs it |

The worker is system Python under `--clearenv`, with `/usr` and `/lib`
mounted read-only, and connects only to the fixture's listener.

**Cleanup.** The probe re-executes itself through a small Python shim that
makes it a Linux child subreaper before anything is launched, and checks
this works with a disposable orphan. Chrome's crash handlers leave the
browser session, so the kernel reparents them to the probe. Node never
reaps those orphans, so their pids stay reserved while the probe runs. After
closing the browser over the pipe and stopping the listener, the probe sends
SIGTERM, then SIGKILL, only to its own direct children, rechecking the
parent pid just before each signal. It then requires:
- no live process in the browser's session;
- no live child of the probe;
- no process whose command line names the browser data directory or the
  scratch root.

A matching command line fails the run but never authorizes a signal. Only
then is the scratch root removed. A failed cleanup is exit 1, the directory
is kept, and its path goes to stderr only.

**Output.** One bounded JSON object: labels, booleans and counts, with no
paths, nonces or cookies. Exit 0: passed. Exit 1: a check or cleanup failed.
Exit 2 (`code: "unsupported"`): not Linux, no Chrome or Chromium, no
`/usr/bin/bwrap` or `/usr/bin/python3`, no child subreaper, Bubblewrap can't
start a sandbox, or the browser can't start.

## Measured

On WSL2 (kernel 6.6, Chrome 143 with its own sandbox, Node 20), three
consecutive runs passed. Each saw 15 to 16 browser processes, 96 to 117
sockets held, 0 TCP listeners held and no `DevToolsActivePort`, and the self
control found 1. The agent got `ECONNREFUSED`, and the shared-network control
got HTTP 505 (the listener refuses HTTP/1.0). Cleanup left 0 processes, and
`/mnt/wslg/stderr.log` gained no lines.

## Not shown

- The human's protected window, or launching the browser from the real
  launcher (#75).
- An agent-started debugging browser: the agent control here is
  network-namespace reach to the listener only. N5
  ([browser endpoint fixture](strict-browser-endpoint.md)) covers the
  converse, where the agent can't reach a browser's debugging endpoint.
- Unix-domain and abstract automation sockets, and same-user ptrace on the
  pipe descriptors.
- Any host other than the one measured.
