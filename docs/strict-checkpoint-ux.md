# Strict checkpoint status and recovery copy (#78 / #99)

Status: **proposal, wired into nothing.** `lib/strict-checkpoint-status.mjs`
turns one checkpoint report from the outside supervisor into what the human
sees. The report schema is a proposal for the #99 supervisor, which Sol owns;
no supervisor emits it yet. Strict stays disabled.

## Who sees what

| Surface | Trust | Shows |
| --- | --- | --- |
| Launcher control window | trusted | `headline`, `detail`, `next`, `note`, and buttons for `actions` |
| Protected decision page | trusted | The same copy. The only action it ever offers is reopening itself |
| Agent's terminal | **untrusted** | `agentNotice` only, which says to wait for the human |

The agent shares its terminal and can forge anything printed there, so
nothing on it is a status the human should rely on. The agent notice never
tells the agent how to recover, restart, recapture or approve, and never
names the control window, decision page, tokens or `skel` commands. When
the agent itself is stopped, nobody reads the notice. It exists for the
fresh session the human may later start, so that session doesn't try to
"fix" a stopped checkpoint.

## Report schema (proposal, version 1)

```js
{ version: 1,
  phase: "running" | "stopping" | "verifying-stop" | "capturing" | "awaiting-review"
       | "restarting" | "checking" | "ready-to-deliver" | "refused" | "ended",
  stage: "scaffold" | "fill",
  round: "<opaque review round id>",
  refusal: null | "teardown-unproven" | "writer-survived" | "capture-refused"
         | "store-unavailable" | "drift" | "restart-unproven" | "check-unavailable",
  detail: null | { kind, path, line } }
```

- **Exact keys only**, own data properties, at every level.
- **`refusal`** is set only when `phase` is `"refused"`.
- **`detail`** is used only for these refusals:
  - **`drift`**, where it is required. `kind` is one of `member-added`,
    `member-removed`, `mode`, `exterior`, `other-fence`, `whole-file`,
    `fence-set` or `link`.
  - **`capture-refused`**, where `kind` is a `CAPTURE_*` code from
    `lib/strict-capture.mjs`.
- **`path`** is project-relative or `null`. It is shown with invisible and
  reordering characters escaped.
- **`line`** is a positive integer or `null`.
- **Anything malformed** renders as "status couldn't be read". The copy
  says to treat the session as stopped and nothing as approved, and the
  only action offered is ending the session.

The report carries no agent-written text. Fence titles, commit messages and
model output never appear in this copy.

## Phases

| Phase | Human sees | Actions | Agent notice |
| --- | --- | --- | --- |
| running | The agent is working; nothing is captured while it runs | end session | — |
| stopping | Stopping every process before anything is copied | — | wait |
| verifying-stop | Nothing is captured until no session process is running | — | wait |
| capturing | A private copy of the stopped project is captured and stored first | — | wait |
| awaiting-review | The decision page shows the **stored snapshot**, not the live project | reopen decision page, end session | wait |
| restarting | A fresh session starts from the stored approved snapshot, not the old files | — | — |
| checking | The fill is compared with the approved snapshot | — | wait |
| ready-to-deliver | The checks passed. **Delivery is an open product decision**, and nothing has been written to the checkout | reopen decision page, end session | wait |
| ended | No session process is running | — | — |

## Refusals

Every refusal behaves the same way:

- The session stays stopped. Nothing from that attempt is used.
- Nothing retries automatically, falls back to default mode or resumes the
  old session.
- No refusal reopens a review.

| Refusal | Means | Next | Restart from approved? |
| --- | --- | --- | --- |
| teardown-unproven | Some processes couldn't be confirmed stopped; nothing captured | End; the profile may not support strict | no |
| writer-survived | A process outlived the stop | End; don't trust files written since | no |
| capture-refused | Only plain, single-linked UTF-8 files with well-formed markers are captured | Fill: restart or end. Scaffold: rewrite in a new session | fill only |
| store-unavailable | The snapshot couldn't be durably stored or reread | End; don't repair launcher files by hand | no |
| drift | Something other than the selected step body changed (kind, path, line) | Restart or end | fill only |
| restart-unproven | The fresh session couldn't be confirmed separate | End | no |
| check-unavailable | The fill couldn't be checked; an unchecked fill is never used | Restart or end | fill only |

Restart from approved is offered only when a clean fresh session could
address the cause. It is never offered when the stop or the session
boundary itself is in doubt.

## Copy rules (enforced by `test/strict-checkpoint-status.test.mjs`)

- **No claims.** The copy never says the session is contained, safe or
  secure, never calls strict active, never says something was guaranteed,
  approved or delivered, and never says output was written to the
  checkout. Every status carries the note that strict remains unverified,
  and that a report is the launcher's account of its own steps, not proof
  that the boundary held.
- **Review.** It is reached only from the trusted window, and only from a
  stored snapshot.
- **Fixed actions.** Actions come from a fixed set: `reopen-decision-page`,
  `restart-from-approved`, `end-session` and `show-details`.

## Open for Sol and the user

- **Sol:** confirm or change the phase and refusal names, and say which of
  these the #99 supervisor can actually distinguish. For example, can it tell
  `writer-survived` from `teardown-unproven`?
- **The user:** the publication choice (managed versions or patch export)
  decides what `ready-to-deliver` turns into. Until then the copy says
  delivery isn't available and nothing was written to the checkout.
- **Later:** a `skel status` line and the skill's strict section can consume
  this once a real supervisor report exists. Neither does today.
