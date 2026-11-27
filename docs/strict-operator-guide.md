# Strict tier: operator guide and recovery map (#78)

Status: **map of proposals, not a how-to.** Strict is not available in this release and nothing here enforces it.
`skel status --json` always reports `strict.state: "unsupported"`. This page
gathers, in the order an operator would meet them, the launch, finish and
recovery behaviour that the strict design documents propose, and says where
each proposal lives. Rows say what a launcher **would** or **must** do; no
launcher exists. When strict ships, this page becomes the user guide. Until
then, every row is a design or a fixture, and none of them is evidence that
a boundary held.

The [verification matrix](strict-verification-matrix.md) is the release
claim gate (#79). Nothing on this page may claim more than that matrix does.

## 1. Before launch: prerequisites and scope

| Topic | Proposal | Where |
| --- | --- | --- |
| Clients and platforms | The candidate first profile is a pinned Claude Code CLI launched as a whole process inside a minimal Linux boundary, with no arbitrary MCP bridges. Each profile would have to be demonstrated on its own. Native Windows, macOS, IDE extensions and Desktop make no active or containment claim. | [strict-boundary.md](strict-boundary.md) |
| Prerequisites | The fixtures need Bubblewrap, unprivileged namespaces, system Python with pidfd support, and Chrome or Chromium; they exit 2 when one is missing. For status, the proposed `dependency-missing` reason tells the human to install the named prerequisite outside the session (`lib/strict-status.mjs`). | [strict-fresh-profile.md](strict-fresh-profile.md), [strict-graceful-stop.md](strict-graceful-stop.md), [strict-launcher-smoke.md](strict-launcher-smoke.md) |
| Human desktop | The protected window would have to open on a seat the human actually sees, with browser debugging off. Xvfb runs are fixture evidence and never stand in for a real desktop. The launcher must refuse when display or seat evidence is missing or untrusted. | [strict-human-desktop.md](strict-human-desktop.md), [strict-real-desktop-launcher.md](strict-real-desktop-launcher.md) |
| Process isolation | Fixtures only: a worker in its own PID and user namespaces with no effective capabilities and no_new_privs, and a launcher-side PID that isn't visible from the worker's private PID namespace. Attach, memory-read and descriptor policy remain open, and nothing here covers the real launcher, console or authority. | [strict-process-isolation.md](strict-process-isolation.md), [strict-process-reach.md](strict-process-reach.md) |

## 2. Status: what each state means

`skel status --json` has a `strict` field with one of four states. In the
proposal, only fresh enforcement evidence bound to the current project and
session can produce `active`; a project file, a settings or dependency
check, or a review-page result never can. Nothing in this release produces
or authenticates such evidence, so `active` can't occur. The copy and every
negative state live in `lib/strict-status.mjs` and are tested in
`test/strict-status.test.mjs`.

| State | Meaning | Approve, reshape, finalize (strict requested) |
| --- | --- | --- |
| `active` | Fresh evidence for this project and session | Never through the in-boundary CLI; only the protected human flow would decide |
| `unverified` + reason | `launcher-absent`, `profile-unsupported`, `evidence-stale`, `evidence-unreadable`, `dependency-missing` or `evidence-mismatch` | Refused, with a next step |
| `unsupported` | This release has no strict enforcement | Refused if strict was requested; skel never falls back to default mode on its own |
| `ended` | The strict session is over | Refused until a new launcher session starts |

Status shown inside the boundary is advice. The agent can forge anything on
its own terminal, so the proposal has the human rely on the launcher's
control window and the protected decision page, not on the agent's terminal
or transcript. See
[strict-decision-page.md (e)](strict-decision-page.md#e-status-and-skills-integration-78).

## 3. Copy/Send is not authority

The review page's Copy and Send buttons carry the human's notes to the
agent. They never approve anything: review-page verdicts, hashes and copied
feedback are workflow signals that shell access can forge (see the
[README](../README.md)). In the strict design, a decision counts only when
the human enters it through the protected human channel. A permission
prompt or a `UserPromptExpansion` is not a human-only receipt. The skills'
strict-mode text (`skills/skeleton/SKILL.md`, `skills/skeleton-fill/SKILL.md`)
tells the agent not to run an equivalent privileged command or work around a
failed boundary; that is model guidance, and
[strict-skills-agent.md](strict-skills-agent.md) samples how well models
follow it.

See [strict-human-channel.md](strict-human-channel.md) and
[strict-decision-page.md (c)](strict-decision-page.md#c-what-the-human-sees-versus-what-gets-approved).

## 4. Normal finish

At a checkpoint the launcher would stop every process in the agent's
namespace, verify the stop, capture the workspace while no session process
is running, and show the stored snapshot on the decision page. After
approval, a fill session would restart from the stored approved snapshot,
and the fill would be compared with it (`checking`, then `checked`).
`checked` is a future gate: nothing is stored or delivered to the checkout,
and what follows it is undecided. Restart after reshape is an open question.

Finalize is not offered in the proposed v1: the page can't yet render and
bind the checked final capture (#99). Today, in default mode, `skel done`
and `skel finalize` check for changes outside the fences and refuse to
complete. That is detection and refusal, not prevention.

See [strict-checkpoint-ux.md](strict-checkpoint-ux.md),
[strict-human-channel.md](strict-human-channel.md) and
[strict-graceful-stop.md](strict-graceful-stop.md).

## 5. When something goes wrong

| Situation | What the human would see | Where |
| --- | --- | --- |
| The stop is in doubt (a writer survived, or teardown is unproven) | The control window says a session process may still be running and refuses capture, checks and restart. The only actions are show details and end session, and ending doesn't prove every process is gone. The agent's terminal shows only "Stopped by the strict launcher. Wait for the human." | [strict-checkpoint-ux.md, refusals](strict-checkpoint-ux.md#refusals) |
| The authority stalls or exits during a stop | The physical stop doesn't depend on the authority, and the fixture shows the stop is still proven. | [strict-lifecycle-fault.md](strict-lifecycle-fault.md) |
| The strict record is missing or corrupt | Every decision is refused, in this session and new ones, until the record is recovered outside the session. Deleting or editing `.skeleton/` changes nothing. | [strict-decision-page.md (d), R3](strict-decision-page.md#d-requestid-retention-and-recovery-ux-requirements-for-sols-journal) |
| The workspace changed after the capture was shown | The page never live-reloads, and Approve names only the capture the tab drew. Only the human can ask for a new capture (Recapture): a changed capture moves the page and discards any kept intent, after a warning if a Retry is pending, and an unchanged one keeps the revision. Recapture is refused during fill, and no listener offers it yet. | [strict-decision-page.md (c), C4](strict-decision-page.md#c-what-the-human-sees-versus-what-gets-approved), [strict-recapture.md](strict-recapture.md) |
| The protected decision listener stops mid-request | The old tab treats the outcome as unknown and tells the human to reopen through the control window. The new tab shows current state and makes no claim about the old request. (The review server is a separate, untrusted channel.) | [strict-decision-page.md (d), R7](strict-decision-page.md#d-requestid-retention-and-recovery-ux-requirements-for-sols-journal) |
| Evidence expires or belongs to another project or session | `unverified: evidence-stale` or `evidence-mismatch`, with the next step: restart through the launcher. | `lib/strict-status.mjs` |
| The session ends | `ended`. No new action is accepted, and nothing claims an earlier request did or didn't commit. | [strict-decision-page.md (d), R5](strict-decision-page.md#d-requestid-retention-and-recovery-ux-requirements-for-sols-journal) |

Recovery never quietly turns containment off. Choosing default mode for a
project is the human's explicit decision, made outside the agent's session.

## 6. Default mode is unchanged

Everything in the [README](../README.md) above "Strict tier (in development)"
is the default tier: a drift guard for a cooperative agent. Nothing on this
page changes how default-mode `approve`, `reshape`, `finalize`, `done` or
the hooks behave.
