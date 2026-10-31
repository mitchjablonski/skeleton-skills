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
- The scan (and the gate) skip tool and build directories wherever they appear: `node_modules`, `.git`, `.claude`, `.skeleton`, `dist`, `build`, `out`, `coverage`, `target` and friends. Fences under a directory with one of those names are ignored, so keep skeleton code elsewhere.

## Architecture diagrams

Mermaid files in `.skeleton/diagrams/*.mmd` render above the code. Nodes with the id `step_<id>` (`step_2_1` for step `2.1`) are colored by status (pending, filled, active), and clicking one jumps to its fence. You can comment on a diagram as a whole.

## Install

```bash
git clone https://github.com/mitchjablonski/skeleton-skills
node skeleton-skills/bin/skel.mjs install /path/to/your/project
```

This copies the two skills into `<project>/.claude/skills/` and adds two things to `<project>/.claude/settings.local.json`: the scope-gate hook, and Claude Code permission **deny** rules for the tool's own state (see [Security model](#security-model)). It merges into what's there: your settings and rules are kept, a re-run changes nothing, and it refuses a symlinked or unparseable settings file rather than write through it or overwrite it.

To remove it, run `node skeleton-skills/bin/skel.mjs uninstall /path/to/your/project`. That takes out the skills, the hook and the deny rules install added, and nothing else: install records which rules it added in `~/.config/skel/` (outside the project), so a rule you already had, even an identical one, survives install and uninstall. It reports how many rules it removed, and lists any rule shaped like skel's that it left in place because this install didn't add it (yours, one from before a move, or one whose ownership record was lost). It leaves `.skeleton/` and its `.gitignore` line for you to delete.

## The loop

