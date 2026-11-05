# skeleton-skills: threat model and design review

Status: **decided** (issue #7). First reviewed at `1929b8a` (PR #1 head); revised after Codex's review on PR #12; evidence refreshed against merged `main` at `6974b8d`, including PR #35 (final implementation head `b3872ed`). PR #46 (`076b906`) is merged. PR #45 (last tested head `a842bbb`) remains unmerged while implementing the decided once-per-unchanged-drift-report policy. **The maintainer has decided every question in §9. A decision isn't an implementation: §10 says what has shipped, and the strict tier stays a conditional design target.**
Claude Code behaviour cited below was checked against the docs on 2026-10-30 and re-checked on 2026-10-31 for the claims added in the revision, and in November 2026 for the Stop, `ConfigChange`, `onFailure` and plugin claims; links are inline.

**Line numbers.** §4 describes the **PR #1 baseline**, and its citations refer to `1929b8a` unless they say "main". Citations marked "main", and those in §10, refer to `main` at `9a4541d`. Unmarked citations outside §10 can still be baseline lines. Much of §4 has changed since the baseline; **§10 (implementation status) says which recommendations shipped, which are in review and which are only planned.** Don't read a recommendation in §5–§7 as shipped unless §10 lists it as merged.

Every review so far asked "how do I break this?" and then patched what broke. This document starts from the other end: what the tool promises, who it promises it against, and which mechanisms actually hold. The short version:

- The **result-based Edit gate** (`lib/gate.mjs:211-338`) is the strongest part of the design and should stay.
- The PR #1 design had **no detection layer**. A change that got around the hook (any Bash write) was never noticed, by `skel done`, `skel finalize` or anything else. PR #10 has since added one at `done`/`finalize`/the page, and PR #20 added a Stop hook that reports drift at the end of each turn, whether or not the agent runs those commands (§5.1, §10).
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
| **Bash: `sed -i`, `python -c`, `git apply`, `cat >`, `git checkout -- file`** | **Misses, and nothing detects it** | **Misses** | The README admits this (`README.md:80,91`). Worse, there is no detection anywhere: `skel done` checks only that `SKEL_TODO` is gone (`bin/skel.mjs:353-368`), and `finalize` checks the same (`:378-393`). An out-of-fence change made through Bash is permanent and silent. *Since then:* PR #10 detects it at `done`/`finalize`/the page; PR #20 adds a per-turn Stop-hook report (§10). |
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
- **Not in the README:** the prompt is *not* only answerable by the human. In modes that ask, "a `PermissionRequest` hook can answer the prompt". `--permission-prompt-tool` and an Agent SDK `canUseTool` callback can too. Without managed settings, an installed **mod** handling `tool.check` "can approve a call that … a PreToolUse hook would prompt for" ([permissions: precedence](https://code.claude.com/docs/en/permissions#precedence-among-rules-hooks-and-mods)). Any of these, installed for unrelated reasons, silently turns "approval" into "auto-approval". `README.md:82` ("the one channel the agent can't answer for you") overstated the guarantee; PR #34 has since corrected that sentence.

### 4.3 The hook itself (A3)

- **Fails open, in two separate places.** This was a deliberate choice: a broken gate must never wedge the session. Making it fail closed needs **both a code change and a configuration change**; configuration alone does not do it (corrected after Codex's review):
  1. **Inside the hook.** `runHook` wraps everything in `try { … } catch { /* no opinion */ }` (main: `lib/hook.mjs:11-12, 73-75`). An exception anywhere in the gate (a throw in `evaluate`, a failed dynamic `import("./gate.mjs")`, malformed stdin) is swallowed, and the process **exits 0 with empty stdout**. The docs define that as success with no decision: "Exit code 0 with no output means the hook has no decision to report, so the tool call continues through the normal permission flow" ([hooks: exit code output](https://code.claude.com/docs/en/hooks#exit-code-output)). Claude Code never sees a failure, so no failure policy applies. Likewise an unreadable or unparseable `state.json` makes `readState` return `null` (main: `lib/state.mjs:33-39`), and the hook treats that as "no skeleton here" (main: `lib/hook.mjs:46-48`).
  2. **Around the hook (launcher and startup).** `skel install` registers the command `node "<path>/bin/skel-hook.mjs"` (main: `bin/skel.mjs:829`). If `node` is missing, the path moved, or a top-level import in `bin/skel-hook.mjs` fails, the process can't start or exits non-zero. By default, "when a hook fails or times out, Claude Code still carries out the action". `onFailure: "block"` turns exactly these cases (can't start, exit code other than 0 or 2, timeout, invalid JSON output) into a block ([hooks: block the action when a hook fails](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)). It cannot see case 1.

  So a fail-closed design has to (a) change the internal `catch` to emit a decision (`deny`; see §5.14 for when), and treat an unreadable state file found by `findRoot` as an error rather than as "no skeleton"; and (b) set an explicit launcher policy, `onFailure: "block"` or not, and accept what it costs when the hook can't start. Neither alone makes the current hook fail closed. PR #35 merged the internal fix (§10): known enrolled fill faults deny until repaired, with explicit phase/state repair requests still asking (§9 Q7). Startup and static-import failures before that catch remain outside its protection. Launcher `onFailure: "block"` remains a strict-tier opt-in, not a shipped default.
- **Lives in `<project>/.claude/settings.local.json`** (`bin/skel.mjs:407`; main: `:812-890`, the install command, which also writes the deny rules from PRs #11 and #30). Hook edits "are normally picked up automatically by the file watcher", and project settings can set `disableAllHooks` ([hooks](https://code.claude.com/docs/en/hooks)). So an agent that edits that file switches the fence off mid-session:
  - an Edit to `.claude/` is a protected path: prompted in default/acceptEdits, sent to the classifier in auto, allowed in bypass;
  - a Bash write is blocked only under the sandbox, which protects `.claude` settings files from writes ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
  - A `ConfigChange` hook can block settings changes from taking effect, which is a cheap guard worth adding. PR #35 shipped this reload guard with the limits and historical notices in §10.

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

Bottom line: the server's residual risk is **forged feedback from other local principals**, plus source disclosure. The maintainer has since chosen live read-only review by default, and PR #14 shipped it. That removes the feedback endpoint unless `--send` is given; source disclosure remains, and both are covered in §5.5.

### 4.7 Summary scorecard (PR #1 baseline)

This is the baseline at `1929b8a`. Since then, PR #10 turned "misses Bash drift silently" into "detected at `done`/`finalize`" for T1, PR #20 added a per-turn report, and PRs #11 and #30 added Edit deny rules on the state files and the config-dir stores; see §10 for what is verified.

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
  1. **Verify somewhere the agent can't skip.** `done` and `finalize` are commands the agent chooses to run. Add a **`Stop` hook** that verifies at the end of every turn during a fill. On a Stop hook, `decision: "block"` and `additionalContext` **both continue the turn**, so `additionalContext` is not a notify-only channel. `stop_hook_active` is the per-hook guard against loops. The 8-continuation cap isn't one, because its count "resets each time Claude calls a tool" ([hooks: Stop](https://code.claude.com/docs/en/hooks#stop)). PR #20 shipped this check as notify-only by default (`systemMessage`), with an opt-in `--block` (main: `lib/stop.mjs:21, 47-50`); §9 Q3 decides that the default becomes one corrective continuation (#38; implementation PR #45 is in review). Optionally add a `PostToolUse` hook on Bash for immediate feedback. That costs one more node spawn (about 90 ms) per Bash call; I'd skip it.
  2. **Verify the reviewable source set, not just skeleton files** (narrowed from "the whole tree"; §9 Q2, #37). At approval, baseline the explicit tracks plus discoverable non-ignored source. Detect new and deleted files in that set, and make excluded and generated paths explicit. A literal whole tree would include build output, caches and dependency trees, which means unrelated drift and large scans. The per-turn Stop check stays on the approved set so it stays fast. *As built in #37 (§10.1):* "the approved set" for Stop means the skeleton's own files (fenced and tracked), because rereading every baselined member each turn costs more than a second at 2,000 files on `/mnt/c`.
  3. **The gate should compare against the snapshot, not the current file.** Today `preservesOutside` compares to the file as it is now (`lib/gate.mjs:327`). If Bash already drifted the exterior, later Edits "preserve" the drift.
  4. **Ask mode: an allowed out-of-fence edit goes through reshape, not automatic amendment** (revised after Codex's review). When an `ask` prompt for an out-of-fence edit is allowed, the snapshot no longer matches, and every later check reports drift. The first draft proposed pairing the PreToolUse `tool_use_id` with a PostToolUse hook and promoting the change "because the tool ran, so the human said yes". **That inference is wrong.** PostToolUse fires "after a tool call succeeds" ([hooks: hook lifecycle](https://code.claude.com/docs/en/hooks#hook-lifecycle)); it says the tool ran, not *who or what* granted permission. In §4.2's terms, bypass mode skips the prompt, a `PermissionRequest` hook can "allow or deny a permission request on behalf of the user" ([hooks: decision control](https://code.claude.com/docs/en/hooks#decision-control)), and `--permission-prompt-tool`, `canUseTool` and mods can answer it too. Automatic amendment would therefore **turn drift into approved shape** whenever any of those is present.
     - **Decided (§9 Q4):** keep the shipped behaviour. An allowed out-of-fence edit lands as drift, `done`/`finalize` refuse, and the human runs `skel reshape` and re-approves the new shape. PR #10 does exactly this, and the gate's refusal says so (main: `lib/gate.mjs:288-296`). `deny` as the fill default is the stricter variant.
     - **Automatic amendment is acceptable only if** it is bound to a *separately trusted approval receipt* (one the agent and its auto-answerers can't produce; the typed channel of §5.8 could be one only behind the agent-inaccessible boundary of §5.15 item 4, because the event alone doesn't show who invoked it) that names the *exact proposed exterior content* (a hash of the post-edit exterior), not just a tool-use id. Until such a receipt channel is demonstrated, reshape and re-approval is the only path.
- **Where I disagree with #2:** "the exact exterior check replaces [the containment heuristic]" is wrong. A body that closes its function and opens a new one (`return 1; }` / `export function evil() {`) leaves every exterior line identical. Only the containment check (or a parser) sees it. Keep the heuristic as ask-only.
- **Storing the snapshot in `~/.config/skel`** (as #2 proposes) stops a repo from shipping one and stops accidental edits. Without the sandbox it doesn't stop T2, whose Bash can write there too. PR #30 has since added an `Edit` deny rule for that dir and a hook `ask` for edits into it and for Bash commands that name it. That Bash check is a word match, so a path built in a script or a variable gets past it.
- **What shipped (PR #10):** the snapshot is recorded at `skel approve` under `$XDG_CONFIG_HOME/skel` (main: `lib/snapshot.mjs:27`, `lib/feedback.mjs:103-106`) and verified by `done`, `finalize`, `status` and the page (main: `bin/skel.mjs:81-84`, `lib/snapshot.mjs:303-309`). It **fails closed**: a missing record, or one from a different approval, counts as drift (main: `lib/snapshot.mjs:306-307`). Item 1 shipped in PR #20, notify-only by default. Item 2 is not shipped (#37): the check covers recorded and fenced files, not the reviewable source set. Item 3 is not shipped: the gate still compares against the current file (main: `lib/gate.mjs:369`).

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
- **What shipped (PR #11):** `skel install` adds `Edit(...)` deny rules for the state files path by path (`state.json`, `serve.json`, `review.html`, `feedback/**`, `feedback-history/**`), leaving `diagrams/` writable, which sidesteps problem 1. The rules name the project by its **absolute** real path, because a `/path` rule in project settings anchors at the session's working directory, not the project (main: `bin/skel.mjs:162-207`). `skel uninstall` removes only the rules this install added, tracked in an ownership record outside the project (main: `bin/skel.mjs:284-301, 892-939`). Problems 3–5 stand; the hook checks remain as defence in depth.
- **What shipped (PR #30, fixes #26):** one more owned rule covers skel's config dir, `Edit(//<real config dir>/skel/**)` (main: `bin/skel.mjs:219-230`). It is resolved at install, so changing `XDG_CONFIG_HOME` needs a re-run of `skel install`, and the old rule is reported as left in place.

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

PR #14 shipped this (main: `bin/skel.mjs:561`; §10).

**What each mode removes, and what it doesn't.** The benefit of read-only and static is that they **remove the input endpoint** (and, for static, the listener). They do **not** authenticate prose:

- **Pasted feedback can still be malicious.** It is free text that arrives in chat, and the model reads it with whatever trust it gives the human's messages. Nothing proves the human wrote what they pasted (R6).
- **A static file is readable** by any local user or process that filesystem permissions allow, like the source it was generated from.
- **The live read-only page still serves the source** to any process that can connect to the loopback port (A5, T5). On WSL2 that includes Windows-side processes. Read-only removes forged feedback over HTTP, not source disclosure.

**Hardening that still applies, decided but not shipped** (formerly "option (d)"; now hardening for the remaining read surface and for opted-in Send, not an alternative to the default; §9 Q9, #39):

1. `skel serve` prints `http://127.0.0.1:PORT/#t=<token>` to the terminal. The page reads `location.hash`, keeps the token in memory (and `sessionStorage`, for reloads), and strips it from the URL.
2. `GET /` returns a shell with no data and no token. Skeleton data comes from `GET /api/data`, which requires the token header. In **read-only** mode this is the part that matters: it closes source disclosure (A5) to processes that can connect but can't read the terminal. In **Send** mode it also stops the token being scraped from the HTML (today it is embedded at main: `lib/review.mjs:151`).
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
- **Migration (§9 Q5; #18, draft PR #41).** Today the snapshot, rendered history, serve sessions and ownership records live under `$XDG_CONFIG_HOME/skel`, covered by PR #30's deny rule. Move them together, in one validated migration, with `%LOCALAPPDATA%` on native Windows. During the migration, deny rules cover both the old and the new location. Refuse a corrupt or conflicting destination instead of overwriting it. Keep pre-existing user rules, and don't infer ownership when a record is missing. PR #41 makes the move explicit, because #35's guard holds settings reloads during a fill, so a rule on disk says nothing about what a running session enforces: records leave the old location only through `skel migrate`, which a human asks for outside a fill. Until then a project keeps using the old location.

### 5.8 A typed approval channel (new)

Approval through `/skeleton-approve`, typed by the human and handled by a **`UserPromptExpansion` hook**. The docs say ([hooks](https://code.claude.com/docs/en/hooks)):

- it fires "when a user-typed command expands into a prompt";
- "a `PreToolUse` hook matching the `Skill` tool fires only when Claude calls the tool, but typing `/skillname` directly bypasses `PreToolUse`. `UserPromptExpansion` fires on that direct path."

**That doesn't make the event proof of human origin, and the CLI spike is a counterexample** ([issue #19](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6647476839)). On CLI 2.1.318 on WSL, a scripted `claude -p '/approval-spike:probe'` fired `UserPromptExpansion` with `expansion_type=slash_command`, `command_name=approval-spike:probe` and `command_source=plugin`. The hook logged the event and exited 2, which blocked the expansion before any model work.

So a script can reach the same direct-prompt path. `command_source=plugin` says where the command came from, not who invoked it. A hook writing on this event can't be called human-only on the strength of the event.

- **The actual prerequisite.** The hook (unsandboxed) may write the trusted approval, bound to the current snapshot hash, with its block reason shown to the user, only behind a separate entrypoint or origin boundary the agent can't reach. That also needs evidence that the sandbox prevents invoking an equivalent unsandboxed path (§5.15 item 4). Neither has been designed or shown. The spike doesn't report a run from inside the agent's sandboxed Bash.
- **Untested:** IDE and Desktop invocation. The CLI result doesn't show how they behave, in either direction.
- **Do not use `UserPromptSubmit`.** It also fires for "a background subagent reporting back" and "a message another session sends", which is agent-authored text.
- **Benefit, once that boundary exists:** approval stops depending on the permission mode, PermissionRequest hooks, mods or a word regex. That lets `isPhaseChange` go.
- **Cost:** a slash command instead of a prompt click, which is arguably *more* deliberate, plus building and demonstrating the boundary.

### 5.9 Bind approval to content (new; fixes the TOCTOU)

Whatever the channel, approval records the snapshot hash. The review page shows the current hash. The approval prompt or command output names it and says how many files changed since the page last loaded (the server knows the last version it served).

- **Cost:** trivial.
- **Benefit:** closes §4.2's TOCTOU against T1.
- **What shipped (PR #20, #15):** the page and the copied or sent feedback carry a skeleton version, and `skel approve [--reviewed V]` refuses, with a diff, when the skeleton isn't the version last reviewed. This checks freshness, not authority: the permission prompt is still the approval, and an agent with a shell can still pass `--reviewed`.

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

A plugin bundles `skills/`, agents and `hooks/hooks.json`, references its scripts with `${CLAUDE_PLUGIN_ROOT}`, and puts the files in its `bin/` on the Bash tool's `PATH` ([plugin reference](https://code.claude.com/docs/en/plugins-reference)). Marketplace plugins are copied to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` at install ([plugin loading](https://code.claude.com/docs/en/plugins/loading)). §9 Q8 decides to do this, as its own release (#40).

- **Benefits:**
  - The hook config and skill copies stop being written into the project's `.claude`.
  - No moved-clone path handling; `${CLAUDE_PLUGIN_ROOT}` replaces it.
  - `skel` is on `PATH` through `bin/`, and updates are versioned.
- **Plugins can't ship permission rules** (corrected; this section used to say install would no longer write into the project). "Only `agent` and `subagentStatusLine` take effect; other keys are dropped at load" ([plugin reference: settings](https://code.claude.com/docs/en/plugins-reference#settings)). So the absolute-path deny rules of PRs #11 and #30 still need a small `skel install` step that writes project settings, and the ownership record stays with it.
- **Scope decides the blast radius and where the switch lives.** Each scope records `enabledPlugins` in a settings file ([install scopes](https://code.claude.com/docs/en/plugins/install#choose-an-install-scope)):
  - *user* in `~/.claude/settings.json`: the hook runs on every edit in every project, and an `onFailure: "block"` failure would wedge them all;
  - *project* in the committed `.claude/settings.json`: it applies to everyone working in the repo;
  - *local* in `.claude/settings.local.json`: it applies to you in this repo only. The agent-editable file of §4.3 therefore still holds the switch.
- **Costs:** a breaking install change, with a migration from existing settings. Project settings can still set `disableAllHooks` (only managed settings can't be overridden).
- **Plugin disable/reload has a bounded CLI result, not a survival guarantee.** The [zero-model-cost Claude Code 2.1.318 fixture](https://github.com/mitchjablonski/skeleton-skills/issues/40#issuecomment-6660933253) used a genuine local marketplace/plugin install on ext4. Disabling it at local scope produced `ConfigChange`; the guard exited 2, while the observer control exited 0. Ordinary watcher changes left the plugin loaded in both arms, so continued loading cannot be attributed uniquely to the guard. Explicit `/reload-plugins` unloaded it in both arms despite exit 2. This establishes an explicit-reload lifecycle limitation, not an automatic-reload bypass or proof an agent can invoke that command in a human session. The fixture used simulated fill state and a fixture hook; the actual skel plugin remains unbuilt and untested. Stronger guarantees still require authority outside the removable plugin.
- **Watcher behavior is bounded platform evidence.** The [paired ext4/drvfs probe](https://github.com/mitchjablonski/skeleton-skills/issues/44#issuecomment-6660880840) observed events on ext4 and none in five-second windows on two `/mnt/c` fixtures; the old effective hook remained loaded on both filesystems. No event **and no reload** is not a guard bypass, nor a universal filesystem rule. Native Windows mutations, actual skel uninstall, longer delays and other runtimes remain untested.
- **Packaging helps only if the plugin's code and config are actually protected.** The plugin's scripts are ordinary files under `~/.claude/plugins` (`${CLAUDE_PLUGIN_ROOT}`, [plugin reference: environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables)), owned by the user. The docs don't describe them as protected from modification. Without the sandbox, the agent's Bash can rewrite them (and `${CLAUDE_PLUGIN_DATA}`) like any other user file; the Edit tool needs a prompt outside the working directory, which an auto-answerer can grant (§4.2). So packaging moves the hook config out of the project, but it is a **boundary only under the conditions of §5.15**. The same is true of `skel install`, so this is a reason not to count a plugin as a boundary, not a reason to prefer install.

### 5.14 Fail closed during a fill

As §4.3 explains, there are two failure paths, and each needs its own fix.

- **Internal (shipped in PR #35).** The historical silent catch has been replaced by diagnostics and scoped refusal when a fill may be active: a hook fault during a fill, or unreadable enrolled state, refuses the call the broken gate can't evaluate. The reason names the bad file and the repair command, and repair commands get through as `ask`. Only a real skel state counts as enrolled, so a bad file above the project doesn't deny everything. Without enrollment, faults produce diagnostics but no permission verdict, so unrelated projects are not enrolled merely because the external config store is unreadable. A real approved receipt can establish a damaged owner; an arbitrary malformed ancestor above the session boundary cannot. Normal evaluated out-of-fence edits still follow the configured gate.
- **Launcher and startup (configuration).** `onFailure: "block"` makes can't-start, non-zero exit, timeout and invalid output block the call ([hooks](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)). The hook can't tell at that point whether a fill is active, so this blocks every gated call (every Edit and Bash) in that project until the hook is fixed. With today's per-project install, or a plugin at local or project scope, that wedges one project. With a plugin at user scope it wedges every project.
- **Decided (§9 Q7): deny until repaired.** On a gate fault there is no reliable verdict for the proposed edit, and on unreadable state the configured gate may be unknown. `ask` would hand an unevaluated call to integrations that can answer automatically, while `deny` holds under `bypassPermissions` too. The accepted cost is that a harmless call is refused until the hook or state is repaired, so a human must always have a documented way out.
- **Kept in reserve:** option B, the configured gate on a fault during a readable fill, if `deny` turns out to break real use. Unreadable state would still deny, because the policy is unknown.
- **Launcher policy:** `onFailure: "block"` only in the strict tier, where wedging is the right failure, and with external-terminal recovery: repair the trusted checkout and its registration outside the blocked session, or run `skel uninstall` there and start a new session. The [`/hooks` menu](https://code.claude.com/docs/en/hooks#the-hooks-menu) is a read-only browser for inspection, not an escape hatch. During a fill the reload guard may hold a settings-file edit, so writing that file alone is not proof the running session loaded a repair. Note that `onFailure` "has no effect" on `Stop` hooks, and the shipped Stop hook itself fails open (main: `lib/stop.mjs:10`), so `done`/`finalize` remain the fail-closed check.
- **Status:** PR #35 merged the internal denial, explicit repair ask path, and historical notice handling (§10.1). Static-import and launcher failures before `runHook` remain outside this internal catch. The strict-tier `onFailure` choice is not a default-tier guarantee.

### 5.15 The trusted executable boundary (prerequisite for the strict tier; new)

Added after Codex's review. A sandbox plus trusted state outside the project is **not enough** if the agent can change *the code that enforces the rules*, or call *a command that performs a privileged transition*. The strict tier needs all of the following. Each is a prerequisite, not a nice-to-have:

1. **An agent-unwritable installed implementation.** The hook script, `lib/*.mjs`, and the CLI the hook and the privileged commands run must sit where the agent's tools can't write them: outside the sandbox's write scope for Bash, and covered by an `Edit` deny rule for the file tools. Today `skel install` runs the hook from wherever skeleton-skills was checked out (main: `bin/skel.mjs:829`). If that is inside the project, or anywhere the sandbox can write, the agent can replace the gate.
2. **Immutable hook configuration.** The settings that register the hook (and the deny rules) must be unwritable by the agent and unchangeable mid-session: the sandbox blocks Bash writes to `.claude` settings ([sandboxing](https://code.claude.com/docs/en/sandboxing)), an `Edit` deny rule covers the file tools, and a `ConfigChange` hook blocks changes from taking effect during a fill (merged PR #35 provides it; it stops reloads, not disk writes or settings loaded on restart). The only configuration the agent can't override at all is managed settings: with `allowManagedHooksOnly`, "user, project, local, and plugin hooks are blocked", except plugins force-enabled in managed `enabledPlugins` ([hooks: hook locations](https://code.claude.com/docs/en/hooks#hook-locations)). Short of managed settings, the configuration is protected only by the controls above.
3. **Narrowly authorized privileged operations.** `approve`, `reshape`, `init --force` and `finalize` write trusted phase state. Run by the agent through sandboxed Bash, the CLI is sandboxed too and can't write the trusted dir; that is the point. The boundary breaks wherever an agent-reachable path runs *unsandboxed*: a command listed in `sandbox.excludedCommands` (proposed for `skel serve` in §5.4), a `dangerouslyDisableSandbox` retry (closed by `allowUnsandboxedCommands: false`), or a hook that runs something because the agent asked. Each such path must be unable to reach a privileged transition: for example, a `serve` entry point that loads no approve/reshape code and has no flag that does. Only the protected writer of item 4 may perform the transitions.
   - **The current docs are an example of the gap.** The README's optional sandbox snippet (main: `README.md:130-135`, from PR #11) excludes the whole CLI, `"excludedCommands": ["node \"/path/to/skeleton-skills/bin/skel.mjs\" *"]`, because `skel` writes the state the deny rules protect and because `serve` must be reachable. That pattern covers `skel approve` and `skel reshape` too, so under it the agent can still perform those transitions unsandboxed, gated only by the hook's word-match `ask` (§4.2). That is fine for the standard tier, where the snippet hardens against accidental Bash writes to state. It is **not** a strict-tier configuration.
4. **Typed approval needs its own boundary; the event isn't one.** The `UserPromptExpansion` hook of §5.8 must write the approval itself (or call code that only it can call), not shell out to the same `skel approve` the agent can run. That isn't enough on its own: a scripted `claude -p` fires the same event in the CLI (§5.8), so the writer can't be called human-only because of what triggers it. The strict tier needs a separate entrypoint or origin boundary the agent can't reach, plus evidence that the sandbox prevents invoking an equivalent unsandboxed path. If the agent can reach an equivalent path, the typed channel is only as strong as that path.
5. **Plugin packaging counts only if 1 and 2 hold for the plugin's files** (§5.13).

**So the strict tier's promise is conditional.** It holds only when 1–4 are in place *and* the spikes in §7 succeed (the boundary of item 4 demonstrated, with each supported surface checked rather than assumed from the CLI result; `serve` reachable without giving the agent a privileged unsandboxed path). Until both are shown, describe the strict tier as a design target, not a guarantee.

---

## 6. Target design

Two tiers. Same code, different guarantees, stated plainly.

### Standard tier (default): drift guard + detection

1. **Prevent (Edit tools):** keep the result-based gate. Compare against the **approved snapshot**, not the current file. Make the between-steps rule consistent: during a fill, an Edit to *any* file outside an active fence asks, not just skeleton files.
2. **Detect (everything):** snapshot verification (5.1).
   - Per-turn **Stop hook**: the approved set only, cheap. Shipped in PR #20, telling the user by default; one corrective continuation is decided in §9 Q3, CLI-probed, and implemented in unmerged PR #45 (#38).
   - Check of the reviewable source set at `done` and `finalize` (§5.1 item 2, §9 Q2, #37).
   - Drift diff shown on the review page.
3. **Trusted state outside the project** (5.7) and an `Edit` deny rule on it (5.3; shipped for today's config-dir stores in PR #30).
4. **Approval bound to content** (5.9; shipped in PR #20), still through the permission prompt by default. Keep the word-match ask as a convenience, but document that it is not a boundary.
5. **A `ConfigChange` guard, and deny until repaired while a fill may be active**, by fixing the hook's internal `catch` (5.14, §9 Q7; merged PR #35). `onFailure: "block"` is a strict-tier setting. **Plugin packaging** (5.13) is a later release (§9 Q8, #40).
6. **Review server: live read-only by default** (5.5, the maintainer's decision; shipped in PR #14). `skel serve` has no input endpoint and feedback is copied into chat; `skel serve --send` opts in to one-click Send; `skel review` writes a static file. Hardening for the remaining read surface and for opted-in Send (§9 Q9, #39): the token in the URL fragment, data behind the token, and a CSP (with the residual stated in 5.5).
7. **Containment heuristic kept**, ask-only.

**What the standard tier promises:** an agent that means well can't change the approved structure through Edit tools without asking. If it changes the structure any other way, `done`/`finalize` refuse (shipped, PR #10), and the Stop hook (shipped, PR #20) reports it at the end of that turn, for changes to the files the approved record covers. A malicious agent can still do anything you can do.

### Strict tier (opt-in): `skel install --strict`, or a documented settings snippet

Everything in the standard tier, plus:

8. **Sandbox on**, with `allowUnsandboxedCommands: false` (5.4).
9. **The trusted executable boundary** (5.15): the hook and CLI installed where the agent can't write them, hook configuration the agent can't change (sandbox, `Edit` deny rule, `ConfigChange` guard; managed settings where available), and no agent-reachable unsandboxed path to a privileged transition. `onFailure: "block"` on the hook.
10. **Typed `/skeleton-approve` and `/skeleton-reshape`** via `UserPromptExpansion` (5.8), gated on the agent-inaccessible entrypoint or origin boundary and the writer of 5.15 item 4, not merely on the event firing. Approval then no longer flows through the agent's Bash, provided that boundary also shuts out a scripted `claude -p` run from there.
11. **Review server launched by the human or a hook**, outside the agent's sandbox, through an entry point that can't reach a privileged transition. Read-only by default, as in the standard tier.
12. **Restricted filler subagent** (5.2; shipped as the fill default in PR #8).

**What the strict tier would promise, conditionally:** *if* the prerequisites of 5.15 hold *and* the spikes in §7 succeed, a prompt-injected agent can't approve, reshape or tamper with the trust anchors. Bash changes to project source are detected at the end of the turn; they are not prevented. Fills inside fences are still arbitrary code (N1). The complete Claude end-to-end strict tier is neither implemented nor verified (issue #19), despite the bounded CLI and OS probes in §7; until it is, it is a design target, not a guarantee.

### Residual risks (both tiers)

- **R1:** In the standard tier, T2 has the user's full power. Detection holds only until T2 also rewrites the snapshot, which it can.
- **R2:** Even in the strict tier, Bash can modify project files. You learn about it at the end of the turn, not before it happens.
- **R3:** `bypassPermissions`, PermissionRequest hooks, `--permission-prompt-tool` and mods can answer the approval prompt in the standard tier. The strict tier's typed approval would avoid this only behind the boundary of 5.15 item 4, and bypass mode still lets Edit write anything, including the trust anchors.
- **R4:** Locality, not capability (N1). A fill can do anything code can do.
- **R5:** The containment check is a heuristic, with known false negatives (PR #1 nit N1).
- **R6:** Feedback is free text the model reads, whether pasted into chat (read-only and static review) or sent (`--send`). Nothing authenticates it as the human's prose. Its framing is advisory.
- **R8:** The live review page serves the source to any process that can connect to the loopback port, in read-only mode too, until the fragment-token/data hardening of 5.5 lands. In Send mode, a compromised same-origin script can read the token and POST forged feedback despite the CSP.
- **R9:** The strict tier is only as strong as the executable boundary (5.15). If the agent can write the hook's code or configuration, or reach a privileged transition through an unsandboxed path, the strict tier degrades to the standard tier.
- **R7:** Same-user local processes can do anything (N2).
- **R10:** Project-boundary reads (PRs #29 and #33) follow links, not inodes. A **hardlink** inside the project to an outside file looks like an ordinary project file, so it is read and served. A **folder swapped mid-scan** by a racing same-user process can still redirect a read after the containment check. Neither is covered by a test.

---

## 7. Migration path

Each phase ships independently and leaves the tool working.

| Phase | Change | Removes | Issue |
|---|---|---|---|
| **0: docs** | README: fix `:82` ("the one channel…") to name PermissionRequest hooks, mods and dontAsk. State N1 (locality, not capability). State the TOCTOU and that the regexes aren't boundaries. | Overclaims | #7. Shipped: the prompt claim (PR #34). |
| **1: detect** | Snapshot at approve (exterior hashes, fence signature, file list). Verify in `done`/`finalize`, a Stop hook and the page. The gate compares against the snapshot. Approval bound to the hash. Between-steps rule made consistent. An allowed out-of-fence edit stays drift until reshape and re-approval; no automatic amendment without a trusted receipt (5.1 item 4). | Nothing yet. The heuristic stays. | #2 (extended). Shipped: snapshot + `done`/`finalize`/page (PR #10); binding + Stop hook (PR #20). Not shipped: the gate comparing against the snapshot; the reviewable source set (#37). One corrective continuation: #38. |
| **2: move the anchor** | Trusted state to `$XDG_STATE_HOME/skel/<hash>/`, agent-owned state stays in `.skeleton/`, with the migration of 5.7. Hook lookup through the index. `Edit` deny rule on the trusted dir. | `.skeleton` any-depth, case-folded edit guard (`lib/gate.mjs:228-238`) shrinks to "`.skeleton/` except diagrams and the feedback queue"; `outermost()` (`lib/hook.mjs:70-82`); `mentionsState` and `STATE_MENTION` (`lib/phase.mjs:19-26`); the `git clean` guard (`lib/phase.mjs:10`) and N2's `git stash`; the `findRoot` climb on the hook path; most `serve.json` distrust. **Keep for now:** the `isPhaseChange` ask for `approve`/`reshape`/`init --force`/`finalize`, which is still the standard tier's approval trigger. | #18 (with #4; replaces its in-project deny rules) |
| **3: surfaces** | A `ConfigChange` guard. Deny until repaired during a fill: internal `catch` emits `deny`, unreadable enrolled state counts as active (5.14, §9 Q7; merged PR #35). Plugin packaging as its own release after #35 and #18 (§9 Q8). Review server: live read-only default, `--send` opt-in, static fallback (shipped, PR #14); then fragment token, `/api/data` behind the token, CSP. | With the plugin: the hook-merging part of `install` (main: `bin/skel.mjs:829-863`, kept as a legacy path for a release). Deny-rule writing stays, because plugins can't ship permission rules (5.13). With the hardening: the token in the HTML (main: `lib/review.mjs:151`) | #5 (PR #14), #17 (PR #35, merged), #39, #40 |
| **4: strict tier** | The executable boundary (5.15): agent-unwritable install location, protected hook config, `onFailure: "block"`, no unsandboxed agent path to a privileged transition. Sandbox settings snippet. `/skeleton-approve` and `/skeleton-reshape` via `UserPromptExpansion`, behind an agent-inaccessible entrypoint or origin boundary with their own writer (5.15 item 4). Hook-launched or human-launched `serve`. | In the strict tier: `isPhaseChange` (main: `lib/phase.mjs:7-20`) and `PHASE_REASONS`. Approval no longer goes through Bash. | #19 |
| **5: optional** | Opportunistic AST containment at `done` and Stop, for TS/JS/Python. | `bodyEscapesFence` for languages with a parser available | n/a |

Spikes needed before committing to Phase 4 (the strict tier's claims are conditional on them):

1. **`UserPromptExpansion` and origin.** *CLI: done, and the result is a counterexample.* Scripted `claude -p '/approval-spike:probe'` fires the event with `command_source=plugin` ([issue #19](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6647476839), §5.8). The event alone doesn't authenticate human origin. The requirement is therefore no longer that it fires only for human-typed commands, but a demonstrated agent-inaccessible entrypoint or origin boundary, plus evidence that the sandbox prevents invoking an equivalent unsandboxed path (5.15 item 4). *IDE and Desktop: untested;* the CLI result doesn't show how they behave.
2. `skel serve` reachability under the Linux/WSL2 sandbox network namespace, without an agent-reachable unsandboxed path that can reach `approve`/`reshape` (5.15 item 3). A [Claude Code 2.1.318 WSL probe](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6649092826) required sandboxing (`failIfUnavailable: true`, no unsandboxed retries). Official Ubuntu `socat` and its missing `libwrap0` dependency were extracted only into the disposable fixture, with package checksums checked against apt metadata; nothing was installed globally. The inside nonce request succeeded in a distinct network namespace; an outside WSL loopback request could not retrieve that nonce while the server ran, and shutdown completed. This proves direct loopback separation for that CLI/runtime, not browser forwarding or Mac/Desktop behavior. A [later OS-only boundary preflight](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6660216797) demonstrated protected implementation/config and inaccessible private receipt/writer paths under a disposable Bubblewrap policy; it was **not Claude end-to-end**, and does not validate the strict approval workflow.
3. Stop-hook cost on a 2,000-file `/mnt/c` repo. PR #20 reports a median of 158 ms on a clean fill and 178 ms on drift (WSL2, `/mnt/c`, 2,005-file repo, 5 skeleton files), and the cost doesn't grow with repo size because only the skeleton's files are read. That is a one-off measurement in the PR, not a test. A [later paired benchmark](https://github.com/mitchjablonski/skeleton-skills/issues/19#issuecomment-6649237984) compared main `970850c` with PR #45 at `27a5991`: clean/drift medians were 151.6/146.9 ms versus 182.2/194.1 ms on Windows Node 24.18, and 183.0/182.5 ms versus 177.5/177.5 ms on WSL `/mnt/c` Node 20.20. One warmup plus five samples per case included Node startup. The fixture contained 2,000 source files and 1,000 excluded files, but approval covered only four fenced files and one tracked file; this is not a #37 inventory benchmark or evidence of a statistically established revision difference.
4. An install layout where the hook, CLI and their settings are unwritable by the sandboxed agent and by its Edit tool, on Linux, macOS and WSL2 (5.15 items 1–2).

---

## 8. Comparison with issues #2–#5 and the PR #1 reviews

- **#2, snapshot verification:** **agree, and it should come first.**
  - *Extend:* verify in a Stop hook (the agent can skip `done`), cover the reviewable source set including new files, have the gate compare against the snapshot, and handle ask-mode approvals. PR #10 and PR #20 shipped the snapshot and the Stop hook; §10 lists the rest.
  - *Disagree:* the exterior check doesn't replace the containment heuristic. A body that closes its function and opens a new one leaves the exterior unchanged.
  - *Caveat:* `~/.config` storage protects against T2 only under the sandbox.
- **#3, filler subagent:** **agree; I recommended opt-in, and the maintainer shipped it as the fill default (PR #8).** It closes the filler's Bash escape but not the main loop's. Detection (#2) covers the same drift after the fact.
- **#4, native rules and sandbox:**
  - **Partly disagree.** Deny-beats-allow breaks the diagrams exception.
  - A sandbox `denyWrite` on `.skeleton/` would break the agent-run `skel next`/`done`.
  - Bash rules are documented as non-boundaries.
  - The right move is to take the anchor *out of the project* (5.7). Then one static rule and the sandbox's default write scope do the job.
- **#5, review server:** **decided by the maintainer and shipped: live read-only by default, `--send` opt-in, static fallback** (PR #14). This draft first recommended keeping POST by default (option (d)). The decision is sound on its own terms: it removes the feedback input endpoint by default. It doesn't authenticate feedback (pasted prose can still be malicious) and it doesn't stop source disclosure from the live page, so option (d)'s fragment token, data behind the token and CSP remain worthwhile as hardening for the read surface and for `--send` (5.5).
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
  - `UserPromptExpansion` as a mode-independent approval channel (since qualified: the event alone doesn't show human origin, §5.8).

---

## 9. Decisions

**The maintainer has decided every question below.** Claude and Codex worked through the open ones on PR #12, and the maintainer accepted all of their joint recommendations; Q7 was the maintainer's choice among three options. A decision sets direction. §10 says what is built, and the probes and prerequisites named here still have to be met.

1. **The promise.** *Decided:* the default tier is a drift guard plus detection for covered native edits. Integrity against an injected agent exists only in an opt-in strict tier, conditionally (Q12). The README should say so.
2. **Verification scope.** *Decided:* at approval, baseline the **reviewable source set**: explicit tracks plus discoverable non-ignored source. Detect new and deleted files in that set, and make excluded and generated paths explicit. Per-turn checks stay on the approved set (#37). *As built:* that means the skeleton's own files (fenced and tracked). Drift in a plain member surfaces at `done` and `finalize`, not per turn, because hashing every member costs about 1.3 s per turn at 2,000 files on `/mnt/c`. `status` also stays on the skeleton's own files and says so. This is deliberately not a literal whole-tree check, because build output, caches and dependency trees would produce unrelated drift and large scans (5.1 item 2).
3. **Drift response.** *Decided:* one corrective continuation through the Stop hook, then `systemMessage` only (#38).
   - **Repeated prompts, decided 2026-11-05:** nudge once per unchanged drift report, rather than once after every new prompt. Changed drift or a new approval can trigger a fresh nudge; completion still refuses unresolved drift. This update is being implemented in [PR #45](https://github.com/mitchjablonski/skeleton-skills/pull/45#issuecomment-6662504125).
   - `additionalContext` is **not** notify-only: it continues the turn, as `decision: "block"` does. So the continuation's Stop must emit neither.
   - `stop_hook_active` is the per-hook guard. The 8-continuation cap isn't, because its count resets each time Claude calls a tool.
   - The opt-in `--block` already follows this pattern (main: `lib/stop.mjs:47-50`). This flips the default, which stays notify-only (main: `lib/stop.mjs:21`) until #38 ships.
   - The [CLI runtime probe](https://github.com/mitchjablonski/skeleton-skills/issues/38#issuecomment-6647933291) on Claude Code 2.1.318 (Sonnet alias → `claude-sonnet-5-5`) confirmed: `systemMessage` alone produced one Stop event and stopped; `decision: "block"` plus reason and, separately, `additionalContext` each produced a second Stop event with `stop_hook_active: true` and the requested corrective reply. The second event, rather than `num_turns` alone, establishes continuation. IDE/Desktop and other clients remain untested. PR #45 is in review.
4. **Ask-mode approvals.** *Decided:* keep `ask` as the fill default and keep what PR #10 shipped: an allowed out-of-fence edit stays drift until reshape and re-approval. No automatic snapshot amendment, because PostToolUse success doesn't show that a human granted permission (5.1 item 4).
5. **Where trusted state lives.** *Decided:* `$XDG_STATE_HOME/skel`, native Windows `%LOCALAPPDATA%`, with a one-time validated migration (5.7, #18).
   - Move the snapshot, rendered history, serve sessions and ownership records together.
   - Deny rules cover both the old and the new location during the migration.
   - Refuse a corrupt or conflicting destination rather than overwrite it.
   - Keep pre-existing user rules, don't infer ownership when a record is missing, and document what reinstalling or changing the environment does.
   - This covers the stores already outside the project. Moving the phase out of `.skeleton/state.json`, as 5.7 proposes, is a further step this decision doesn't settle.
6. **Approval channel.** *Decided:* the permission prompt stays the default, as workflow authorization rather than a human-authenticated receipt. Typed `/skeleton-approve` is for the strict tier only, and it is gated on an entrypoint or origin boundary and a privileged writer the agent can't reach (5.15 item 4), not merely on the event firing. The CLI spike shows a scripted `claude -p` fires `UserPromptExpansion` too, so the event doesn't authenticate a human (5.8). IDE and Desktop are untested. Codex owns the remaining spikes, including network reach.
7. **Hook failure.** *Decided:* option A, deny until repaired. A hook fault during a fill, or unreadable enrolled state, refuses the call the broken gate can't evaluate. Normal evaluated out-of-fence edits still follow the configured gate.
   - *Also:* no project, scaffold and done stay usable. `onFailure: "block"` in the strict tier only.
   - *Option kept in reserve:* B, the configured gate on a fault during a readable fill, acceptable to the maintainer if `deny` turns out to break real use. C (`ask` on unreadable state) wasn't taken.
   - *Accepted cost:* a harmless call is refused until the hook or state is repaired. A human must always have a documented way out.
   - *Required (the review's blocking finding on #35):* name the bad file and the repair command; let repair commands through as `ask`; count only a real skel state, and don't let a bad file above the project deny everything.
   - PR #35 merged this policy, scoped to known/potential enrolled owners with named repair guidance and an explicit repair ask path. Startup failures remain outside the internal catch; strict-tier launcher failure policy is separate.
8. **Packaging.** *Decided:* make a plugin the main way to get skel, as its own release after #35 and #18, at project or local scope, not user scope, for usability and with no trust claim (5.13, 5.15). Keep a small install step, because plugins can't ship permission rules (only `agent` and `subagentStatusLine` settings take effect). Tracked in #40.
   - *Prerequisite evidence:* the fixture CLI probe in §5.13 is complete, and explicit reload unloaded the plugin despite the guard. This does not validate an actual installed skel plugin or a human-only origin boundary; reload/restart limits must remain explicit.
9. **Review server.** *Decided:* live read-only by default, `skel serve --send` opt-in, `skel review` static fallback (shipped, PR #14). *Also decided:* add the fragment-held token, `/api/data` behind the token and the CSP as separate hardening (#39), while saying plainly that they don't stop a same-origin script or a same-user process (5.5).
10. **Containment heuristic.** *Decided:* keep it ask-only; no AST project for now.
11. **Filler subagent.** *Decided:* shipped as the fill default (PR #8).
12. **Strict-tier prerequisites.** *Decided:* describe the strict tier as an unverified, conditional design target until the executable, configuration and privileged-writer boundaries (5.15) and the client and platform spikes (§7) are shown. Typed approval can't be described as human-only until that boundary exists: the CLI spike shows the event alone doesn't establish human origin, and it says nothing about IDE or Desktop.

---

## 10. Implementation status

Added after Codex's review, so that no decision or recommendation above reads as shipped when it isn't. Status refreshed against merged `main` at `970850c`; old source line citations below describe the historical revisions where they were recorded, not verified line numbers at the new head.

**Tests.** Final PR #35 implementation `b3872ed`: complete suites had 162 tests on each platform, native Windows 154 passed / 8 platform skips / 0 failures, and WSL 160 passed / 2 skips / 0 failures. These are the merged implementation evidence, not a new run of this document. Merged PR #46 at `076b906` passed 163 tests: Windows 155 passed / 8 skips and WSL 161 passed / 2 skips, with no failures. Unmerged PR #45 at `a842bbb` passed 167 tests: Windows 159 passed / 8 skips and WSL 165 passed / 2 skips, with no failures; these results predate the decided once-per-unchanged-report update, which is in progress. Runtime probes below are separate from the repository tests. Historical `9a4541d` runs found an intermittent page-load timing test; that old result is not a failure attributed to these newer heads.

### 10.1 Decisions and recommendations mapped to PRs and issues

| Status | PR / issue | What it does | Design section |
|---|---|---|---|
| **Merged** | #1 | Hardening from the adversarial reviews: the result-based Edit gate, `.skeleton/` guards, serve Host/Origin/token checks, quarantine of shipped feedback. This is the §4 baseline. | §4 |
| **Merged** | #21, #22 | The scanner and the gate skip tool and build dirs, `.claude/` included, so the installed skills' example fences never become steps. | §4.1 |
| **Merged** | #9 | PR #1 re-review nits N1, N2 (`git stash --all` asks; main: `lib/phase.mjs:11-13`), N4–N7. | §4.2, §4.4 |
| **Merged** | #13 | LF line endings pinned with `.gitattributes`. | n/a |
| **Merged** | #24 | An Edit or MultiEdit on a missing file counts as creating a new file, which asks during a fill and between steps. #27 narrowed this to calls that would really create one (main: `lib/gate.mjs:187-191, 255-260`). | §4.1 |
| **Merged** | #8 | Restricted `skeleton-filler` subagent (Read, Grep, Glob, Edit, MultiEdit), the fill skill's default path. | §5.2 |
| **Merged** | #10 | Snapshot of the approved skeleton, recorded outside the project at `approve` and verified at `done`, `finalize`, `status` and the page. **It fails closed**: a missing, stale or malformed record is drift. **An out-of-fence edit the human allowed at the prompt still blocks `done`/`finalize` until `skel reshape` and re-approval**; there is no automatic amendment (§5.1 item 4). | §5.1 |
| **Merged** | #11 | Native `Edit(...)` deny rules for the `.skeleton/` state files, written with the project's **absolute** real path, and `skel uninstall`, which removes only the rules this install added. | §5.3 |
| **Merged** | #14 | Live **read-only** review by default (`skel serve`: POST answers 405, Copy → paste into chat); `skel serve --send` opt-in for one-click Send; `skel review` static fallback. Closes #5. | §5.5 |
| **Merged** | #20 | Approval bound to the reviewed skeleton version (#15), and a Stop-hook drift check, notify-only by default with an opt-in `--block` (#16). | §5.1 item 1, §5.9 |
| **Merged** | #27 | Skipped-dir edge cases (#23) and missing-path wording (#25 item 4). | §4.1 |
| **Merged** | #29 | Diagram reads stay inside the project: links out are skipped (closes #28). | §4.6 |
| **Merged** | #30 | Fixes #26: an owned `Edit` deny rule for skel's config-dir stores, and a hook `ask` on edits into that dir and on Bash commands that name it. | §5.1, §5.3 |
| **Merged** | #31 | #25 items 1–3: serve polls tracked files the search would read; a gitignored tracked file's fence bodies are recorded; the fill skill's before-and-after check. Also #14 review nits. | §5.1, §5.2 |
| **Merged** | #33 | Fixes #32: serve and scan read only regular files that resolve inside the project, so a known file swapped for a link out of it isn't served or recorded. | §4.6 |
| **Merged** | #34 | First item of #17: the README no longer calls the permission prompt the one channel the agent can't answer. | §4.2 |
| **Merged** | #35 | Closes #17 standard-tier work: settings reload guard during an enrolled fill, internal fault denial with a repair ask path, scoped receipt/state diagnosis, and persisted historical blocked-change notices surfaced by status/Stop. Notices are consumed once per session; status remains non-consuming. Blocks reloads, not disk writes or restart-loaded settings; managed policy and startup faults remain outside this control. | §4.3, §5.14, §9 Q7 |
| **Closed** | #17 | Standard-tier approval-channel claims and fault/reload work shipped through #34 and #35. This does not establish a human-authenticated strict-tier receipt. | §4.3, §5.14 |
| **In review, blocked** | #18 / PR #41 | Move trusted state to `$XDG_STATE_HOME/skel/`, with the migration of §5.7. At `35d4b14`, [marker-error and unknown-fill findings remain](https://github.com/mitchjablonski/skeleton-skills/pull/41#issuecomment-6661015555). [Normal old-server replacement and protocol-2 continuity passed](https://github.com/mitchjablonski/skeleton-skills/pull/41#issuecomment-6661273825); that clears those tested paths, not the whole PR. | §5.7, §9 Q5 |
| **Planned** | #19 | Strict tier: sandbox, typed approval via `UserPromptExpansion` behind an agent-inaccessible entrypoint or origin boundary, the executable boundary, and the remaining spikes. The CLI expansion spike is done: the event doesn't authenticate human origin (§5.8). | §5.4, §5.8, §5.15, §7 |
| **In review** | #37 | Reviewable-source-set verification: a format-3 record with a versioned baseline, checked by `done`, `finalize` and `status`. `status`, the page and the Stop hook stay on the skeleton's own files, so plain-member drift surfaces at completion, not per turn. Measured on `/mnt/c` at 2,000 source files plus 1,000 ignored outputs, main to branch: approve 1.84 s to 3.66 s, done 1.82 s to 3.41 s, Stop 176 ms to 175 ms. Native Windows: approve 0.55 s to 1.13 s, done 0.54 s to 0.99 s, Stop 113 ms to 111 ms. At 20,000 files on `/mnt/c`, done goes from 8.5 s to about 22 s: many seconds per step. | §5.1 item 2, §9 Q2 |
| **In review** | #38 / PR #45 (`a842bbb`) | One corrective Stop continuation by default, with explicit notify-only opt-out. CLI protocol probe completed; the once-per-unchanged-report update is decided and being implemented before merge. | §5.1 item 1, §9 Q3 |
| **In review, blocked** | #39 / PR #43 | Fragment token, `/api/data` behind it, and a CSP. The upgrade must replace servers without authenticated reads. [Storage protocol 2 alone is not read-authentication capability](https://github.com/mitchjablonski/skeleton-skills/pull/43#issuecomment-6661193304); reuse needs a distinct capability and a successful authenticated token probe. | §5.5, §9 Q9 |
| **Merged** | #42 / PR #46 (`076b906`) | Deduplicate installed scope hooks without changing user matchers or removing pre-existing empty groups; preserve the first installed hook’s fields, including its failure policy. | §4.3 |
| **Decided, not built** | #40 | A plugin as the main way to get skel, after #35 and #18; fixture disable/reload probe completed with the explicit-reload limit in §5.13; actual skel packaging remains unbuilt/untested. | §5.13, §9 Q8 |
| **Not started** | n/a | Gate compares against the snapshot (§5.1 item 3). AST checks (§5.6) are deferred by §9 Q10. | |

### 10.2 Accepted threat model

What the project has accepted as its scope (§1–§3), independent of what is built:

- The **default tier is a drift guard with detection** for a cooperative agent (T1), plus resistance to malicious repos (T3) and web pages (T4).
- A **prompt-injected agent (T2) is not contained** by the default tier. Containing it is the strict tier's job, and only under the prerequisites of §5.15.
- **Out of scope:** semantic containment of fills (N1), same-user malware (N2), `bypassPermissions` (N3), Claude Code's workspace trust (N4).
- **Feedback is unauthenticated prose** in every review mode (R6). Read-only and static review remove the input endpoint; they don't authenticate what is pasted.

### 10.3 Planned controls (not guarantees)

Everything in §5–§7 that §10.1 doesn't list as merged is a **planned control**: decided or intended, but with an effect that hasn't been shown. That includes, in particular:

- reviewable-source-set verification (§9 Q2, #37) until its PR merges;
- one corrective Stop continuation by default (§9 Q3, #38; today's default only notifies);
- the review-server hardening (§9 Q9, #39);
- plugin packaging (§9 Q8, #40); the internal deny-until-repaired hook and reload guard shipped in #35, with startup faults and restart limitations retained;
- trusted state outside the project (#18);
- the whole strict tier (#19), whose promises are conditional on §5.15 and the spikes in §7.

### 10.4 Verified guarantees

Repository evidence is separated from live runtime probes (runs are summarized above; historical line citations remain at their original revisions). Where a guarantee depends on Claude Code enforcing something, that part rests on Claude Code's documentation, not on this project's tests, and is marked *(docs)*. The tests call the hook and the CLI directly; the repository tests do not run inside a live Claude Code session. The separately linked CLI probes do.

1. **Edit-tool fills stay inside the fence.** During an active step, an Edit, MultiEdit or Write that changes text outside the step's fence, changes its markers or creates a file gets an `ask` (or `deny` under `gate: deny`). The check is on the resulting file, MultiEdits are applied in order, and CRLF files are compared as LF (`test/skel.test.mjs`, the security H-series tests from `:153`). *(docs)* That Claude Code then prompts depends on the permission mode and on what can answer the prompt (§4.2).
2. **Drift is detected at `done` and `finalize`, however it was made.** A `sed -i` outside the fence, a Write that appends outside it, new fenced files and deleted tracked files all block `done` and `finalize` with a `file:line` report (`test/skel.test.mjs:1006`, `:1026`). A missing, stale or malformed record fails closed (`:1066`, `:1547`). An Edit the human allowed at the prompt still blocks `done` (`:992`). With #37 (in review), `done` and `finalize` also cover the source baseline: edits, new files, deletes and renames of source nobody fenced, including after an ignore rule changes (`test/source-set.test.mjs`). A failed discovery refuses rather than recording or accepting a smaller set. **Not shown:** that anyone reviewed the baseline's files (it is coverage, not review, and isn't in the skeleton version); changes to what the policy leaves out unless tracked; the content behind a link out of the project (recorded by target only); new files hidden by `.git/info/exclude` or a global ignore; per-turn detection of plain members (the Stop hook doesn't read them, by decision, for cost); and detection against an agent that rewrites the snapshot (R1).
3. **During a fill, the Stop hook reports drift.** Given a drifted file or a missing record, the hook emits a `systemMessage` with the `file:line` report; drift reporting stays silent with no skeleton, outside a fill and on a clean fill, except that #35 historical blocked-settings notices may still be emitted; with `--block` it emits `decision: "block"` once and not when `stop_hook_active` is set (`test/skel.test.mjs:1202`, `:1222`). Delivery and continuation were separately checked in the linked Claude Code 2.1.318 CLI probe (§9 Q3); this does not establish IDE/Desktop behavior. It fails open on a fault, by design.
4. **Approval checks the reviewed version.** `skel approve` refuses, with a diff, when the skeleton changed after the review on the page, or when `--reviewed` doesn't match (`test/skel.test.mjs:1144`, `:1178`, `:1953`). This is freshness, not authority: **not shown**, and not claimed, is that the human gave the approval.
5. **The trusted files are covered by Edit deny rules after `skel install`.** The `.skeleton/` state rules use the project's absolute path whatever directory install runs from (`test/skel.test.mjs:485`, `:575`). The config-dir rule is absolute and escaped, and a changed `XDG_CONFIG_HOME` adds a rule and reports the old one (`:2108`, `:2154`). `skel uninstall` removes only rules this install added (`:611`). The hook asks on edits into the config dir from any project, and denies under `gate: deny` (`:2174`). *(docs)* That Claude Code enforces deny rules before hooks and across all built-in edit tools is from the [permissions](https://code.claude.com/docs/en/permissions) docs; the tests check the rules written, not Claude Code's enforcement.
6. **`skel serve` is read-only by default, and `--send` keeps its checks.** By default a feedback POST answers 405 and no session is created (`test/skel.test.mjs:271`). With `--send`, the endpoint refuses cross-site posts, wrong Host headers and missing tokens (`:352`). **Not shown:** protection of the source against local processes that can connect to the port, or of the token in Send mode (§4.6).
7. **Reads stay inside the project, for links.** A diagram link or a diagrams or `.skeleton` folder link out of the project exposes nothing (`test/diagrams.test.mjs:32`, `:38`, `:62`). A known fenced file swapped for a file or folder link out of the project isn't served, in scaffold or fill (`test/skel.test.mjs`, the `#32` tests, including `:2479` and `:2506`). **Residuals (R10), not closed and not covered by a test:** a hardlink inside the project to an outside file, and a folder swapped mid-scan by a racing same-user process. Symlink cases need the file-symlink privilege on native Windows; they ran here on WSL.
8. **The filler subagent has no shell and no Write.** Its definition lists `tools: Read, Grep, Glob, Edit, MultiEdit` and disallows Bash, PowerShell, Monitor, Write, NotebookEdit and Agent (`agents/skeleton-filler.md:4-5`). *(docs)* Enforcement of the allowlist is Claude Code's ([sub-agents](https://code.claude.com/docs/en/sub-agents)).

Nothing here is a guarantee against a prompt-injected agent.
