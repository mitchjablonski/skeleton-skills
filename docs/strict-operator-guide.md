# Strict tier: operator guide and recovery map (#78)

Status: **map of proposals, not a how-to.** Strict is not available in this
release and nothing here enforces it. `skel status --json` always reports
`strict.state: "unsupported"`. This page gathers, in the order an operator
would meet them, the launch, finish and recovery behaviour that the strict
design documents propose, and says what each one depends on. When strict
ships, this page becomes the user guide. Until then, every row below is a
design or a fixture, and none of them is evidence that a boundary held.

The [verification matrix](strict-verification-matrix.md) is the release
claim gate (#79). Nothing on this page may claim more than that matrix does.

## 1. Before launch: prerequisites and scope

| Topic | Proposal | Where |
| --- | --- | --- |
| Supported clients and platforms | Candidate v1 is a pinned Claude Code CLI, launched as a whole process inside a minimal Linux/WSL2 boundary. Each profile must be demonstrated separately. Native Windows, macOS, IDE extensions and Desktop make no active or containment claim. | [strict-boundary.md](strict-boundary.md) |
| Launcher prerequisites | Bubblewrap, unprivileged user and PID namespaces, system Python with pidfd support, and Chrome or Chromium for the protected window. A missing prerequisite gives `unverified: dependency-missing` and names what to install outside the session. | [strict-fresh-profile.md](strict-fresh-profile.md), [strict-graceful-stop.md](strict-graceful-stop.md), [strict-launcher-smoke.md](strict-launcher-smoke.md) |
| Human desktop | The protected window must open on a seat the human actually sees, with browser debugging off. Xvfb runs are fixture evidence and never stand in for a real desktop. The launcher refuses when the display or seat evidence is missing or untrusted. | [strict-human-desktop.md](strict-human-desktop.md), [strict-real-desktop-launcher.md](strict-real-desktop-launcher.md) |
| Process isolation | The agent runs in its own PID and user namespaces with no capabilities and no_new_privs, and can't reach launcher-side processes. | [strict-process-isolation.md](strict-process-isolation.md), [strict-process-reach.md](strict-process-reach.md) |

## 2. Status: what each state means

`skel status --json` has a `strict` field with one of four states. Only
fresh, authenticated enforcement evidence bound to the current project and
session can produce `active`. A project file, a settings or dependency
check, or a review-page result never can. The copy and every negative state
live in `lib/strict-status.mjs` and are tested in
`test/strict-status.test.mjs`.

| State | Meaning | Approve, reshape, finalize (strict requested) |
| --- | --- | --- |
| `active` | Fresh evidence for this project and session | Only through the protected human flow, never the in-boundary CLI |
| `unverified` + reason | `launcher-absent`, `profile-unsupported`, `evidence-stale`, `evidence-unreadable`, `dependency-missing` or `evidence-mismatch` | Refused, with a next step |
| `unsupported` | This release has no strict enforcement | Refused if strict was requested; skel never falls back to default mode on its own |
| `ended` | The strict session is over | Refused until a new launcher session starts |

Status shown inside the boundary is advice. The agent can forge anything on
its own terminal, so the human relies on the launcher's control window and
the protected decision page, not on the agent's terminal or transcript.
See [strict-decision-page.md (e)](strict-decision-page.md#e-status-and-skills-integration-78).

## 3. Copy/Send is not authority

The review page's Copy and Send buttons carry the human's notes to the
agent. They never approve anything: verdicts, hashes and pasted feedback are
workflow signals that shell access can forge. In strict mode a decision
counts only when the human enters it through the protected human channel.
A permission prompt or a `UserPromptExpansion` is not a human-only receipt,
and the skills never tell an agent to run an equivalent privileged command,
fetch a secret, or work around a failed boundary.

See [strict-human-channel.md](strict-human-channel.md),
[strict-decision-page.md (c)](strict-decision-page.md#c-what-the-human-sees-versus-what-gets-approved)
and [strict-skills-agent.md](strict-skills-agent.md).

## 4. Normal finish

At each checkpoint the launcher stops every process in the agent's
namespace and confirms the stop. It then captures the workspace while no
writer is alive, waits for the human's decision, and restarts a fresh agent
for the next phase. Finalize goes through the same protected flow.
`skel done` and `skel finalize` still check for changes outside the fences
and refuse to complete. That is detection and refusal, not prevention.

See [strict-checkpoint-ux.md](strict-checkpoint-ux.md) and
[strict-graceful-stop.md](strict-graceful-stop.md).

## 5. When something goes wrong

| Situation | What the human sees | Where |
| --- | --- | --- |
| The stop can't be proven (a writer survived, teardown or restart unproven) | The control window refuses and names the recovery. The agent's terminal shows only "Stopped by the strict launcher. Wait for the human." | [strict-checkpoint-ux.md, refusals](strict-checkpoint-ux.md#refusals) |
| The authority or its record fails | Every decision is refused, in this session and new ones, until the record is recovered outside the session. Deleting or editing `.skeleton/` changes nothing. | [strict-decision-page.md (d)](strict-decision-page.md#d-requestid-retention-and-recovery-ux-requirements-for-sols-journal), [strict-lifecycle-fault.md](strict-lifecycle-fault.md) |
| The review is stale (the workspace changed after the capture was shown) | The page never live-reloads, and Approve names only the capture the tab drew. To review the new state, the human presses Recapture, which selects a new capture and discards any kept intent. Recapture is refused during fill. | [strict-decision-page.md (c), C4](strict-decision-page.md#c-what-the-human-sees-versus-what-gets-approved), [strict-recapture.md](strict-recapture.md) |
| The review server or listener restarts | An old tab's request is treated as an unknown outcome. The human reopens through the control window, which shows current state and makes no claim about the old request. | [strict-decision-page.md (d), R7](strict-decision-page.md#d-requestid-retention-and-recovery-ux-requirements-for-sols-journal) |
| Evidence expires or belongs to another project or session | `unverified: evidence-stale` or `evidence-mismatch`. Restart through the launcher. | `lib/strict-status.mjs` |
| The session ends | `ended`. No new action is accepted, and nothing claims an earlier request did or didn't commit. | [strict-control-console.md](strict-control-console.md) |

Recovery never quietly turns containment off. Choosing default mode for a
project is the human's explicit decision, made outside the agent's session.

## 6. Default mode is unchanged

Everything in the [README](../README.md) above "Strict tier (in development)"
is the default tier: a drift guard for a cooperative agent. Nothing on this
page changes how default-mode `approve`, `reshape`, `finalize`, `done` or
the hooks behave.
