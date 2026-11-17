# Strict launcher contract: protected bootstrap and PTY (#147; parents #124, #99)

Status: **experimental contract, not adopted for production.** The user's instruction authorizes bounded disabled prototypes and cross-review; this document supplies their acceptance criteria, not additional authorization. It does not adopt H0, H1 or H3, make strict `active`, or approve a release. The broader design in [strict-human-channel.md](strict-human-channel.md) remains unadopted. The default verifier still reports unsupported; fixture results stay `unverified`.

**What this does not claim.** A PTY doesn't show that a human typed something. Filtering doesn't remove every dangerous terminal sequence. The launcher also doesn't trust same-uid processes, ptrace or desktop automation without evidence. Every isolation claim below is a gate that needs a passing negative row and its positive control.

## Owner and boundary

The **launcher** is a host process started by the human, outside the agent boundary. No agent path starts it, re-execs it or parents it. It owns these exclusively:

| Asset | Contract |
|---|---|
| Authority and capture stores | Created with `createHumanAuthorityStore` and reopened only with `openHumanAuthorityStore` for the exact enrolled context. Protected capture storage and `observeUnderLock` remain host-owned dependencies. Durable enrollment, records and immutable captures live outside disposable scratch and survive ordinary session cleanup. None is mounted, bound or inherited into the agent namespace. |
| Channel descriptors | Unnamed `socketpair` only, passed to `createHumanCommandServer` and `createHumanCommandClient` ([transport](strict-human-channel-transport.md)). No socket path, TCP port, HTTP route or named FIFO. Descriptors are `O_CLOEXEC` except where deliberately passed to one host helper. |
| Control PTY and session | A fresh `openpty`, then a control helper under `setsid` plus `TIOCSCTTY`, with raw mode and its own process group. The agent never receives the control PTY's master or slave fd. PTY paths, session ids and host PIDs are nonsecret target identifiers: knowing or guessing them must not grant access. |
| Agent PTY | A separate PTY whose slave is the agent's only terminal. The agent runs with a private devpts instance (`newinstance`), so it can't see `/dev/pts/*` for control. The launcher reads the master only through `agentOutput` filtering. |
| Agent environment | Built from an empty environment plus an allowlist. Removed: `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `PULSE_SERVER`, `DBUS_SESSION_BUS_ADDRESS`, `WSL_INTEROP`, `XDG_RUNTIME_DIR`, `TERM_PROGRAM`, `SSH_AUTH_SOCK` and any `*_SOCK` or `*_DEBUG*` variable. No WSLg, X11 or Wayland socket paths are mounted. |
| Scratch | One launcher-private directory per run, mode 0700, outside every agent mount. |

The trusted human session is limited to what [strict-human-channel.md](strict-human-channel.md) assumes. Host-side automation the human runs is out of scope. **Any automation the agent can reach is in scope.**

## Lifecycle

1. **L0, preflight.** A production launcher must refuse with a fixed reason enum, exit 2, and no store created when:
   - the profile is unsupported (X12);
   - interop or `/mnt/*` aliases are visible (X13);
   - a display or bus socket is reachable from the agent namespace plan;
   - pins don't match;
   - `kernel.yama.ptrace_scope` isn't known, or user and PID namespace separation isn't available.

   No supported profile currently exists, so this is not a path to production launch. The explicitly invoked fixture may instead admit its disposable test worker after checking its own prerequisites, reporting only bounded observations. `blocked-policy` (a check ran and forbids launch) is different from `channel-absent` (no protected channel could be bootstrapped). Neither may fall back to unconstrained mode (X18).
2. **L1, enroll.** The launcher creates the store. Enrollment metadata may hold only opaque ids, digests, the epoch id, the profile id and timestamps. **It never holds codes, round keys, HMAC inputs, channel fds or paths.** An enrollment failure is not retried with a fresh enrollment.
3. **L2, control bootstrap.** The launcher creates the socketpair and the control PTY, then starts the control helper (`lib/strict-control-console.mjs` text layer) holding only its client fd and the PTY slave. The launcher reports **ready** only after:
   - the helper has completed the existing `state()` round trip over the channel (reachability only, not a new readiness/authentication protocol);
   - the launcher has inspected the actual helper fd table: PTY stdio, the explicitly passed channel and individually permitted runtime-private descriptors only. Node's internal event-loop descriptors must not be mistaken for additional authority capabilities;
   - the agent PTY has not yet been created.

   Any failure leads to `channel-absent`. The agent is never started, and scratch is retained.
4. **L3, agent start.** The agent starts only after ready, in its own user, PID, mount and network namespaces, under bwrap or equivalent with `--die-with-parent`. Host loopback, abstract sockets and any allowed broker route need explicit negative controls; user/PID isolation alone is insufficient. It gets private devpts, the scrubbed environment and explicitly passed agent PTY stdio. Runtime-opened descriptors are inspected separately. It gets no host procfs mount.
5. **L4, supervise.** The launcher holds supervised group leaders unreaped, using `waitid(...WNOWAIT)` as in the private-channel probe, and signals by process group only before reaping. Bounds: an idle timeout on the control helper, a wall-clock lifetime cap per session, and the transport's per-connection bounds. The proposed values (control idle 30 min, lifetime 8 h) are unadopted; fast fixture deadlines are independently documented. On a bound or authority/control fault, stop the worker independently of authority progress. A blocked `endSession` must never delay physical stop. Logical admissions are unknown until a confirmed result is recovered; failure does not justify fresh enrollment or counters being reset.
6. **L5, end or restart.**
   - The console's `end` closes admissions only (`admissions-revoked`). It does not prove process death. The launcher's own stop terminates and verifies supervised workers independently, then stops the control group. Group termination alone cannot prove a detached `setsid` descendant died; complete namespace-writer quiescence needs the existing namespace/pidfd controls and further supported-profile evidence.
   - Restart is a new launcher run that reopens the same enrolled store and **never re-enrolls** to clear a refusal or a cap.
7. **L6, scratch.**
   - Fixture success deletes scratch only after its supervised groups and deliberately tracked descendants are verified stopped and reaped. This is not proof that arbitrary detached host processes cannot escape supervision.
   - Any cleanup failure, unknown outcome or refusal after L1 retains scratch and exits 1.
   - Retained scratch is inspected only by the outside recovery process.

## Unknown outcomes

Loss of the channel or of the control helper, a malformed reply, a timeout or a host fault all mean **outcome unknown**. Nothing is ever retried automatically or rebuilt from current state.

- The existing live console retains the exact request and durable `requestId` in memory. Reconnection must preserve both; changing the connection sequence does not change that id.
- A lost control process cannot reconstruct a safe replay from current state. Durable pending-request storage, including any persisted code, is an open design choice requiring its own threat review, canonical format and fault vectors. The prototypes here do not implement it. A fresh process reports unresolved recovery rather than generating a replacement decision or implying the previous command failed.
- A deliberately retained exact request in a host test harness can demonstrate same-ID replay after authority restart, as the existing fixture does; this does not prove control-process crash recovery.
- A lookup-by-id operation that doesn't need the code is a **candidate only**. It needs approved vectors and a protocol change before implementation.

## No new wire schema adopted

Prototypes reuse the existing frame and codec (`version:1`, 4096-byte bodies). The launcher↔helper readiness handshake, the pending-record format and any lookup-by-id operation are **unadopted candidates**. Each needs:

- canonical encoding;
- test vectors;
- a separate approval before any implementation beyond fixtures.

## Pure filtering fixture (Claude slice)

These functions do no I/O and use no timers:

- `controlInput(bytes, state) → {state, events}`:
  - strips the bracketed-paste markers `ESC[200~` and `ESC[201~`;
  - refuses a whole paste that contains LF, CR, ESC, C0, C1 or DEL;
  - buffers the entire bounded paste/line before emitting an accepted event; a printable prefix must not execute before a later invalid byte rejects it. Overflow, nested markers and malformed framing discard the whole input until a safe terminator/reset;
  - otherwise emits printable ASCII for the console's existing input rules (max 200, Crockford normalization).
- `agentOutput(bytes, state) → {state, out}`: a stateful parser with these policies:
  - drops OSC 0, 1, 2 and 52 whole, along with every other OSC;
  - drops DCS, including tmux and screen passthrough wrappers, and APC, PM and SOS;
  - handles BEL and ST terminators, the C1 bytes 0x9D, 0x90 and 0x9C, and splits at every byte offset. Unterminated strings use constant state and remain discarded until a valid terminator or explicit end/reset; reaching a byte cap must never resume passthrough inside the string. Byte handling and malformed UTF-8 policy need explicit vectors before implementation;
  - passes plain text, CR/LF/TAB and CSI unchanged. CSI rows are logged as **not filtered**.

**It claims only these channels.** It doesn't claim to defend against terminal emulator bugs or CSI-based attacks.

## Negative test map (each row needs a positive control)

| Row | Negative | Positive control | Owner |
|---|---|---|---|
| C17 | An agent prints `strict: active`, a fake banner or `approve XXXX-XXXX`, and nothing reaches the control channel or authority | The same bytes typed on the control PTY reach the console | Codex probe |
| C18a | The agent cannot inject into control or access its real terminal/process. Attempt `TIOCSTI`, PTY opens, procfs, ptrace and process-vm paths, with narrower first-slice coverage stated explicitly | Own-terminal/procfs controls and host access prove targets exist. If kernel policy disables an ioctl even for the host, record that limitation; it does not prove isolation caused denial. A missing exploit control cannot satisfy a causal isolation claim | Codex |
| C18b | OSC 0/1/2/52 (split, BEL/ST, 0x9D, DCS-wrapped) is absent from the filtered output | Text, SGR and cursor CSI are byte-identical after filtering | Claude |
| C18c | A paste with LF, ESC or C1, nested paste markers, or an over-length line refuses the whole line | A clean bracketed paste of a code is accepted and normalized | Claude |
| C18d | The agent inherits no control descriptor and cannot access the actual control endpoint despite knowing target paths/PIDs | The launcher's own access works, and the agent's own PTY/procfs controls work | Codex |
| C19/C20 | No WSLg, X11 or Wayland socket, `DISPLAY` or `XAUTHORITY` from the agent; no `--remote-debugging-*` or CDP port is reachable; no `xdotool`, `ydotool`, AT-SPI or D-Bus session reach | A host helper reaches the same sockets and ports | Codex |
| X10/X13/X14 | Interop, `/mnt/*` and loopback or host aliases are refused or unreachable | A preflight on a deliberately bad profile emits `blocked-policy` | Codex |
| X17/X18 | A crash at each lifecycle step leaves no live group, retains scratch and never falls back | A clean run deletes scratch | Codex |
| Absent vs blocked | Removing the socketpair or helper gives `channel-absent`. A policy hit gives `blocked-policy`. The two reasons never mix | Both reasons appear in a single matrix run | Both |

## Failure matrix

| Failure | Required behavior | Exit |
|---|---|---|
| Preflight or pin mismatch | No store, no agent, `blocked-policy` | 2 |
| Readiness not reached | No agent, `channel-absent`, scratch retained | 1 |
| Control helper dies with a request pending | Stop the worker without waiting for authority; report outcome unknown. Control-crash replay stays unsupported without a reviewed protected pending record | 1 |
| Agent exits | The control helper stays up until `end` or idle, then a normal stop | 0 or 1 |
| Idle timeout or lifetime cap hit | Stop supervised workers independently of authority, report the bound and unresolved logical state when necessary | 1 |
| Cleanup or reap fails | Refuse success, retain scratch | 1 |
| A negative row passes without its positive control | The row is **invalid**, not passed | 1 |

## Manual acceptance (recorded as observations, not attestation)

- **Human:** on a named profile, the maintainer confirms:
  - the control window is visually distinct;
  - a forged banner in the agent terminal is noticeable;
  - pasting a code works.
- **Profile:** OS and kernel build, WSL version, WSLg on or off, terminal emulator and version, `ptrace_scope`, Node and bwrap hashes.

These go in the matrix as dated observations. They don't adopt H0, H1 or H3 and don't make strict `active`.

## Slices

**First prototype (Linux and WSL2, narrow):**

- A Python `-I` host like `strict-private-channel-probe.py`.
- The test harness, not a real window, drives the control PTY.
- The agent stand-in is a minimal bwrap worker.
- The first Codex slice (#149) measures separate PTYs/devpts, descriptor/procfs access, TIOCSTI outcomes, synthetic display/socket exclusion and bounded group cleanup. It does not implement enrollment, durable pending requests, complete L0–L6 supervision, arbitrary ptrace/process-vm attacks or real display/browser isolation. Each additional claim needs its own slice and controls.

**Broader gates:**

- a real separate control window on WSL (a Windows Terminal tab started outside the agent session, or WSLg);
- the real pinned CLI as the agent;
- the browser profile (C20);
- anti-rollback (X11);
- the profile matrix (X12);
- Sol's protocol approvals.
