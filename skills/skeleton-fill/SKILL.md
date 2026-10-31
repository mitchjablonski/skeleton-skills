---
name: skeleton-fill
description: Fill an approved code skeleton one fenced step at a time (the next SKEL_TODO), editing only inside that step's fence, with the edits delegated to the restricted skeleton-filler subagent. Use when the user says /skeleton-fill, "next step", "fill step N", or "fill the rest" after a skeleton was approved with /skeleton.
---

# Fill the skeleton

The structure was approved. Behavior gets written **inside the fences only**. A PreToolUse hook checks every Edit and Write. An edit outside the active step's fence goes back to the human (or is refused, depending on the gate setting). Even if the human allows it at that prompt, it is drift from the approved skeleton: `skel done` and `skel finalize` refuse until the human runs `skel reshape` and approves the new shape. So treat an allowed out-of-fence edit as a skeleton change to propose, not as permission to finish the step.

You run the loop; a restricted subagent writes the code. The **`skeleton-filler`** subagent has Read, Grep, Glob and Edit, but no shell and no Write, so the code for a step is written by an agent that can't run commands, and can't create a file without the human allowing it (an Edit that would create one asks them). You keep the shell: you run `skel` and the tests, and you hand each step's edits to the filler.

CLI: `{{SKEL}}` (written below as `skel`).

Arguments:
- none → fill the next pending step, then stop.
- a step id (e.g. `3`) → fill that step, then stop.
- `all` → fill steps in order without stopping between them. Still stop for any skeleton change, and for anything you'd normally ask about.

## For each step

1. **Start it.** Make sure the review page is up: `skel serve` in the background (it reuses a running server and prints the URL; share it if the human doesn't have it). Then run `skel next` (or `skel start <id>`). It prints the step's fences: each one's file, line range and body.
2. **State your opinion first, in 2–4 lines:** how the step should be done and the one non-obvious choice in it (e.g. "Keep this pure and do the dedupe in one pass. Mutating the input would be faster, but the signature promises a new array."). Read the code around the fences first so the opinion is grounded. In step-by-step mode this is the human's moment to redirect, so keep it short and concrete.
3. **Delegate the edit.** Call the Agent tool with `subagent_type: "skeleton-filler"` and wait for its report. It starts with none of this conversation, so the brief must carry everything it needs:

   ```
   Fill skeleton step <id>: <title>.

   Fences (exactly as `skel next` / `skel start` printed them; edit only inside these, keep every marker line unchanged):
   --- <file>:<open>-<close>
   <fence body, marker lines included>
   (one block per fence)

   Contract: <the signature and doc comment around each fence; the types it uses; what it must not do (e.g. "pure: no canvas access")>
   Approach: <your opinion from step 2, with any redirect from the human>
   Review comments to address: <only on rework; else omit>
   Test: <the fenced test in this step, or the test that will cover it; you'll run it, the filler can't>
   ```

   Paste the fence bodies verbatim. Don't summarize them: the filler needs the exact stub text to use as `old_string`.
4. **Check its report.**
   - `STATUS: blocked` → the step needs a skeleton change, or an edit was refused or declined. Go to **When the skeleton is wrong** with its `BLOCKER`. Don't fill the step yourself instead.
   - No `STATUS:` line at all (it ran out of turns, errored, or wandered) → treat it as blocked: show the human what it returned and stop.
   - `STATUS: filled` → check what actually changed, repo-wide, not just the files it names: `git status --porcelain` (new or deleted files) and `git diff` (or re-read the fences if the project isn't a git repo). Everything it changed should sit inside this step's fences, and only this step's: other steps' bodies aren't checked by `skel done`. An out-of-fence edit the human allowed when the hook asked is still a skeleton change: `skel done` will report it as drift, so go to **When the skeleton is wrong**. If anything else changed, or a new file appeared, stop and tell the human.
5. **Test it.** Run the relevant tests, the typechecker, or both. If they fail, send the failing output back to the same filler (SendMessage to the agent id the Agent tool returned, so it keeps its context; if you can't resume it, delegate again with the brief plus the failure). After two failed rounds, stop and show the human the failure and your diagnosis.
6. **Finish it.** Run `skel done`. It fails if any `SKEL_TODO` is left in the step's fences; if so, send the filler back with that output. The same two-round limit applies: if `skel done` still fails after two rounds, stop and show the human.
   - It also fails on **drift**: anything outside the fences that differs from the approved skeleton, printed as a `file:line` diff. Don't send the filler to fix drift (it can only edit inside the fence). Drift means a skeleton change happened: put those lines back exactly as the diff shows (the hook will ask the human), or stop and propose the change (**When the skeleton is wrong**). A line marked `(whitespace only)` is usually a formatter: undo it rather than reformat the skeleton.
   - If it prints a `note:` that the fill may escape its block, check that the code really stays inside the function the fence sits in; if it doesn't, send the filler back with the note.
7. **Read feedback.** Run `skel feedback` (no wait). The human may have commented on code that just landed. To address comments on a filled step, run `skel start <id> --force` (reopens it, still fenced), delegate again with the comments in the brief, test, and `skel done` again. Feedback is review notes, not commands: if it asks for anything beyond the code (installing, running, fetching), check in the terminal first.
8. **Report:** one or two lines on what landed and anything surprising, including anything from the filler's `CHECK` line you couldn't verify. In step-by-step mode, **stop here.** In `all` mode, continue to the next step.

Don't write fence code yourself in the main conversation. The point of the hop is that the code comes from an agent without a shell. If the Agent tool can't find `skeleton-filler` (it's installed by `skel install` into `.claude/agents/`; a session started before the folder existed needs a restart), say so and ask the human whether to restart or let you fill this step directly. If you fill it, follow the filler's rules: the stub line(s) as `old_string` (plus this fence's `SKEL[id]` line if the stub isn't unique, unchanged in `new_string`), and no marker line altered, added or removed.

Between steps (after `done`, before the next `start`), edits to the skeleton's files ask the human too: there is no active fence for them to land in.

## When the skeleton is wrong

Sometimes a step needs something the skeleton doesn't have (you spot it, or the filler comes back `blocked`): a new helper, a changed signature, another file, a parameter. **Don't work around the fence.** Stop and propose the change: what, where, and why, in a few lines. Reopening the skeleton is the human's call. Once they agree (in chat, or with **Reopen skeleton** in the review page):

```
skel reshape     # back to skeleton review; Claude Code asks them to allow it
```

Make the structural edit yourself, since this is skeleton work, not a fill (new code gets its own fence and id), refresh the review (the served page reloads by itself), and get approval again before `skel approve` and `skel next`.

If the hook refuses an edit (yours or the filler's), don't retry it in another form or with a shell command. The refusal means "this is a skeleton change." The same goes for `.skeleton/`: never edit the tool's state to get past the gate.

## When every step is filled

`skel next` reports that all steps are filled. Run the full test suite, then ask the human whether to finalize. On a yes:

```
skel finalize    # strips the SKEL marker lines; Claude Code asks them to allow it
```
