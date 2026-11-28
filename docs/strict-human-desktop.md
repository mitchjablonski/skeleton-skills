# Human desktop qualification (#231, first slice)

Status: read-only inventory, an operator runbook for real WSLg with a fixed
synthetic capture and worker, and the qualification plan. Human observation is pending.
Strict remains `unverified`.

This is the human-desktop part of #79. Codex owns the separate readiness and
load slice (#230). Xvfb evidence (the
[private display mode](strict-fresh-profile.md) and the namespace admission
window cases) stays fixture evidence and never stands in for the real
desktop.

## Launcher isolation prerequisite

The opt-in `--desktop-isolation-preflight` mode of
`test/live/strict-namespace-admission-probe.py` uses the existing Node and
Bubblewrap pins. It starts only the fixed launcher-owned x86_64 fixture.
The namespace starts with the shared display isolation filter. Its worker
checks that AF_VSOCK socket creation is refused and that ordinary local
socket creation succeeds. Neither check connects to an endpoint.

The launcher requires the worker report from its owned PID namespace and
independent kernel evidence of an added seccomp filter. It stops the
namespace and proves cleanup before reporting success. Missing evidence
refuses the preflight. This mode opens no window and contacts no desktop;
its result is `unverified` and does not authorize a human-desktop launch.

## The read-only inventory

```sh
node test/live/strict-desktop-inventory.mjs [--chrome-sha256 <hex>]
```

### Fixed candidate preflight

```sh
node test/live/strict-desktop-inventory.mjs --real-seat-preflight
```

This opt-in check samples the x86-64 WSL2 seat before and after inspecting
the pinned Chrome ELF from the [launcher design](strict-real-desktop-launcher.md).
It checks the mountinfo device against the seat's filesystem entries and
the fixed installation path for root ownership, writable group or other
bits, and symlinks. It hashes the opened regular file and rechecks
its identity and the path chain. It only reads passive evidence. Root and
filesystem trust, the isolation preflight, operator conditions and the
actual window all have separate checks. Success still reports
`strictState: "unverified"`.

### Interactive rehearsal

```sh
node test/live/strict-desktop-inventory.mjs --real-seat-rehearsal
```

The rehearsal checks that standard input and output refer to the same
control terminal and asks for the operator attestations in the launcher
design. It carries the same terminal, seat and pinned Chrome installation
identity through readiness and the restart check. It samples install
metadata under the trusted-root assumption. A terminal change, negative
response, missing evidence or changed seat or executable refuses. Once
a bound check refuses, a later match cannot revive that binding. The rehearsal
is read-only. It samples passive evidence, collects operator statements and
reports `strictState: "unverified"`.

The retained binding's `confirmRestart()` checks the seat, asks the operator
to confirm the conditions for that restart, and checks the same seat again.
A refused confirmation ends that binding.

The operator binding's `prepareWindow()` generates one phrase for the
selected capture and its navigation. After the selected page loads,
`confirmMatch()` shows the phrase and capture version on the operator
terminal and asks the operator to compare them with the browser. The
same navigation must still be current after the operator answers.
The prepared window's `confirmRestart()` repeats the comparison and
rechecks the operator attestations. It requires a successful initial
comparison. The private-window fixture verifies that the phrase and
capture version stay the same across restart.

### Inventory fields

It prints one bounded JSON object with fixed labels:
- **Platform:** machine, kernel release, WSL or not (from `/proc/version`),
  whether the WSL interop binfmt entry exists, and whether a distro name is
  set.
- **WSLg:** `stat()` of `/mnt/wslg`, its version file and its log.
  `x11Anchor` reports whether the fixed `:0` directory and socket refer to
  the same filesystem objects through both WSLg paths and whether mount
  metadata shows the expected read-only bind.
- **Environment:** `DISPLAY` and `WAYLAND_DISPLAY` names (for example `:0`,
  `wayland-0`), and whether `XDG_RUNTIME_DIR`, `PULSE_SERVER` and
  `XAUTHORITY` are set.