```
/skeleton add stroke smoothing to the canvas
   → skel init, writes stubs + diagram, `skel serve` → review URL
   → you comment / request changes / approve in the page
   → skel feedback --wait 110   (Claude picks up your feedback)
   → skel approve               (Claude Code asks you to allow it)
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
| `skel serve [--port N] [--stop]` | Live review page; feedback is sent back to Claude. Reuses a running server; uses a stable port per project, so unsent drafts survive a restart |
| `skel review` | Static `.skeleton/review.html`; copy the feedback by hand |
| `skel feedback [--wait S]` | Print and archive the human's feedback (waits up to 110s; prints `NO_FEEDBACK` otherwise) |
| `skel approve` | Enter the fill phase. When Claude runs it, the hook asks you to allow it: that prompt is your approval |
| `skel reshape` | Back to skeleton review (also asks you) |
| `skel next` / `skel start <id> [--force]` / `skel done` | Run steps. `--force` abandons an unfinished step or reopens a filled one |
| `skel finalize` | All filled: strip the markers |
| `skel hook` | The `PreToolUse` scope gate |
| `skel install [dir]` / `skel uninstall [dir]` | Add or remove the skills, hook and deny rules in a project's `.claude/` |

**Gate modes:** `ask` (default) sends an out-of-fence edit to you for a yes or no. `deny` refuses it outright, so Claude must propose a skeleton change.

## Security model

The fence is a **drift guard for a cooperative agent**: it keeps an agent that means well from quietly widening its own scope. It is not a sandbox against a hostile one, which could always write files from a shell.

### Which layer enforces what

| Layer | Set up by | Enforces | Doesn't cover |
|---|---|---|---|
| **Claude Code permission deny rules** | `skel install` | The agent's Edit, Write, MultiEdit and NotebookEdit calls can't write `.skeleton/state.json`, `serve.json`, `review.html`, `feedback/` or `feedback-history/`. Nor can Bash commands Claude Code recognises as file writes (`> file`, `tee`, `sed -i`, …). Claude Code checks deny rules itself, whatever a hook returns (a hook's `allow` can't lift them), in every permission mode including `bypassPermissions`, and offers no prompt. The settings file is a Claude Code protected path, so outside `auto` and `bypassPermissions` the agent can't quietly delete the rules either | A script or interpreter that opens files itself (`node -e …`, `python …`). Nested `.skeleton/` directories. A session started where Claude Code doesn't load the project's settings file ([below](#start-claude-code-at-the-project-root)) |
| **Bash sandbox** (optional) | You (see below) | OS-level: the same deny rules become write denials for every sandboxed shell command and its child processes, scripts included | The fence: sandboxed commands can still edit your code. The built-in file tools (the deny rules cover those). Excluded commands, and unsandboxed retries you approve |
| **`PreToolUse` hook** (`skel hook`) | `skel install` | The fence itself: an edit during a fill must leave everything outside the active fence unchanged. Asks before `approve`, `reshape`, `init --force`, `finalize` and `git clean -x`. Asks for edits to any `.skeleton/` at any depth and for Bash commands that name it (defence in depth behind the deny rules) | Arbitrary Bash that doesn't name its target, anything once a hook fault fails open, and, like the deny rules, a session that doesn't load the project's settings file |
| **Snapshot check at `done`/`finalize`** | Planned ([#2](https://github.com/mitchjablonski/skeleton-skills/issues/2)) | Would catch any drift outside the fences, however it was made (Edit, Bash, a script) | Not built yet |

The deny rules are listed path by path, not as `.skeleton/**`, so that `.skeleton/diagrams/` (which the agent writes during `/skeleton`) stays writable: Claude Code's `!` carve-outs can't reopen a directory inside one a rule blocks as a whole. They use only `Edit(...)`, because Claude Code checks every file-writing tool against `Edit` rules and never matches a `Write(path)` rule, and they avoid wildcards other than a trailing `/**`, the only kind the sandbox honours on Linux and WSL2. They name the project by its absolute real path (`Edit(//home/you/proj/.skeleton/state.json)`; on Windows `C:\proj` is written `//c/proj`, the POSIX form Claude Code matches). A single leading `/` would anchor at the session's primary working directory, not the project, so a Claude session started in a subdirectory would guard `<subdir>/.skeleton` and miss the real state. Moving or renaming the project means re-running `skel install`, and install from the same side (Windows or WSL) you run Claude Code on, since the two spell paths differently. The rules for the old path stay in the settings file until you remove them by hand: install and uninstall list them as left in place but never delete a rule they didn't add. A rule is a gitignore pattern, so install backslash-escapes `[ ] * ?` in the path (`( ) { }` match as they are, so `Program Files (x86)` is fine). A path a rule can't spell at all (a newline, or a literal backslash on Linux and macOS) gets the hook and the skills but no deny rules, and install warns.

#### Start Claude Code at the project root

The rules and the hook both live in `.claude/settings.local.json`, and Claude Code doesn't always load that file from the project. On Linux, macOS and WSL, in a git repository, it loads it from the repository root (in a worktree, the main checkout's root), whichever subdirectory you start in. It loads it from the directory you start in instead outside a git repository, on native Windows, when the repository root is your home directory, or when the root (or its `.git` or `.claude`) isn't owned by your user (see Claude Code's [settings docs](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)). So a session started in a subdirectory is covered only when the project is its git repository's root; otherwise neither the rules nor the hook load. `skel install` warns when the project isn't the root of its git repository (or isn't in one, or is a worktree, or the repository is rooted at your home directory), and on native Windows. Root ownership it doesn't check.

**Turning on the sandbox (recommended, manual).** `install` doesn't switch it on, because it changes how every shell command in the project runs (network goes through a proxy with an empty allowlist, writes are limited to the working directory and temp). To enable it, add this to `.claude/settings.local.json` (or `~/.claude/settings.json`), with the path `install` prints:

```json
{
  "sandbox": {
    "enabled": true,
    "excludedCommands": ["node \"/path/to/skeleton-skills/bin/skel.mjs\" *"]
  }
}
```

`skel` itself has to run outside the sandbox. It writes the very state the deny rules protect, plus its session store in `~/.config/skel/`. And on Linux and WSL2 a sandboxed command's `localhost` is private, so your browser couldn't reach `skel serve`. Keep the skeleton-skills checkout outside the project, so the agent can't edit the excluded script. On Linux and WSL2 the sandbox needs `bubblewrap` and `socat`. Without them Claude Code runs commands unsandboxed, unless you also set `"failIfUnavailable": true`. To stop Claude from retrying a blocked command outside the sandbox, set `"allowUnsandboxedCommands": false`. See Claude Code's [sandboxing](https://code.claude.com/docs/en/sandboxing) and [permissions](https://code.claude.com/docs/en/permissions#read-and-edit) docs.

### Details

- **Your approval is Claude Code's permission prompt.** The hook always asks before `skel approve`, `skel reshape`, `skel init --force` or `skel finalize` runs, and before `git clean -x`/`-X` (which would delete `.skeleton/`), even in `deny` mode. That prompt is the one channel the agent can't answer for you. It fires from any working directory and for the common spellings (quoted, a path in a variable, `xargs`); it's a word match, not a shell parser. Review-page verdicts and feedback files are only signals to the agent; anything on disk or on a local port can be forged from a shell, so none of it counts as approval. How the prompt behaves follows Claude Code's permission mode: you see it in the default, `acceptEdits`, `plan` and `auto` modes; a non-interactive run with no one to answer refuses the command; and `bypassPermissions` skips it.
- **Edits are judged by their result.** During a fill, an Edit, MultiEdit (applied in order) or Write is allowed only if the SKEL markers come out identical, every line outside the active fence is unchanged, and the filled body stays inside its block. Line endings are compared as LF (Claude Code's Edit matches CRLF files that way), and an edit whose `old_string` can't be located asks. The block check is a language-aware heuristic, not a parser, so a hit always asks rather than refuses.
- **Between steps,** edits to fenced or tracked files, and new files, ask. NotebookEdit asks during a fill.
- **The tool's state is off-limits.** The deny rules above refuse writes to the top-level state outright. Behind them, the hook asks for agent edits to any `.skeleton/` directory, at any depth (except the top-level `diagrams/`), matched case-insensitively. So do Bash commands that name `.skeleton/` state, from any working directory. An enclosing skeleton that is mid-fill outranks a nested state file, so one planted or shipped deeper down can't take over the fence.
- **The review server** binds to 127.0.0.1, answers only requests addressed to `127.0.0.1`/`localhost` (no DNS rebinding), and accepts feedback only same-origin, as JSON, with a per-run token. So other websites can't post to it. The markdown Claude reads is rebuilt server-side and framed as review notes, not instructions.
- **Feedback is tied to this skeleton's serve runs**, whose ids live outside the project (`~/.config/skel/`), so nothing committed to a repo can vouch for a feedback file. Leftover, committed or hand-written ones are quarantined. `init` stops the old review server and forgets its sessions; a superseded server refuses sends. `skel serve` reuses a running server only after it answers with the id it recorded, and never kills a bare pid. `install` adds `.skeleton/` to `.gitignore`.
- **Files:** tracked files must resolve inside the project; writes go through temp-file-and-rename (never through a symlink); `install` refuses symlinked or unparseable settings rather than overwrite them.
- **Mermaid** is pinned to a patched release (past CVE-2025-54881) with Subresource Integrity, and loads without blocking the page.

Not covered: arbitrary Bash editing your code outside the fence (until [#2](https://github.com/mitchjablonski/skeleton-skills/issues/2)), anything once a hook fault makes it fail open, and, without the sandbox, a script that writes `.skeleton/` state.

## Prior art

[pi-topdown-kit](https://github.com/yinloo-ola/pi-topdown-kit) does scaffold-first stepwise refinement for the pi harness: a compilable skeleton of `stub()` calls, with progress read by grep. skeleton-skills brings the idea to Claude Code and adds fences enforced by a hook, a review page with comments that go back to Claude, and diagrams that track step status.

## Development

```bash
npm test     # node --test, no dependencies
```

MIT
