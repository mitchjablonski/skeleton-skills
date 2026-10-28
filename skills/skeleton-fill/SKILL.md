---
name: skeleton-fill
description: Fill an approved code skeleton one fenced step at a time (the next SKEL_TODO), editing only inside that step's fence. Use when the user says /skeleton-fill, "next step", "fill step N", or "fill the rest" after a skeleton was approved with /skeleton.
---

# Fill the skeleton

The structure was approved. Your job is to write behavior **inside the fences only**. A PreToolUse hook checks every Edit and Write. An edit outside the active step's fence goes back to the human (or is refused, depending on the gate setting).

CLI: `{{SKEL}}` (written below as `skel`).

Arguments:
- none → fill the next pending step, then stop.
- a step id (e.g. `3`) → fill that step, then stop.
- `all` → fill steps in order without stopping between them. Still stop for any skeleton change, and for anything you'd normally ask about.

## For each step

1. **Start it.** Run `skel next` (or `skel start <id>`). It prints the fence bodies you're allowed to change.
2. **State your opinion first, in 2–4 lines:** how you'll do it and the one non-obvious choice in it (e.g. "Keep this pure and do the dedupe in one pass. Mutating the input would be faster, but the signature promises a new array."). In step-by-step mode this is the human's moment to redirect, so keep it short and concrete.
3. **Write it.** Use Edit with `old_string` taken from *inside* the fence: the `SKEL_TODO` stub line(s), never the marker lines. Replace the stub with the real code. The markers stay until finalize.
   - Match the surrounding code's style. Keep it small, since the human is reading every line.
   - If the step has a fenced test, make it real in the same step.
4. **Check it.** Run the relevant tests, the typechecker, or both. Fix problems inside the fence.
5. **Finish it.** Run `skel done`. It fails if any `SKEL_TODO` is left in the step's fences.
6. **Report:** one or two lines on what landed and anything surprising. In step-by-step mode, **stop here.** In `all` mode, continue to the next step.

## When the skeleton is wrong

You'll sometimes find that a step needs something the skeleton doesn't have: a new helper, a changed signature, another file, a parameter. **Don't work around the fence.** Stop and propose the change: what, where, and why, in a few lines. If the human agrees:

```
skel reshape     # back to skeleton review
```

Make the structural edit (new code gets its own fence and id), refresh the review (the served page reloads by itself), and get approval again before `skel approve` and `skel next`.

If the hook refuses an edit, don't retry it in another form or with a shell command. The refusal means "this is a skeleton change."

## When every step is filled

`skel next` reports that all steps are filled. Run the full test suite, then ask the human whether to finalize. On a yes:

```
skel finalize    # strips the SKEL marker lines
```
