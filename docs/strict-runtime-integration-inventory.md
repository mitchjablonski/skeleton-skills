# Strict runtime-integration dependency inventory (#124 / #99)

Status: an inventory, not a design. It records what exists on `main` (as of
26f27b6), who would own each piece during protected launch and restart, and
what is still missing, in the order of the
[bootstrap contract](strict-protected-bootstrap.md). Nothing here adopts a
component. Strict stays disabled and `unverified`.

**Production wiring today.** Only one strict module is imported by a
production entrypoint:
- `bin/skel.mjs` imports `lib/strict-status.mjs`, and calls it with
  `requested: false` for display only.

Every other `lib/strict-*.mjs` module is a disabled prototype, a mock or a
pure candidate, reached only from tests, fixtures and other strict modules.

## By bootstrap step

The **owner** column names the process that would hold the piece under the
contract's "Who owns what":
- **L** is the launcher;
- **A** is the authority;
- **C** is the control console;
- **Ls** is the listener;
- **Ag** is the agent sandbox.

| Step | Owner | Exists (module, or fixture evidence) | State | Missing for integration |
| --- | --- | --- | --- | --- |
| 1 Preflight | L | `test/live/strict-runtime-receipt.py` (#144) | fixture | A launcher-side receipt check and refusal path. The receipt schema doesn't record `legacy_tiocsti` (contract N2) |
| 2 Directories | L | stores open given paths: `strict-capture-store`, `strict-authority-store`, `strict-human-authority-store` | prototypes | A **directory manager**: create or reopen durable history (owner, mode, filesystem checks), and create **fresh** scratch, refusing an existing path |
| 3 Capture + authority | L, then A | `strict-capture`, `strict-enumeration`, `strict-capture-store`; `strict-human-authority(-store)`, `strict-authority(-store)`, `strict-protocol` | pure, prototypes | An authority **process** host. The enrollment message and its binding (`docs/strict-enrollment-binding.md`, a proposal; #178 open) |
| 4 Control process | L, then C | `strict-control-console` (text), `strict-control-input` (N7 parser), composed in `test/strict-control-input-console.test.mjs` | prototypes | The **control-process host**: PTY, raw mode, session leadership, and candidate A vs B (open). The launcher→console link |
| 5 Readiness | L (association, report, start decision); C ↔ A (state exchange) | `strict-human-channel` (#145 framing); `test/live/strict-launcher-binding-probe.py` (the #182 report gate: a parent-owned report pipe, generation, selected enrollment, exact capture and peer liveness, with refusal before the marker child) | prototypes, fixture | The runtime piece in which the **launcher** associates the socketpair with the enrolled authority, hands the endpoint to C, receives C's private readiness report (from the existing `state` call; no new protocol) and decides whether to start. Today this exists only as the #182 fixture |
| 6 Listener + browser | L, then Ls | `strict-decision-listener`, `-app`, `-codes`, the capture-view modules; `strict-browser-matrix.mjs` | mock only | The **issuance capability** (listener↔authority; not a #145 call). **Browser launch** with a fresh launcher-owned profile (C20). Listener restart (the contract says it doesn't exist yet) |
| 7 Agent | L, then Ag | Fixtures only: descriptors (N3, #163), display/interop/vsock (N4, #160), browser endpoint (N5, #168), links (N9, #164), listener addresses and PID visibility (X14, #170, #174), PTY separation (#152) | fixtures | The **agent sandbox profile**: the namespace set, devpts, `--new-session`, `--die-with-parent`, a measured descriptor allowlist format and a minimal environment. A **syscall policy** (AF_VSOCK, io_uring; only a fixture BPF exists, #160). The agent **PTY relay** hosting `strict-pty-output` (N6). Model egress via `strict-model-broker` / `-policy` (mock, lab) |

## No fallback, stop and restart

| Concern | Owner | Exists | State | Missing |
| --- | --- | --- | --- | --- |
| No fallback (X18, N10) | L | `test/strict-bootstrap-fault.test.mjs` (all seven phases, #175/#176); `strict-lifecycle-fault-probe.py` (stand-in faults, #158/#165) | fixtures | The launcher itself. Launcher-owned observation of every started process, and a launcher-side forced kill (post-merge notes on #176) |
| Physical stop | L | lifecycle and checkpoint probes (pid-namespace teardown proof) | fixtures | A **supervisor**: namespace teardown with every member proven exited; the authority's one-time reopen; a parent-death cascade for the authority, console and listener; a "cleanup unproven" report |
| End | C → A, plus L | `endSession` in `strict-human-authority-store`; `strict-control-console` end flow | prototypes | The launcher's independent physical stop paired with revocation. Neither proves the other (contract) |
| Restart after checkpoint (#99) | L | `strict-recapture-coordinator`, `strict-checkpoint-status` (copy), capture primitives | prototypes | A **checkpoint supervisor** that stops the agent, recaptures, restarts it from the approved capture, and emits the report that `strict-checkpoint-status` parses. The control process and authority must persist across it |
| Ordinary reconnect | L → C | `strict-human-channel` same-id retry on the live channel; the private-channel probe | prototypes, fixture | The launcher handing the console a fresh socketpair (never a named endpoint), and the idle-timeout value (open) |
| Recovery after an authority or readiness fault | L | the host-only history guard (#183) | host-only guard | The runtime handoff: a **fresh enrolled endpoint** and the **exact committed history**, refusing when history is absent or unreadable. Never the live-channel retry |

## Dependency order

These are what each missing piece needs first, read from the contract:
1. **Directory manager** and **authority process host**: needed by step 3,
   by readiness, and by every restart path.
2. **Enrollment binding (#178)**, then the **launcher's readiness gate**:
   the launcher associates the socketpair with the enrolled authority, hands
   the endpoint to the console, and only then takes the console's readiness
   report (the `state` call plus a private launcher report) and decides to
   start. The #182 fixture exercises this order.
3. **Control-process host**: needs the candidate A/B decision, a
   maintainer choice.
4. **Agent sandbox profile** and **syscall policy**: needs the vsock
   decision (#79), and the descriptor allowlist measured on the pinned
   runtime.
5. **Supervisor** (stop, cascade, cleanup proof): needed by every fault
   path and by restart.
6. **Issuance capability** and **browser launch**: needed by step 6, with
   code issuance still open.
7. **Checkpoint supervisor**: builds on 1, 4 and 5. **Fault recovery**
   builds on 1, 2 (including the step-5 launcher readiness gate) and 5 (the
   supervisor's proven physical stop, which must come first), plus the #183
   history guard.
8. **Launcher** sequencing steps 1–7 with no fallback: built last, on all
   of the above.

## Decisions this inventory depends on

These are open in the contract and need a maintainer or design review:
- control-window candidate A or B;
- the WSL interop and vsock policy (X13 rescoping, #79);
- timeouts and the number of reopens;
- stop versus pause on control loss;
- where the agent PTY filter runs;
- durable pending requests.
