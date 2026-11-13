# Strict checkpoint status and recovery copy (#78 / #99)

Status: **proposal, wired into nothing.** `lib/strict-checkpoint-status.mjs`
turns one checkpoint report from the outside supervisor into what the human
sees. The report schema is a proposal for the #99 supervisor, which Sol owns.
No supervisor emits it yet, and no schema is adopted. Strict stays disabled.

## Who sees what

| Surface | Trust | Shows |
| --- | --- | --- |
| Launcher control window | trusted | `headline`, `detail`, `next`, `note`, and buttons for `actions` |
| Protected decision page | trusted | `headline`, `detail`, `note` and `pageNext`. Its only action is reopening itself, so `pageNext` never points at window actions |
| Agent's terminal | **untrusted** | `agentNotice` only: "Stopped by the strict launcher. Wait for the human." |

The agent can forge anything printed on its terminal, so nothing there is a
status the human should rely on. The notice is for an agent that may still
see its terminal before the stop lands, or after a stop that failed. It names
no recovery step. The `running` and `restarting` phases carry no notice.

## Report schema (proposal, version 1)

```js
{ version: 1,
  phase: "running" | "stopping" | "verifying-stop" | "capturing" | "awaiting-review"
       | "restarting" | "checking" | "checked" | "refused" | "ended",
  stage: "scaffold" | "fill",
  round: "<opaque review round id>",
  refusal: null | "teardown-unproven" | "writer-survived" | "restart-unproven"
         | "capture-refused" | "store-outcome-unknown" | "approved-unreadable"
         | "drift" | "check-unavailable",
  detail: null | { kind, path, line } }
```

- **Keys:** exact keys only, as own data properties.
- **`refusal`:** set only when `phase` is `"refused"`.
- **Stage-specific values:** `restarting`, `checking`, `checked`,
  `restart-unproven`, `drift` and `check-unavailable` require `stage: "fill"`.
- **`detail`:** required for `drift` and `capture-refused`, and not allowed
  anywhere else.
  - For drift, `kind` is one of `member-added`, `member-removed`, `mode`,
    `exterior`, `other-fence`, `whole-file`, `fence-set` or `link`.
  - For capture refusals, `kind` is a known `CAPTURE_*` code
    (`lib/strict-capture.mjs`) or `ENUM_*` code (`lib/strict-enumeration.mjs`).
  - `path` is null or project-relative, under the same rules as `safePath`.
    It is shown with invisible, format, combining, surrogate and
    default-ignorable characters escaped.
  - `line` is a positive integer, and only allowed when there is a path.
- **Anything malformed or impossible** renders as "status couldn't be read".
  The copy says to treat the session as **possibly still running** and
  nothing as approved, and the only action is ending the session.

The report carries no agent-written text.

## Phases

The supervisor mapping below comes from Sol's review of the first draft.

| Phase | Supervisor event | Human sees | Actions |
| --- | --- | --- | --- |
| running | launch | Nothing is captured while the agent runs | stop for review, end session |
| stopping | init signalled | Every process asked to end; nothing copied yet | — |
| verifying-stop | exit and census | Nothing captured until no session process is running | — |
| capturing | copy, list, capture, store | The private copy is captured and stored before anything refers to it | — |
| awaiting-review | **needs host semantics** | The decision page shows the **stored snapshot**, not the live project | reopen decision page, end session |
| restarting | approved seed plus a fresh namespace | A fresh fill session from the stored approved snapshot | — |
| checking | stopped candidate comparison | The fill is compared with the approved snapshot | — |
| checked | **future gate** | Passed the checks. **Not durably stored, not delivered**; nothing in the checkout | end session |
| ended | **needs host semantics** | "The launcher reports the session ended." An earlier unproven stop still stands | — |

## Refusals

### When the stop itself is in doubt

These refusals are: `teardown-unproven`, `writer-survived`, `restart-unproven`,
and `capture-refused` with `CAPTURE_CHANGED` or `ENUM_CHANGED`.

- **The copy says** a session process may still be running.
- **What is refused:** capture, checks and restart.
- **Trust:** every file the session could reach is untrusted, from before and
  after the stop.
- **Ending the session** asks the launcher to stop it again, and the copy says
  that doesn't prove every process is gone.
- **Actions:** show details and end session only. Restart from approved is
  never offered here.

`writer-survived` means a member was positively observed alive after the
stop deadline. Missing pidfd or census proof is `teardown-unproven`. The
agent CLI exiting on its own is expected and is not a survivor.

### Other refusals

None of these retries, falls back to default mode, resumes the old session
or reopens a review. Restart from approved is offered only at the fill
stage, and only for these causes:

| Refusal | Means | Restart from approved |
| --- | --- | --- |
| capture-refused, content codes | Something the session wrote: malformed markers, non-UTF-8 text, a BOM, an ambiguous separator, a duplicate path, a line or size limit, an unsupported or too-long name, `ENUM_UNAVAILABLE` | fill only |
| capture-refused, host codes | A link or special file (`CAPTURE_LINK`, `ENUM_TYPE`), or a launcher or environment fault (root, I/O, missing file, device boundary, handles, budget, policy, unsupported platform) | no |
| store-outcome-unknown | Storing may or may not have completed. The request identity is kept for reconciliation, and a reload or re-read can't settle it. The copy never says "nothing was used" | no |
| approved-unreadable | The approved record or capture can't be read or doesn't match. Every request and session refuses until recovery outside the host (decision-page R3) | no |
| drift | Something other than the selected step body changed (kind, path, line) | fill only |
| check-unavailable | The fill couldn't be checked, and an unchecked fill is never handed over | fill only |

## Copy rules (enforced by `test/strict-checkpoint-status.test.mjs`)

- **What the copy never says.** It never calls the session contained, safe or
  secure, never calls strict active, and never says anything was guaranteed,
  approved or delivered. It never says output was written to the checkout,
  never says "the session stays stopped" and never says "no process is
  running".
- **Pinned wording.** Every status carries the exact standing note and every
  notice is the exact wait text; both are pinned. Actions are pinned per
  phase, and a refusal's `next` mentions restart exactly when restart is
  offered.

## Open for Sol and the user

- **Sol:**
  - What host semantics should `awaiting-review` and a production `ended`
    carry?
  - Is a stop reason needed? The cases are a human request versus a deadline
    versus the agent exiting.
  - What does a human end mid-capture look like, and what about a supervisor
    crash with an unknown outcome?
  - Restart after reshape: today `restarting` always means a fresh fill from
    the approved skeleton.
  - Should a journal-full refusal (R4) exist?
- **The user:** the publication choice (managed versions or patch export)
  decides what follows `checked`.
- **Later:** a `skel status` line and the skill's strict section can consume
  this once a real supervisor report exists.
