# Browser debugging endpoint and profile reach fixture (N5, #167 / #124 / #99)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on Linux or WSL2 with system Python, Bubblewrap and Chrome or Chromium:

```sh
/usr/bin/python3 -I test/live/strict-browser-endpoint-probe.py
```

## What it shows

Contract negative control N5: no automation or debugging endpoints.

**The browser.** The fixture launches **its own disposable headless
Chrome**:
- a fresh scratch profile holding a random marker file;
- a loopback remote-debugging endpoint (`--remote-debugging-address=127.0.0.1
  --remote-debugging-port=0`), with the port read from `DevToolsActivePort`.

The browser gets no display variables, so it never touches WSLg. It runs
with `--disable-background-networking`, and the fixture itself connects only
to the endpoint it created.

**Chrome's crash handlers do start** (Chrome 143 headless), each in its own
session. Their database is under HOME, which is the scratch root, and they
are configured with Chrome's crash-upload URL. No crash occurs in a passing
run, but the fixture doesn't block or observe their network traffic. The
output records how many were seen, and cleanup must reap them (below).

Chrome's own sandbox is preferred. `--no-sandbox` is used only if the
sandboxed browser can't start, and both the choice and the reason are
recorded.

**Endpoint identity is pinned:**
- the 127.0.0.1 listener's socket inode must be held by a process in the
  browser's own session, at the start and again at the end;
- `/json/version` must report the same browser both times;
- its `webSocketDebuggerUrl` must equal the address, port and path recorded
  in `DevToolsActivePort`.

| Gate | Agent (Bubblewrap sandbox) | Positive control (opens only that gate) |
| --- | --- | --- |
| Debugging endpoint (network namespace) | `ECONNREFUSED` | Shared network namespace: it connects, and the profile stays `ENOENT` |
| Browser profile (mount) | `ENOENT` | Profile bound read-only: the marker reads back, and the endpoint stays `ECONNREFUSED` |
| Both | — | The launcher itself reaches the endpoint and reads the marker |

**Cleanup.** Every browser session the fixture launched, including a failed
sandboxed attempt, gets SIGTERM, then SIGKILL. A pass needs both of these to
hold:
- no live process remains in any of those sessions;
- no process names anything under the scratch root on its command line.
  That catches the crash handlers and any other helper that left the
  session.

A session with nothing left alive isn't signalled again, because its
number may already belong to someone else.

A process that outlives cleanup fails the run (exit 1) and keeps the
scratch directory.

## Output and bounds

The output is bounded public JSON:
- the browser product string;
- whether Chrome's sandbox was on;
- the endpoint kind and address (loopback only);
- errno results.

Exit codes:
- **Exit 0:** passed.
- **Exit 1:** a check, positive control or cleanup failed.
- **Exit 2:** unsupported: no Chrome, Chromium or Bubblewrap, the browser
  can't start, or Bubblewrap can't start a sandbox.

## Limits

- One fixture-owned loopback CDP endpoint and profile. It says nothing
  about the human's own browser.
- C20 (a protected window, and acceptance of a fresh launcher-owned
  profile) stays open.
- WebDriver, abstract automation sockets, model egress and other host
  bindings (X14) need their own observations.

Observed on 2026-11-17 on WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64, system Python 3.12.3, Chrome 143.0.7499.192 with its sandbox on:
- the agent reached neither the endpoint nor the profile;
- each control opened exactly its own gate;
- the endpoint was held by the browser session at the start and at the end;
- no browser process or crash handler survived cleanup;
- a mutation that made the sandboxed attempt exit at once fell back to
  `--no-sandbox` and recorded why;
- `/mnt/wslg/stderr.log` gained no lines.

Strict remained `unverified`.
