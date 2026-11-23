# Real-desktop launcher mode: design (#231)

Status: **design only.** No code connects to the real desktop, and nothing in
this slice was run against WSLg. Strict stays `unverified`. It builds on the
merged Xvfb window mode:
- the private display helpers, `test/live/strict-private-display.mjs`;
- the #227 protected window, `test/live/strict-protected-window.mjs`, and
  its admission and restart checks
  ([namespace admission](strict-namespace-admission.md#protected-browser-window));
- the #232 display-slot proof;
- the read-only seat inventory and acceptance record in
  [human desktop](strict-human-desktop.md).

The question this answers, before any human session: which exact seat, which
ownership checks, which conditions refuse, and what the maintainer must
observe.

## 1. The exact candidate

| Item | Candidate |
| --- | --- |
| Host | Windows with WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, x86_64 (#235 inventory) |
| Desktop broker | WSLg: weston with XWayland, shown on the Windows desktop over RDP (RAIL). X socket `:0` (`/tmp/.X11-unix/X0`, a read-only bind of WSLg's directory) and `wayland-0` |
| Browser | Google Chrome **143.0.7499.192**, ELF `/opt/google/chrome/chrome`, SHA-256 `7ee5f9e4bf6674e3b19d8c7fb952aea78385e6ba6caa6330d62ed9821558cf6f`, run directly (not the wrapper script), with its default sandbox |
| Ozone platform | **X11 through XWayland** (`--ozone-platform=x11`, with only `DISPLAY=:0` passed). See below |
| Browser data directory | Fresh, launcher-created, 0700, on a verified tmpfs (`/dev/shm`, as in the #227 window), and removed after the proof |
| Control surface | The human's own terminal tab that started the launcher (candidate A, below) |

**Ozone choice: X11 through XWayland (recommended).**
- **Ownership checks need it.** Under X11 the launcher can enumerate
  top-level windows and read their properties. That is how the merged Xvfb
  mode checks for exactly one window owned by the launched PID
  (`xwininfo`/`xprop`). Under native Wayland, no client can enumerate or
  inspect another client's windows. The launcher could not even tell that
  its window exists, let alone that it is the only one.
- **Same code path.** It keeps the code path the Xvfb fixtures already
  exercise (`--ozone-platform=x11`), so pre-verification transfers.
- **The cost is X11's weak isolation.** Any client on `:0` can read
  properties, spoof titles and inject input (XTEST), and WSLg's `:0`
  accepts local clients without a cookie. This is acceptable **only**
  because the agent can't reach `:0` at all: the N4 sandbox removes the
  socket, the environment and the abstract namespace (section 4). The
  remaining `:0` clients are the human's own processes, which the trust
  model already trusts.
- **Wayland fallback, if adopted later:** native Wayland gives better
  isolation but no external attribution. It would have to rely on human
  observation alone, and so is not recommended for qualification.

**Not candidates.** Each of these is refused, not degraded:
- native Windows Chrome or Edge: outside the pinned Linux binary, with
  profiles and extensions the launcher doesn't own;
- the user's own Linux browser data directory, or any existing or shared
  one;
- the wrapper script or an unpinned binary, any `--no-sandbox` launch, and
  any remote-debugging switch (pipe or port);
- native Wayland ozone (see above);
- Xvfb or any private display, which stays fixture evidence only;
- tmux, screen, or IDE and agent-hosted terminals as the control surface;
- a remote or shared seat (RDP session sharing), or a seat where the agent
  runs unsandboxed.

## 2. Ownership checks

| Subject | What is checked | How | What it proves |
| --- | --- | --- | --- |
| Browser binary | SHA-256 of the ELF equals the pin, before any run | Harness `pinBrowser`, with the pin normalized | The executable content at launch time |
| Browser process | `/proc/<pid>/exe` path equals the pinned path, not ` (deleted)`; the exe inode and device equal the hashed file's; the browser leads its own session; it is the launcher's direct child (subreaper) | `/proc` reads, as in the C20 sampler | The running process is the pinned file the launcher started, and a swap by rename fails closed |
| Window attribution | Exactly one top-level window titled `Skeleton decision (prototype)…`, mapped and viewable. Its `_NET_WM_PID` is the launched PID; `WM_CLIENT_MACHINE` is this host; and its lifecycle follows the process (absent before launch, present after, gone within a bound when the owned PID is stopped) | X11 queries on `:0`, run only inside the human-launched session (section 7) | The only matching window belongs to a process that says it is the owned PID and that lives and dies with it |
| Window attribution (stronger, if available) | X-Resource client PID (`XResQueryClientIds`, PID mask) for the window's client equals the launched PID | XRes query | A server-side PID, not one the client set |
| Browser data directory | Created fresh (exclusive `mkdir`), 0700, owned by us, on tmpfs, never the default, and unused before launch | `lstat`/`statfs`, as in the harness | No prior state, extension or debugging port file |
| Debugging off | No `--remote-debugging*` switch in any browser process, no `DevToolsActivePort` under the scratch root (HOME), no TCP listener held, and all tables readable. Checked at launch, during a bounded sample, **and at every restart check** | The shared sampler | No debugging endpoint is open at those samples |
| Private navigation | The one-use URL comes from the host-only window navigation method. It passes only on the owned browser's argv, inside the launcher's namespace, which the agent can't read. It is never logged, printed or written to agent-visible files. The listener's once-only selected-view observation must be taken (#220) | Listener and launcher code; output schema has no URL or nonce field | The page shown is the exact selected capture, read once by the owned navigation, and no credential reached agent-visible evidence |

**Why `_NET_WM_PID` and the title aren't enough alone.** Both are ordinary
properties that the client sets on its own window. Any X client on `:0` can
set any title and any PID, including a process that only pretends to be
the browser. So they are claims, not proof. Lifecycle correlation helps:
the window disappears when the owned PID dies. So does uniqueness: two
matching windows refuse. Both rest on the agent having no route to `:0`.

**XRes on WSLg: likely unavailable (an honest limit).** XWayland on WSLg
runs inside WSLg's system distribution, a separate container with its own
PID namespace. The server learns a client's PID from the socket's peer
credentials, translated into **its** PID namespace. A client in the user
distribution isn't visible there, so the PID is expected to read as 0, or
as a number in the wrong namespace.

So on WSLg, kernel-backed window attribution is **probably impossible**.
The design treats XRes as:
- **pass**, if it returns exactly the launched PID;
- **refuse**, if it returns any other non-zero PID;
- **recorded as `xres-pid-unavailable`**, if it returns 0 or the extension
  is missing. Qualification then rests on uniqueness, lifecycle correlation,
  the once-only selected-view observation and the human's observation, and
  says so.

Whether XRes returns 0 here can only be learned inside a human-launched
session, because querying it means connecting to `:0`.

## 3. Protected control surface

- **Where the human decides.** In the control window: under H3
  ([human channel](strict-human-channel.md)) the human types the code that
  the protected page shows into the control console. The browser page stays
  read-only, with no decision route.
- **Candidate A (proposed here):** the terminal tab where the human
  started the launcher becomes the control window. It must be a fresh,
  clean Windows Terminal tab running a WSL shell, with no other jobs.
  ([Protected bootstrap](strict-protected-bootstrap.md) records why A
  requires a clean terminal, and that the control-window choice is still
  open.)
- **The agent's terminal is separate:** a different Windows Terminal tab
  or window that the launcher creates or the human opens, whose processes
  are only the Bubblewrap agent. The agent has no access to the control
  PTY (N1, C18): separate sessions, no `TIOCSTI` route, and OSC 52 and
  OSC 0/1/2 filtered out of its PTY output.
- **What the launcher can't check:** Windows Terminal features that join
  panes, such as broadcast input or shared-input modes, live outside WSL.
  The launcher can't read them, so the human must confirm they are off.
- **Relation to the browser window:** the control window starts the owned
  browser and prints the expected capture hash and window title. The human
  compares the two. Decisions flow only from the control window to the
  authority. The owned fixture terminal (#210) is fixture evidence for the
  console, not this seat.

## 4. Fail-closed conditions

| Condition | Refusal code |
| --- | --- |
| The agent sandbox can reach `:0` (socket, `DISPLAY`, or the abstract X namespace) | `agent-display-reachable` |
| The agent sandbox can reach `wayland-0` or `WAYLAND_DISPLAY` | `agent-wayland-reachable` |
| The agent sandbox can reach the Pulse server or session bus | `agent-desktop-service-reachable` |
| The agent sandbox can reach WSL interop (`/run/WSL`, `WSL_INTEROP`, `/init`, the binfmt) or can execute anything under `/mnt/<drive>` | `agent-interop-reachable` |
| `socket(AF_VSOCK)` isn't proven denied inside the agent sandbox | `agent-vsock-not-denied` |
| `/dev/uinput` or another input-injection device is writable from the agent | `agent-input-injection-reachable` |
| No matching window within the bound | `window-attribution-unavailable` |
| More than one matching window, or a match not owned by the launched PID | `window-attribution-ambiguous` |
| XRes returns a non-zero PID other than the launched one | `window-attribution-conflict` |
| The window doesn't follow the owned process's lifecycle | `window-lifecycle-mismatch` |
| The browser digest doesn't match the pin, or the exe path or inode changed | `browser-pin-mismatch` |
| Any debugging switch, `DevToolsActivePort` or held TCP listener, at launch or at any restart check | `browser-debugging-seen` |
| The browser data directory isn't fresh, owned, 0700 and on tmpfs | `browser-data-directory-untrusted` |
| The selected-view observation is missing or reusable | `selected-view-missing` |
| `DISPLAY`, the X socket's inode, `/mnt/wslg`, or the namespace ids change mid-run | `seat-changed` |
| Unreadable `/proc`, net or fd tables, or socket state that can't be determined | `evidence-unreadable` |
| The human hasn't confirmed that Windows Terminal broadcast input is off | `terminal-broadcast-unconfirmed` |
| Launched from a test, an agent, or a non-interactive session (no TTY, or not the human's explicit command) | `real-desktop-not-human-launched` |

Every refusal stops everything the launcher started and never falls back
(X18).

## 5. What the maintainer must observe

In order, matching the outcome checklist in
[human desktop](strict-human-desktop.md):
1. Seat recorded: the pinned inventory JSON and the terminal version.
   **Expected:** pin matched.
2. Windows Terminal broadcast input and pane-sync features are off,
   confirmed to the launcher's prompt. **Expected:** the launcher accepts
   the confirmation, and refuses without it.
3. Exactly one new window titled `Skeleton decision (prototype)` appears.
   **Expected:** its capture hash equals the one the control window prints.
4. The window is a clean browser: no extensions, bookmarks or sign-in, and
   their own Chrome windows unchanged.
5. **Outcome:** no agent-originated input reaches the decision window, the
   control window or the Windows clipboard during the run.
6. Typing in the browser window does nothing. **Expected:** read-only.
7. The decision entered in the control window is accepted there only.
8. **Outcome:** no window title or clipboard content comes from the agent.
9. A healthy restart keeps the window and generation. Closing the owned
   window refuses or cleans up. **Expected:** the exact message is
   recorded.
10. Cleanup leaves no extra Chrome processes or windows, and the WSLg log
    unchanged.

## 6. Pre-verified on an owned Xvfb display vs only on the real seat

| Pre-verifiable on Xvfb (fixture) | Only the real seat |
| --- | --- |
| Pin, exe and inode identity; a fresh tmpfs data directory | That the window is visible on the human's screen, not hidden or covered |
| No debugging at launch and at restart checks (sampler, negative control) | XRes behaviour on WSLg's XWayland (expected unavailable) |
| Exactly one mapped window with `_NET_WM_PID`, uniqueness, and the lifecycle-correlation logic | Windows Terminal broadcast input, pane and clipboard behaviour |
| The selected-view observation and private navigation (no nonce in output) | That no agent-originated input reaches the decision surfaces in practice |
| Restart keeps, loss and replacement refuse, and cleanup (#227 cases) | The human's recognition of the capture hash and title |
| The refusal codes in section 4, driven by synthetic faults (a second spoofed window, a changed pin, a debugging switch) | That the RDP/RAIL presentation shows the expected window on Windows |
| N4 sandbox reach (display, Wayland, bus, interop, vsock) | — |

## 7. Safety constraints for any implementation

- **No connect/close probing** of `:0`, `wayland-0`, the Pulse server, the
  RDP sink or the session bus, ever. The earlier probe that did this crashed
  weston repeatedly
  ([display interop](strict-display-interop.md#safety-never-connect-to-live-desktop-sockets)).
  The only `:0` connections allowed are proper X clients (the owned browser,
  and attribution queries), inside the real-desktop mode.
- **The real-desktop mode runs only when the human launches it
  explicitly:** an interactive TTY and an explicit flag, never from
  `npm test`, the live fixtures or an agent. Without those, it refuses with
  `real-desktop-not-human-launched`.
- **Tests stay on owned displays.** Fixtures use only the private Xvfb
  display and owned synthetic windows and clipboards. They never target the
  user's windows or Windows clipboard.
- **The user's environment is left unchanged.** No change to their browser
  profiles, display settings or Windows Terminal settings, and nothing
  written under `/mnt/wslg`.
- **The WSLg log is checked** before and after: `wc -l
  /mnt/wslg/stderr.log` must not grow.

## Hard blockers

- **Strong window attribution on WSLg is likely impossible.** XRes PIDs
  are expected to be 0 across the WSLg container boundary. Attribution then
  rests on claims (`_NET_WM_PID`, title), uniqueness, lifecycle correlation,
  the once-only listener observation and the human's observation.
- **The control-window choice (A or B) is still open** in
  [protected bootstrap](strict-protected-bootstrap.md). This design assumes
  A, and its WSL terminal question is unresolved.
- **Windows Terminal pane features can't be read from WSL**, so only the
  human can confirm them.
- **The vsock policy isn't adopted:** the N4 seccomp filter is a fixture
  mitigation. And the launcher itself (#75) doesn't exist yet.
