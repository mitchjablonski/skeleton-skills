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
| Ozone platform | **X11 through XWayland**, conditionally: see the costs and the precondition below |
| Browser data directory | Fresh, launcher-created, 0700, on a verified tmpfs (`/dev/shm`, as in the #227 window), and removed after the proof |
| Control surface | The human's own terminal tab that started the launcher (candidate A, section 3) |
| Session precondition | **No other agent or automation process of this user runs unsandboxed** during the session, on Linux or on Windows. This is attested by the human (section 4) |

### Who can see the page

**X11 exposes the page's contents to every client of `:0`.** WSLg's `:0`
accepts any local client without a cookie. Any client can:
- read any window's pixels (`XGetImage`) and properties;
- inject input (XTEST);
- map a look-alike window with the same title and `_NET_WM_PID`, showing
  the public capture hash.

On this host, `:0` clients include **every unsandboxed agent the same user
runs**: default-mode Claude sessions, other Claude Code sessions and Codex,
not only the human's own applications. Under H3 the page shows decision
codes (C5). So any such process could read a code and type it, or put a
convincing fake window in front of the human. The N4 sandbox keeps the
**strict** agent away from `:0`, but it does nothing about other agents of
the same user.

**Windows-side observers see it too, whatever the ozone choice.** The window
reaches the Windows desktop over RDP/RAIL. There, any process of the user
can:
- capture the screen;
- read the window and the control terminal through UI Automation;
- read the clipboard, which WSLg syncs between X/Wayland and Windows.

Codex runs on Windows on this host. Section 4 lists these exposures, and
none of them can be controlled from WSL.

### Ozone platform: X11 vs native Wayland, re-weighed

| | X11 through XWayland | Native Wayland on weston |
| --- | --- | --- |
| Other WSL clients capturing the page or injecting input | **Possible** for any `:0` client | Blocked: Wayland clients can't read another client's surfaces or inject input. Weston's screenshooter is restricted to authorized clients |
| Look-alike windows | Any `:0` client can mimic the title and `_NET_WM_PID` | Any Wayland client can still map a window with the same title. The launcher can't see it, and neither could it see its own |
| Launcher attribution | Can enumerate windows: uniqueness, `_NET_WM_PID`, lifecycle, and XRes if it works | **None:** no external enumeration or inspection, so only the human's observation |
| Windows-side capture, UI Automation, clipboard | Exposed | Exposed (same RAIL path) |
| Fixture pre-verification | Same path as the Xvfb fixtures | No owned equivalent today |

**Recommendation: X11, but only under the session precondition.** The
Wayland advantage is real but narrow:
- it protects against other **WSL-side** clients only;
- those same unsandboxed agents could still capture the window from the
  Windows side whenever they also run there, and Codex does;
- the precondition (no other unsandboxed agent or automation of this user)
  is needed for Windows-side reasons regardless.

Once the precondition holds, Wayland's isolation adds little. Its cost, no
attribution at all, then dominates.

The costs of choosing X11 are accepted and recorded:
- page contents (including codes) are exposed to every `:0` client;
- the window can be spoofed by any `:0` client;
- XTEST can inject input;
- all of these are mitigated only by the attested precondition and the
  strict agent's N4 sandbox.

If the maintainer would rather resist WSL-side capture than keep
attribution, native Wayland is the alternative. In that case qualification
rests on human observation alone.

**Not candidates.** Each of these is refused, not degraded:
- native Windows Chrome or Edge: outside the pinned Linux binary, with
  profiles and extensions the launcher doesn't own;
- the user's own Linux browser data directory, or any existing or shared
  one;
- the wrapper script or an unpinned binary, any `--no-sandbox` launch, and
  any remote-debugging switch (pipe or port);
- Xvfb or any private display, which stays fixture evidence only;
- tmux, screen, or IDE and agent-hosted terminals as the control surface;
- a remote or shared seat (RDP session sharing, screen sharing, recording);
- a session where any other agent or automation of the user runs
  unsandboxed.

## 2. Ownership checks

| Subject | What is checked | How | What it proves |
| --- | --- | --- | --- |
| Browser binary | SHA-256 of the ELF equals the pin, before any run | Harness `pinBrowser`, with the pin normalized | The executable content at launch time |
| Browser process | `/proc/<pid>/exe` path equals the pinned path, not ` (deleted)`; the exe inode and device equal the hashed file's; the browser leads its own session; it is the launcher's direct child (subreaper) | `/proc` reads, as in the C20 sampler | The running process is the pinned file the launcher started, and a swap by rename fails closed |
| Window attribution | Exactly one top-level window titled `Skeleton decision (prototype)…`, mapped and viewable. Its `_NET_WM_PID` is the launched PID; `WM_CLIENT_MACHINE` is this host; and its lifecycle follows the process (absent before launch, present after, gone within a bound when the owned PID is stopped) | X11 queries on `:0`, run only inside the human-launched session (section 7) | A **claim**, consistent with the owned PID: see below |
| Window attribution (stronger, if available) | X-Resource client PID (`XResQueryClientIds`, PID mask) for the window's client equals the launched PID | XRes query | A server-side PID, not one the client set |
| Discriminating phrase | A per-run phrase, printed in the control window and shown on the page, matches (section 5) | The human compares them | The visible window is showing the private navigation's content, not a look-alike |
| Browser data directory | Created fresh (exclusive `mkdir`), 0700, owned by us, on tmpfs, never the default, and unused before launch | `lstat`/`statfs`, as in the harness | No prior state, extension or debugging port file |
| Debugging off | No `--remote-debugging*` switch in any browser process, no `DevToolsActivePort` under the scratch root (HOME), no TCP listener held, and all tables readable. Checked at launch, during a bounded sample, **and at every restart check** | The shared sampler | No debugging endpoint is open at those samples |
| Private navigation | The one-use URL comes from the host-only window navigation method. It passes only on the owned browser's argv, inside the launcher's namespace, which the agent can't read. It is never logged, printed or written to agent-visible files. The listener's once-only selected-view observation must be taken (#220) | Listener and launcher code; output schema has no URL or nonce field | The page was read once by the owned navigation, and no credential reached agent-visible evidence |

**Why `_NET_WM_PID`, the title and the hash aren't enough.** Both
properties are ordinary values that the client sets on its own window. Any
`:0` client can set any title and any PID. The capture hash is public: it
is in agent-visible evidence and the workspace. So a look-alike window can
show all three.

**Lifecycle correlation only correlates.** A spoofer that watches the owned
process can map its window after the real one appears and unmap it when the
process dies. Uniqueness (two matching windows refuse) narrows this, but
doesn't exclude a spoofer that replaces the real window. The discriminating
phrase is what a look-alike can't show without reading the real page. On
X11 an unsandboxed `:0` client could read it, which is one more reason for
the precondition.

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
  is missing.

Qualification then rests on uniqueness, lifecycle correlation, the
once-only selected-view observation, the discriminating phrase and the
human's observation. Whether XRes returns 0 here can only be learned
inside a human-launched session, because querying it means connecting to
`:0`.

**Where `:0` lives.** WSLg's X server listens in WSLg's own network
namespace. Its abstract socket `@/tmp/.X11-unix/X0` doesn't appear in this
distribution's `/proc/net/unix` (the #235 and #232 reads show no X0 entry
there). From the user distribution, `:0` is reached through the filesystem
socket `/tmp/.X11-unix/X0` and `DISPLAY`, which the N4 sandbox removes
(unmounted, `--clearenv`). The strict agent's `--unshare-net` also covers
abstract sockets in general.

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
- **Windows-side exposure:** Windows Terminal's text is readable through
  UI Automation by any Windows process of the user, and its panes can
  share input. The launcher can't read or control either, so the human
  attests both (section 4).
- **Relation to the browser window:** the control window starts the owned
  browser. It prints the expected capture hash, the window title and the
  per-run discriminating phrase. The human compares them with the page.
  Decisions flow only from the control window to the authority. The owned
  fixture terminal (#210) is fixture evidence for the console, not this
  seat.

## 4. Fail-closed conditions

Checked by the launcher:

| Condition | Refusal code |
| --- | --- |
| The agent sandbox can reach `:0` (filesystem socket or `DISPLAY`) or shares a network namespace with an X server's abstract socket | `agent-display-reachable` |
| The agent sandbox can reach `wayland-0` or `WAYLAND_DISPLAY` | `agent-wayland-reachable` |
| The agent sandbox can reach the Pulse server or session bus | `agent-desktop-service-reachable` |
| The agent sandbox can reach WSL interop (`/run/WSL`, `WSL_INTEROP`, `/init`, the binfmt) or can execute anything under `/mnt/<drive>` | `agent-interop-reachable` |
| `socket(AF_VSOCK)` isn't proven denied inside the agent sandbox | `agent-vsock-not-denied` |
| `/dev/uinput` or another input-injection device is writable from the agent | `agent-input-injection-reachable` |
| The browser has a session bus or accessibility bus (AT-SPI), or accessibility is forced on | `browser-accessibility-exposed` |
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
| Launched from a test, an agent, or a non-interactive session (no TTY, or not the human's explicit command) | `real-desktop-not-human-launched` |

Attested by the human at the launcher's prompt (it can't check them from
WSL). A missing or negative answer refuses:

| Condition | Refusal code |
| --- | --- |
| Another agent or automation process of this user may be running unsandboxed (default-mode Claude, other Claude Code sessions, Codex, scripts), on Linux or on Windows | `unsandboxed-agent-not-excluded` |
| Windows Terminal broadcast input or pane-sync not confirmed off | `terminal-broadcast-unconfirmed` |
| Screen capture, recording, sharing or remote viewing may be active on Windows | `windows-capture-not-excluded` |
| A Windows process of the user may be reading windows through UI Automation (assistive or automation tools, agents) | `windows-ui-automation-not-excluded` |
| A clipboard manager, history or cloud clipboard may be active on Windows | `windows-clipboard-observer-not-excluded` |
| A third-party IME or input-method service that logs or predicts text may be active for the control window or the page | `ime-not-excluded` |
| The maintainer didn't see the discriminating phrase match (section 5) | `discriminating-phrase-mismatch` |

**Can't be controlled from WSL at all:**
- Windows screen capture and UI Automation of RAIL windows and Windows
  Terminal;
- WSLg's clipboard sync between X/Wayland and Windows. No per-window or
  per-session switch is known to the launcher. Codes must therefore never
  be placed on the clipboard, and the page offers no copy action. A human
  selecting and copying text is outside the launcher's control;
- drag-and-drop between the RAIL window and Windows applications;
- the Windows IME and text services;
- Windows-side processes in general.

These rest on the attestations above.

Every refusal stops everything the launcher started and never falls back
(X18).

## 5. What the maintainer must observe

In order, matching the outcome checklist in
[human desktop](strict-human-desktop.md). Each step uses only
fixture-owned endpoints and synthetic data, and never the user's own
windows or files.

1. **Seat recorded.** Run the pinned inventory and save the JSON; note the
   terminal version. **Expected:** pin matched.
2. **Attestations.** Answer the launcher's prompts for section 4's attested
   conditions. Close any other agent sessions first. **Expected:** the
   launcher proceeds only on all yes answers, and refuses on any no.
3. **Discriminating phrase.** The control window prints a per-run phrase:
   random words, generated by the launcher and never written to
   agent-visible files. Exactly one new window titled
   `Skeleton decision (prototype)` appears. **Expected:** the page shows
   the same phrase and the same capture hash as the control window.

   The phrase reaches the page only through the private one-use navigation
   that the listener serves to the bound tab. A look-alike window can copy
   the public hash, but can't know the phrase without reading the real page.
4. **Clean browser.** **Expected:** no extensions, bookmarks or sign-in in
   the window, and the user's own Chrome windows unchanged.
5. **Synthetic agent-pane input.** In the agent pane, the sandboxed agent
   prints a synthetic marker the launcher gave it (for example
   `SYNTH-INPUT-<n>`), and the human also types a different synthetic
   marker there. **Expected:** neither marker appears in the control window
   or on the page.
6. **Synthetic clipboard write.** The sandboxed agent runs a fixture
   command that writes an OSC 52 clipboard sequence carrying
   `SYNTH-CLIP-<n>` to **its own PTY**. The human then pastes into a new,
   empty Notepad window. **Expected:** the marker is absent (the agent PTY
   filter removed it).
7. **Synthetic title write.** The sandboxed agent writes an OSC 2 title
   sequence carrying `SYNTH-TITLE-<n>` to its own PTY. **Expected:** no
   window or tab title shows it.
8. **Browser read-only.** The human types `SYNTH-PAGE-<n>` into the page.
   **Expected:** nothing is accepted, and the listener logs no write
   request.
9. **Decision.** Enter the code shown on the page into the control window.
   **Expected:** accepted there only, for that capture.
10. **Restart and loss.** A healthy restart keeps the window, generation and
    phrase. Closing the owned window refuses or cleans up. **Expected:**
    the exact message is recorded.
11. **Cleanup.** **Expected:** no extra Chrome processes or windows, and the
    WSLg log unchanged.

## 6. Pre-verified on an owned Xvfb display vs only on the real seat

| Pre-verifiable on Xvfb (fixture) | Only the real seat |
| --- | --- |
| Pin, exe and inode identity; a fresh tmpfs data directory | That the window is visible on the human's screen, not hidden or covered |
| No debugging at launch and at restart checks (sampler, negative control) | XRes behaviour on WSLg's XWayland (expected unavailable) |
| Exactly one mapped window with `_NET_WM_PID`, uniqueness, and the lifecycle-correlation logic | Windows Terminal broadcast input, pane and clipboard behaviour |
| The selected-view observation, the phrase plumbing, and private navigation (no nonce in output) | The human's comparison of phrase, hash and title |
| Restart keeps, loss and replacement refuse, and cleanup (#227 cases) | Windows-side exposure (capture, UI Automation, clipboard sync, IME), which can only be attested |
| The refusal codes, driven by synthetic faults (a second spoofed window on the owned display, a changed pin, a debugging switch) | That the RDP/RAIL presentation shows the expected window on Windows |
| N4 sandbox reach (display, Wayland, bus, interop, vsock) and the agent PTY filters (synthetic markers) | That the synthetic markers don't surface on the real seat |

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

- **Other unsandboxed agents of the same user can read the page on X11.**
  On Windows they can read it whatever the ozone choice. Code secrecy on
  this seat therefore rests on the human's attestation that none runs
  during the session. Nothing in WSL can check this.
- **Windows-side observers can't be controlled from WSL.** That covers
  screen capture, UI Automation of the page and the control terminal,
  WSLg's clipboard sync, drag-and-drop and IME. Each is attested, not
  enforced.
- **Strong window attribution on WSLg is likely impossible.** XRes PIDs are
  expected to be 0 across the WSLg container boundary. Attribution then
  rests on claims, uniqueness, lifecycle correlation, the selected-view
  observation, the discriminating phrase and the human.
- **The control-window choice (A or B) is still open** in
  [protected bootstrap](strict-protected-bootstrap.md). This design assumes
  A, and its WSL terminal question is unresolved.
- **The vsock policy isn't adopted:** the N4 seccomp filter is a fixture
  mitigation. And the launcher itself (#75) doesn't exist yet.