- **Sockets, by `stat()` only:**
  - the X11 socket directory and whether it is writable;
  - the display's X11 socket and WSLg's X11 directory;
  - the runtime and WSLg Wayland sockets;
  - the WSLg Pulse server;
  - the session bus.
- **Input:** whether `/dev/uinput` exists and is writable by this user.
  XTEST is reported as unknown, because finding out needs an X client.
- **Tools:** whether `xdotool`, `xprop`, `xwininfo`, `xinput`, `xauth`,
  `xclip`, `xsel`, `Xvfb`, `wlrctl`, `wtype`, `ydotool`, `wl-copy`,
  `wl-paste`, `weston` and `bwrap` exist (an executable check only).
- **Browser:** the installed candidate's label and SHA-256. If
  `--chrome-sha256` is supplied, the inventory compares the digest and
  refuses a mismatch. The inventory does not execute the browser. Use
  separate qualified evidence for the version.
- **Namespaces:** this process's namespace ids.

**Safety.** An earlier probe crashed WSLg's compositor by connecting to X0
and the audio sink (see [display interop](strict-display-interop.md)). So,
for anything under `/mnt/wslg`, `/tmp/.X11-unix` or `$XDG_RUNTIME_DIR`, and
for the Wayland, Pulse and session-bus sockets, the inventory uses only
`lstat()`, `access(W_OK)` and `readlink()` (the latter only on
`/proc/self/ns/*`):
- it never opens, connects to or binds any of them;
- the Wayland runtime entry is a symlink, and `lstat()` doesn't follow it
  to its target;
- starts no child processes;
- prints no home paths, user names or socket paths.

The anchor check also reads `/proc/self/mountinfo` for the fixed mount paths.

Exit 0: inventory recorded. Exit 2: unsupported (not Linux, no Chrome or
Chromium binary, a pin mismatch, or unexpected arguments).

**What it does NOT show:**
- that any window can be shown, or that one is visible to the human;
- who can reach a socket: a socket inode says nothing about a live server or
  its clients;
- XTEST, compositor input policy, clipboard ownership, or how the terminal
  emulator handles titles and clipboard escapes;
- anything about the agent's view of the seat: the agent sandbox is
  separate, see below.

The launcher-side metadata helper keeps the initial filesystem and namespace
observations private. It can recheck them before readiness and at protected
restart. A changed or unreadable observation invalidates that binding for
the rest of its lifetime. This check samples continuity in the calling
namespace. Server identity, window ownership and human presence need
separate evidence. The inventory records the initial observation only.

