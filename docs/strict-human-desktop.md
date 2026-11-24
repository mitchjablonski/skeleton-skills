# Human desktop qualification (#231, first slice)

Status: a read-only inventory plus the qualification plan. No window has been
observed and no human step has been run. Strict remains `unverified`.

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

It prints one bounded JSON object with fixed labels:
- **Platform:** machine, kernel release, WSL or not (from `/proc/version`),
  whether the WSL interop binfmt entry exists, and whether a distro name is
  set.
- **WSLg:** `stat()` of `/mnt/wslg`, its version file and its log.
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
2. [ ] **Start the protected launcher** once the real-desktop launcher mode
   exists (a later slice; it doesn't yet). Note the command and the time.
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

## Next: the real-desktop launcher mode

The design for the launcher mode that opens the owned window on this seat is
in [real-desktop launcher](strict-real-desktop-launcher.md). It covers the
exact candidate and ozone choice, the ownership checks, refusal codes, the
maintainer's observations, and what Xvfb can pre-verify. It is design only;
nothing has been run against WSLg.

## Not shown yet

- Any real-desktop window, input or clipboard observation.
- A launcher mode that opens the owned window on the human desktop.
- XTEST or Wayland input-protocol reachability from the agent sandbox,
  beyond socket absence.
- Seats other than WSLg on the measured host.
