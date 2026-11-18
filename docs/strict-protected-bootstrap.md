# Protected launcher bootstrap and control PTY contract (#147)

Status: **disabled contract for review, not an implementation, adoption or
runtime verdict.**
- **No adoption.** It adopts none of H0, H1 or H3. It claims no human
  authentication, no supported profile, no production activation and no
  release.
- **PTY isolation is an experimental candidate.** It narrows who can type
  into the control window. It does not prove that a human typed a decision.
- **Nothing here is current evidence.** Every lifecycle fault and every
  negative control below is a **requirement for tests still to be written**.
- **No launcher yet.** Implementing the launcher is a separate, bounded
  follow-up after this contract is reviewed. Codex cross-reviews this
  document.

It builds on:
- the inherited command channel ([strict-human-channel-transport.md](strict-human-channel-transport.md), #145);
- the runtime receipt ([strict-runtime-receipt.md](strict-runtime-receipt.md), #144);
- the durable human authority ([strict-human-authority-store.md](strict-human-authority-store.md));
- the console ([strict-control-console.md](strict-control-console.md));
- the decision listener ([strict-decision-listener.md](strict-decision-listener.md));
- the H3 proposal ([strict-human-channel.md](strict-human-channel.md)).

## Who owns what

| Part | Owner process | Created by | Reachable from the agent? |
| --- | --- | --- | --- |
| Launcher | the human's own login session, outside any sandbox | the human | no |
| **Durable history directory** (enrollment, authority record and journal, capture store) | launcher | launcher, on first enrollment; reopened on later launches; mode 0700, outside the workspace, never mounted into the agent | **no** |
| **Scratch directory** (per-launch working files, sockets' bookkeeping, probe output) | launcher | launcher, **fresh for every launch**; an existing path is refused | **no** |
| Authority process (durable human authority, one enrolled project and session) | launcher child | launcher | **no** |
| Control process (console) and the control PTY | **depends on the candidate below** (open blocker). Under B: a launcher child and session leader on a launcher-made PTY. Under A: the console runs in the human's existing terminal; that PTY predates the launcher and is shared with the human's shell session | the human's terminal (A) or the launcher (B) | **no** |
| Decision listener (127.0.0.1, protected origin) | launcher child, host network namespace | launcher | **no** |
| Control↔authority link | an unnamed socketpair (#145 framing, exactly four methods) | launcher | **no** |
| Launcher→console control link (hand over a fresh socketpair on reconnect or idle timeout) | **open**: not defined yet | launcher | **no** |
| Launcher→authority link (for example `endSession` when the control window is lost) | **open**: not defined yet; it can't reuse the console's connection | launcher | **no** |
| Listener↔authority code issuance | **open**: #145 has no issuance operation (below) | — | **no** |
| Agent sandbox (pinned CLI) | launcher child in **separate PID, mount, user and network namespaces** | launcher | — |
| Agent PTY | agent sandbox | launcher, with an output filter in between | the agent's own only |

**The control window mechanism is an open blocker.** A real terminal emulator
creates its own PTY and is the console's parent. gnome-terminal's server and
Windows Terminal don't inherit the launcher's descriptors, and `wt.exe` can't
receive Linux descriptors at all. So "launcher child on a new PTY reached by
socketpair" can't simply be a new emulator window. Two candidates to choose
between before implementation:

- **A (proposed). The launcher's own terminal is the control window.** The
  human starts the launcher in a terminal; that terminal's PTY becomes the
  control PTY, and the console runs in the foreground there.
  - **The agent's window.** The agent's PTY is launcher-created (`openpty`).
    It is shown in a second window through a relay that carries **both**
    output and the human's input to the agent, so it isn't display-only. That
    second window is a new emulator too, and hits the same descriptor-handoff
    problem. Because the agent's window is untrusted, its relay may use a
    named or otherwise less protected endpoint. The rule against named
    endpoints applies to the control side only.
  - **Departure from H3.** This differs from the H3 assumption of "a fresh
    terminal or window that only the launcher owns". The control PTY was
    created by the emulator before the launcher started.
  - **Prerequisites and residuals.** Every process in that terminal session
    shares the controlling terminal, so it could `TIOCSTI` into it or read
    from it: earlier background jobs, and anything started from that shell.
    Under the residual-trust rule these are trusted human processes, so this
    isn't a hole, but A requires starting from a **clean terminal** with no
    other jobs. Running the launcher inside tmux, screen or an IDE terminal
    adds those programs to the trusted set (they can read and inject); either
    refuse it or record it as a residual per profile.
  - **WSL.** Showing the agent's window on WSL still needs a terminal (open
    question 1).
- **B. A launcher-made PTY handed to an emulator that accepts one** (for
  example `xterm -S`). Few emulators support this, and none on the Windows
  side.

Either way, a named endpoint is not an acceptable workaround for the control side.

**Namespace separation.** The required profile is:
- PID, network, IPC (X11 MIT-SHM), mount and user namespaces;
- a new session (`--new-session`), so the agent's PTY is never the control
  window's controlling terminal;
- a **new devpts instance** (`--dev`). `--dev-bind /dev` is refused, because
  under the host devpts the same uid could open the control window's
  `/dev/pts/N`, write fake output and read what the human types;
- `--die-with-parent`.

PID and devpts isolation alone don't remove host loopback or abstract-socket
reach. Only the network namespace does.

**What the agent receives:**
- its own PTY;
- the workspace mount;
- the model-relay descriptor (X4);
- an explicit, minimal environment;
- the descriptors its runtime itself opens (Node, for example, opens some at
  startup).

That last group is checked against an **inspected allowlist** measured on the
pinned runtime. It isn't assumed to be stdio only. The control is
launcher-side: descriptors are closed before exec (`close_range`). A check
run inside the agent is a fixture probe of that, not the control itself.

**What it never receives:**
- any descriptor for the control PTY, the authority, the listener, or either
  directory;
- the launcher's environment;
- display, session-bus, WSLg, Wayland or X11 sockets or variables;
- browser profiles.

**Residual trust, unchanged from the H3 proposal and the decision page doc.**
"Not reachable from the agent" assumes:
- the human's own processes are trusted, including Windows-side processes on
  WSL, which can reach the listener and read `\\wsl$`;
- host git doesn't run agent-written config (X15). If it does, every negative
  control below is bypassed.

**Dependencies the agent can't influence.** The authority's protected
dependencies (`captureStore`, `observeUnderLock`, its clock and entropy) live
in the launcher's processes, outside anything the agent can reach.

## Durable history versus scratch

**Durable history** holds the enrollment, the authority record and journal,
and the immutable captures.
- **Restart and replay need it.** Same-id lookup after a lost reply depends
  on it, so ordinary cleanup **never removes it**.
- **Reopening it** must find the expected enrollment. Missing or corrupt
  enrolled state refuses, and a new epoch is never started silently (#124).
- **After a crash, reopen is expected to refuse.** A crash mid-operation leaves
  the store's holder lock, and the store never expires or unlinks it on its
  own. Recovery then goes through the outside-host recovery process in
  [strict-human-authority-store.md](strict-human-authority-store.md), not
  through an automatic reopen.
- **Rollback isn't detected.** The store can't prove it wasn't rolled back to
  an older copy. Anti-rollback is a separate external gate (X11), not a
  current capability.

**Scratch** is per-launch and disposable.
- **Created fresh:** a path that already exists is refused.
- **Cleanup:** removed after a clean shutdown. If cleanup can't be proven,
  the scratch is **retained** and the launcher reports it. Durable history is
  never touched by that cleanup.

## Enrollment and session metadata

Enrollment uses the store's real API: the full initial V2 `state` and
`policy` that `createHumanAuthorityStore` requires. Its digests must match an
initial capture already stored in the capture store, so bootstrap captures
before it enrolls (step 3). Enrollment and session metadata
**never** carry:

- authority keys or key material;
- approval codes;
- tokens;
- tab bindings.

The rest of the design depends on where each item lives:

- **Keys** are generated inside the authority process (32 bytes from
  `crypto.randomBytes`, per #124) and never leave it.
- **Codes** reach the listener through a **separate issuance capability that
  doesn't exist yet**. #145 supports exactly `verifyAndCommit`, `recapture`,
  `endSession` and `state`, so issuance can't be expressed as an existing
  #145 call. Its operation and schema stay **open**, and need independent
  vectors and cross-review before implementation.
- **The console** never sees a code except the one the human types.
- **The authority's durable record is private history, not metadata.** Its
  record file keeps every epoch key and, in the command ledger, the codes the
  human typed, so a same-id retry returns the original result. It lives in
  the durable history directory, which only the authority may open (N9).
  That directory's lock and temporary files count as private history too.
  `test/strict-metadata-secrets.test.mjs` checks the metadata side (N11).

## Bootstrap sequence

Each step either succeeds or refuses the whole launch.

1. **Preflight.** Collect a runtime receipt (#144) and check the prerequisite
   observations. Receipt unavailable, or a prerequisite missing, means
   refuse. A receipt identifies an observed configuration. It grants no
   support (X12, X13).
2. **Directories.** Reopen the durable history directory, or create it on
   first enrollment, checking ownership, mode and filesystem. Then create a
   **fresh** scratch directory; an existing scratch path is refused.
3. **Initial capture and authority.** Capture the workspace into the capture
   store (the first capture may be empty or partial; the first real review is
   a human Recapture, per the decision page doc). Then start the authority and
   open, or create and enroll, the store with the full state and policy, under
   the reopen rules above.
4. **Control process.** Start the console on the control PTY, using candidate
   A or B above.
5. **Readiness.** Over the control↔authority socketpair, the console's
   `state()` must answer. Any failure refuses.
6. **Listener.** Start it and check that it answers. Then open the page in a
   **fresh, launcher-owned browser profile** (C20). Merely printing the URL for
   the human to paste into their normal browser isn't offered in protected
   mode: it would be a fallback that defeats C20. Code issuance stays open.
7. **Agent.** Only once the authority, console and listener are all ready,
   start the agent sandbox with the required profile, the inspected
   descriptor allowlist, the filtered PTY and the minimal environment.

**No fallback (X18).** If any step fails:
- the launcher reports the failure on the control window, or on its own
  stderr if no control window exists yet;
- it stops everything it started, under the stop rules below;
- it retains or removes the scratch directory under the cleanup rule, and
  never touches durable history;
- it **never** starts the agent in default or unconstrained mode as a
  fallback.

## Connection lifetime

**Channel bounds** come from #145, as prototype values rather than adopted
policy: 128 calls per connection, one in flight, a 1000 ms request deadline,
and a 4096-byte frame.
- **On connection loss** the console reports an unknown outcome and keeps
  the request. It keeps it **in memory only** (see control crash, below).
- **Reconnecting** gives the console a fresh socketpair from the launcher.
  It never gets a named endpoint.
- **A retry after reconnecting** uses the **same request id**, so the journal
  returns the original result. Tested pairwise in
  `test/strict-human-channel.test.mjs`, `test/strict-control-store.test.mjs`
  and `test/live/strict-private-channel-probe.py`, not under a launcher.

**Idle timeout (proposal):** close the control↔authority connection after 10
minutes idle, and reconnect on the next command. The value is to be agreed.
It is not a security control.

## Supervision and stop

**Physical stop comes first and is independent.** On any authority or control
fault, the launcher stops the agent's whole namespace straight away, without
waiting for the authority to answer, recover or revoke admissions.
- **A blocked `endSession`** never delays the stop or quiescence.
- **Admissions stay unknown** until revocation is confirmed.
- **Stop means namespace teardown.** As in the #102 probe, every namespace
  member must be confirmed exited. The existing private-channel probe keeps
  helpers unreaped with `waitid(WNOWAIT)` until group cleanup. That prevents
  process-group id reuse, but a group kill alone doesn't prove that detached
  writers inside the namespace are gone.

| Event | Required behavior |
| --- | --- |
| Authority process exits or stops answering | The launcher **stops the agent immediately**. The console reports unknown and accepts no new decisions. The launcher may try to reopen the authority from durable history **once**, but only to resolve a same-id result. After a crash that reopen is expected to refuse (leftover holder lock), and recovery goes through the outside-host process. A reopen can't clear a broken gate, doesn't imply that resuming is safe, and never restarts the agent by itself |
| Control process or its terminal exits (under A, closing the control terminal hangs up the launcher too, so the row below applies) | The launcher **stops the agent immediately** and asks the authority to revoke admissions (best effort; their state stays unknown until confirmed). Any kept request in the console is **lost**, because the console holds it only in memory. Durable pending records and lookup-by-id across a control restart are separate, unadopted design choices. A new decision is never a substitute for recovering the old one |
| Listener exits | Decisions are unaffected, because they travel through the console. Reopening it with a fresh listener and nonce needs a new console command or launcher control, which **doesn't exist yet** |
| Agent exits | Normal end of a run. Admissions stay open until the human ends the session |
| Launcher exits or crashes | Required: nothing it started keeps running. A parent-death signal reaches **direct children only**, and no watchdog survives the launcher itself, so the agent namespace must die through `--die-with-parent` on its own PID 1. The authority, console and listener each need their own parent-death handling. Under candidate A the console runs in the human's terminal, which isn't a child at all. A later launcher run finds durable history and refuses to resume automatically; it needs an explicit human restart. This cascade is a **test to implement**, not current evidence |
| Cleanup can't be proven (a helper can't be reaped, a namespace member is still alive) | Retain the scratch, report "cleanup unproven", and never report success. Durable history is never touched |

## End and restart

- **End.** The human types `end` and confirms. That triggers `endSession`,
  answered with `admissions-revoked` (decisions closed), and the launcher's
  separate **physical stop** of the agent. Neither proves the other. The
  console never says the session ended because of revocation (#138).
- **Restart after a checkpoint (#99).** The launcher tears down the agent's
  namespace, captures, and restarts a fresh agent from the approved capture.
  The control process and the authority persist across that restart. The
  agent never inherits them.

## Negative controls (required before any claim)

Each control needs a positive control, so a probe can't pass merely because
nothing worked.

| ID | Control | How it is to be tested | Matrix |
| --- | --- | --- | --- |
| N1 | The agent can't reach the control PTY | **Compare terminal and namespace identities**, not paths: numeric `/dev/pts/N` names collide across private devpts instances. Then test **actual delivery**: bytes written from inside the agent to every terminal it can open never arrive at the control process. **Positive controls:** the agent can use its own terminal (and its procfs view of it), and host-side writes to the control PTY do arrive | C18 |
| N2 | No `TIOCSTI` into the control PTY | The kernel refuses `TIOCSTI` unless the target is the caller's **controlling** terminal, or the caller has `CAP_SYS_ADMIN` in the initial namespace. So the defence is the separate session (`--new-session`; CVE-2017-5226) together with N1. **Record the actual ioctl outcome** on every terminal the agent can reach. Pass means it never reaches the control PTY; `TIOCSTI` on the agent's **own** PTY may legitimately succeed when `legacy_tiocsti=1`. A hardened kernel may refuse everywhere, so a refusal alone shows nothing about isolation. `strict-runtime-receipt/v1` does **not** record `dev.tty.legacy_tiocsti`: recording it needs a new reviewed receipt schema with vectors, or a separate fixture-only observation | C18 |
| N3 | No inherited descriptors beyond the inspected allowlist | The agent enumerates `/proc/self/fd` at start, and the result is compared with the allowlist measured on the pinned runtime | C17, X14 |
| N4 | No display, session-bus, WSLg, Wayland/X11 or WSL interop reach | The agent's environment has no `DISPLAY`, `WAYLAND_DISPLAY` or `DBUS_SESSION_BUS_ADDRESS`, and connecting to the **actual** sockets on the measured host fails, **including abstract sockets** (`@/tmp/.X11-unix/X0`, abstract D-Bus), which only the network namespace blocks. **WSL interop isn't gated by environment variables.** On the measured WSL host (kernel 6.6), `WSLInterop` is registered in binfmt_misc with the F flag (`/init` preopened), and that registration isn't per-namespace there. So the gate to test is the `/run/WSL/*_interop` socket: it must not be mounted, and **executing a Windows (MZ) file inside the sandbox must fail**. *Unverified reviewer observation, to be reproduced by a fixture:* `bwrap --unshare-all --clearenv ... whoami.exe` failed without `/run/WSL` and printed the Windows user with `--ro-bind /run/WSL /run/WSL`. Checks against synthetic socket paths aren't evidence of WSLg or clipboard denial. **Measured (#159):** AF_VSOCK to the Hyper-V host isn't netns-scoped on that host, so N4 also needs a syscall-level refusal (for example seccomp on `socket(AF_VSOCK)` and io_uring) ([fixture](strict-display-interop.md)) | X13, C18 |
| N5 | No automation or debugging endpoints | No browser profile directories are mounted, and from the agent's network namespace, connecting to the host's CDP and WebDriver ports and to abstract sockets fails. Positive control: the host itself can reach them | C20, X14 |
| N6 | No terminal control strings from the agent reach the human's terminal | An **allowlist** filter on the agent PTY output: drop **all** OSC, DCS, APC, PM and SOS strings (OSC 52 clipboard, OSC 0/1/2 title, OSC 8 links, OSC 9 and OSC 1337 notifications), and never pass DCS through (tmux DCS wraps OSC 52). It must be a stateful parser, tested for split reads, BEL and ST terminators and the C1 introducer bytes. A real terminal emulator still needs manual acceptance | C18 |
| N7 | Pasted control bytes and multi-line pastes are refused atomically | **#151:** a streaming parser buffers each whole line or paste and validates it before any accepted event. The current console accepts an already assembled printable line and isn't streaming evidence | C6 |
| N8 | The agent can't pass itself off as the control window | A banner is forgeable text, so this needs protected ownership of the window (the launcher opens it), the title filter (N6), and manual acceptance on each terminal. The human is told that nothing counts unless the launcher-opened window echoes it | C17 |
| N9 | The agent can't reach the authority or listener links or either directory | No named endpoints exist, the socketpairs aren't inherited, neither directory is mounted, and access attempts fail. Positive control: the launcher's own processes reach them | X14 |
| N10 | No fallback | An injected failure at each bootstrap step must leave no agent running, unconstrained or otherwise | X18 |
| N11 | Enrollment and session metadata hold no keys or codes | A static schema check plus a fixture that dumps the metadata | C17 |

## What fixtures can and can't establish

**The current private-channel probe** (`test/live/strict-private-channel-probe.py`)
covers the #145 socketpair, durable reconnect and a fixture worker's
descriptor and path exclusion. It proves **neither** PTY isolation **nor**
display, automation or browser isolation.

**Codex's #149 terminal fixture** measures only a private PTY/devpts, proc
and descriptor access, `TIOCSTI` observations, synthetic path and environment
exclusion, and supervised same-group cleanup. It is not itself N1–N11 or
full-profile evidence.

**A future launcher fixture** and its successors can establish N1–N5 and
N9–N11 **for the measured profile only**,
which the runtime receipt fingerprints. That still says nothing about other
profiles, and the receipt grants no support.

**Manual human and profile acceptance** is still needed, per supported
terminal and OS:
- that the launcher actually opens and owns a separate terminal window;
- that the real terminal emulator ignores filtered OSC sequences and doesn't
  expose its own clipboard or title channels;
- that the human's browser profile is separate and fresh;
- on WSL, how the outside launcher opens a Windows-side terminal and browser
  without giving the agent interop.

**Browser fixtures** (`test/live/strict-browser-matrix.mjs`) cover the decision
page's request rules and rendering (C1–C5). They don't cover the human's own
browser or its isolation.

## Before implementation

Any bootstrap framing or schema needs **independent vectors and Codex
cross-review** before code. That covers:
- the enrollment message;
- the readiness handshake;
- the listener↔authority issuance capability;
- the launcher→console control link;
- the launcher→authority link;
- the descriptor allowlist format;
- any extended runtime receipt.

The #145 channel framing is reused unchanged.

## Open questions

1. **Control and agent windows.** Choose candidate A or B. Under A, how does
   the agent's display-only window appear on WSL: `wt.exe` through interop
   (on for the launcher, since the binfmt_misc registration isn't
   per-namespace on the measured host; refused for the sandbox by withholding
   `/run/WSL` and failing MZ execution, N4), or a WSLg terminal? The `wt.exe`
   route conflicts with X13 as written, which refuses launch whenever interop
   is enabled. Choosing it would need an explicit maintainer decision to
   rescope X13 to "interop unreachable from the sandbox" (#79). That is a
   **proposed alternative**, not adopted; disabled fixtures don't need the
   choice now.
2. **Timeouts and reopens.** The idle timeout and reconnect values, and how
   many authority reopens to allow per session (proposed: one).
3. **Stop or pause on control-window loss.** Is a physical stop the right
   default? Pausing the namespace (SIGSTOP) would still have to meet the same
   independence rule.
4. **Where to filter the agent PTY.** The launcher, or a dedicated filter
   process. Either way, the filter must be a stateful parser (N6).
5. **Durable pending requests.** Should kept console requests survive a
   control crash, through a protected pending record or lookup-by-id? That
   would be a separate design. Neither is adopted.
