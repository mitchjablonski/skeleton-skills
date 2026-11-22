# Agent browser fixture (C20 second slice, #77 / #79)

Status: opt-in development fixture only. No production entrypoint imports it.
It makes no support claim, and strict remains `unverified` after a pass.

Run on Linux or WSL2 with Node, system Python, Bubblewrap and Chrome or
Chromium:

```sh
node test/live/strict-agent-browser-probe.mjs [--chrome-sha256 <hex>]
```

It shares its harness with the
[fresh browser data directory fixture](strict-fresh-profile.md) in
`test/live/strict-browser-fixture.mjs`: the supervised run, browser pin,
fresh data directories, headless launches with no display variables, the
debugging sampler, fixed error labels and the cleanup proof.

## What it shows

Matrix row C20, second half: **an agent-started debugging browser never
receives the page**.

**Agent browser.** The fixture starts an "agent" headless Chrome from the
pinned ELF on `about:blank`. It runs in its own fresh 0700 data directory,
with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=0`. The
port is read from a bounded, validated `DevToolsActivePort`. The browser
keeps running for the whole run, and the fixture waits 2 s for its own
background targets to settle before taking a baseline of its targets.

**Launcher open.** The read-only decision listener starts with the fixed
fixture capture, and the one-time URL is minted. The URL is opened on the
#213 primary path: a fresh launcher data directory, `--dump-dom`, no
debugging switch and Chrome's default sandbox. The run is sampled while it
runs, with the same checks as the fresh browser data directory fixture:
- no debugging switch;
- no `DevToolsActivePort` under the scratch root (the browsers' HOME), apart
  from the agent's directory;
- no TCP listener held by the launcher's processes;
- at least one sandbox boundary Chrome added.

The agent's processes are attributed to the agent and excluded from the
launcher's sample. Attribution covers the agent's session, its process tree,
processes naming its directory, and the crash handlers those processes
reference by `--crashpad-handler-pid`. The rendering must show the capture,
with bind and view 200s.

**The agent browser never received it.** A background poller sends
`GET /json/list` to the agent's fixture-owned port about every 100 ms. It
polls before the launcher starts, during its run, and for 1.5 s after it
exits. The run requires:
- polls in all three phases and no poll errors;
- no target URL containing the listener origin;
- the agent's `page` targets identical to the baseline. Its own background
  and service-worker targets may appear on their own, so only page targets
  are compared;
- exactly one bind (status 200), with every bind and view the listener
  logged falling inside the launcher run. So there is no second consumer of
  the nonce.

**Singleton handoff: what Chrome actually does.** With a second nonce, the
fixture starts the pinned Chrome headless on the URL with the **agent's**
data directory (`--user-data-dir=<agent dir>`, no `--dump-dom`).
Headless Chrome 143 does **not** forward the URL to the running agent:
- the new process fails to create `SingletonLock` (`File exists`), logs
  "Failed to create a ProcessSingleton for your profile directory ...
  Aborting now", and exits with code 21 within about 100 ms;
- no target appears in the agent, and the listener gets no request.

This is a lock refusal, not a second instance and not a forward. The fixture
records the exit code, whether the lock text appeared, whether anything was
forwarded, and the listener request count.

**Negative control.** Because the singleton refuses, the fixture shows the
check can detect a page arriving in the agent another way. With a third
nonce, it opens the URL in the agent through CDP `PUT /json/new` on the
agent's fixture-owned port. `/json/list` must then show a target with the
listener origin; the listener also logs the agent's bind. If a future Chrome
does forward through the singleton, that forward is used as the control.

**Cleanup, on a normal or signalled exit.** Between phases the fixture stops
only the launcher's or handoff's leftovers, keeping the agent's processes.
At the end, cleanup stops every browser, the agent included, and the
listener. It then proves no live process remains in any browser session,
among the probe's children, or naming a data directory or the scratch root.
Only then is the scratch root removed. A failed cleanup is exit 1 with the
directory kept, and its path goes to stderr only. SIGINT, SIGTERM, SIGHUP
and the 150 s watchdog run the same cleanup and end `interrupted` or
`watchdog-aborted` with exit 1. `SKEL_C20_TEST_ANNOUNCE_LAUNCH=1` writes a
stderr marker once the launcher browser is up, for a signal test; a run using
it never passes.

**Output.** One bounded JSON object: labels, booleans, counts and the binary
hash, with no paths, nonces, URLs or cookies.
- Exit 0: passed.
- Exit 1: a check or cleanup failed.
- Exit 2: not Linux, no Chrome or Chromium binary, no `/usr/bin/bwrap` or
  `/usr/bin/python3`, no child subreaper, a pin mismatch, no sandbox
  evidence, the agent browser can't start (`agent-browser-unavailable`), or
  the sandboxed launcher browser can't start (`browser-sandbox-unavailable`).

## Measured

WSL2 (kernel 6.6), Chrome 143.0.7499.192
(`7ee5f9e4bf6674e3b19d8c7fb952aea78385e6ba6caa6330d62ed9821558cf6f`),
Node 20:
- three consecutive runs passed, one with a matching `--chrome-sha256`;
- each launcher run was sampled 4 times, with up to 16 processes and 7
  sandboxed. It showed 0 held listeners, 0 switches, no
  `DevToolsActivePort` and 0 unreadable tables;
- the agent was polled 5 times before, 4 during and 16 after. It never named
  the listener origin, its page targets were unchanged, and the listener saw
  1 bind;
- the singleton handoff exited 21 with the lock refusal text, forwarding
  nothing;
- `PUT /json/new` returned 200, and the origin then appeared in the agent's
  targets;
- SIGINT to the probe's process group while the launcher browser was up
  ended `interrupted` with exit 1, no browser process left and the scratch
  root removed;
- `/mnt/wslg/stderr.log` gained no lines.

## Not shown

- The human's protected window, or the real launcher (#75).
- An agent reaching a browser through other channels: a CDP pipe it holds,
  extensions, shared files, or a debugging endpoint the fixture didn't
  start.
- Listeners or targets that exist only between two samples or polls.
- Any host other than the one measured.
