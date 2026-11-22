# Fresh browser data directory fixture (C20 first slice, #77 / #79)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on Linux or WSL2 with Node, system Python, Bubblewrap and Chrome or
Chromium:

```sh
node test/live/strict-fresh-profile-probe.mjs [--chrome-sha256 <hex>]
```

## What it shows

Bootstrap step 6 and matrix row C20: the decision page opens in a fresh,
launcher-owned browser data directory with **remote debugging off**, and the
agent can't reach the listener the page talks to. It reuses the existing
read-only [decision listener](strict-decision-listener.md) and the same
`--dump-dom` approach as `test/live/strict-decision-listener-browser.mjs`.

**No-debugging evidence comes from the `--dump-dom` run only.** No CDP is
used, so neither `--remote-debugging-pipe` nor `--remote-debugging-port` is
ever passed to that browser. (`--remote-debugging-pipe` is itself debugging
and would not satisfy C20.)

**Browser pin.** The fixture resolves the Chrome or Chromium launcher to the
ELF binary it executes; a wrapper script is resolved to its sibling `chrome`.
It records that binary's SHA-256 and `--version`, and checks the running
browser's `/proc/<pid>/exe` is that binary. With `--chrome-sha256`, a
mismatch refuses with exit 2 (`browser-pin-mismatch`) before anything is
launched. On the measured host the hash was
`7ee5f9e4bf6674e3b19d8c7fb952aea78385e6ba6caa6330d62ed9821558cf6f`
(Chrome 143.0.7499.192).

**Listener.** The existing listener starts on loopback with a fixed fixture
capture (the same hostile-title file the listener browser probe uses), and
the fixture mints the one-time URL the same way.

**Browser data directory.** The fixture creates a scratch root (mkdtemp,
0700) and, for each launch, a new directory inside it with an exclusive
`mkdir`, so an existing path is refused. Before each launch it checks that
the directory is empty, a real directory (not a symlink), owned by the
fixture's uid, mode 0700, and not under HOME or any default Chrome or
Chromium location.

**Browser.** One headless run: `--headless=new --virtual-time-budget=10000
--dump-dom <URL>`, in its own session, with **Chrome's default sandbox only**.
There is no `--no-sandbox` fallback: if the sandboxed browser exits without
a DOM, the run refuses with exit 2 (`browser-sandbox-unavailable`). Its
environment is only `HOME` (the scratch root), `PATH` and
`DBUS_SESSION_BUS_ADDRESS=disabled:`. There are no display variables, so WSLg
is never touched; the fixture checks the browser's `/proc/<pid>/environ`
for them.

**Remote debugging off, TCP only, sampled while the browser runs.** Every
50 ms until the `--dump-dom` browser exits, the fixture collects the
browser's processes: 5 to 12 samples per run on the measured host, and at
least 2 are required. The processes are its session, its process tree, the
fixture's own children (reparented helpers) and any process naming the
scratch root. For each sample:
- no browser process command line contains `--remote-debugging` (any form);
- no `DevToolsActivePort` exists under the scratch root (checked again after
  exit);
- no TCP listener is held. The fixture collects the listening (`0A`) inodes
  from `net/tcp` and `net/tcp6` of every network namespace seen through
  those pids, then reads each process's `/proc/<pid>/fd` socket inodes. The
  intersection must be empty. An unreadable descriptor or net table of a live
  process fails the run. A read is retried once after 25 ms, so a process
  caught mid-exit isn't counted;
- at least one process is sandboxed (seccomp filter mode or its own user
  namespace).

Listeners opened and closed between two samples are not seen.

**Positive rendering.** The fixture parses the dumped DOM:
- the capture view (`data-strict-capture`) is present;
- the status says "Showing stored capture";
- the hostile title appears as escaped text, with no `<img>` in the view;
- the listener logged `/api/bind` and `/api/view` 200 during the run.

The virtual time budget lets the page's own binding script finish before the
dump, as in the listener browser probe.

