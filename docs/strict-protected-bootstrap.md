# Protected launcher bootstrap and control PTY contract (#147)

Status: **disabled contract for review, not an implementation, adoption or
runtime verdict.**
- **No adoption.** It adopts none of H0, H1 or H3. It claims no human
  authentication, no supported profile, no production activation and no
  release.
- **PTY isolation is an experimental candidate.** It narrows who can type
  into the control window. It does not prove that a human typed a decision.
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
| Private directory (authority store, capture store, key, scratch) | launcher | launcher; mode 0700, outside the workspace, never mounted into the agent | **no** |
| Authority process (durable human authority, one enrolled project and session) | launcher child | launcher | **no** |
| Control process (console) with its **own controlling PTY** in a separate terminal window | launcher child, its own session leader | launcher | **no** |
| Decision listener (127.0.0.1, protected origin) | launcher child, host network namespace | launcher | **no** |
| Control↔authority and listener↔authority links | unnamed socketpairs (#145 framing) | launcher | **no** |
| Agent sandbox (pinned CLI) | launcher child in its own namespaces | launcher | — |
| Agent PTY | agent sandbox | launcher, with an output filter in between | the agent's own only |

**What the agent receives, and nothing else:**
- its own PTY;
- the workspace mount;
- the model-relay descriptor (X4);
- an explicit, minimal environment.

**What it never receives:**
- any descriptor for the control PTY, the authority, the listener or the
  private directory;
- the launcher's environment;
- display, session-bus, WSLg, Wayland or X11 sockets or variables;
- browser profiles.

The descriptor allowlist is checked inside the agent at startup (N3).

## Enrollment and session metadata

The launcher enrolls the authority with three things: the project id, the
session id and the initial review round. Enrollment and session metadata
**never** carry:

- authority keys or key material;
- approval codes;
- tokens;
- tab bindings.

The rest of the design depends on where each item lives:

- **Keys** are generated inside the authority process (32 bytes from
  `crypto.randomBytes`, per #124) and never leave it.
- **Codes** leave the authority only toward the listener, which serves them
  to the bound tab. They never go to the console or the agent.
- **The console** never sees a code except the one the human types.

## Bootstrap sequence

Each step either succeeds or refuses the whole launch.

1. **Preflight.** Collect a runtime receipt (#144) and check the prerequisite
   observations. Receipt unavailable, or a prerequisite missing, means refuse
   (X12, X13).
2. **Private directory.** Create it fresh: 0700, owned by the user, on a
   supported local filesystem, outside the workspace. An existing path is
   refused, never reused.
3. **Authority.** Start it, then create or reopen the store and enroll it.
   Missing, corrupt or rolled-back enrolled state refuses. It never silently
   starts a new epoch (#124).
4. **Control process.** Start it on a **new** PTY, as its own session leader
   with that PTY as its controlling terminal, in a separate terminal window
   that shows the fixed `SKELETON STRICT CONTROL` banner.
5. **Readiness.** Over the control↔authority socketpair, the console's
   `state()` must answer. Any failure refuses.
6. **Listener.** Start it, and mint the first navigation. The control window
   shows the URL, or opens a fresh, launcher-owned browser profile (C20).
7. **Agent.** Only now start the agent sandbox, with the descriptor
   allowlist, the filtered PTY and the minimal environment.

**No fallback (X18).** If any step fails:
- the launcher reports the failure on the control window, or on its own
  stderr if no control window exists yet;
- it stops everything it started, then retains or cleans up the private
  directory under the cleanup rule below;
- it **never** starts the agent in default or unconstrained mode as a
  fallback.

## Connection lifetime and supervision

**Channel bounds** come from #145, as prototype values rather than adopted
policy: 128 calls per connection, one in flight, a 1000 ms request deadline,
and a 4096-byte frame.
- **On connection loss** the console reports an unknown outcome and keeps
  the request.
- **Reconnecting** gives the console a fresh socketpair from the launcher.
  It never gets a named endpoint.
- **A retry after reconnecting** uses the **same request id**, so the
  journal returns the original result (evidence:
  `test/strict-human-channel.test.mjs`, `test/strict-control-store.test.mjs`).

**Idle timeout (proposal):** close the control↔authority connection after 10
minutes idle, and reconnect on the next command. The value is to be agreed.
It is not a security control.

**Supervision** goes through pidfds and process groups that stay unreaped
until cleanup, as in the existing probes:

| Event | Required behavior |
| --- | --- |
| Authority process exits or stops answering | Console: unknown outcome, the request kept, no new decisions. Launcher: reopen the authority from the durable store **once**, with the same enrollment. If reopen fails, stop the agent and end the session |
| Control process or its terminal exits | Launcher stops the agent (physical stop), revokes admissions (`endSession`), keeps the authority store. No decision can be made without the control window |
| Listener exits | Decisions are unaffected (they travel through the console). The control window offers to reopen it with a fresh listener and nonce |
| Agent exits | Normal end of a run. Admissions stay open until the human ends the session |
| Launcher exits or crashes | Every child dies with it (parent-death signal plus a pidfd watchdog). A later launcher run sees the durable store and refuses to auto-resume. It requires an explicit human restart |
| Cleanup can't be proven (a helper can't be reaped, a namespace member still alive) | Retain the private scratch, report "cleanup unproven", and never report success |

## End and restart

- **End.** The human types `end` and confirms. That triggers `endSession`,
  answered with `admissions-revoked` (decisions closed), and the launcher's
  separate **physical stop** of the agent. Neither proves the other. The
  console never says the session ended because of revocation (#138).
- **Restart after a checkpoint (#99).** The launcher stops the agent's
  namespace, captures, and restarts a fresh agent from the approved capture.
  The control process and the authority persist across that restart. The
  agent never inherits them.

## Negative controls (required before any claim)

| ID | Control | How it is tested | Fixture can prove? | Matrix |
| --- | --- | --- | --- | --- |
| N1 | The agent can't open the control PTY | The agent sandbox gets its own devpts instance, and from inside it, opening each `/dev/pts/*` and the launcher's PTY path fails | yes, for the measured profile | C18 |
| N2 | No `TIOCSTI` into the control PTY | The control PTY can't be reached (N1). The receipt also records `dev.tty.legacy_tiocsti` and a probe attempts `TIOCSTI` on every reachable tty | yes | C18 |
| N3 | No inherited descriptors beyond the allowlist | The agent enumerates `/proc/self/fd` at start and compares it with the allowlist | yes | C17, X14 |
| N4 | No display, session-bus, WSLg or Wayland/X11 reach | The agent's environment has no `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` or `WSL_*` interop variables, and connecting to `/tmp/.X11-unix/*`, `/mnt/wslg/*`, Wayland and bus sockets fails | yes (paths and variables); the terminal side needs manual checks | X13, C18 |
| N5 | No automation or debugging endpoints | No browser profile directories are mounted, and connecting to CDP/WebDriver ports in the host namespace fails from the agent namespace | yes | C20, X14 |
| N6 | OSC 52 (clipboard) and OSC 0/1/2 (title) never reach the human's terminal from the agent | A stateful output filter on the agent PTY. Tests cover split reads, BEL and ST terminators, the C1 OSC byte and DCS passthrough | yes (the filter); a real terminal needs manual checks | C18 |
| N7 | Pasted control bytes and multi-line pastes are refused in the console | Console input policy (#122) | yes (unit) | C6 |
| N8 | The agent can't spoof the control window | The banner only appears in the control window. Title escapes are filtered (N6). The human is told nothing counts unless the bannered window echoes it | partly; human judgment | C17 |
| N9 | The agent can't reach the authority or listener links or the private directory | No named endpoints exist, the socketpairs aren't inherited, the private directory isn't mounted, and access attempts fail | yes (an existing probe covers a fixture worker) | X14 |
| N10 | No fallback | An injected failure at each bootstrap step must leave no agent running, unconstrained or otherwise | yes | X18 |
| N11 | Enrollment and session metadata hold no keys or codes | A static schema check plus a fixture that dumps the metadata | yes | C17 |

## What the fixtures prove, and what stays manual

**The fixtures** are Bubblewrap with socketpairs and pinned binaries, as in
`test/live/strict-private-channel-probe.py`. They can establish N1–N5, N9,
N10 and N11 **for the measured profile**, which the runtime receipt
fingerprints. They don't establish that profile for anyone else, and the
receipt grants no support.

**Manual human and profile acceptance** is still needed, per supported
terminal and OS:
- that the launcher actually opens a separate terminal window, and that only
  it shows the banner;
- that the real terminal emulator ignores filtered OSC sequences and
  doesn't expose its own clipboard or title channels;
- that the human's browser profile is separate and fresh;
- on WSL, how the outside launcher opens a Windows-side terminal and
  browser (see the open questions) without giving the agent interop.

**Browser fixtures** (`test/live/strict-browser-matrix.mjs`) cover the
decision page's request rules and rendering (C1–C5). They don't cover the
human's own browser or its isolation.

## Before implementation

Any bootstrap framing or schema needs **independent vectors and Codex
cross-review** before code. That covers:
- the enrollment message;
- the readiness handshake;
- the launcher↔listener issuance link;
- the descriptor allowlist format.

The #145 channel framing is reused unchanged.

## Open questions

1. **WSL control window.** Can the outside launcher start a Windows terminal
   (for example `wt.exe`) through interop while the agent sandbox has
   interop refused? Or must v1 require a Linux terminal emulator (WSLg)?
2. **Idle timeout and reconnect limits.** Values to agree, plus how many
   authority reopens to allow per session (proposed: one).
3. **Physical stop on control-window loss.** Is stopping the agent the right
   default, or should the agent be paused (SIGSTOP of the namespace) until
   the human reopens the control window?
4. **Where to filter the agent PTY.** The launcher, or a dedicated filter
   process. Either way, the filter must be a stateful parser (N6).