**Measured** on 2026-11-22: WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`,
x86_64.
- WSLg's mount and version file are present.
- `DISPLAY=:0` and `WAYLAND_DISPLAY=wayland-0`.
- The X0, WSLg Wayland, Pulse and session-bus sockets are present as socket
  inodes. The Wayland runtime entry is a symlink.
- `/tmp/.X11-unix` is **not writable** (a read-only bind of WSLg's tmpfs).
- `/dev/uinput` exists but isn't writable by this user.
- Of the tools, `xprop`, `xwininfo`, `xauth`, `Xvfb` and `bwrap` are present;
  `xdotool`, `xinput`, `ydotool`, `wtype` and `wlrctl` are absent.
- The browser is Chrome 143.0.7499.192, with SHA-256
  `7ee5f9e4bf6674e3b19d8c7fb952aea78385e6ba6caa6330d62ed9821558cf6f`.
- `/mnt/wslg/stderr.log` gained no lines.

## WSLg: one desktop shared unless the agent is sandboxed away

On WSLg, every process of the user sees the same X0 socket, Wayland socket,
Pulse server and session bus. Any agent process that can reach X0 or
`wayland-0` can create windows, read window titles and, with XTEST over X11,
inject input into another client's window. **Without the sandbox there is no
desktop boundary between the human and the agent.**

The existing Bubblewrap agent sandbox hides them. The N4 fixture
([display interop](strict-display-interop.md)) records this:
- with `--clearenv`, none of `DISPLAY`, `WAYLAND_DISPLAY`,
  `DBUS_SESSION_BUS_ADDRESS`, `WSL_INTEROP`, `PULSE_SERVER` or
  `XDG_RUNTIME_DIR` reaches the sandbox;
- the actual WSLg X11, Wayland, session-bus, Pulse and RDP sockets give
  `ENOENT` inside it, because they aren't mounted. Each positive control,
  which bind-mounts one socket, shows it as a socket inode;
- with `--unshare-net`, an abstract-socket listener is refused. That covers
  an abstract X socket such as `@/tmp/.X11-unix/X<n>`;
- AF_VSOCK still reaches the Hyper-V host from inside the namespaces, and
  only a seccomp filter closes it. That is a fixture mitigation, not an
  adopted policy.

So the separation rests on the agent being launched only inside that
sandbox. The seat itself provides none.

## Acceptance criteria (#231)

| Criterion | A fixture can prove | Needs a human |
| --- | --- | --- |
| A fresh, pinned, launcher-owned browser data directory with debugging off | Pin and digest; a fresh 0700 directory; no debugging switch, `DevToolsActivePort` or held TCP listener while it runs (C20 fixtures) | — |
| An actual human-visible window for the exact selected capture | That a window titled for the decision page is mapped and owned by the launched browser PID. On the real desktop this requires an X client, which isn't run yet | That the window is actually visible on the screen they use, shows the expected capture hash, and isn't covered or spoofed |
| The decision input stays in the protected terminal | The browser page is read-only, with no decision route (H3), and the control PTY input policy (C6, C18) | That typing decisions happens in the separately identified control window, and the browser accepts none |
| Agent desktop separation for this seat | The sandbox hides the display, Wayland, bus and Pulse sockets and the environment (N4). `/dev/uinput` isn't writable | That nothing typed or pasted from the agent pane reaches the owned window or the control window |
| Clipboard and title handling | OSC 52 and OSC 0/1/2 filtering on the agent PTY (C18) | How the actual terminal emulator shows filtered titles and handles clipboard requests |
| Navigation leaves no credential in agent-visible evidence | The one-time URL is host-only; the agent sandbox can't reach the listener (C20, X14); nonces are never printed | — |
| Healthy restart keeps the window and generation; loss and replacement refuse or clean up | The namespace admission window cases (Xvfb) | That the same holds with the real window, and what the human sees on loss |

## When the launcher must refuse

The launcher must refuse to open the protected review on a seat, and never
fall back, when the desktop evidence is unavailable or untrusted:
- **The window can't be attributed to the owned browser.** No mapped
  window, a title mismatch, or `_NET_WM_PID` (or the compositor's
  equivalent) isn't the launched browser's PID.
- **The seat is shared with the agent.** The agent process has any of
  `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`,
  `PULSE_SERVER` or a session-bus address, or any of those sockets (or
  `/mnt/wslg`) is mounted into its sandbox, or it shares the network
  namespace where an abstract X socket lives.
- **The agent can inject input.** It can reach an X server with XTEST, a
  writable `/dev/uinput`, or a Wayland or virtual-keyboard protocol socket.
- **The agent can reach WSL interop.** That covers the interop socket
  (`/run/WSL`, `WSL_INTEROP`), `/init`, a registered `WSLInterop` binfmt
  that runs Windows binaries for it, or the ability to execute anything
  under `/mnt/<drive>`. Interop access invalidates isolation from the
  human's Windows desktop and clipboard. The N4 fixture
  ([display interop](strict-display-interop.md))
  shows the strict sandbox refuses a Windows binary and that binding
  `/run/WSL` alone re-enables it. Matrix row X13 records interop as a
  launch refusal.
- **AF_VSOCK isn't proven denied.** Refuse unless `socket(AF_VSOCK)` is
  shown to fail inside the agent sandbox. On WSL2, namespaces don't confine
  vsock: the N4 fixture reached the Hyper-V host from inside
  `--unshare-net`. Only its seccomp filter refuses `socket(AF_VSOCK)` (and
  `io_uring_setup`). The descriptor fixture
  ([descriptor probe](strict-descriptor-probe.md), #162) shows a
  `--seccomp` program actually loaded. That filter is still a fixture
  mitigation, not an adopted policy.
- **Debugging is on**, or not proven off: any `--remote-debugging-*`
  switch, a `DevToolsActivePort`, a held TCP listener, or unreadable
  evidence.
- **The pin doesn't match**, or the browser data directory isn't fresh,
  owned and 0700.
- **Evidence can't be read:** unreadable `/proc` tables, socket state that
  can't be determined, or tools missing for the required observation.

## Steps Mitch must perform personally (not run yet)

These need a human on the real seat. Please do them in a normal WSL terminal
on the Windows desktop, not from an agent pane, and report the results under
#79. Don't change existing browser profiles or display settings.

1. [ ] **Record the seat:** run
   `node test/live/strict-desktop-inventory.mjs --chrome-sha256 7ee5f9e4bf6674e3b19d8c7fb952aea78385e6ba6caa6330d62ed9821558cf6f`
   and save the JSON. Note the terminal emulator (Windows Terminal or
   other) and its version.
2. [ ] **Start the protected launcher** when the full contained launch and
   restart flow is wired into the real seat. Note the command and time.
3. [ ] **Look at the screen:** confirm a new browser window appears titled
   `Skeleton decision (prototype)`. Note the capture hash shown in the page
   status, and compare it with the hash printed in the control window.
   Report whether they match.
4. [ ] **Check it is the owned browser:** confirm the window has no
   extensions, bookmarks or signed-in profile, and that your normal Chrome
   windows are unchanged.
5. [ ] **Check isolation evidence for this seat.** Review the launcher
   report for display, input, clipboard, and interop isolation. Use
   dedicated, fixture-owned endpoints and synthetic inputs for active
   controls. Record which checks the candidate could verify, and refuse a
   support claim while any required check is missing.
6. [ ] **Windows Terminal cross-pane features:** check that broadcast
   input (sending input to all panes) is off. Check how the clipboard and
   any shared-input or pane-sync features behave across panes and tabs, and
   that none of them joins the agent pane to the control window. Note the
   Windows Terminal version and the relevant settings.
7. [ ] **Try the browser side:** click in the owned window and type. Report
   whether anything is accepted. Expected: it is read-only, with no decision
   control.
8. [ ] **Decide in the control window:** enter the decision in the
   separately identified control window. Confirm it is accepted there only.
9. [ ] **Clipboard and title:** record the terminal emulator's behavior
   from an isolated test session using fixture-owned test data and windows.
   Confirm that agent output leaves the protected clipboard and title
   unchanged.
10. [ ] **Restart and loss:** restart the launcher healthily and confirm the
   window and generation are kept. Then close the owned browser window
   yourself, and report whether the launcher refuses or cleans up, with the
   message shown.
11. [ ] **Cleanup:** after the run, confirm no extra Chrome windows or
    processes remain, and that `/mnt/wslg/stderr.log` has no new lines
    (`wc -l /mnt/wslg/stderr.log` before and after).

## Operator run for the real WSLg window

Use a fresh WSL tab in Windows Terminal on the WSLg desktop. From the
repository checkout containing this launcher, run the commands below. Use
the WSL Node installation on your PATH and the pinned Chrome installation
from the [launcher design](strict-real-desktop-launcher.md).

```bash
git rev-parse HEAD
git status --porcelain
node --version
wc -l /mnt/wslg/stderr.log
```

Use the reviewed commit in a clean checkout. An empty `git status --porcelain`
confirms the checkout is clean. Then run the launcher and record the final
WSLg log line count.

```bash
python3 -I test/live/strict-real-seat-launcher.py --real-seat-launcher
wc -l /mnt/wslg/stderr.log
```

Answer each attestation yourself with the literal `yes` only if it holds.
Once Chrome opens, check that a single new review window is visible, the
profile is fresh, and your other browser
windows are unchanged. Compare the phrase and capture version on the page
with the values in the control terminal. At the restart checkpoint, repeat
the comparison and check that the same window stayed open. The second
prompt rehearses the restart check with the original process still running.
After the launcher returns, confirm its window is gone and your existing
windows are still present.

Post the final JSON result, commit SHA, clean-checkout status, Windows
Terminal and Node versions, and WSLg log line counts before and after to
#79. Include which visual comparisons and cleanup checks you could witness.
Keep the phrase and any private
navigation data out of the issue. If the runner refuses, record its code
and whether the owned window closed. A refusal or an increase in WSLg log
lines needs investigation before trying again. `wslg-window-teardown-unproven`
can hide the first failure (for example after the seat changed), so check the
window by hand. If the result has a `leftover` list, usually after
`real-seat-cleanup-unproven`, make sure no process from the run remains
before deleting those directories. `pgrep -af skel-wslg` printing nothing is
only a heuristic, so also check `lsof +D <dir>` for each listed directory.
The `/dev/shm/skel-wslg-*` scratch holds the Chrome profile. The contained
and interactive runs' `/tmp/skel-wslg-state-*` holds the protected key
snapshot and client transcripts. Never attach either to the issue.

The success code is `real-seat-window-checkpoint-passed`. This command
serves a fixed synthetic capture with no decision codes. It checks the
retained window, capture and phrase at the restart checkpoint. Full #79
qualification still needs the controlled agent restart, real decision
terminal and desktop isolation checks above. A contained agent run also
depends on the private PID isolation in #172 to protect Chrome's navigation
argument from agent-visible process metadata. The result stays
`strictState: unverified` with `attribution-unavailable` because WSLg's
X server PID namespace has no verified translation.

## Operator run for protected approval and contained restart

Use a fresh foreground WSL tab in Windows Terminal and a clean checkout of
the reviewed commit. This run uses the real WSLg window and the tab that
starts the launcher as its protected decision terminal. It runs the fixed
synthetic worker in its own Bubblewrap namespace. It uses only its own
temporary source, history, profiles and stages.

Prepare the runtime selection on the same WSL distribution with the pinned
Node 22 candidate on your PATH. Record the commit, empty
working-tree status, Windows Terminal and Node versions, and the WSLg
log line count before beginning.

```bash
git rev-parse HEAD
git status --porcelain
node=$(command -v node)
"$node" --version
receipt=$(mktemp /dev/shm/skel-wslg-runtime.XXXXXXXX)
node_pin=3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327
bwrap_pin=e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71
worker_pin=$(git show HEAD:test/live/strict-launcher-binding-worker.mjs | sha256sum | cut -d ' ' -f 1)
terminal_pin=$(git show HEAD:test/live/strict-terminal-host-worker.mjs | sha256sum | cut -d ' ' -f 1)
/usr/bin/python3 -I test/live/strict-runtime-receipt.py observe-node-channel \
  --node "$node" --node-sha256 "$node_pin" --bwrap-sha256 "$bwrap_pin" \
  --binding-worker-sha256 "$worker_pin" --scratch-root /tmp > "$receipt"
