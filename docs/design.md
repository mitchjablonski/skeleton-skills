# skeleton-skills: threat model and design review

Status: **proposal for the maintainer to decide on** (issue #7). First reviewed at `1929b8a` (PR #1 head); revised after Codex's review on PR #12, against `main` at `a8413af` (PRs #1, #8, #9, #10, #11, #13, #21, #22 and #24 merged).
Claude Code behaviour cited below was checked against the docs on 2026-10-30 and re-checked on 2026-10-31 for the claims added in the revision; links are inline.

**Line numbers.** §4 describes the **PR #1 baseline**, and its citations refer to `1929b8a` unless they say "main". Citations in §5–§10 that were added or touched in the revision refer to `main` at `a8413af`. Much of §4 has changed since the baseline; **§10 (implementation status) says which recommendations shipped, which are in review and which are only planned.** Don't read a recommendation in §5–§7 as shipped unless §10 lists it as merged.

Every review so far asked "how do I break this?" and then patched what broke. This document starts from the other end: what the tool promises, who it promises it against, and which mechanisms actually hold. The short version:

- The **result-based Edit gate** (`lib/gate.mjs:211-338`) is the strongest part of the design and should stay.
- The PR #1 design had **no detection layer**. A change that got around the hook (any Bash write) was never noticed, by `skel done`, `skel finalize` or anything else. PR #10 has since added one at `done`/`finalize`/the page (§5.1, §10); a check the agent can't skip (the Stop hook) is still in review.
- The regex layers (`lib/phase.mjs:7-26`) and the `.skeleton/` special cases spread across the hook, gate and feedback code are an arms race the tool can't win. Most of them exist only because the trust anchor sits **inside the project**, where both the agent and a cloned repo can write it.
- Against a **prompt-injected agent**, nothing in the current design is a boundary. Claude Code's sandbox is a necessary part of one, but not enough on its own: the hook, the CLI's privileged commands and their configuration must also be out of the agent's reach (§5.15). The design should say so plainly and offer that as an opt-in tier rather than imitate it with regexes. The strict tier's promises are **conditional** on those prerequisites and on the spikes in §7.

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
| **Bash: `sed -i`, `python -c`, `git apply`, `cat >`, `git checkout -- file`** | **Misses, and nothing detects it** | **Misses** | The README admits this (`README.md:80,91`). Worse, there is no detection anywhere: `skel done` checks only that `SKEL_TODO` is gone (`bin/skel.mjs:353-368`), and `finalize` checks the same (`:378-393`). An out-of-fence change made through Bash is permanent and silent. *Since then:* PR #10 detects it at `done`/`finalize`/the page; PR #20 (in review) adds a per-turn Stop-hook check (§10). |
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

- **Fails open, in two separate places.** This was a deliberate choice: a broken gate must never wedge the session. Making it fail closed needs **both a code change and a configuration change**; configuration alone does not do it (corrected after Codex's review):
  1. **Inside the hook.** `runHook` wraps everything in `try { … } catch { /* no opinion */ }` (main: `lib/hook.mjs:11-12, 64-66`). An exception anywhere in the gate (a throw in `evaluate`, a failed dynamic `import("./gate.mjs")`, malformed stdin) is swallowed, and the process **exits 0 with empty stdout**. The docs define that as success with no decision: "Exit code 0 with no output means the hook has no decision to report, so the tool call continues through the normal permission flow" ([hooks: exit code output](https://code.claude.com/docs/en/hooks#exit-code-output)). Claude Code never sees a failure, so no failure policy applies. Likewise an unreadable or unparseable `state.json` makes `readState` return `null` (main: `lib/state.mjs:32-38`), and the hook treats that as "no skeleton here" (main: `lib/hook.mjs:37-39`).
  2. **Around the hook (launcher and startup).** `skel install` registers the command `node "<path>/bin/skel-hook.mjs"` (main: `bin/skel.mjs:679`). If `node` is missing, the path moved, or a top-level import in `bin/skel-hook.mjs` fails, the process can't start or exits non-zero. By default, "when a hook fails or times out, Claude Code still carries out the action". `onFailure: "block"` turns exactly these cases (can't start, exit code other than 0 or 2, timeout, invalid JSON output) into a block ([hooks: block the action when a hook fails](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)). It cannot see case 1.

  So a fail-closed design has to (a) change the internal `catch` to emit a decision (see §5.14 for which one, and when), and treat an unreadable state file found by `findRoot` as an error rather than as "no skeleton"; and (b) set an explicit launcher policy, `onFailure: "block"` or not, and accept what it costs when the hook can't start. Neither alone makes the current hook fail closed.
- **Lives in `<project>/.claude/settings.local.json`** (`bin/skel.mjs:407`; main: `:676-686`, where PR #11's `.skeleton/` deny rules now live too). Hook edits "are normally picked up automatically by the file watcher", and project settings can set `disableAllHooks` ([hooks](https://code.claude.com/docs/en/hooks)). So an agent that edits that file switches the fence off mid-session:
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

Bottom line: the server's residual risk is **forged feedback from other local principals**, plus source disclosure. The maintainer has since chosen live read-only review by default, which removes the feedback endpoint unless `--send` is given; source disclosure remains, and both are covered in §5.5.

### 4.7 Summary scorecard (PR #1 baseline)

This is the baseline at `1929b8a`. Since then, PR #10 turned "misses Bash drift silently" into "detected at `done`/`finalize`" for T1, and PR #11 added Edit deny rules on the state files; see §10 for what is verified.

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
  4. **Ask mode: an allowed out-of-fence edit goes through reshape, not automatic amendment** (revised after Codex's review). When an `ask` prompt for an out-of-fence edit is allowed, the snapshot no longer matches, and every later check reports drift. The first draft proposed pairing the PreToolUse `tool_use_id` with a PostToolUse hook and promoting the change "because the tool ran, so the human said yes". **That inference is wrong.** PostToolUse fires "after a tool call succeeds" ([hooks: hook lifecycle](https://code.claude.com/docs/en/hooks#hook-lifecycle)); it says the tool ran, not *who or what* granted permission. In §4.2's terms, bypass mode skips the prompt, a `PermissionRequest` hook can "allow or deny a permission request on behalf of the user" ([hooks: decision control](https://code.claude.com/docs/en/hooks#decision-control)), and `--permission-prompt-tool`, `canUseTool` and mods can answer it too. Automatic amendment would therefore **turn drift into approved shape** whenever any of those is present.
     - **Recommendation:** keep the shipped behaviour. An allowed out-of-fence edit lands as drift, `done`/`finalize` refuse, and the human runs `skel reshape` and re-approves the new shape. PR #10 does exactly this, and the gate's refusal says so (main: `lib/gate.mjs:270-277`). `deny` as the fill default is the stricter variant.
     - **Automatic amendment is acceptable only if** it is bound to a *separately trusted approval receipt* (one the agent and its auto-answerers can't produce, such as the human-typed channel of §5.8, whose writer is protected per §5.15) that names the *exact proposed exterior content* (a hash of the post-edit exterior), not just a tool-use id. Until such a receipt channel is demonstrated, prefer reshape and re-approval.
- **Where I disagree with #2:** "the exact exterior check replaces [the containment heuristic]" is wrong. A body that closes its function and opens a new one (`return 1; }` / `export function evil() {`) leaves every exterior line identical. Only the containment check (or a parser) sees it. Keep the heuristic as ask-only.
- **Storing the snapshot in `~/.config/skel`** (as #2 proposes) stops a repo from shipping one and stops accidental edits. Without the sandbox it doesn't stop T2, whose Bash can write there too.
- **What shipped (PR #10):** the snapshot is recorded at `skel approve` under `$XDG_CONFIG_HOME/skel` (main: `lib/snapshot.mjs:24`, `lib/feedback.mjs:90-93`) and verified by `done`, `finalize`, `status` and the page (main: `bin/skel.mjs:76-79`, `lib/snapshot.mjs:193-238`). It **fails closed**: a missing record, or one from a different approval, counts as drift (main: `lib/snapshot.mjs:195-197`). Items 1 (Stop hook) and 2 (whole tree) are not shipped; the Stop hook is in PR #20. Item 3 is not shipped: the gate still compares against the current file (main: `lib/gate.mjs:350`).

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
- **What shipped (PR #8):** the maintainer chose to ship it as the fill skill's default path rather than opt-in: `agents/skeleton-filler.md` (Read, Grep, Glob, Edit, MultiEdit; no Bash, no Write), installed by `skel install`. The cost and T2 caveats above still apply.

### 5.3 Native permission rules (#4)

- **Verified:** `Edit(...)` rules "apply to all built-in tools that edit files" (so a separate `Write(...)` rule isn't needed). Path rules use gitignore syntax. **Deny beats allow**, and PreToolUse hooks don't override deny or ask rules ([permissions](https://code.claude.com/docs/en/permissions)).
- **Problems with #4 as written:**
  1. `deny Edit(.skeleton/**)` plus `allow .skeleton/diagrams/**` doesn't work, because deny wins. You'd have to enumerate state files or move diagrams.
  2. Nested `.skeleton` dirs need `**/.skeleton/**`. Case folding on `/mnt/c` is not documented for rule matching.
  3. **A sandbox `denyWrite` on `.skeleton/` would also block `skel next/done/start`**, which the agent runs through sandboxed Bash and which write `state.json`. #4 doesn't address this conflict.
  4. Bash rules are explicitly not a boundary: "a deny or ask rule covers the invocation Claude usually produces and isn't a security boundary around the program" ([permissions](https://code.claude.com/docs/en/permissions)).
  5. Rules are static per project, while the phase is dynamic.
- **What does work:** once trusted state lives outside the project (5.7), a single static `deny Edit(~/.config/skel/**)` is simple and strong for the Edit tools, and the sandbox's default write scope already keeps Bash out of it.
- **What shipped (PR #11):** `skel install` adds `Edit(...)` deny rules for the state files path by path (`state.json`, `serve.json`, `review.html`, `feedback/**`, `feedback-history/**`), leaving `diagrams/` writable, which sidesteps problem 1. The rules name the project by its **absolute** real path, because a `/path` rule in project settings anchors at the session's working directory, not the project (main: `bin/skel.mjs:142-184`). `skel uninstall` removes only the rules this install added, tracked in an ownership record outside the project (main: `bin/skel.mjs:228-258, 714-746`). Problems 3–5 stand; the hook checks remain as defence in depth.

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

  That gives a real split: **hooks and the human are the trusted computing base; the agent is not.** This holds only if the hook's code and configuration, and every privileged command path, are themselves out of the agent's reach (§5.15).
- **What it doesn't do:**
  - Bash can still rewrite project source. That is detected by 5.1, not prevented.
  - The model can still request unsandboxed runs unless `allowUnsandboxedCommands` is `false`.
  - **`skel serve` launched from sandboxed Bash runs in a separate network namespace on Linux**, so the browser can't reach it. It would need `sandbox.excludedCommands`, the human starting it with `!` (which "usually run[s] outside the sandbox"), or a hook that launches it. This needs a spike.
- **Cost:** opt-in, off by default, and it needs a domain allowlist for package managers. Some tools (plain `ssh`, database drivers) can't connect through the proxy. This is a big ask to impose by default, so offer it as a tier.

### 5.5 Review-server surface (#5)

**Product decision (supersedes this section's first draft, which recommended keeping POST by default).** The maintainer chose:

- **`skel serve` (default): live, read-only review.** The page updates as code changes, the human comments on lines and diagrams, and feedback reaches Claude by **Copy → paste into chat**. The server has **no feedback input endpoint**: `POST /api/feedback` answers 405, and no feedback token or trusted session is created.
- **`skel serve --send` (opt-in): one-click Send**, through the existing Host/Origin/JSON/token-checked POST.
- **`skel review` (fallback): a static HTML file**, with no listener at all.

This is implemented by PR #14 (in review, not merged; §10). On `main` today, `skel serve` still accepts feedback POSTs by default.

**What each mode removes, and what it doesn't.** The benefit of read-only and static is that they **remove the input endpoint** (and, for static, the listener). They do **not** authenticate prose:

- **Pasted feedback can still be malicious.** It is free text that arrives in chat, and the model reads it with whatever trust it gives the human's messages. Nothing proves the human wrote what they pasted (R6).
- **A static file is readable** by any local user or process that filesystem permissions allow, like the source it was generated from.
- **The live read-only page still serves the source** to any process that can connect to the loopback port (A5, T5). On WSL2 that includes Windows-side processes. Read-only removes forged feedback over HTTP, not source disclosure.

**Hardening that still applies** (formerly "option (d)"; now hardening for the remaining read surface and for opted-in Send, not an alternative to the default):

1. `skel serve` prints `http://127.0.0.1:PORT/#t=<token>` to the terminal. The page reads `location.hash`, keeps the token in memory (and `sessionStorage`, for reloads), and strips it from the URL.
2. `GET /` returns a shell with no data and no token. Skeleton data comes from `GET /api/data`, which requires the token header. In **read-only** mode this is the part that matters: it closes source disclosure (A5) to processes that can connect but can't read the terminal. In **Send** mode it also stops the token being scraped from the HTML (today it is embedded at main: `lib/review.mjs:127`).
3. Add a CSP: `default-src 'none'; script-src 'self' <cdn> 'sha256-…'; connect-src 'self'; style-src 'unsafe-inline'`.
4. Keep the Host, Origin, JSON and token checks on any POST.

**What the CSP does and doesn't buy** (narrowed after Codex's review). It removes inline-handler injection and stops an injected script from sending data to *other* origins. It does **not** make script execution harmless. An allowed script that is compromised (a future bug in the pinned Mermaid, or an injection flaw in the page's own script) runs same-origin. It can read the in-memory token, read `/api/data`, and in Send mode **POST forged feedback through the permitted `connect-src 'self'` channel**. That feedback would be stored as the human's. The CSP narrows the routes; it doesn't close this one. In read-only mode the same script can't POST, but it can still alter what the human sees on the page.

**Residual risks:** a process that can read the user's terminal or the agent transcript can get the token (same-user, N2). A compromised same-origin script can act with the token (above). Pasted and sent feedback are both unauthenticated prose (R6).

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
- **Without the sandbox** it stops T1 and T3, not T2. **With the sandbox, and the executable boundary of §5.15,** it stops T2 for A2 and A3.
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
- **Costs:** a different install story. Project settings can still set `disableAllHooks` (only managed settings can't be overridden), so add a `ConfigChange` hook that blocks it while a fill is active. `ConfigChange` can block "the configuration change from taking effect (except `policy_settings`)" ([hooks: exit code 2 behavior per event](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event)).
- **Packaging helps only if the plugin's code and config are actually protected.** The plugin's scripts are ordinary files under `~/.claude/plugins` (`${CLAUDE_PLUGIN_ROOT}`, [plugin reference: environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables)), owned by the user. The docs don't describe them as protected from modification. Without the sandbox, the agent's Bash can rewrite them (and `${CLAUDE_PLUGIN_DATA}`) like any other user file; the Edit tool needs a prompt outside the working directory, which an auto-answerer can grant (§4.2). So packaging moves the hook config out of the project, but it is a **boundary only under the conditions of §5.15**.

### 5.14 Fail closed during a fill

As §4.3 explains, there are two failure paths, and each needs its own fix.

- **Internal (code change).** Today's `catch` is silent (main: `lib/hook.mjs:64-66`), so Claude Code sees success. Change it to emit a decision when a fill may be active: if the hook got far enough to find a skeleton root, or any state file it can't parse, it emits `ask` (or `deny` under `gate: deny`) with a reason saying the gate failed. With no skeleton anywhere it stays silent, so unrelated projects are unaffected. An unparseable `state.json` should count as "fill may be active", not as "no skeleton".
- **Launcher and startup (configuration).** `onFailure: "block"` makes can't-start, non-zero exit, timeout and invalid output block the call ([hooks](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)). The hook can't tell at that point whether a fill is active, so this blocks every gated call (every Edit and Bash) in that project until the hook is fixed. With today's per-project install that wedges one project. With a plugin or user-level install it wedges every project.
- **Verdict:** recommended: the internal change now; `onFailure: "block"` only in the strict tier, where wedging is the right failure, and with a documented recovery (`skel uninstall`, or `/hooks`). Note that `onFailure` "has no effect" on `Stop` hooks, so a Stop-hook drift check (PR #20) can't be made fail-closed this way; `done`/`finalize` remain the fail-closed check.

### 5.15 The trusted executable boundary (prerequisite for the strict tier; new)

Added after Codex's review. A sandbox plus trusted state outside the project is **not enough** if the agent can change *the code that enforces the rules*, or call *a command that performs a privileged transition*. The strict tier needs all of the following. Each is a prerequisite, not a nice-to-have:

1. **An agent-unwritable installed implementation.** The hook script, `lib/*.mjs`, and the CLI the hook and the privileged commands run must sit where the agent's tools can't write them: outside the sandbox's write scope for Bash, and covered by an `Edit` deny rule for the file tools. Today `skel install` runs the hook from wherever skeleton-skills was checked out (main: `bin/skel.mjs:679`). If that is inside the project, or anywhere the sandbox can write, the agent can replace the gate.
2. **Immutable hook configuration.** The settings that register the hook (and the deny rules) must be unwritable by the agent and unchangeable mid-session: the sandbox blocks Bash writes to `.claude` settings ([sandboxing](https://code.claude.com/docs/en/sandboxing)), an `Edit` deny rule covers the file tools, and a `ConfigChange` hook blocks changes from taking effect during a fill. The only configuration the agent can't override at all is managed settings: with `allowManagedHooksOnly`, "user, project, local, and plugin hooks are blocked", except plugins force-enabled in managed `enabledPlugins` ([hooks: hook locations](https://code.claude.com/docs/en/hooks#hook-locations)). Short of managed settings, the configuration is protected only by the controls above.
3. **Narrowly authorized privileged operations.** `approve`, `reshape`, `init --force` and `finalize` write trusted phase state. Run by the agent through sandboxed Bash, the CLI is sandboxed too and can't write the trusted dir; that is the point. The boundary breaks wherever an agent-reachable path runs *unsandboxed*: a command listed in `sandbox.excludedCommands` (proposed for `skel serve` in §5.4), a `dangerouslyDisableSandbox` retry (closed by `allowUnsandboxedCommands: false`), or a hook that runs something because the agent asked. Each such path must be unable to reach a privileged transition: for example, a `serve` entry point that loads no approve/reshape code and has no flag that does. Only the human-only writer below may perform the transitions.
   - **The current docs are an example of the gap.** The README's optional sandbox snippet (main: `README.md:117-125`, from PR #11) excludes the whole CLI, `"excludedCommands": ["node \"/path/to/skeleton-skills/bin/skel.mjs\" *"]`, because `skel` writes the state the deny rules protect and because `serve` must be reachable. That pattern covers `skel approve` and `skel reshape` too, so under it the agent can still perform those transitions unsandboxed, gated only by the hook's word-match `ask` (§4.2). That is fine for the standard tier, where the snippet hardens against accidental Bash writes to state. It is **not** a strict-tier configuration.
4. **Human-only approval must not share an agent-callable write path.** The `UserPromptExpansion` hook of §5.8 must write the approval itself (or call code that only it can call), not shell out to the same `skel approve` the agent can run. If both reach the same function through an agent-reachable entry point, the "human-only" channel is only as strong as the agent-reachable one.
5. **Plugin packaging counts only if 1 and 2 hold for the plugin's files** (§5.13).

**So the strict tier's promise is conditional.** It holds only when 1–4 are in place *and* the spikes in §7 succeed (`UserPromptExpansion` firing only for human-typed commands in every surface; `serve` reachable without giving the agent a privileged unsandboxed path). Until both are shown, describe the strict tier as a design target, not a guarantee.

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
5. **Hook packaged as a plugin** (5.13) with a `ConfigChange` guard. Fail closed while a fill may be active by fixing the hook's internal `catch` (5.14); `onFailure: "block"` is a strict-tier setting.
6. **Review server: live read-only by default** (5.5, the maintainer's decision; PR #14). `skel serve` has no input endpoint and feedback is copied into chat; `skel serve --send` opts in to one-click Send; `skel review` writes a static file. Hardening for the remaining read surface and for opted-in Send: the token in the URL fragment, data behind the token, and a CSP (with the residual stated in 5.5).
7. **Containment heuristic kept**, ask-only.

**What the standard tier promises:** an agent that means well can't change the approved structure through Edit tools without asking. If it changes the structure any other way, `done`/`finalize` refuse (shipped, PR #10), and you are told at the end of that turn (once the Stop hook in PR #20 lands). A malicious agent can still do anything you can do.

### Strict tier (opt-in): `skel install --strict`, or a documented settings snippet

Everything in the standard tier, plus:

8. **Sandbox on**, with `allowUnsandboxedCommands: false` (5.4).
9. **The trusted executable boundary** (5.15): the hook and CLI installed where the agent can't write them, hook configuration the agent can't change (sandbox, `Edit` deny rule, `ConfigChange` guard; managed settings where available), and no agent-reachable unsandboxed path to a privileged transition. `onFailure: "block"` on the hook.
10. **Human-typed `/skeleton-approve` and `/skeleton-reshape`** via `UserPromptExpansion` (5.8), written by a path the agent can't call (5.15 item 4). Approval no longer flows through Bash at all.
11. **Review server launched by the human or a hook**, outside the agent's sandbox, through an entry point that can't reach a privileged transition. Read-only by default, as in the standard tier.
12. **Restricted filler subagent** (5.2; shipped as the fill default in PR #8).

**What the strict tier would promise, conditionally:** *if* the prerequisites of 5.15 hold *and* the spikes in §7 succeed, a prompt-injected agent can't approve, reshape or tamper with the trust anchors. Bash changes to project source are detected at the end of the turn; they are not prevented. Fills inside fences are still arbitrary code (N1). None of this is implemented or verified yet (issue #19); until it is, it is a design target, not a guarantee.

### Residual risks (both tiers)

- **R1:** In the standard tier, T2 has the user's full power. Detection holds only until T2 also rewrites the snapshot, which it can.
- **R2:** Even in the strict tier, Bash can modify project files. You learn about it at the end of the turn, not before it happens.
- **R3:** `bypassPermissions`, PermissionRequest hooks, `--permission-prompt-tool` and mods can answer the approval prompt in the standard tier. The strict tier's typed approval avoids this, but bypass mode still lets Edit write anything, including the trust anchors.
- **R4:** Locality, not capability (N1). A fill can do anything code can do.
- **R5:** The containment check is a heuristic, with known false negatives (PR #1 nit N1).
- **R6:** Feedback is free text the model reads, whether pasted into chat (read-only and static review) or sent (`--send`). Nothing authenticates it as the human's prose. Its framing is advisory.
- **R8:** The live review page serves the source to any process that can connect to the loopback port, in read-only mode too, until the fragment-token/data hardening of 5.5 lands. In Send mode, a compromised same-origin script can read the token and POST forged feedback despite the CSP.
- **R9:** The strict tier is only as strong as the executable boundary (5.15). If the agent can write the hook's code or configuration, or reach a privileged transition through an unsandboxed path, the strict tier degrades to the standard tier.
- **R7:** Same-user local processes can do anything (N2).

---

## 7. Migration path

Each phase ships independently and leaves the tool working.

| Phase | Change | Removes | Issue |
|---|---|---|---|
| **0: docs** | README: fix `:82` ("the one channel…") to name PermissionRequest hooks, mods and dontAsk. State N1 (locality, not capability). State the TOCTOU and that the regexes aren't boundaries. | Overclaims | #7 |
| **1: detect** | Snapshot at approve (exterior hashes, fence signature, file list). Verify in `done`/`finalize`, a Stop hook and the page. The gate compares against the snapshot. Approval bound to the hash. Between-steps rule made consistent. An allowed out-of-fence edit stays drift until reshape and re-approval; no automatic amendment without a trusted receipt (5.1 item 4). | Nothing yet. The heuristic stays. | #2 (extended). Shipped: snapshot + `done`/`finalize`/page (PR #10). In review: binding + Stop hook (PR #20) |
| **2: move the anchor** | Trusted state to `$XDG_STATE_HOME/skel/<hash>/`, agent-owned state stays in `.skeleton/`. Hook lookup through the index. `Edit` deny rule on the trusted dir. | `.skeleton` any-depth, case-folded edit guard (`lib/gate.mjs:228-238`) shrinks to "`.skeleton/` except diagrams and the feedback queue"; `outermost()` (`lib/hook.mjs:70-82`); `mentionsState` and `STATE_MENTION` (`lib/phase.mjs:19-26`); the `git clean` guard (`lib/phase.mjs:10`) and N2's `git stash`; the `findRoot` climb on the hook path; most `serve.json` distrust. **Keep for now:** the `isPhaseChange` ask for `approve`/`reshape`/`init --force`/`finalize`, which is still the standard tier's approval trigger. | #4 (replaces its in-project deny rules) |
| **3: surfaces** | Plugin packaging plus a `ConfigChange` guard. Fail closed during a fill: internal `catch` emits a decision, unreadable state counts as active (5.14). Review server: live read-only default, `--send` opt-in, static fallback (PR #14); then fragment token, `/api/data` behind the token, CSP. | The `settings.local.json` merge code in `install` (main: `bin/skel.mjs:664-712`, kept as a legacy path for a release); the token in the HTML (main: `lib/review.mjs:127`) | #5 (PR #14), #17 |
| **4: strict tier** | The executable boundary (5.15): agent-unwritable install location, protected hook config, `onFailure: "block"`, no unsandboxed agent path to a privileged transition. Sandbox settings snippet. `/skeleton-approve` and `/skeleton-reshape` via `UserPromptExpansion`, with their own writer. Hook-launched or human-launched `serve`. | In the strict tier: `isPhaseChange` (main: `lib/phase.mjs:7-20`) and `PHASE_REASONS`. Approval no longer goes through Bash. | #19 |
| **5: optional** | Opportunistic AST containment at `done` and Stop, for TS/JS/Python. | `bodyEscapesFence` for languages with a parser available | n/a |

Spikes needed before committing to Phase 4 (the strict tier's claims are conditional on them):

1. `UserPromptExpansion` firing for plugin commands in the CLI, VS Code and desktop, and *only* for human-typed commands there.
2. `skel serve` reachability under the Linux/WSL2 sandbox network namespace, without an agent-reachable unsandboxed path that can reach `approve`/`reshape` (5.15 item 3).
3. Stop-hook cost on a 2,000-file `/mnt/c` repo.
4. An install layout where the hook, CLI and their settings are unwritable by the sandboxed agent and by its Edit tool, on Linux, macOS and WSL2 (5.15 items 1–2).

---

## 8. Comparison with issues #2–#5 and the PR #1 reviews

- **#2, snapshot verification:** **agree, and it should come first.**
  - *Extend:* verify in a Stop hook (the agent can skip `done`), cover the whole tree including new files, have the gate compare against the snapshot, and handle ask-mode approvals.
  - *Disagree:* the exterior check doesn't replace the containment heuristic. A body that closes its function and opens a new one leaves the exterior unchanged.
  - *Caveat:* `~/.config` storage protects against T2 only under the sandbox.
- **#3, filler subagent:** **agree; I recommended opt-in, and the maintainer shipped it as the fill default (PR #8).** It closes the filler's Bash escape but not the main loop's. Detection (#2) covers the same drift after the fact.
- **#4, native rules and sandbox:**
  - **Partly disagree.** Deny-beats-allow breaks the diagrams exception.
  - A sandbox `denyWrite` on `.skeleton/` would break the agent-run `skel next`/`done`.
  - Bash rules are documented as non-boundaries.
  - The right move is to take the anchor *out of the project* (5.7). Then one static rule and the sandbox's default write scope do the job.
- **#5, review server:** **decided by the maintainer: live read-only by default, `--send` opt-in, static fallback** (PR #14). This draft first recommended keeping POST by default (option (d)). The decision is sound on its own terms: it removes the feedback input endpoint by default. It doesn't authenticate feedback (pasted prose can still be malicious) and it doesn't stop source disclosure from the live page, so option (d)'s fragment token, data behind the token and CSP remain worthwhile as hardening for the read surface and for `--send` (5.5).
- **PR #1 reviews:** they verified the gate logic thoroughly. I agree it is sound for Edit tools. Their remaining nits are symptoms of the two structural issues here:
  - N1 (regex hiding) is heuristic limits;
  - N2 (`git stash --all`), N3 and N7 are state-in-project. (PR #9 has since patched N1, N2 and N4–N7 individually.)
- **What none of them raised** (as of the PR #1 baseline; several are now addressed, see §10):
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
4. **Ask-mode approvals.** Keep "an allowed out-of-fence edit is drift until reshape and re-approval" (shipped in PR #10; recommended), or make `deny` the fill default? Automatic snapshot amendment is **not** recommended: PostToolUse success doesn't show that a human granted permission (5.1 item 4). Revisit only with a separately trusted approval receipt bound to the exact proposed content.
5. **Where trusted state lives.** `$XDG_STATE_HOME/skel` (recommended) or `~/.config/skel`? And is it acceptable that state is no longer visible in the repo?
6. **Approval channel.** Keep the permission prompt as the default, and add typed `/skeleton-approve` for the strict tier only, or for both?
7. **Hook failure.** Fail closed while a fill may be active (recommended)? That needs the internal `catch` change regardless (configuration can't see a swallowed exception). Separately: set `onFailure: "block"` for launcher/startup failures in the strict tier only (recommended), in both tiers, or never?
8. **Packaging.** Move to a Claude Code plugin (a breaking install change)? Note that it is a boundary only where the plugin's files and config are protected (5.13, 5.15).
9. **Review server.** *Decided:* live read-only by default, `skel serve --send` opt-in, `skel review` static fallback (PR #14). Open: add the fragment token, `/api/data` behind the token and the CSP as hardening for the read surface and for `--send` (recommended)?
10. **Containment heuristic.** Keep it as ask-only (recommended), drop it as #2 suggests, or invest in Phase 5 AST checks?
11. **Filler subagent.** *Decided:* shipped as the fill default (PR #8).
12. **Strict-tier prerequisites.** Accept that the strict tier is described as a conditional design target until the executable boundary (5.15) and the spikes (§7) are shown? (Recommended: yes.)

---

## 10. Implementation status

Added after Codex's review, so that no recommendation above reads as shipped when it isn't. Status as of `main` at `a8413af` (2026-10-31). The test suite on that commit passes (88 pass, 1 skipped, under `node --test test/`).

### 10.1 Recommendations mapped to PRs

| Status | PR / issue | What it does | Design section |
|---|---|---|---|
| **Merged** | #1 | Hardening from the adversarial reviews: the result-based Edit gate, `.skeleton/` guards, serve Host/Origin/token checks, quarantine of shipped feedback. This is the §4 baseline. | §4 |
| **Merged** | #21, #22 | The scanner and the gate skip tool and build dirs, `.claude/` included, so the installed skills' example fences never become steps. | §4.1 |
| **Merged** | #9 | PR #1 re-review nits N1, N2 (`git stash --all` asks; main: `lib/phase.mjs:11-13`), N4–N7. | §4.2, §4.4 |
| **Merged** | #13 | LF line endings pinned with `.gitattributes`. | n/a |
| **Merged** | #24 | An Edit or MultiEdit on a missing file counts as creating a new file, which asks during a fill and between steps (main: `lib/gate.mjs:251-258, 296-299`). | §4.1 |
| **Merged** | #8 | Restricted `skeleton-filler` subagent (Read, Grep, Glob, Edit, MultiEdit), the fill skill's default path. | §5.2 |
| **Merged** | #10 | Snapshot of the approved skeleton, recorded outside the project at `approve` and verified at `done`, `finalize`, `status` and the page. **It fails closed**: a missing, stale or malformed record is drift. **An out-of-fence edit the human allowed at the prompt still blocks `done`/`finalize` until `skel reshape` and re-approval**; there is no automatic amendment (§5.1 item 4). Codex's >1 MB finalize report was fixed before merge (`c7eb009`). | §5.1 |
| **Merged** | #11 | Native `Edit(...)` deny rules for the `.skeleton/` state files, written with the project's **absolute** real path (Codex's subdirectory-anchoring report), and `skel uninstall`, which removes only the rules this install added. Merged on 2026-10-31, during this revision. | §5.3 |
| **In review** | #14 | Live **read-only** review by default (`skel serve`: no input endpoint, POST answers 405, Copy → paste into chat); `skel serve --send` opt-in for one-click Send; `skel review` static fallback. | §5.5 |
| **In review** | #20 | Approval bound to the reviewed skeleton version (#15) and a Stop-hook drift check (#16). | §5.1 item 1, §5.9 |
| **Planned** | #17 | Correct the README's "one channel the agent can't answer" claim; `ConfigChange` guard; fail-closed hook decision (§4.3, §5.14); plugin packaging. | §4.2, §4.3, §5.13, §5.14 |
| **Planned** | #18 | Move trusted state to `$XDG_STATE_HOME/skel/<hash>/`. | §5.7 |
| **Planned** | #19 | Strict tier: sandbox, human-typed approval via `UserPromptExpansion`, the executable boundary, and the spikes. | §5.4, §5.8, §5.15, §7 |
| **Planned** | #23 | Skipped-dir edge cases: case variants of `.claude` on case-insensitive filesystems; tracked files under skipped dirs. | §4.1 |
| **Planned** | #25 | Follow-ups from #10 and #8: serve lag for tracked files gaining fences, unrecorded bodies of tracked fenced files, a "before" snapshot for the fill skill's post-fill check. | §5.1, §5.2 |
| **Not started** | n/a | Gate compares against the snapshot (§5.1 item 3); whole-tree verification (§5.1 item 2); fragment token, `/api/data` and CSP (§5.5); AST checks (§5.6). | |

### 10.2 Accepted threat model

What the project has accepted as its scope (§1–§3), independent of what is built:

- The **default tier is a drift guard with detection** for a cooperative agent (T1), plus resistance to malicious repos (T3) and web pages (T4).
- A **prompt-injected agent (T2) is not contained** by the default tier. Containing it is the strict tier's job, and only under the prerequisites of §5.15.
- **Out of scope:** semantic containment of fills (N1), same-user malware (N2), `bypassPermissions` (N3), Claude Code's workspace trust (N4).
- **Feedback is unauthenticated prose** in every review mode (R6). Read-only and static review remove the input endpoint; they don't authenticate what is pasted.

### 10.3 Planned controls (not guarantees)

Everything in §5–§7 that §10.1 doesn't list as merged is a **planned control**: a design intention whose effect hasn't been shown. That includes, in particular:

- the Stop-hook check and approval binding (in review, PR #20);
- live read-only by default (in review, PR #14);
- the fail-closed hook (§5.14), the `ConfigChange` guard and plugin packaging (#17);
- trusted state outside the project (#18);
- the whole strict tier (#19), whose promises are conditional on §5.15 and the spikes in §7.

### 10.4 Verified guarantees

Only what tests on `main` or completed reviews have shown. Where a guarantee depends on Claude Code enforcing something, that part rests on Claude Code's documentation, not on this project's tests, and is marked *(docs)*.

1. **Edit-tool fills stay inside the fence.** During an active step, an Edit, MultiEdit or Write that changes text outside the step's fence, changes its markers or creates a file gets an `ask` (or `deny` under `gate: deny`). The check is on the resulting file, MultiEdits are applied in order, and CRLF files are compared as LF (`test/skel.test.mjs`, the security H-series tests; PR #1's reviews). *(docs)* That Claude Code then prompts depends on the permission mode and on what can answer the prompt (§4.2).
2. **Drift is detected at `done` and `finalize`, however it was made.** A `sed -i` outside the fence, a Write that appends outside it, new fenced files and deleted tracked files all block `done` and `finalize` with a `file:line` report (`test/skel.test.mjs:935-970`). A missing, stale or malformed record fails closed (`:995`, `:1320`). An Edit the human allowed at the prompt still blocks `done` (`:921`). **Not shown:** detection when the agent never runs `done`/`finalize` (that is PR #20's Stop hook), and detection against an agent that rewrites the snapshot (R1).
3. **The state files are covered by Edit deny rules after `skel install`**, written with the project's absolute path whatever directory install runs from, and removed by `skel uninstall` only if this install added them (`test/skel.test.mjs:415-560`). *(docs)* That Claude Code enforces deny rules before hooks and across all built-in edit tools is from the [permissions](https://code.claude.com/docs/en/permissions) docs; this project's tests check the rules written, not Claude Code's enforcement.
4. **The serve endpoint refuses cross-site posts, wrong Host headers and missing tokens** (`test/skel.test.mjs:291`). **Not shown:** protection of the source or the token against local processes that can connect to the port (§4.6).
5. **The filler subagent has no shell and no Write.** Its definition lists `tools: Read, Grep, Glob, Edit, MultiEdit` and disallows Bash, PowerShell, Monitor, Write, NotebookEdit and Agent (`agents/skeleton-filler.md:4-5`). *(docs)* Enforcement of the allowlist is Claude Code's ([sub-agents](https://code.claude.com/docs/en/sub-agents)).

Nothing here is a guarantee against a prompt-injected agent.