**Negative control.** A second disposable headless browser starts in its own
fresh directory with `--remote-debugging-address=127.0.0.1
--remote-debugging-port=0`. It goes through the same process collection and
the same check, which must report at least one held TCP listener, at least
one `DevToolsActivePort` and at least one debugging switch. Nothing connects
to that port. Every run found 1, 1 and 5.

| Gate | Agent (Bubblewrap, `--unshare-net`) | Positive control (same worker, shared network namespace) |
| --- | --- | --- |
| Listener origin | `ECONNREFUSED`; the listener logs nothing | Connects; `GET /` gets an HTTP status (any) and the listener logs it |

The worker is system Python under `--clearenv`, with `/usr` and `/lib`
mounted read-only, and connects only to the fixture's listener.

**Cleanup, on a normal or signalled exit.** The probe re-executes itself
through a small Python shim that makes it a Linux child subreaper before
anything is launched, and checks this works with a disposable orphan.
Chrome's crash handlers leave the browser session, so the kernel reparents
them to the probe. Node never reaps those orphans, so their pids stay
reserved while the probe runs. After each browser and at the end, the probe
sends SIGTERM, then SIGKILL, only to its own direct children, rechecking the
parent pid just before each signal. It then requires:
- no live process in any browser session;
- no live child of the probe;
- no process whose command line names a browser data directory or the
  scratch root.

A matching command line fails the run but never authorizes a signal. Only
then is the scratch root removed. A failed cleanup is exit 1, the directory
is kept, and its path goes to stderr only. A failed check also keeps it.

The same cleanup runs on SIGINT, SIGTERM or SIGHUP and when the 150 s
watchdog fires. The run is abandoned, cleanup and its proof run, and the
scratch root is removed once proven. The result is `interrupted` or
`watchdog-aborted`, with exit 1. The outer process forwards those signals to
the inner one, and its own 180 s timeout as SIGTERM. It sends SIGKILL only
after a 45 s grace period. The test-only variable
`SKEL_C20_TEST_PAUSE_AFTER_LAUNCH_MS` pauses while the negative-control browser
is up, so a signal test can interrupt a live browser.

**Output.** One bounded JSON object: labels, booleans, counts and the binary
hash, with no paths, nonces or cookies. Exceptions are reported as fixed
labels.
- Exit 0: passed.
- Exit 1: a check or cleanup failed.
- Exit 2: not Linux, no Chrome or Chromium binary, no `/usr/bin/bwrap` or
  `/usr/bin/python3`, no child subreaper, Bubblewrap can't start a sandbox,
  a pin mismatch, or the sandboxed browser can't start.

## Measured

WSL2 (kernel 6.6), Chrome 143.0.7499.192 with its default sandbox, Node 20:
- five consecutive runs passed, one of them with a matching `--chrome-sha256`;
- each `--dump-dom` run was sampled 5 to 12 times with the browser up, with
  up to 14 processes, 8 of them sandboxed. It showed 0 TCP listeners held,
  0 debugging switches, no `DevToolsActivePort` and 0 unreadable tables;
- the agent got `ECONNREFUSED`, and the shared-network control got HTTP 505
  (the listener refuses HTTP/1.0);
- a wrong `--chrome-sha256` refused with exit 2;
- SIGINT to the probe's process group while the control browser was up ended
  `interrupted` with exit 1, with no browser process left and the scratch
  root removed;
- `/mnt/wslg/stderr.log` gained no lines.

## Not shown

- The human's protected window, or launching the browser from the real
  launcher (#75).
- An agent-started debugging browser: the agent control here is
  network-namespace reach to the listener only. N5
  ([browser endpoint fixture](strict-browser-endpoint.md)) covers the
  converse, where the agent can't reach a browser's debugging endpoint.
- Unix-domain and abstract automation sockets (TCP only), and listeners that
  exist only between two samples.
- Cleanup after SIGKILL of the probe itself.
- Any host other than the one measured.