```

Continue only after the runtime receipt command succeeds.

```bash
wc -l /mnt/wslg/stderr.log
/usr/bin/python3 -I test/live/strict-real-seat-launcher.py --real-seat-contained "$receipt" "$terminal_pin"
wc -l /mnt/wslg/stderr.log
```

1. Answer the attestations yourself. Compare the phrase and capture on the
   single new Chrome window with the control terminal. Confirm the fresh
   profile and check that your existing browser windows are unchanged.
2. Reveal the approval command on the page. Type it (don't paste it) in
   the control terminal and press Enter. The prompt reads raw keystrokes
   without echo. It refuses a paste only when the terminal marks it with
   bracketed-paste sequences, which Windows Terminal does. On a terminal
   that doesn't, a paste can't be told apart from typing. You get one
   attempt: Backspace and Ctrl-U edit, but a mistyped line, an arrow or
   other escape key, or the 120 s timeout ends the prompt as a refusal.
   Ctrl-C cancels, and the run reports that as an approval refusal, not an
   interrupt. The browser page stays read-only. Wait for the approval and first-worker
   messages.
3. When the launcher reports that the first worker stopped, compare the
   retained window and attest again. After the **new worker** message,
   confirm the same window, phrase and capture once more.
4. Check that the launcher closes its browser window and leaves the
   other windows in place. Save the final JSON. The success code is
   `real-seat-contained-restart-passed`.
5. In a separate run, close only the owned Chrome window after the new
   worker message and before answering. Expect `wslg-owned-window-lost`.
   Record the refusal, the owned-window teardown, and the before/after
   WSLg log counts. When both runs are recorded, remove the receipt with
   `rm -- "$receipt"`. Keep approval codes, phrases and private navigation
   data out of #79.

The supervisor requires fresh readiness from the same protected generation,
proves the first namespace stopped after a graceful shutdown, and starts a
different namespace from the approved stored bytes. It checks desktop-policy and control-terminal
separation evidence in both namespaces. Report human observations and
fixture evidence separately in #79. The interactive Claude CLI, its agent
pane input/output and clipboard/title checks follow in the next section,
which has no recorded run in #79 yet. The broader #79 matrix remains separate
qualification work. The result keeps `strictState: unverified`.

## Operator run for the interactive Claude CLI

Use the foreground WSL control tab and the pinned runtime receipt from the
previous section. Select the reviewed native Claude executable by its
resolved absolute path and independent SHA-256. Record both the candidate
version and pin. On the measured WSL seat the candidate was Claude Code
2.1.332 with SHA-256
`a2df1f41bb00250992926420d0063f89b127cb81abdd284dbefb80c50ff1d026`.

```bash
claude=$(readlink -f "$(command -v claude)")
claude_pin=a2df1f41bb00250992926420d0063f89b127cb81abdd284dbefb80c50ff1d026
wc -l /mnt/wslg/stderr.log
/usr/bin/python3 -I test/live/strict-real-seat-launcher.py --real-seat-interactive \
  "$receipt" "$terminal_pin" "$claude" "$claude_pin"
