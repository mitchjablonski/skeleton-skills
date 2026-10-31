# skeleton-skills: threat model and design review

Status: **proposal for the maintainer to decide on** (issue #7). Reviewed at `1929b8a` (PR #1 head).
Claude Code behaviour cited below was checked against the docs on 2026-10-30; links are inline. Line numbers refer to that commit.

Every review so far asked "how do I break this?" and then patched what broke. This document starts from the other end: what the tool promises, who it promises it against, and which mechanisms actually hold. The short version:

- The **result-based Edit gate** (`lib/gate.mjs:211-338`) is the strongest part of the design and should stay.
- The design has **no detection layer**. A change that gets around the hook (any Bash write) is never noticed, by `skel done`, `skel finalize` or anything else.
- The regex layers (`lib/phase.mjs:7-26`) and the `.skeleton/` special cases spread across the hook, gate and feedback code are an arms race the tool can't win. Most of them exist only because the trust anchor sits **inside the project**, where both the agent and a cloned repo can write it.
- Against a **prompt-injected agent**, nothing in the current design is a boundary. Only Claude Code's sandbox can provide one, and the design should say so plainly and offer it as an opt-in tier rather than imitate it with regexes.

---

## 1. Goals and non-goals

**Goals**

1. **G1: Structure is approved once.** The human approves the skeleton's shape: which files exist, the signatures, the wiring, and where behaviour goes. After that, fills can't change the shape without the human's say-so.
2. **G2: Approval is the human's.** Phase changes (approve, reshape, replace, finalize) happen only when the human decides.
3. **G3: Pairing feel.** Fills are fast and don't prompt when they stay in scope. Step-by-step mode stays conversational.
4. **G4: Fast on WSL `/mnt/c`**, where each file syscall costs about 5 ms. The hook runs on every Edit and Bash call (measured at 92–125 ms in the PR #1 re-review).
5. **G5: Zero runtime dependencies.** Node ≥ 20 and git only.
6. **G6: Honest claims.** The README states what is prevented, what is detected and what is not covered.

**Non-goals**

- **N1: Semantic containment of a fill.** A fill body can import modules, mutate globals, open sockets or `eval`. The fence gives *locality*, not *capability* (see §4.5). Tests and the human's reading of each fill cover behaviour.
- **N2: Protection against same-user malware.** Anything running as the user outside Claude Code can do anything the tool can.
- **N3: Protection when the human opts out.** In `bypassPermissions`, the docs say "Only use this mode in isolated environments" ([permissions](https://code.claude.com/docs/en/permissions)), so the tool doesn't try to hold.
- **N4: Replacing Claude Code's workspace trust** for repos that ship their own `.claude/` settings, skills or hooks.

---

## 2. Assets

| # | Asset | Why it matters |
|---|---|---|
| A1 | **The approved structure:** text outside fence bodies in skeleton files, the fence set (ids, titles, order), and the set of files | This is G1 |
| A2 | **The approval decision:** the transitions into and out of `fill` (`approve`, `reshape`, `init --force`, `finalize`) | Whoever controls these controls whether A1 is enforced at all |
| A3 | **Trust anchors:** `.skeleton/state.json` (phase, gate, activeStep, tracked files), the feedback queue and history, `serve.json`, `~/.config/skel/<hash>.json` (serve sessions), the hook entry in `.claude/settings.local.json` | Tampering with any of them disables A1 or A2 |
| A4 | **Integrity of the human's feedback:** what the agent is told "the reviewer said" | The agent treats it with elevated trust, so forged feedback is an injection channel |
| A5 | **Confidentiality of the source** served on `127.0.0.1` | Other local users can read it, and on WSL2 so can Windows-side processes |
| A6 | **The user's machine** | Out of scope beyond "don't make it worse" (no new remote surface, no code execution from repo content) |

---

## 3. Adversaries and trust boundaries

### 3.1 Adversaries

| # | Adversary | Capability | Realistic behaviour |
|---|---|---|---|
| T1 | **Drifting cooperative agent** | Every tool the session has | Means well. Widens scope "to make it work": tweaks a signature, adds a helper outside the fence. When an Edit is refused, it **retries the change another way, often `sed -i` or a `python -c` one-liner**. The skill forbids that (`skills/skeleton-fill/SKILL.md:41`), but agents still do it. |
| T2 | **Prompt-injected agent** (via repo content, fence titles, review feedback, fetched pages, tool output) | Same tools as T1, actively evasive | Will spell commands to dodge regexes, write state files directly, skip `skel done`, and forge feedback or approval if it can |
| T3 | **Malicious cloned repo** | Controls file contents, including committed `.skeleton/`, symlinks, diagrams, fence titles and huge files | Plants state or feedback to pre-approve or unfence; serves XSS through diagrams; injects instructions through text the agent reads |
| T4 | **Malicious web page** in the user's browser | Can make cross-origin requests to `127.0.0.1:*` and attempt DNS rebinding | Forge feedback; read the source |
| T5 | **Other local processes** | (a) Same user: anything. (b) Other users, or Windows processes on WSL2: can connect to loopback ports | Read the served source; scrape the token and post feedback |

T2 is the adversary that matters most and is hardest. Without an OS-level boundary, T2 has the same power as T1 plus the intent to use it.

### 3.2 Trust boundaries (as built)

```
 human ──(terminal prompt / chat)──► Claude Code harness ──► hooks (unsandboxed; run as the user)
   │                                    │  permission rules, modes, sandbox (opt-in)
   │                                    ▼
   │                               model + tools ── Edit/Write ──► PreToolUse gate  ─► project files
   │                                    └────────── Bash ────────► (word-match only) ─► anything the user can write
   ▼
 browser ──HTTP──► skel serve (started BY THE AGENT via Bash) ──► .skeleton/feedback/*.json ──► agent reads
```

The current design treats four things as trustworthy. Each has a weak link:

1. **The permission prompt is treated as the human's channel** (`README.md:82`). This is true in most modes, with caveats in §4.2.
2. **The PreToolUse hook's view of tool calls is treated as complete.** It is complete for Edit/Write/MultiEdit/NotebookEdit. For Bash, the hook sees only the command text (`lib/hook.mjs:19-26`).
3. **Project-local state is treated as the human's.** It isn't. The agent's Bash and Edit can write `.skeleton/`, and a repo can ship it. PR #1 added layer after layer to compensate (§4.4).
4. **`skel serve` is treated as the human's endpoint.** But the agent starts it, and any local process can read its token.

---

## 4. The current design, threat by threat

Legend: **Stops** = prevents. **Detects** = notices after the fact. **Misses** = neither.

### 4.1 Fence integrity (A1)

| Path | T1 drift | T2 injected | Notes |
|---|---|---|---|
| Edit/MultiEdit/Write inside a fill step | **Stops** | **Stops** | Checks the result: markers identical (`lib/gate.mjs:324`), exterior identical (`:327`), MultiEdit applied in order (`:295-315`), CRLF normalised, an unlocatable `old_string` asks. This is sound and well tested. |
| Edit between steps, on a non-skeleton file | **Misses** (by design) | Misses | `lib/gate.mjs:253` returns no opinion for any existing file without `SKEL[` that isn't tracked. During an active step, the same edit asks (`:286`). This is inconsistent: "finish the step, then edit freely" is a loophole. The skill says not to change existing behaviour outside a fence (`skills/skeleton/SKILL.md:52`). |
| Edit in `scaffold` phase | n/a (by design) | n/a | Everything is free until approval (`:240`). That is correct, but see §4.2 (TOCTOU). |
| A body that closes its enclosing block and opens a new function, keeping the exterior lines intact | **Asks** (heuristic) | Asks, with bypasses (PR #1 nit N1: a crafted regex literal hides a `}`) | `bodyEscapesFence` (`lib/gate.mjs:115-174`) is the *only* thing that catches this. The exterior check can't, because no exterior line changes. |
| A body that adds capability (`require`, `globalThis.fetch = …`, `eval`) | **Misses** | **Misses** | Verified: such an edit returns `null` (allowed silently). The fence gives locality, not capability (N1). |
| **Bash: `sed -i`, `python -c`, `git apply`, `cat >`, `git checkout -- file`** | **Misses, and nothing detects it** | **Misses** | The README admits this (`README.md:80,91`). Worse, there is no detection anywhere: `skel done` checks only that `SKEL_TODO` is gone (`bin/skel.mjs:353-368`), and `finalize` checks the same (`:378-393`). An out-of-fence change made through Bash is permanent and silent. |
| NotebookEdit during a fill | Stops (asks) | Stops (asks) | `lib/gate.mjs:269` |

### 4.2 Approval (A2)

`skel approve`, `reshape`, `init --force`, `finalize` and `git clean -x` trigger a hook `ask` (`lib/gate.mjs:358-369`, `lib/phase.mjs:7-17`).

| Path | T1 | T2 | Notes |
|---|---|---|---|
| Normal spelling, from any cwd | **Stops** (prompts) | Stops | |
| Re-spelled: `node bin/skel.mjs $(echo YXBwcm92ZQ== \| base64 -d)`, or `bash go.sh` where `go.sh` was written during scaffold | Unlikely | **Misses** | Verified against `isPhaseChange`: returns `null` for both |
| Write the state file directly: `node -e "fs.writeFileSync('.sk'+'eleton/state.json', …)"`, `cat .skel*/state.json` | Unlikely | **Misses** | Verified against `mentionsState`: `false` for both |
| `git stash --all` (removes the ignored `.skeleton/`) | Possible | Misses | PR #1 re-review nit N2. This shows the problem with enumerating spellings. |
| **TOCTOU between review and approval** | **Misses** | Misses | **Not raised before.** `approve` records nothing about *what* was approved (`bin/skel.mjs:300-311`), and the prompt shows only the title (`lib/gate.mjs:350-356`). The agent can change the skeleton after the human said "looks good" and before `skel approve`, so the human approves an unseen version. |

**How the prompt behaves in each permission mode** (verified):

- **default, acceptEdits:** a hook `"ask"` prompts. acceptEdits also auto-approves `sed`, `mv`, `cp` and `rm` inside the working directory ([permission modes](https://code.claude.com/docs/en/permission-modes)), which makes the Bash bypass of §4.1 *prompt-free* in that mode.
- **auto:** "a PreToolUse hook's `"ask"` normally sends the tool call to the permission prompt, and the classifier doesn't decide it" ([hooks](https://code.claude.com/docs/en/hooks)). README `:82` is correct here.
- **plan:** a hook `"allow"` has no effect on non-read-only calls. An `"ask"` still prompts.
- **dontAsk:** auto-denies every call that would prompt, so approval is impossible. That fails closed, which is fine. The README doesn't mention this mode.
- **bypassPermissions:** "Skips permission prompts, except for the actions no mode auto-approves" ([permissions](https://code.claude.com/docs/en/permissions)). That list doesn't include hook `"ask"`, so the prompt is skipped. A hook `"deny"` still blocks ("A call that a PreToolUse hook blocked stays blocked").
- **`-p` / non-interactive:** a call that needs approval is denied.
- **Not in the README:** the prompt is *not* only answerable by the human. In modes that ask, "a `PermissionRequest` hook can answer the prompt". `--permission-prompt-tool` and an Agent SDK `canUseTool` callback can too. Without managed settings, an installed **mod** handling `tool.check` "can approve a call that … a PreToolUse hook would prompt for" ([permissions: precedence](https://code.claude.com/docs/en/permissions#precedence-among-rules-hooks-and-mods)). Any of these, installed for unrelated reasons, silently turns "approval" into "auto-approval". `README.md:82` ("the one channel the agent can't answer for you") overstates the guarantee.

### 4.3 The hook itself (A3)

- **Fails open on any exception** (`lib/hook.mjs:64`). This was a deliberate choice: a broken gate must never wedge the session. Claude Code now offers `onFailure: "block"`, which covers a hook that can't start, exits non-zero, times out or emits invalid output (v2.1.295+, [hooks](https://code.claude.com/docs/en/hooks)). So fail-closed is a configuration choice, not a code change.
- **Lives in `<project>/.claude/settings.local.json`** (`bin/skel.mjs:407`). Hook edits "are normally picked up automatically by the file watcher", and project settings can set `disableAllHooks` ([hooks](https://code.claude.com/docs/en/hooks)). So an agent that edits that file switches the fence off mid-session:
  - an Edit to `.claude/` is a protected path: prompted in default/acceptEdits, sent to the classifier in auto, allowed in bypass;
  - a Bash write is blocked only under the sandbox, which protects `.claude` settings files from writes ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
  - A `ConfigChange` hook can block settings changes from taking effect, which is a cheap guard worth adding.

### 4.4 State in the project: the source of the special cases

Because `.skeleton/` is inside the project, writable by the agent and shippable by a repo, PR #1 had to add all of these:

| Mechanism | Where | Exists because |
|---|---|---|
| Any-depth, case-folded `.skeleton` edit guard | `lib/gate.mjs:228-238` | The agent or a repo could write state |
| `outermost()`: a mid-fill ancestor outranks a nested state file | `lib/hook.mjs:70-82` | A planted nested `state.json` could unfence a subtree |
| Bash `.skeleton` mention regex | `lib/phase.mjs:19-26` | Bash could write state |
| `git clean -x` guard (and the uncaught `git stash --all`) | `lib/phase.mjs:10` | The state is git-ignored, so git can delete it |
| Serve sessions kept outside the project; feedback quarantine | `lib/feedback.mjs:72-95, 126-154` | A repo could ship feedback plus `serve.json` |
| `serve.json` URL and pid distrust | `bin/skel.mjs:79-89` | A repo could ship `serve.json` |
| `findRoot` climbing on every hook call | `lib/state.mjs:18-26`, `lib/hook.mjs:33-36` | State is found by walking up from the file. Each `existsSync` costs about 5 ms per level on `/mnt/c` |

Each is a correct patch. Together they are an enumeration of the ways to reach a file the tool shouldn't trust in the first place. **Moving the trust anchor out of the project deletes most of this table** (§6, Phase 2).

### 4.5 Locality vs capability

The fence guarantees *where* code is written, not *what it can do*. A fill can `require("child_process")`, reassign a module-level binding, add a global, or do I/O in a function documented as pure. None of that changes the exterior, and the heuristic doesn't look for it. This should be stated in the README as a non-goal (N1). An AST check can narrow it (§5.6) but not close it.

### 4.6 Review server and feedback (A4, A5)

`skel serve` makes good choices: it binds `127.0.0.1`, checks the Host header (`bin/skel.mjs:217`), and requires same-origin JSON plus a per-run token (`:233-236`). It rebuilds the markdown server-side (`lib/feedback.mjs:37-56`), runs Mermaid in `strict` mode (`lib/review-client.js:216`), pins Mermaid with SRI (`lib/review.mjs:93-96`), and sends `X-Frame-Options: DENY`.

| Threat | Result |
|---|---|
| T4 web page: CSRF, DNS rebinding | **Stops** |
| T4: detect that skel is running | The port is predictable (`41000 + hash`, `bin/skel.mjs:259`). Fingerprinting only; low risk. |
| **T5 other local user / Windows process: read the source** | **Misses.** `GET /` returns every skeleton file to anyone who can connect to loopback. On WSL2, Windows-side processes can typically reach it through localhost forwarding. |
| **T5: forge "human" feedback** | **Misses.** The token is embedded in the `GET /` HTML (`lib/review.mjs:117`), so any process that can connect can scrape it and post. The record is then stored under the real session and passes verification (`lib/feedback.mjs:147-148`). |
| T3 repo-shipped diagram XSS | Stops today (Mermaid strict, patched version). The residual is a future Mermaid bug. The page has no CSP, so XSS would read the token and post forged feedback (an injection laundered as the human's). |
| T2 agent forges its own feedback | Irrelevant: the agent is the reader. Feedback is (correctly) never approval. |
| Repo text in feedback framing | The framing tells the model the notes are data (`lib/feedback.mjs:41-42`). That is advisory, not a control. |

Bottom line: the server's residual risk is **forged feedback from other local principals**, plus source disclosure. The fix is narrower than removing POST (§5.5).

### 4.7 Summary scorecard (current)

| | T1 drift | T2 injected | T3 repo | T4 web | T5 local |
|---|---|---|---|---|---|
| A1 structure | Stops Edit-tool drift; **misses Bash drift silently** | Misses | Mostly stops (shipped state handled) | n/a | n/a |
| A2 approval | Stops (prompt), with a TOCTOU gap | Misses (re-spelling) | Stops | n/a | n/a |
| A3 anchors | Stops accidental edits | Misses | Stops (PR #1 layers) | n/a | Same user: misses (N2) |
| A4 feedback | n/a | n/a | Stops shipped feedback | Stops | **Misses** (token scrape) |
| A5 source | n/a | n/a | n/a | Stops | **Misses** |

---

## 5. Alternatives

### 5.1 Snapshot verification (#2)

At approval, record per skeleton file the hash of its *exterior* (fence bodies blanked) and the fence signature. Verify on `done`, `finalize` and on the page.

- **Benefit:** turns every bypass of §4.1 from *silent* into *detected*, however the change was made. It is the single biggest improvement available and cheap on `/mnt/c` (only skeleton files are read).
- **Where I'd go further than #2:**
  1. **Verify somewhere the agent can't skip.** `done` and `finalize` are commands the agent chooses to run. Add a **`Stop` hook** that verifies at the end of every turn during a fill. Stop hooks can block with a reason, or continue with `additionalContext`; they carry `stop_hook_active` and an 8-continuation cap against loops ([hooks](https://code.claude.com/docs/en/hooks)). Optionally add a `PostToolUse` hook on Bash for immediate feedback. That costs one more node spawn (about 90 ms) per Bash call; I'd skip it.
  2. **Verify every file, not just skeleton files.** During a fill, *any* change outside fence bodies is out of scope, new files included. Record the approved file list too (`git ls-files -co --exclude-standard`), and at `done` and `finalize` compare the full tree. Keep the per-turn Stop check to skeleton files so it stays fast.
  3. **The gate should compare against the snapshot, not the current file.** Today `preservesOutside` compares to the file as it is now (`lib/gate.mjs:327`). If Bash already drifted the exterior, later Edits "preserve" the drift.
  4. **Ask mode needs a way to amend the snapshot.** When the human allows an out-of-fence edit at an `ask` prompt, the snapshot must absorb it, or every later check reports drift. The PreToolUse input carries `tool_use_id` ([hooks](https://code.claude.com/docs/en/hooks)). The PreToolUse hook records "pending exterior change X for tool_use_id Y", and a PostToolUse hook on the same id promotes it (the tool ran, so the human said yes). Alternatively, make `deny` the fill default and send all exterior changes through reshape.
- **Where I disagree with #2:** "the exact exterior check replaces [the containment heuristic]" is wrong. A body that closes its function and opens a new one (`return 1; }` / `export function evil() {`) leaves every exterior line identical. Only the containment check (or a parser) sees it. Keep the heuristic as ask-only.
- **Storing the snapshot in `~/.config/skel`** (as #2 proposes) stops a repo from shipping one and stops accidental edits. Without the sandbox it doesn't stop T2, whose Bash can write there too.

### 5.2 Restricted filler subagent (#3)

A subagent with `tools: Read, Grep, Glob, Edit, MultiEdit` fills the step. The main loop runs tests and the CLI.

- **Verified:** the `tools` allowlist narrows the subagent's tools. PreToolUse hooks fire for subagent tool calls, with `agent_id` and `agent_type` in the input. Subagents inherit the parent's permission rules. When the parent is in bypass, acceptEdits or auto, the subagent runs in that same mode and its `permissionMode` field is ignored ([sub-agents](https://code.claude.com/docs/en/sub-agents)).
- **Benefit:** this targets T1's most common escape exactly (refused Edit → `sed`). For the filler, the Edit gate becomes complete.
- **Costs:**
  - The main agent still has Bash, so T2 in the main loop is unaffected. The filler also reads repo content, which injection can reach.
  - An extra hop per step, and the filler loses conversational context: the step-by-step "opinion first" moment has to stay in the main loop.
  - Fix-the-failing-test iterations bounce between agents. This works against G3.
  - With nothing configured, a subagent starts in the background; its prompts surface in the main session.
- **Verdict:** worth shipping as an **opt-in strict fill**. Snapshot verification (5.1) catches the same drift after the fact at almost no UX cost, so 5.1 comes first.

### 5.3 Native permission rules (#4)

- **Verified:** `Edit(...)` rules "apply to all built-in tools that edit files" (so a separate `Write(...)` rule isn't needed). Path rules use gitignore syntax. **Deny beats allow**, and PreToolUse hooks don't override deny or ask rules ([permissions](https://code.claude.com/docs/en/permissions)).
- **Problems with #4 as written:**
  1. `deny Edit(.skeleton/**)` plus `allow .skeleton/diagrams/**` doesn't work, because deny wins. You'd have to enumerate state files or move diagrams.
  2. Nested `.skeleton` dirs need `**/.skeleton/**`. Case folding on `/mnt/c` is not documented for rule matching.
  3. **A sandbox `denyWrite` on `.skeleton/` would also block `skel next/done/start`**, which the agent runs through sandboxed Bash and which write `state.json`. #4 doesn't address this conflict.
  4. Bash rules are explicitly not a boundary: "a deny or ask rule covers the invocation Claude usually produces and isn't a security boundary around the program" ([permissions](https://code.claude.com/docs/en/permissions)).
  5. Rules are static per project, while the phase is dynamic.
- **What does work:** once trusted state lives outside the project (5.7), a single static `deny Edit(~/.config/skel/**)` is simple and strong for the Edit tools, and the sandbox's default write scope already keeps Bash out of it.

### 5.4 Claude Code sandbox

- **Verified:**
  - Supported on macOS, Linux and **WSL2** (not WSL1).
  - Writes are limited to the working directory, a per-user temp dir and any added dirs. Writes are denied to `.claude` settings, skills, agents, commands and hooks even inside the working dir.
  - Network goes through a proxy with an allowlist that starts empty.
  - `allowUnsandboxedCommands: false` removes the `dangerouslyDisableSandbox` retry.
  - **The sandbox does not cover Edit/Write tools or hooks.** Those "run with your full access" and follow permission rules instead ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
- **This is the only mechanism that changes the T2 story.** If trusted state lives outside the project:
  - the agent's Bash can't write it;
  - the agent's Edit can't write it without a prompt (or at all, with a deny rule);
  - hooks, which run unsandboxed, can.

  That gives a real split: **hooks and the human are the trusted computing base; the agent is not.**
- **What it doesn't do:**
  - Bash can still rewrite project source. That is detected by 5.1, not prevented.
  - The model can still request unsandboxed runs unless `allowUnsandboxedCommands` is `false`.
  - **`skel serve` launched from sandboxed Bash runs in a separate network namespace on Linux**, so the browser can't reach it. It would need `sandbox.excludedCommands`, the human starting it with `!` (which "usually run[s] outside the sandbox"), or a hook that launches it. This needs a spike.
- **Cost:** opt-in, off by default, and it needs a domain allowlist for package managers. Some tools (plain `ssh`, database drivers) can't connect through the proxy. This is a big ask to impose by default, so offer it as a tier.

### 5.5 Review-server surface (#5)

Options (a) static by default and (b) read-only both trade away the one-click Send, which is most of the pairing UX. They also leave the actual risk in place for the static page, since copy-paste feedback is equally unauthenticated. The risk (§4.6) is narrower: *other local principals can scrape the token and the source*. I recommend a **fourth option, (d): keep POST and stop handing the token to anyone who connects.**

1. `skel serve` prints `http://127.0.0.1:PORT/#t=<token>` to the terminal. The page reads `location.hash`, keeps the token in memory and `sessionStorage`, and strips it from the URL.
2. `GET /` returns a shell with no data and no token. Skeleton data is fetched from `GET /api/data`, which requires the token header. This fixes source disclosure (A5) too.
3. Add a CSP: `default-src 'none'; script-src 'self' <cdn> 'sha256-…'; connect-src 'self'; style-src 'unsafe-inline'`. XSS then can't exfiltrate, and inline-handler injection is dead.
4. Keep the Host, Origin, JSON and token checks.

Residual risk: a process that can read the user's terminal or the agent transcript can get the token. That is same-user (N2). Static `skel review` stays as the fallback.

### 5.6 AST and structural checks

- **Option:** parse the filled file and require (a) the fence body to be a sequence of statements inside the original enclosing function, and optionally (b) no new imports, top-level declarations or assignments to outer bindings.
- **Zero-dep constraint:** Node has no public JS/TS parser. Python's `ast` is there only if Python is installed. **Opportunistic** use of the project's own toolchain is possible (its `typescript` package, `python3 -c 'import ast'`).
- **Cost:** per-language adapters, and loading TypeScript costs hundreds of ms on `/mnt/c`, which is too slow for the per-edit hook (G4).
- **Verdict:** a possible later phase, run **at `done` and in the Stop hook only**, falling back to the current heuristic. It turns (a) from heuristic into exact for TS/JS/Python and gives a partial answer to §4.5. Not a priority.

### 5.7 Trusted state outside the project (new)

Split state by who may write it:

- **Trusted** (phase, approved snapshot, gate mode, the serve session and token): `${XDG_STATE_HOME:-~/.local/state}/skel/<sha256(realpath root)>/`. On WSL this is on ext4, so it's *faster* than `/mnt/c`.
- **Agent-owned** (activeStep, diagrams, the feedback queue): stays in `.skeleton/`. activeStep is only a choice among approved fences (`skel start --force` is already ungated, and should be).

The hook finds the skeleton for a file from a small index in the trusted dir, which also removes the `findRoot` climb on `/mnt/c`.

- **Removes:** most of §4.4. A repo can't ship trusted state, `git clean`/`git stash` can't delete it, and a nested `.skeleton` means nothing.
- **Without the sandbox** it stops T1 and T3, not T2. **With the sandbox** it stops T2 for A2 and A3.
- **Cost:** state is invisible in the repo, and you need `skel status` to see it. Moving or renaming the project orphans it; key it by realpath and offer `skel forget`.

### 5.8 A human-typed approval channel (new)

Approval through `/skeleton-approve`, typed by the human and handled by a **`UserPromptExpansion` hook**. Verified ([hooks](https://code.claude.com/docs/en/hooks)):

- it fires "when a user-typed command expands into a prompt";
- "a `PreToolUse` hook matching the `Skill` tool fires only when Claude calls the tool, but typing `/skillname` directly bypasses `PreToolUse`. `UserPromptExpansion` fires on that direct path."

So the event fires only for commands the human typed, never for Claude's own Skill calls. The hook (unsandboxed) writes the trusted approval, bound to the current snapshot hash, and its block reason is shown to the user.

- **Do not use `UserPromptSubmit`.** It also fires for "a background subagent reporting back" and "a message another session sends", which is agent-authored text.
- **Benefit:** approval stops depending on the permission mode, PermissionRequest hooks, mods or a word regex. That lets `isPhaseChange` go.
- **Cost:** a slash command instead of a prompt click. That is arguably *more* deliberate. It also needs a spike to confirm the event fires for plugin commands in every surface (CLI, VS Code, desktop).

### 5.9 Bind approval to content (new; fixes the TOCTOU)

Whatever the channel, approval records the snapshot hash. The review page shows the current hash. The approval prompt or command output names it and says how many files changed since the page last loaded (the server knows the last version it served).

- **Cost:** trivial.
- **Benefit:** closes §4.2's TOCTOU against T1.

### 5.10 Git-based snapshots, fill branch or worktree

- **Option:** commit the approved skeleton to `refs/skel/approved` and verify with `git diff`; or fill on a branch, one commit per step; or run fills in a separate worktree and merge after verification.
- **Benefit:** git does the diffing, and per-step commits are a nice review artefact.
- **Costs:**
  - It touches the user's index and history, which is intrusive with a dirty tree.
  - Spawning git in the hook costs about 50–100 ms on `/mnt/c`, and large-repo status runs to seconds.
  - A separate worktree only isolates anything if writes are confined to it (sandbox cwd). Subagent `isolation: worktree` exists, but it branches from the *default branch*, not HEAD ([sub-agents](https://code.claude.com/docs/en/sub-agents)), which is wrong for an uncommitted skeleton.
- **Verdict:** use plain exterior hashes for the hot path. Offer `skel done --commit` as a convenience later.

### 5.11 Signed approvals

An HMAC over the approval needs a key the agent can't read. That requires a sandbox `denyRead`, and in that setup the trusted dir is already unwritable, so signing adds nothing. **Rejected.**

### 5.12 Claude Code plan mode and checkpoints

- **Plan mode:** blocks writes, so it can't host the skeleton phase. `ExitPlanMode` is a harness-level approval, but it approves prose, not files. Not a fit.
- **Checkpoints:** "A file that only Bash commands changed isn't tracked" ([checkpointing](https://code.claude.com/docs/en/checkpointing)). They are a recovery aid, not a control. Mention `/rewind` in the docs for undoing a bad fill.

### 5.13 Ship as a Claude Code plugin (new)

A plugin bundles `skills/` and `hooks/hooks.json`, references its scripts with `${CLAUDE_PLUGIN_ROOT}`, and lives under `~/.claude/plugins` ([plugin reference](https://code.claude.com/docs/en/plugins-reference)).

- **Benefits:**
  - The hook config moves out of project `settings.local.json`, which the agent (Edit tool) could edit.
  - Install no longer writes into the user's project.
  - Updates are versioned.
- **Costs:** a different install story. Project settings can still set `disableAllHooks` (only managed settings can't be overridden), so add a `ConfigChange` hook that blocks it while a fill is active.

### 5.14 Fail closed during a fill

- **Option:** set `onFailure: "block"` on the hook.
- **Cost:** a crash wedges *every* project. A narrower version: the hook's own `catch` returns `ask` (not silence) when the trusted state says a fill is active, and stays silent otherwise.
- **Verdict:** recommended in that narrow form.

---

## 6. Recommended target design

Two tiers. Same code, different guarantees, stated plainly.

### Standard tier (default): drift guard + detection

1. **Prevent (Edit tools):** keep the result-based gate. Compare against the **approved snapshot**, not the current file. Make the between-steps rule consistent: during a fill, an Edit to *any* file outside an active fence asks, not just skeleton files.
2. **Detect (everything):** snapshot verification (5.1).
   - Per-turn **Stop hook**: skeleton files only, cheap. On drift it tells Claude to revert or propose a reshape, and tells the user.
   - Full-tree check at `done` and `finalize`.
   - Drift diff shown on the review page.
3. **Trusted state outside the project** (5.7) and an `Edit` deny rule on it (5.3).
4. **Approval bound to content** (5.9), still through the permission prompt by default. Keep the word-match ask as a convenience, but document that it is not a boundary.
5. **Hook packaged as a plugin** (5.13) with a `ConfigChange` guard. Fail closed only while a fill is active (5.14).
6. **Review server option (d)** (5.5): the token in the URL fragment, data behind the token, and a CSP.
7. **Containment heuristic kept**, ask-only.

**What the standard tier promises:** an agent that means well can't change the approved structure through Edit tools without asking. If it changes the structure any other way, you are told at the end of that turn and `done`/`finalize` refuse. A malicious agent can still do anything you can do.

### Strict tier (opt-in): `skel install --strict`, or a documented settings snippet

Everything in the standard tier, plus:

8. **Sandbox on**, with `allowUnsandboxedCommands: false` (5.4).
9. **Human-typed `/skeleton-approve` and `/skeleton-reshape`** via `UserPromptExpansion` (5.8). Approval no longer flows through Bash at all.
10. **Review server launched by the human or a hook**, outside the agent's sandbox.
11. **Optional restricted filler subagent** (5.2).

**What the strict tier promises:** a prompt-injected agent can't approve, reshape or tamper with the trust anchors. Bash changes to project source are detected at the end of the turn; they are not prevented. Fills inside fences are still arbitrary code (N1).

### Residual risks (both tiers)

- **R1:** In the standard tier, T2 has the user's full power. Detection holds only until T2 also rewrites the snapshot, which it can.
- **R2:** Even in the strict tier, Bash can modify project files. You learn about it at the end of the turn, not before it happens.
- **R3:** `bypassPermissions`, PermissionRequest hooks, `--permission-prompt-tool` and mods can answer the approval prompt in the standard tier. The strict tier's typed approval avoids this, but bypass mode still lets Edit write anything, including the trust anchors.
- **R4:** Locality, not capability (N1). A fill can do anything code can do.
- **R5:** The containment check is a heuristic, with known false negatives (PR #1 nit N1).
- **R6:** Feedback is free text the model reads. Its framing is advisory.
- **R7:** Same-user local processes can do anything (N2).

---

## 7. Migration path

Each phase ships independently and leaves the tool working.

| Phase | Change | Removes | Issue |
|---|---|---|---|
| **0: docs** | README: fix `:82` ("the one channel…") to name PermissionRequest hooks, mods and dontAsk. State N1 (locality, not capability). State the TOCTOU and that the regexes aren't boundaries. | Overclaims | #7 |
| **1: detect** | Snapshot at approve (exterior hashes, fence signature, file list). Verify in `done`/`finalize`, a Stop hook and the page. The gate compares against the snapshot. Approval bound to the hash. Between-steps rule made consistent. Ask-mode amend (Pre/Post `tool_use_id`) or `deny` default. | Nothing yet. The heuristic stays. | #2 (extended) |
| **2: move the anchor** | Trusted state to `$XDG_STATE_HOME/skel/<hash>/`, agent-owned state stays in `.skeleton/`. Hook lookup through the index. `Edit` deny rule on the trusted dir. | `.skeleton` any-depth, case-folded edit guard (`lib/gate.mjs:228-238`) shrinks to "`.skeleton/` except diagrams and the feedback queue"; `outermost()` (`lib/hook.mjs:70-82`); `mentionsState` and `STATE_MENTION` (`lib/phase.mjs:19-26`); the `git clean` guard (`lib/phase.mjs:10`) and N2's `git stash`; the `findRoot` climb on the hook path; most `serve.json` distrust. **Keep for now:** the `isPhaseChange` ask for `approve`/`reshape`/`init --force`/`finalize`, which is still the standard tier's approval trigger. | #4 (replaces its in-project deny rules) |
| **3: surfaces** | Plugin packaging plus a `ConfigChange` guard. Fail closed during a fill. Review server: fragment token, `/api/data` behind the token, CSP. | The `settings.local.json` merge code in `install` (`bin/skel.mjs:400-444`, kept as a legacy path for a release); the token in the HTML (`lib/review.mjs:117`) | #5 (option d) |
| **4: strict tier** | Sandbox settings snippet. `/skeleton-approve` and `/skeleton-reshape` via `UserPromptExpansion`. Hook-launched or human-launched `serve`. Optional filler subagent. | In the strict tier: `isPhaseChange` (`lib/phase.mjs:7-17`) and `PHASE_REASONS`. Approval no longer goes through Bash. | #3 |
| **5: optional** | Opportunistic AST containment at `done` and Stop, for TS/JS/Python. | `bodyEscapesFence` for languages with a parser available | n/a |

Spikes needed before committing to Phase 4:

1. `UserPromptExpansion` firing for plugin commands in the CLI, VS Code and desktop.
2. `skel serve` reachability under the Linux/WSL2 sandbox network namespace.
3. Stop-hook cost on a 2,000-file `/mnt/c` repo.

---

## 8. Comparison with issues #2–#5 and the PR #1 reviews

- **#2, snapshot verification:** **agree, and it should come first.**
  - *Extend:* verify in a Stop hook (the agent can skip `done`), cover the whole tree including new files, have the gate compare against the snapshot, and handle ask-mode approvals.
  - *Disagree:* the exterior check doesn't replace the containment heuristic. A body that closes its function and opens a new one leaves the exterior unchanged.
  - *Caveat:* `~/.config` storage protects against T2 only under the sandbox.
- **#3, filler subagent:** **agree, as opt-in.** It closes the filler's Bash escape but not the main loop's. Detection (#2) covers the same drift with less UX cost.
- **#4, native rules and sandbox:**
  - **Partly disagree.** Deny-beats-allow breaks the diagrams exception.
  - A sandbox `denyWrite` on `.skeleton/` would break the agent-run `skel next`/`done`.
  - Bash rules are documented as non-boundaries.
  - The right move is to take the anchor *out of the project* (5.7). Then one static rule and the sandbox's default write scope do the job.
- **#5, review server:** **neither (a) nor (b).** The actual residual risk is token and source scraping by other local principals, which option (d) fixes while keeping one-click Send. Static copy-paste feedback isn't more authentic anyway.
- **PR #1 reviews:** they verified the gate logic thoroughly. I agree it is sound for Edit tools. Their remaining nits are symptoms of the two structural issues here:
  - N1 (regex hiding) is heuristic limits;
  - N2 (`git stash --all`), N3 and N7 are state-in-project.
- **What none of them raised:**
  - there is no detection layer;
  - the review→approve TOCTOU;
  - PermissionRequest hooks, mods and `--permission-prompt-tool` can answer the approval prompt;
  - the hook config is agent-editable and hot-reloaded;
  - local token and source scraping on the server;
  - locality ≠ capability;
  - the between-steps loophole (`lib/gate.mjs:253`);
  - acceptEdits auto-approves `sed`/`mv`/`cp` inside the project;
  - `UserPromptExpansion` as a mode-independent approval channel.

---

## 9. Decisions for the maintainer

1. **The promise.** Accept that the default tier is "drift guard + detection" and that integrity against an injected agent exists only in an opt-in sandboxed tier? (Recommended: yes, and say so in the README.)
2. **Verification scope.** During a fill, is a change to *any* file outside fences a violation (whole-tree), or only changes in skeleton files? (Recommended: whole tree at `done`/`finalize`, skeleton files per turn.)
3. **Drift response.** Should the Stop hook *block* (keep Claude working until it reverts or proposes a reshape) or only *notify*? (Recommended: block once with `additionalContext`, then notify; the loop cap applies.)
4. **Ask-mode approvals.** Amend the snapshot automatically through Pre/Post `tool_use_id` pairing, or make `deny` the fill default and route exterior changes through reshape?
5. **Where trusted state lives.** `$XDG_STATE_HOME/skel` (recommended) or `~/.config/skel`? And is it acceptable that state is no longer visible in the repo?
6. **Approval channel.** Keep the permission prompt as the default, and add typed `/skeleton-approve` for the strict tier only, or for both?
7. **Hook failure.** Fail closed while a fill is active (recommended), always, or never?
8. **Packaging.** Move to a Claude Code plugin (a breaking install change)?
9. **Review server.** Option (d) (recommended), or #5's (a), (b) or (c)?
10. **Containment heuristic.** Keep it as ask-only (recommended), drop it as #2 suggests, or invest in Phase 5 AST checks?
11. **Filler subagent.** Ship it opt-in (recommended), as the default, or not at all?
