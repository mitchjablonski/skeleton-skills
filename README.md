# skeleton-skills

**Write the plan as code. Review the plan's shape. Then fill it in one fenced step at a time.**

Two Claude Code skills and a small CLI that bring back the feeling of building with an AI pair one function at a time, with strong opinions about where code lives:

1. **`/skeleton`**: Claude writes the feature as a *skeleton*: real files, real types and signatures, real wiring, plus an architecture diagram. Every body is an empty, fenced stub. You review the skeleton in a local page, comment on lines or on the diagram, and approve.
2. **`/skeleton-fill`**: Claude fills one step at a time (or `all` of them), but **only inside the fences**. A `PreToolUse` hook checks every edit, so a signature change or new file can't slip in. It has to come back to you as a skeleton change.

![The review page: architecture diagram coloured by step status, steps sidebar, fenced code, line comments, and the feedback panel.](docs/review.png)

## Why

A prose plan says what will happen. A skeleton *is* what will happen: the file layout, the names, what calls what, what's pure and what has side effects. Most architecture mistakes from an agent happen at exactly that level, and in a skeleton they're cheap to fix because there's no logic to throw away yet. Once you've approved the shape, each fill is a 5–30 line diff inside a slot you designed, small enough to actually read.

## Markers

```ts
/** Smooth a raw stroke. Pure: no canvas access. */
export function smoothStroke(raw: Point[], tension: number): Point[] {
  // SKEL[2] drop near-duplicate points (< 0.5px apart), then interpolate()
  throw new Error("SKEL_TODO");
  // /SKEL[2]
}
```

- `SKEL[id] <title>` opens a fence and `/SKEL[id]` closes it. Each marker is on its own line, behind any comment prefix (`//`, `#`, `--`, `<!--`, …).
- A fence whose body contains `SKEL_TODO` is pending; otherwise it's filled. Progress is read from the code, so there's no status file to drift out of date.
- One id can fence several places (an implementation and its test).
- Ids sort naturally (`1`, `2`, `2.1`, `10`) and set the build order.

## Architecture diagrams

Mermaid files in `.skeleton/diagrams/*.mmd` render above the code. Nodes with the id `step_<id>` (`step_2_1` for step `2.1`) are colored by status (pending, filled, active), and clicking one jumps to its fence. You can comment on a diagram as a whole.

## Install

```bash
git clone https://github.com/mitchjablonski/skeleton-skills
node skeleton-skills/bin/skel.mjs install /path/to/your/project
```

This copies the two skills into `<project>/.claude/skills/` and adds the scope-gate hook to `<project>/.claude/settings.local.json`.

## The loop

```
/skeleton add stroke smoothing to the canvas
   → skel init, writes stubs + diagram, `skel serve` → review URL
   → you comment / request changes / approve in the page
   → skel feedback --wait 110   (Claude picks up your feedback)
   → skel approve               (checks that the Approve came from you)
/skeleton-fill            (one step, then stop)
/skeleton-fill all        (every step, still fenced)
   → skel next → edit inside the fence → tests → skel done → skel feedback
   → a structural change? Claude stops and proposes it → you reopen it → skel reshape → re-review
   → skel finalize          (strips the markers)
```

## CLI

| Command | |
|---|---|
| `skel init "<title>" [--gate ask\|deny] [--force]` | Start a skeleton (`.skeleton/state.json`); won't replace one in progress without `--force` |
| `skel track <file…>` | Include unfenced skeleton files (e.g. new types) in the review; must be inside the project |
| `skel status [--json]` | Phase, active step, each step's status, and diagram nodes that match no step |
| `skel serve [--port N] [--stop]` | Live review page; feedback is sent back to Claude. Reuses a running server |
| `skel review` | Static `.skeleton/review.html`; copy the feedback by hand |
| `skel feedback [--wait S]` | Print and archive the human's feedback (waits up to 110s; prints `NO_FEEDBACK` otherwise) |
| `skel approve [--confirm]` | Enter the fill phase. Needs the human's Approve from the review page, or `--confirm` typed in their own terminal |
| `skel reshape [--confirm]` | Back to skeleton review. Needs the human's "Reopen skeleton" from the page, or `--confirm` in their terminal |
| `skel next` / `skel start <id> [--force]` / `skel done` | Run steps. `--force` abandons an unfinished step or reopens a filled one |
| `skel finalize` | All filled: strip the markers |
| `skel hook` | The `PreToolUse` scope gate |

**Gate modes:** `ask` (default) sends an out-of-fence edit to you for a yes or no. `deny` refuses it outright, so Claude must propose a skeleton change.

## Security model

The fence is a **drift guard for a cooperative agent**, not a sandbox. What it does:

- **Edits are judged by their result.** An Edit, MultiEdit (applied in order) or Write is allowed during a fill only if the SKEL markers come out identical, every line outside the active fence is unchanged, and the filled body stays inside its block (no closing brace or dedent past the fence). The containment check is a heuristic, not a parser.
- **Between steps,** edits to fenced or tracked files ask. **NotebookEdit** asks during a fill.
- **The tool's state is the human's.** Agent edits to `.skeleton/` (except `diagrams/`), and Bash commands naming its state files, ask. `approve` and `reshape` need a verdict sent from the review page or a `--confirm` typed on the human's own terminal, which an agent's Bash tool can't answer.
- **The review server** binds to 127.0.0.1, answers only requests addressed to `127.0.0.1`/`localhost` (no DNS rebinding), and accepts feedback only same-origin, as JSON, with a per-run token embedded in the page. The markdown Claude reads is rebuilt server-side and framed as review notes, not instructions.
- **Feedback is tied to the serve run** that received it. Leftover, committed or hand-written feedback files are quarantined, not shown as the human's. `install` adds `.skeleton/` to `.gitignore`.
- **Files:** tracked files must resolve inside the project; writes go through temp-file-and-rename (never through a symlink); `install` refuses symlinked or unparseable settings rather than overwrite them.
- **Mermaid** is pinned to a patched release (past CVE-2025-54881) with Subresource Integrity, and loads without blocking the page.

What it doesn't cover: arbitrary Bash (an agent can still write files from a shell), and anything once a fault makes the hook fail open. Pair it with Claude Code's permission rules if you need hard limits.

## Prior art

[pi-topdown-kit](https://github.com/yinloo-ola/pi-topdown-kit) does scaffold-first stepwise refinement for the pi harness: a compilable skeleton of `stub()` calls, with progress read by grep. skeleton-skills brings the idea to Claude Code and adds fences enforced by a hook, a review page with comments that go back to Claude, and diagrams that track step status.

## Development

```bash
npm test     # node --test, no dependencies
```

MIT