wc -l /mnt/wslg/stderr.log
```

The launcher starts the pinned interactive CLI on its own private PTY in
each admitted namespace. The agent pane shows an ASCII transcript with
terminal controls removed. Display endpoints, session-bus settings and
WSL interop paths are absent from the worker's environment and filesystem.
Both turns use the same predetermined prompt, a disposable HOME, and a
local API fixture. Personal credentials, user settings, tools, plugins and
arbitrary prompt input are outside this run.

1. Before launch, note the control and agent tab titles and put a harmless
   marker on your clipboard using an empty scratch editor. Keep terminal
   broadcast and pane synchronization off.
2. Compare the browser phrase and capture in the control tab. Enter the
   approval there only. Keep the approval code and phrase out of the
   agent tab, clipboard and report.
3. When the control tab prints the attach command, paste it unchanged into
   a **separate foreground WSL tab**. It uses absolute paths, and the relay
   accepts only that exact command: the launcher's Node running this
   checkout's pane filter on this run's socket. Any other client (another
   checkout's script, `socat`) gets no agent output. Wait for Claude's startup
   transcript, record the displayed version, type `witness`, and press Enter once. Check that the
   agent pane shows `DESKTOP-WITNESS` and `LOCAL-FIXTURE-REPLY`. Check
   that the typed marker and reply never appear as agent output in the
   control tab or decision page. Leave the agent pane attached until the
   launcher closes it. Confirm the observed reply in the control tab.
4. Confirm the retained review after the first namespace stops. Repeat
   the agent-pane exchange with the replacement namespace and confirm the
   same browser window, capture and phrase.
5. Check that both tab titles stayed as expected and that a paste into
   your empty scratch editor still shows your own clipboard marker.
   Check that the owned browser and agent connections close and that
   existing windows stay open. In a separate run, close the owned browser
   during the second agent exchange to witness refusal and teardown.
6. Report the checkout, runtime pins, terminal version, window and
   clipboard observations, WSLg log counts, and final JSON under #79.
   Success reports `real-seat-interactive-restart-passed`. Keep the
   run's approval code, phrase and private navigation data out of the
   report.

The local fixture exercises the real CLI and terminal path on the candidate
seat. The remaining #79 matrix covers upstream authentication, tools,
general client behavior, and additional profiles. Strict remains
`unverified`.

## Not shown yet

- Any real-desktop window, input or clipboard observation.
- XTEST or Wayland input-protocol reachability from the agent sandbox,
  beyond socket absence.
- Seats other than WSLg on the measured host.
