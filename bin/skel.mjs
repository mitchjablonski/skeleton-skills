#!/usr/bin/env node
// skel — plan as code skeleton, fill it one fenced step at a time.
// Run `skel help` for commands.

import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, searchable, toSteps, stripMarkers } from "../lib/markers.mjs";
import { STATE_DIR, findRoot, readState, writeState, initState, insideRoot, legacyConfigDir, projectKey, realish, skelStateDir, storePath, writeFileAtomic } from "../lib/state.mjs";
import { clearConfigNotice, readConfigNotice } from "../lib/config-notice.mjs";
import { installStatus, isSkelHook, rulePath } from "../lib/install-status.mjs";
import { enrollment } from "../lib/config-hook.mjs";
import { SHELL_CSP, buildReviewData, clientScript, pagePayload, readDiagrams, renderShell, writeReview } from "../lib/review.mjs";
import {
  cleanFeedback, feedbackMarkdown, isVersion, lastReview, mergeRecords, newServeSession,
  addSession, clearSessions, historyDir, legacyQueued, pendingCount, queueDir, readServe, servePath,
  storeFeedback, takeFeedback,
} from "../lib/feedback.mjs";
import { discardUnusedStateDirFiles, migrateProject, migrationPlan } from "../lib/migrate.mjs";
import { storeNotice } from "../lib/store-notice.mjs";
import {
  clearRendered, clearSnapshot, compareWith, formatDrift, noteRendered, readRendered, readRenderedStore, recordSkeleton, scanSkeleton, verifySnapshot, writeSnapshot,
} from "../lib/snapshot.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Forward slashes on every platform: these land in shell commands and skill text.
const SELF = path.join(PKG_ROOT, "bin", "skel.mjs").split(path.sep).join("/");
const HOOK = path.join(PKG_ROOT, "bin", "skel-hook.mjs").split(path.sep).join("/");
const STOP_HOOK = path.join(PKG_ROOT, "bin", "skel-stop.mjs").split(path.sep).join("/");
const CONFIG_HOOK = path.join(PKG_ROOT, "bin", "skel-config-hook.mjs").split(path.sep).join("/");

const HELP = `skel — plan as code skeleton, fill one fenced step at a time

  init "<title>" [--gate ask|deny] [--force]
                                     start a skeleton in this project (--force replaces an existing one)
  track <file...>                    show unfenced skeleton files (types, wiring) in the review too
  status [--json]                    phase, active step, every step's status
  review                             write .skeleton/review.html (static; copy feedback by hand)
  serve [--port N] [--send] [--stop] serve live read-only; --send enables feedback
  feedback [--wait SECONDS]          print (and archive) the human's latest feedback (waits up to 110s)
  approve [--reviewed VERSION]       enter the fill phase (the loaded hook requests permission;
                                     permission modes and integrations control who answers);
                                     refuses if the version the human last reviewed isn't the current one
  next                               start the first pending step and print its fences
  start <id> [--force]               start a specific step (--force abandons an unfinished active step,
                                     or reopens a filled one for rework)
  done                               finish the active step (fails if SKEL_TODO remains, or on drift
                                     outside the fences from the approved skeleton)
  reshape                            back to skeleton review (the loaded hook requests permission)
  finalize                           all steps filled and no drift: strip markers, phase done
  hook                               PreToolUse scope gate (reads hook JSON on stdin)
  stop-hook [--block]                Stop hook: reports drift from the approved skeleton during a fill
  migrate [--dry-run] [projectDir]   move this project's records from the old config dir to the state dir
                                     (run skel install and restart Claude Code first; refused during a fill)
  install [projectDir]               install skills, filler subagent, hooks and deny rules (.skeleton/ state,
                                     skel's state dir) into a project's .claude/
  uninstall [projectDir]             remove what install added (leaves .skeleton/ and .gitignore alone)
`;

function die(msg) {
  console.error(`skel: ${msg}`);
  process.exit(1);
}

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function requireRoot() {
  const root = findRoot(process.cwd());
  if (!root) die(`no ${STATE_DIR}/state.json here or above — run \`skel init "<title>"\` first`);
  return root;
}

function validState(state) {
  return !!state && ["scaffold", "fill", "done"].includes(state.phase) && ["ask", "deny"].includes(state.gate) && typeof state.title === "string" && Array.isArray(state.files) && state.files.every(file => typeof file === "string") && (state.activeStep === null || typeof state.activeStep === "string") && Number.isFinite(state.reviewEpoch);
}

function requireState(root) {
  const state = readState(root);
  if (!validState(state)) {
    die(`can't read valid state from ${path.join(root, STATE_DIR, "state.json")}; repair it from a terminal or Claude Code's ! shell mode, or run skel init --force "<title>" from ${root} to replace the prior fill state`);
  }
  return state;
}

function clearConfigNotices(root) {
  for (const owner of new Set([root, process.env.CLAUDE_PROJECT_DIR].filter(Boolean))) {
    try { clearConfigNotice(owner); } catch (err) { console.error(`skel: couldn't clear the historical settings notice (${err.code ?? err.message})`); }
  }
}

function snapshot(root, state = requireState(root)) {
  const { fences, errors, files } = scanSkeleton(root, state);
  return { steps: toSteps(fences), errors, files };
}

/** Refuse when the working tree has drifted from the approved skeleton. */
function requireNoDrift(root, state, fencedFiles, what) {
  const drift = verifySnapshot(root, state, fencedFiles);
  if (!drift.ok) die(`can't ${what}: ${formatDrift(drift)}`);
}

/** Why approve refuses a stale review: what changed since the version the human saw. */
function staleReview(root, state, files, reviewed, how = "the human reviewed") {
  // The current version is not printed: the agent must only ever pass a
  // version it got from the human, so it isn't handed one to copy.
  const head = `can't approve: ${how} skeleton version ${reviewed}, and the skeleton has changed since.`;
  const tail = "Have the human reload the review page (a live page reloads by itself; regenerate a static one with `skel review`) and review it again. Approve with the version from the feedback they copy and paste (`--reviewed`), or after their next send in Send mode. Don't pass a version the human didn't give you.";
  const seen = readRendered(root).find((r) => r.version === reviewed);
  if (!seen) return `${head}\nVersion ${reviewed} isn't one this project's review page rendered recently, so there is no diff to show.\n${tail}`;
  const diff = compareWith(seen, root, state, files);
  return `${head}\n${formatDrift(diff, 8, { header: "Changed since that version (outside the fence bodies):", footer: tail })}`;
}

function printFences(step) {
  for (const f of step.fences) {
    console.log(`\n--- ${f.file}:${f.openLine}-${f.closeLine} (${f.status})`);
    console.log(f.body);
  }
}

/**
 * The review server named in serve.json, if it is really ours and running:
 * a 127.0.0.1 URL that answers with the serverId we recorded. A bare pid (or
 * a serve.json shipped in a repo) is never trusted, killed or handed out. Its
 * review token lives in serve.json too, and only ever goes back to that URL.
 * A server from before the token answers without one: that identifies it well
 * enough to stop or replace it, not to reuse it (readsProtected).
 */
/** How long `skel feedback --wait` waits for a review server to answer before saying there's none. */
const NO_SERVER_GRACE = 10_000;

/**
 * Which store layout a server understands, in /api/version. No path: anything
 * holding the token can read that endpoint. A server without it is from
 * before the state dir: it only ever reads the old location, so it reports a
 * missing approval record once a project has migrated.
 */
const STORE_PROTOCOL = 2;

/**
 * That a server's reads need the review token, in /api/version. Separate from
 * STORE_PROTOCOL: a server can understand the state dir and still serve source
 * to anyone (#41's did).
 */
const READ_AUTH = 1;

async function liveServer(root) {
  const s = readServe(root);
  if (!s?.url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(s.url) || !s.serverId) return null;
  try {
    const token = typeof s.token === "string" && /^[0-9a-f]{32,128}$/.test(s.token) ? s.token : null;
    const res = await fetch(new URL("api/version", s.url), { headers: token ? { "x-skeleton-token": token } : {}, signal: AbortSignal.timeout(1500) });
    const v = await res.json();
    if (!(v.serverId === s.serverId && Number.isInteger(v.pid) && v.pid > 1 && (s.pid === undefined || s.pid === v.pid))) return null;
    return {
      url: s.url,
      pid: v.pid,
      feedbackEnabled: v.feedbackEnabled !== false,
      storeProtocol: v.storeProtocol ?? 1,
      token,
      readAuth: v.readAuth,
      // The server accepted this token: a server that ignores the header
      // answers 200 as well, so this alone proves nothing (see readsProtected).
      tokenAccepted: !!token && res.status === 200,
    };
  } catch {
    return null;
  }
}

/**
 * Is it safe to hand out this verified server's URL as hardened? It must claim
 * the capability, have accepted our token, and refuse the same reads without
 * it. A token in serve.json proves none of that, and a stale or planted marker
 * is caught by the refusals. /api/version is asked first: an older server's
 * GET / would record a page view nobody saw. Any doubt, a timeout included,
 * counts as no: the caller replaces the server, which costs a reload.
 */
async function readsProtected(server) {
  if (!server.token || !server.tokenAccepted || !Number.isInteger(server.readAuth) || server.readAuth < READ_AUTH) return false;
  try {
    const get = (route) => fetch(new URL(route, server.url), { signal: AbortSignal.timeout(1500) });
    for (const route of ["api/version", "api/data"]) {
      const res = await get(route);
      await res.body?.cancel();
      if (res.status !== 401) return false;
    }
    const shell = await get("");
    return shell.ok && !!shell.headers.get("content-security-policy") && !(await shell.text()).includes('id="skeleton-data"');
  } catch {
    return false;
  }
}

/**
 * Feedback queued by a pre-upgrade server (whose session ids lived in the
 * project's serve.json) can't be verified, and isn't migrated: a committed
 * serve.json looks exactly like a real one, so trusting its list would let a
 * repo vouch for its own feedback again. Tell the human to send it again.
 */
/** Does this project's next store access read the old location? */
const usesLegacy = (root) => storePath(root).startsWith(legacyConfigDir() + path.sep);

function warnLegacyQueue(root) {
  const n = legacyQueued(root);
  if (n) {
    console.error(
      `skel: warning: ${n} unread feedback file(s) were queued by an older \`skel serve\` and can't be verified; ` +
        "`skel feedback` will set them aside. If they're yours, send them again from the review page.",
    );
  }
}

function setActive(root, state, step, force = false) {
  if (step.status !== "todo" && !force) die(`step ${step.id} is already filled; \`skel start ${step.id} --force\` reopens it for rework`);
  writeState(root, { ...state, phase: "fill", activeStep: step.id });
  console.log(`STEP ${step.id} active: ${step.title}`);
  console.log(`Edit only inside these fences; replace each SKEL_TODO stub. Leave the marker lines in place.`);
  printFences(step);
}

const SKILLS = ["skeleton", "skeleton-fill"];
// The fill skill delegates each step's edits to this subagent (Read, Grep,
// Glob, Edit, MultiEdit only: no shell, no Write).
const AGENT = "skeleton-filler";

/** [source, destination] for every file install writes into .claude/. */
function installedFiles(claudeDir) {
  return [
    ...SKILLS.map((name) => [path.join(PKG_ROOT, "skills", name, "SKILL.md"), path.join(claudeDir, "skills", name, "SKILL.md")]),
    [path.join(PKG_ROOT, "agents", `${AGENT}.md`), path.join(claudeDir, "agents", `${AGENT}.md`)],
  ];
}

/**
 * Claude Code permission rules `install` adds, so the agent's own file tools
 * can't write the tool's state: Claude Code enforces deny rules before any
 * hook (a hook's "allow" can't lift them), and the Bash sandbox, when enabled,
 * turns them into OS-level write denials. Only `Edit(...)` path rules match
 * (they cover Write, MultiEdit and NotebookEdit too; `Write(path)` rules
 * never match). A `!` carve-out can't reopen diagrams/ inside a denied
 * .skeleton/**, so the state is listed path by path, with no wildcard but a
 * trailing /** (the only kind the Linux sandbox honours).
 *
 * The rules name the project by its ABSOLUTE real path (`//abs/path/...`): a
 * `/path` rule in .claude/settings.local.json anchors at the session's primary
 * working directory, not the project, so a session launched from a
 * subdirectory would protect <subdir>/.skeleton and miss the real state. On
 * Windows Claude Code matches POSIX-normalized paths (C:\x becomes /c/x).
 */
const STATE_PATHS = ["state.json", "serve.json", "review.html", "feedback/**", "feedback-history/**"];
const LEGACY_DENY_RULES = STATE_PATHS.map((p) => `Edit(/${STATE_DIR}/${p})`);

/** The project's real path, as Windows spells it on disk (true case) or as POSIX does. */
const realDir = (target) => fs.realpathSync.native(target);

/** The deny rules for a project's .skeleton/ state, or why there are none (install still adds the hook and the skills). */
function denyRules(target) {
  const { path: p, why } = rulePath(realDir(target));
  return why ? { rules: [], why } : { rules: STATE_PATHS.map((s) => `Edit(/${p}/${STATE_DIR}/${s})`), why: null };
}

/**
 * The deny rule for each dir skel's stores can be in, or why there is none. The
 * approved-skeleton records, the rendered review versions, the serve sessions
 * and the ownership records live in the state dir, outside every project, where
 * the hook's fence doesn't reach and only Claude Code's
 * outside-the-working-directory prompt (skipped by bypassPermissions) would
 * otherwise stand in the way. The old config dir gets one too, created or not:
 * a migration trusts what it finds there. skel writes the stores from its own
 * process, which deny rules don't apply to. Resolved now: a later change of
 * XDG_STATE_HOME or XDG_CONFIG_HOME leaves a rule guarding the dir it named.
 */
function storeDenyRules() {
  const toRule = (real, dir, name) => {
    const { path: p, why } = rulePath(real);
    return why ? { name, dir, rule: null, why } : { name, dir, rule: `Edit(/${p}/**)`, why: null };
  };
  const dir = skelStateDir();
  let current;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    current = toRule(realDir(dir), dir, "state dir");
  } catch (err) {
    current = { name: "state dir", dir, rule: null, why: `can't create or resolve ${dir} (${err.code ?? err.message})` };
  }
  const old = toRule(realish(legacyConfigDir()), legacyConfigDir(), "old config dir");
  return old.rule && old.rule === current.rule ? [current] : [current, old];
}

/**
 * Any deny rule shaped like one skel writes, for any project: the absolute
 * form or the old project-relative one. Used to report rules install and
 * uninstall leave alone (a moved project's, or ones whose ownership record
 * was lost), never to remove them.
 */
const SKEL_SHAPED = new RegExp(`^Edit\\((//.*)?/\\.skeleton/(${STATE_PATHS.map((p) => p.replace(/[.*]/g, (c) => `\\${c}`)).join("|")})\\)$`);
/** A store-dir rule's shape, any dir: `Edit(//<abs>/skel/**)`. Loose (any skel/ dir matches), so only ever reported as "possibly" ours. */
const STORE_SHAPED = /^Edit\(\/\/.*\/skel\/\*\*\)$/;
function reportLeftInPlace(settings, notOurs) {
  const deny = (settings.permissions?.deny ?? []).filter((r) => typeof r === "string" && !notOurs.includes(r));
  const left = deny.filter((r) => SKEL_SHAPED.test(r));
  if (left.length) {
    console.log(`left in place: ${left.length} ${STATE_DIR}/ deny rule(s) this install didn't add (a moved project's, a lost ownership record's, or your own); remove any you no longer want by hand:`);
    for (const r of left) console.log(`  ${r}`);
  }
  const cfg = deny.filter((r) => STORE_SHAPED.test(r));
  if (cfg.length) {
    console.log(`left in place: ${cfg.length} deny rule(s) for a .../skel/** dir that this install didn't add; possibly skel's store-dir rule from an old XDG_STATE_HOME or XDG_CONFIG_HOME, a moved project or a lost ownership record, or your own. Remove any you no longer want by hand:`);
    for (const r of cfg) console.log(`  ${r}`);
  }
}

/**
 * Where Claude Code loads .claude/settings.local.json from: the git root on
 * Linux/macOS/WSL, but the launch directory outside git, on native Windows, in
 * a home-directory repo, or when the root isn't the user's. Warn when the
 * project isn't a place both agree on, so a launch from a subdirectory would
 * load neither the rules nor the hook.
 */
function launchWarning(target) {
  const real = realDir(target);
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const git = (...args) => execFileSync("git", ["-C", real, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let why = null;
  if (process.platform === "win32") {
    why = "on native Windows, Claude Code loads it from the directory you start in";
  } else {
    let top = null;
    try { top = realDir(git("rev-parse", "--show-toplevel")); } catch {}
    if (!top) why = "outside a git repository, Claude Code loads it from the directory you start in";
    else if (same(top, realDir(os.homedir()))) why = "in a repository rooted at your home directory, Claude Code loads it from the directory you start in"
    else if (!same(top, real)) why = `the project isn't its git repository's root (${top}), and Claude Code loads it from the root, or from the directory you start in`;
    else {
      try {
        if (!same(path.resolve(real, git("rev-parse", "--git-dir")), path.resolve(real, git("rev-parse", "--git-common-dir")))) why = "in a git worktree, Claude Code loads it from the main checkout's root, so what install just wrote here isn't loaded: run `skel install` in the main checkout too";
      } catch {}
    }
  }
  if (why) console.log(`warning: the hook and the deny rules live in .claude/settings.local.json, and ${why}. ${/main checkout too$/.test(why) ? "" : `Start Claude Code in ${real} itself, not a subdirectory.`}`.trimEnd());
}

/**
 * Which deny rules this install added, kept OUTSIDE the project (next to the
 * serve-session store), so uninstall removes only those: a rule the user
 * already had survives install + uninstall.
 */
const ownedStorePath = (target) => storePath(target, "-install");
function readOwned(target) {
  const file = ownedStorePath(target);
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    die(`can't read install's ownership record ${file} (${err.code ?? err.message}). Fix it first: without it, install would treat its own rules as yours.`);
  }
  // Unreadable isn't missing: guessing here would orphan rules, or take the user's.
  let o;
  try { o = JSON.parse(text).ownedDeny; } catch {}
  if (!Array.isArray(o)) die(`install's ownership record ${file} is corrupt. Delete it to treat every current rule as yours, or restore a good copy, then run this again.`);
  // A record outside the project can still be planted. Install only ever adds
  // rules of these shapes, so anything else stays the user's, whatever it says.
  const strings = o.filter((x) => typeof x === "string");
  const ours = (r) => SKEL_SHAPED.test(r) || STORE_SHAPED.test(r) || LEGACY_DENY_RULES.includes(r);
  const foreign = strings.filter((r) => !ours(r));
  if (foreign.length) console.log(`warning: install's ownership record ${file} lists ${foreign.length} rule(s) install never writes, so they're left alone: ${foreign.join(", ")}`);
  return strings.filter(ours);
}
function writeOwned(target, owned) {
  if (!owned.length) return fs.rmSync(ownedStorePath(target), { force: true });
  writeFileAtomic(ownedStorePath(target), JSON.stringify({ root: realDir(target), ownedDeny: owned }, null, 2) + "\n", 0o600);
}

/**
 * Rules an install from before ownership tracking wrote: the old
 * project-relative set, claimed only when no ownership record exists, the
 * scope gate hook is installed and all five are present (a user's own lone
 * `Edit(/.skeleton/state.json)` is never taken).
 */
function legacyOwned(settings, owned) {
  if (owned) return [];
  const deny = settings.permissions?.deny ?? [];
  const hooked = (settings.hooks?.PreToolUse ?? []).some((m) => m?.hooks?.some?.((hk) => isSkelHook(hk?.command)));
  return hooked && LEGACY_DENY_RULES.every((r) => deny.includes(r)) ? LEGACY_DENY_RULES : [];
}

/**
 * Our Stop hook (bin/skel-stop.mjs, or `skel.mjs stop-hook`) from any checkout,
 * recognised by its script whatever flags (`--x`) follow; block: one of them is
 * --block. Anything else after it (`&& notify-send done`) makes it the user's.
 */
const skelStopHook = (cmd) => {
  const m = typeof cmd === "string" && /^node "[^"]*[\\/]bin[\\/](?:skel-stop\.mjs"|skel\.mjs" stop-hook)((?:\s+--\w[\w-]*)*)\s*$/.exec(cmd);
  return m ? { block: m[1].split(/\s+/).includes("--block") } : null;
};
/** Exact standalone commands only: a chained command remains the user's. */
const isSkelConfigHook = (cmd) => typeof cmd === "string" && /^node "[^"]*[\\/]bin[\\/]skel-config-hook\.mjs"$/.test(cmd);

/**
 * A project's .claude/settings.local.json, parsed, for install/uninstall to
 * merge into. Dies rather than risk the user's settings: a symlink on the way
 * (we'd write through it), JSON we can't parse (we'd drop it), or a shape we
 * don't understand (we'd clobber it).
 */
function openProjectSettings(dir, { forInstall = false } = {}) {
  const target = path.resolve(dir);
  if (!fs.existsSync(target)) {
    if (!forInstall) die(`${target} doesn't exist`);
    fs.mkdirSync(target, { recursive: true }); // as install always has: it creates the project dir
  } else if (!fs.statSync(target).isDirectory()) die(`${target} isn't a directory`);
  const claudeDir = path.join(target, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  // A symlinked folder would aim our writes outside the project, and a
  // symlinked file may be someone's live checkout: refuse both.
  const dests = installedFiles(claudeDir).flatMap(([, dest]) => [path.dirname(path.dirname(dest)), path.dirname(dest), dest]);
  for (const p of new Set([claudeDir, settingsPath, ...(forInstall ? [path.join(target, ".gitignore")] : []), ...dests])) {
    if (isLink(p)) die(`${p} is a symlink; refusing to write through it`);
  }
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      die(`${settingsPath} isn't valid JSON; fix it first (overwriting it would drop your settings)`);
    }
  }
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const bad = !isObj(settings) ? "the file"
    : settings.permissions !== undefined && !isObj(settings.permissions) ? '"permissions"'
    : settings.permissions?.deny !== undefined && !Array.isArray(settings.permissions.deny) ? '"permissions.deny"'
    : settings.hooks !== undefined && !isObj(settings.hooks) ? '"hooks"'
    : settings.hooks?.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse) ? '"hooks.PreToolUse"'
    : settings.hooks?.Stop !== undefined && !Array.isArray(settings.hooks.Stop) ? '"hooks.Stop"'
    : settings.hooks?.ConfigChange !== undefined && !Array.isArray(settings.hooks.ConfigChange) ? '"hooks.ConfigChange"'
    : null;
  if (bad) die(`${settingsPath}: ${bad} isn't shaped the way Claude Code expects; fix it first (we won't overwrite it)`);
  return { target, claudeDir, settingsPath, settings };
}

const commands = {
  help() {
    console.log(HELP);
  },

  async init(args) {
    const gate = flag(args, "gate", "ask");
    if (!["ask", "deny"].includes(gate)) die("--gate must be ask or deny");
    const force = args.includes("--force");
    const title = args.filter((a) => a !== "--force").join(" ").trim();
    if (!title) die('usage: skel init "<title>"');
    const root = findRoot(process.cwd()) ?? process.cwd();
    const existing = readState(root);
    if (existing && existing.phase !== "done" && !force) {
      die(`a skeleton is already in progress here: "${existing.title}" (phase: ${existing.phase}). Use --force to replace it.`);
    }
    initState(root, title);
    writeState(root, { ...readState(root), gate });
    clearConfigNotices(root);
    // A new skeleton starts with no feedback and no review server: nothing
    // left over (or shipped in the repo) can pose as this review's notes.
    const old = await liveServer(root);
    if (old) { try { process.kill(old.pid); } catch {} }
    for (const f of [queueDir(root), historyDir(root), servePath(root)]) fs.rmSync(f, { force: true, recursive: true });
    try {
      discardUnusedStateDirFiles(root);
      clearSessions(root);
      clearSnapshot(root);
      clearRendered(root);
    } catch (err) {
      console.error(`skel: warning: couldn't clear the previous skeleton's review sessions and approval record (${err.path ?? err.code ?? err.message}${err.path ? `: ${err.code}` : ""})`);
    }
    console.log(`skel: "${title}" started in ${root} (phase: scaffold, gate: ${gate})`);
  },

  track(args) {
    if (!args.length) die("usage: skel track <file...>");
    const root = requireRoot();
    const state = requireState(root);
    const rels = args.map((a) => path.relative(root, path.resolve(a)).split(path.sep).join("/"));
    const missing = rels.filter((r) => !fs.existsSync(path.join(root, r)));
    if (missing.length) die(`not found: ${missing.join(", ")}`);
    const outside = rels.filter((r) => !insideRoot(root, path.join(root, r)) || !fs.statSync(path.join(root, r)).isFile());
    if (outside.length) die(`only files inside the project can be tracked: ${outside.join(", ")}`);
    writeState(root, { ...state, files: [...new Set([...(state.files ?? []), ...rels])] });
    console.log(`tracking ${rels.join(", ")}`);
  },

  async status(args) {
    const root = findRoot(process.cwd());
    const configNotice = readConfigNotice(process.env.CLAUDE_PROJECT_DIR || process.cwd()) || (root && readConfigNotice(root));
    if (!root) {
      if (configNotice) console.error(configNotice);
      die(`no ${STATE_DIR}/state.json here or above — run \`skel init "<title>"\` first`);
    }
    const state = readState(root);
    if (!validState(state)) {
      const error = `can't read ${path.join(root, STATE_DIR, "state.json")}; repair that file or run \`skel init --force "<title>"\` from ${root} (requires approval in Claude Code)`;
      if (args.includes("--json")) {
        console.log(JSON.stringify({ error, configNotice }, null, 2));
        process.exitCode = 1;
        return;
      }
      if (configNotice) console.error(configNotice);
      die(error);
    }
    const { steps, errors, files } = snapshot(root);
    const drift = state.phase === "fill" ? verifySnapshot(root, state, files) : null;
    const stores = await storeNotice(root);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ...state, errors, drift, configNotice, ...(stores ? { storeNotice: stores } : {}), steps: steps.map(({ fences, ...s }) => ({
        ...s, fences: fences.map(({ body, ...f }) => f),
      })) }, null, 2));
      return;
    }
    const done = steps.filter((s) => s.status === "filled").length;
    console.log(`${state.title} — phase: ${state.phase}${state.activeStep ? `, active: ${state.activeStep}` : ""} — ${done}/${steps.length} filled`);
    if (configNotice) console.log(configNotice);
    for (const s of steps) {
      const mark = s.id === state.activeStep ? "▶" : s.status === "filled" ? "✓" : "·";
      console.log(`  ${mark} ${s.id.padEnd(5)} ${s.title}  (${s.fences.map((f) => `${f.file}:${f.openLine}`).join(", ")})`);
    }
    for (const e of errors) console.log(`  ! ${e}`);
    if (stores) console.log(`  ! ${stores}`);
    if (drift && !drift.ok) console.log(`  ! ${formatDrift(drift).replace(/\n/g, "\n    ")}\n    (skel done and skel finalize refuse until it's resolved)`);
    // Diagram nodes named step_<id> that match no step are silently uncolored
    // on the page; say so here.
    for (const d of readDiagrams(root)) {
      const ids = [...d.source.matchAll(/\bstep_([A-Za-z0-9_]+)/g)].map((m) => m[1].replace(/_/g, "."));
      const unknown = [...new Set(ids)].filter((id) => !steps.some((st) => st.id === id));
      if (unknown.length) console.log(`  ! diagram ${d.name}: node${unknown.length > 1 ? "s" : ""} ${unknown.map((i) => `step_${i.replace(/\./g, "_")}`).join(", ")} match no step`);
    }
  },

  review() {
    const root = requireRoot();
    const out = writeReview(root, requireState(root));
    console.log(out);
    console.log(`file://${out}`);
  },

  async serve(args) {
    const root = requireRoot();
    const running = await liveServer(root);
    if (args.includes("--stop")) {
      if (running) { try { process.kill(running.pid); } catch (err) { if (err.code !== "ESRCH") throw err; } console.log(`stopped the review server (${running.url})`); }
      else console.log("no review server running");
      fs.rmSync(servePath(root), { force: true });
      return;
    }
    requireState(root);
    const feedbackEnabled = args.includes("--send");
    const mode = feedbackEnabled ? "feedback enabled" : "read-only";
    // A verified server is reused, and its token kept, only if its reads are
    // shown to need that token. Anything else from before #39 is replaced.
    const protectedReads = running ? await readsProtected(running) : false;
    if (running && protectedReads && running.feedbackEnabled === feedbackEnabled && running.storeProtocol >= STORE_PROTOCOL) {
      console.log(`skel review: ${running.url}#t=${running.token} (${mode}; already running; \`skel serve --stop\` stops it)`);
      return;
    }
    if (running) {
      try { process.kill(running.pid); } catch (err) { if (err.code !== "ESRCH") throw err; }
      if (!protectedReads) console.log("replaced the running review server: it didn't show that its reads need the review token. Reload any tab still open on it, using the URL below.");
    }
    const { session } = feedbackEnabled ? newServeSession() : {};
    // One token, for reading and for Send: the page must hold it to do either,
    // so a second one would protect nothing from whatever can read the first.
    // A mode switch replaces a server we just verified, whose reads need its
    // token, and keeps that token, so open tabs follow it and reload. Any other
    // start gets a fresh one: a token left in serve.json by a dead server,
    // shipped in a repo, or never guarding reads isn't picked up, unless a
    // local process answers for it and passes readsProtected (same-user: out of
    // scope, and it could read the real token anyway).
    const token = protectedReads ? running.token : crypto.randomBytes(24).toString("hex");
    const tokenOk = (req) => {
      const given = Buffer.from(String(req.headers["x-skeleton-token"] ?? ""));
      const want = Buffer.from(token);
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    };
    const serverId = crypto.randomBytes(12).toString("hex");
    // The session store vouches for this run's feedback. If it can't be
    // written, still serve the page (it's useful to read), but say plainly
    // that what's sent from it won't reach the agent (and refuse sends).
    let recorded = true;
    try {
      if (feedbackEnabled) addSession(root, session);
    } catch (err) {
      recorded = false;
      console.error(
        `skel: warning: can't record this review session in ${err.path ?? "skel's state dir"} (${err.code ?? err.message}). ` +
          "The page works, but it can't send feedback; copy it by hand, or make that directory writable (or set XDG_STATE_HOME) and restart `skel serve`.",
      );
    }
    warnLegacyQueue(root);
    // Polls re-stat only the skeleton's own files (fenced and tracked); finding
    // fences in NEW files takes a full search, which runs in a child process
    // so it never blocks a request (a git grep on WSL's /mnt/c can take
    // seconds). It runs every 30s while a page is polling, and on a page load
    // once the last one is >5s old.
    const cache = new Map();
    let known = scanRepo(root, cache).files.map((f) => path.join(root, f));
    let searching = false;
    let lastSearch = Date.now();
    let lastPoll = 0;
    // Tracked files the search would look in (not gitignored, not under a
    // skipped dir), so one that gains fences shows up on the next poll, not
    // the next search. Ones the search excludes stay out: the page and the
    // CLI agree on the steps. Asked once per file between searches.
    const trackedSearchable = new Map();
    const pollTracked = (state) => {
      const rels = (state.files ?? []).map(String).filter((rel) => insideRoot(root, path.join(root, rel)));
      const fresh = rels.filter((rel) => !trackedSearchable.has(rel));
      if (fresh.length) {
        const ok = new Set(searchable(root, fresh));
        for (const rel of fresh) trackedSearchable.set(rel, ok.has(rel));
      }
      return rels.filter((rel) => trackedSearchable.get(rel)).map((rel) => path.join(root, rel));
    };
    const refresh = () => {
      if (searching) return;
      searching = true;
      execFile(process.execPath, [SELF, "__candidates"], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, out) => {
        searching = false;
        lastSearch = Date.now();
        if (!err) { try { known = JSON.parse(out); } catch {} }
        // .gitignore may have changed: ask again about tracked files.
        trackedSearchable.clear();
      });
    };
    setInterval(() => { if (Date.now() - lastPoll < 60_000) refresh(); }, 30_000).unref();
    const current = () => {
      const state = readState(root);
      // Tracked files are polled for fences only if the search would look in
      // them (pollTracked); buildReviewData reads the others' text itself.
      // Keep watching files that have fences or malformed markers until the
      // next search.
      const { record, ...data } = buildReviewData(root, state, cache, [...new Set([...known, ...pollTracked(state)])]);
      const watched = [...data.steps.flatMap((st) => st.locations.map((l) => l.file)), ...data.errored];
      known = [...new Set([...known, ...watched.map((f) => path.join(root, f))])];
      const { generatedAt, errored, ...stable } = data;
      return { data, record, version: crypto.createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 12) };
    };
    const superseded = () => readServe(root)?.serverId !== serverId;
    let origin = "";
    const hosts = new Set();
    const server = http.createServer((req, res) => {
      // Refusals answer before reading a body; drain it so the client gets the
      // status instead of a connection reset (Windows resets on unread input).
      const refuse = (code, text) => { req.resume(); res.writeHead(code, { connection: "close" }).end(text); };
      try {
        // DNS rebinding: only answer requests addressed to us by name.
        if (!hosts.has(String(req.headers.host ?? "").toLowerCase())) return void refuse(421, "misdirected request");
        if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
          // The shell and the client script are the same for every project:
          // no source, no token. Everything else needs the token.
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "content-security-policy": SHELL_CSP,
          });
          res.end(renderShell());
        } else if (req.method === "GET" && req.url === "/assets/review.js") {
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(clientScript());
        } else if (req.method === "GET" && (req.url === "/api/data" || req.url === "/api/version") && !tokenOk(req)) {
          refuse(401, "this needs the review token: open the URL `skel serve` prints");
        } else if (req.method === "GET" && req.url === "/api/data") {
          lastPoll = Date.now();
          // Serve what we know now; the page's polls pick up the search's result.
          if (Date.now() - lastSearch > 5_000) refresh();
          const { data, record, version } = current();
          // Remember what the human was shown, so `skel approve` can diff
          // against the version they reviewed. This is the read that shows
          // it: the shell alone shows nothing.
          noteRendered(root, record);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
          res.end(JSON.stringify(pagePayload(data, { version, feedbackEnabled, serverId })));
        } else if (req.method === "GET" && req.url === "/api/version") {
          lastPoll = Date.now();
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          const now = current();
          res.end(JSON.stringify({ version: now.version, skeletonVersion: now.data.skeletonVersion, serverId, pid: process.pid, feedbackEnabled, storeProtocol: STORE_PROTOCOL, readAuth: READ_AUTH }));
        } else if (req.method === "POST" && req.url === "/api/feedback") {
          if (!feedbackEnabled) { req.resume(); return void res.writeHead(405, { Allow: "GET", connection: "close" }).end("read-only review; reload and use Copy feedback for Claude"); }
          // Cross-site writes: same origin, a JSON content type (forces a CORS
          // preflight we never answer), and the review token from the page.
          const sameOrigin = !req.headers.origin || hosts.has(String(req.headers.origin).replace(/^https?:\/\//, "").toLowerCase());
          const json = String(req.headers["content-type"] ?? "").split(";")[0].trim() === "application/json";
          if (!sameOrigin || !json || !tokenOk(req)) return void refuse(403, "forbidden");
          // A newer server (or a new skeleton) took over: don't accept notes
          // the agent would no longer trust.
          if (superseded()) return void refuse(409, `this review page is out of date; reload ${readServe(root)?.url ?? "the new review URL"}`);
          if (!recorded) return void refuse(503, "skel serve couldn't record its session, so Claude wouldn't trust this feedback; copy it to Claude by hand");
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
          req.on("end", () => {
            try {
              const fb = cleanFeedback(JSON.parse(body));
              const now = current().data.skeletonVersion;
              storeFeedback(root, session, fb, now);
              // A page that was already out of date is told so (the notes are
              // still delivered, marked stale).
              if (fb.version && fb.version !== now) {
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ stale: true, reviewed: fb.version, current: now }));
              } else res.writeHead(204).end();
            } catch {
              res.writeHead(400).end("bad feedback payload");
            }
          });
        } else {
          res.writeHead(404).end("not found");
        }
      } catch {
        res.writeHead(500).end("internal error");
      }
    });
    // A stable port per project keeps the page's origin, and with it the
    // viewer's unsent drafts, across restarts.
    const preferred = Number(flag(args, "port", "0")) || 41000 + (Number.parseInt(crypto.createHash("sha1").update(root).digest("hex").slice(0, 6), 16) % 8000);
    const onListening = () => {
      const p = server.address().port;
      for (const h of [`127.0.0.1:${p}`, `localhost:${p}`]) hosts.add(h);
      origin = `http://127.0.0.1:${p}`;
      writeFileAtomic(servePath(root), JSON.stringify({ url: `${origin}/`, port: p, pid: process.pid, serverId, feedbackEnabled, token }), 0o600);
      console.log(`skel review: ${origin}/#t=${token} (${mode})`);
    };
    server.once("error", (err) => {
      if (err.code !== "EADDRINUSE") throw err;
      server.listen(0, "127.0.0.1", onListening);
    });
    server.listen(preferred, "127.0.0.1", onListening);
  },

  // Internal: the full fence search, run by `serve` in a child process.
  __candidates() {
    const root = requireRoot();
    console.log(JSON.stringify(scanRepo(root).files.map((f) => path.join(root, f))));
  },

  async feedback(args) {
    const root = requireRoot();
    // The agent's Bash tool times out at 120s by default: keep each wait under
    // it and let the skill loop.
    const wait = Math.min(Number(flag(args, "wait", "0")) || 0, 110);
    const deadline = Date.now() + wait * 1000;
    let readonly = false;
    // No server (a static review, or it stopped): nothing can send, so don't
    // sit out the wait. Only once none has answered for NO_SERVER_GRACE in a
    // row: `skel serve` scans the project before it listens (and only then
    // writes serve.json), so one just started in the background, or
    // restarting, must not be mistaken for none.
    let noServer = false;
    let missingSince = null;
    while (pendingCount(root) === 0) {
      const live = await liveServer(root);
      if (live?.feedbackEnabled === false) { readonly = true; break; }
      missingSince = live ? null : missingSince ?? Date.now();
      if (wait && missingSince !== null && Date.now() - missingSince >= NO_SERVER_GRACE) { noServer = true; break; }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    warnLegacyQueue(root);
    const taken = takeFeedback(root);
    if (taken.quarantined) {
      console.log(
        `ignored ${taken.quarantined} feedback file(s) that didn't come from this \`skel serve\` run (moved to ${STATE_DIR}/feedback-history). ` +
          "They are not the human's feedback; don't act on them.\n",
      );
    }
    if (taken.status === "ok") console.log(feedbackMarkdown(requireState(root).title, mergeRecords(taken.records)));
    else if (readonly) console.log("READ_ONLY: the review is read-only; the human's feedback arrives as a chat message. Wait for it; don't poll. Only if the human asks for direct Send: skel serve --send.");
    else if (noServer) console.log("NO_SERVER: no review server is running (a static review, or it stopped), so nothing can be sent; the human's feedback arrives as a chat message. Wait for it; don't poll.");
    else console.log(`NO_FEEDBACK${wait ? ` (waited ${wait}s)` : ""}`);
  },

  async approve(args) {
    const given = flag(args, "reviewed", null);
    if (given !== null && !isVersion(given)) die('--reviewed takes the 12-character version the human reviewed (the "Reviewed skeleton version: …" line of their feedback)');
    const root = requireRoot();
    const state = requireState(root);
    if (state.phase !== "scaffold") die(`the skeleton is already ${state.phase === "fill" ? "approved and being filled" : "finalized"}`);
    const { steps, errors, files } = snapshot(root);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    if (!steps.length) die("no SKEL[...] fences found — nothing to approve");
    // The loaded hook requests permission (see evaluateBash); permission modes
    // and integrations determine who answers. This checks freshness, not
    // human authority: that what is approved is the version the human
    // last reviewed, so an edit made after their "looks good" can't ride along.
    // A tracked file's malformed markers throw SKEL_MARKERS; anything else is I/O.
    let record;
    try {
      record = recordSkeleton(root, state, files, undefined, { strict: true });
    } catch (err) {
      if (err.code === "SKEL_MARKERS") die(`fix marker errors first:\n  ${err.message}`);
      die(`couldn't read the skeleton to record it: ${err.message}`);
    }
    const { record: last, unread } = lastReview(root, state.reviewEpoch);
    if (unread) die(`the human sent feedback you haven't read yet (${unread} send${unread > 1 ? "s" : ""}). Run \`skel feedback\` first; approve only if they still agree.`);
    // What the human reviewed: the version named in the feedback the agent
    // was given (copied markdown → --reviewed), else the page's latest send,
    // else the version the review page (live or `skel review`) last rendered.
    // Under the read-only default the last is the common case: approving what
    // the page showed is fine, approving something it never showed is not.
    let review = null;
    if (given) review = { version: given, source: "reviewed-flag", at: null, how: "the human reviewed" };
    else if (last?.version) review = { version: last.version, source: "review-page", at: last.at, how: "the human reviewed" };
    let storeError = null;
    if (!review) {
      const store = readRenderedStore(root);
      storeError = store.unreadable;
      const shown = store.versions[0];
      if (shown) review = { version: shown.version, source: "rendered", at: shown.at, how: "no --reviewed was given and nothing was sent; the review page last showed" };
    }
    if (review && review.version !== record.version) die(staleReview(root, state, files, review.version, review.how));
    if (!review) console.log(`note: no reviewed version given (pass --reviewed <v> from the "Reviewed skeleton version" line of the feedback the human pasted), no send on record, and ${storeError ? `the rendered-versions store couldn't be read (${storeError}), so there's no rendered version to check against` : "no review page was ever rendered for this project"}. Approving on the human's word alone.`);
    console.log(`skeleton version ${record.version}: ${Object.keys(record.files).length} file(s), ${record.fences.length} fence(s)`);
    const next = { ...state, phase: "fill", activeStep: null, reviewEpoch: Date.now() };
    try {
      writeSnapshot(root, next, files, record, review && { version: review.version, source: review.source, at: review.at });
    } catch (err) {
      die(`couldn't record the approved skeleton: ${err.message}`);
    }
    writeState(root, next);
    console.log(`skeleton approved: ${steps.length} steps, version ${record.version}${review ? (review.source === "rendered" ? " (the version the review page last showed)" : " (the version the human reviewed)") : ""}. Run \`skel next\` to start filling.`);
    // This is where a record in an unguarded state dir gets used: say so, don't refuse.
    if (installStatus(root, skelStateDir()).status === "stale") console.log(`warning: ${await storeNotice(root)}`);
  },

  next() {
    const root = requireRoot();
    const state = requireState(root);
    if (state.phase !== "fill") die(`phase is ${state.phase} — the skeleton must be approved first (skel approve)`);
    const { steps } = snapshot(root);
    if (state.activeStep) {
      const active = steps.find((s) => s.id === state.activeStep);
      if (active) {
        console.log(`STEP ${active.id} is still active: ${active.title}`);
        printFences(active);
        return;
      }
    }
    const step = steps.find((s) => s.status === "todo");
    if (!step) {
      console.log("all steps filled — run `skel finalize` when the human is happy");
      return;
    }
    setActive(root, state, step);
  },

  start(args) {
    const force = args.includes("--force");
    const id = args.find((a) => a !== "--force");
    if (!id) die("usage: skel start <id> [--force]");
    const root = requireRoot();
    const state = requireState(root);
    if (state.phase !== "fill") die(`phase is ${state.phase} — the skeleton must be approved first (skel approve)`);
    const { steps } = snapshot(root);
    const step = steps.find((s) => s.id === id);
    if (!step) die(`no step ${id}; steps are ${steps.map((s) => s.id).join(", ") || "(none)"}`);
    const active = steps.find((s) => s.id === state.activeStep);
    if (active && active.id !== id && active.status === "todo" && !force) {
      die(`step ${active.id} is still active with SKEL_TODO left; finish it (skel done) or abandon it with --force`);
    }
    const skipped = steps.slice(0, steps.indexOf(step)).filter((s) => s.status === "todo" && s.id !== id);
    if (skipped.length) console.log(`note: starting out of build order; ${skipped.map((s) => s.id).join(", ")} still pending before it`);
    setActive(root, state, step, force);
  },

  async done() {
    const root = requireRoot();
    const state = requireState(root);
    if (!state.activeStep) die("no active step");
    const { steps, errors, files } = snapshot(root);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    requireNoDrift(root, state, files, `finish step ${state.activeStep}`);
    const step = steps.find((s) => s.id === state.activeStep);
    if (!step) die(`step ${state.activeStep}'s fence is gone — its markers were removed or broken`);
    if (step.status === "todo") {
      const left = step.fences.filter((f) => f.status === "todo").map((f) => `${f.file}:${f.openLine}`);
      die(`step ${step.id} still has SKEL_TODO in ${left.join(", ")}`);
    }
    // The exterior check can't see a body that closes its own block and opens
    // a new one before the fence ends (the code after the fence is unchanged).
    // The hook's heuristic catches that for Edit/Write; repeat it here, as a
    // note, for fills it didn't see. A heuristic, so it never blocks.
    let bodyEscapesFence;
    try { ({ bodyEscapesFence } = await import("../lib/gate.mjs")); }
    catch (err) { die(`can't load the gate; restore or repair the skeleton-skills checkout from a terminal or ! shell mode (${err.message})`); }
    for (const f of step.fences) {
      const marker = fs.readFileSync(path.join(root, f.file), "utf-8").split("\n")[f.openLine - 1] ?? "";
      const escape = bodyEscapesFence(f.body.replace(/\r$/gm, ""), marker.replace(/\r$/, ""), f.file);
      if (escape) console.log(`note: in ${f.file}:${f.openLine}-${f.closeLine}, ${escape} (a heuristic; check that the fill stays inside its block)`);
    }
    writeState(root, { ...state, activeStep: null });
    const pending = steps.filter((s) => s.status === "todo" && s.id !== state.activeStep);
    console.log(`STEP ${state.activeStep} done. ${pending.length} pending${pending[0] ? `; next: ${pending[0].id} ${pending[0].title}` : ""}.`);
  },

  reshape(args) {
    const root = requireRoot();
    const state = requireState(root);
    if (state.phase !== "fill") die(state.phase === "done" ? "this skeleton is finalized; start a new one with skel init" : "the skeleton is already open for changes");
    writeState(root, { ...state, phase: "scaffold", activeStep: null, reviewEpoch: Date.now() });
    // The record is of the shape being reopened; approve writes the new one.
    clearSnapshot(root);
    clearConfigNotices(root);
    console.log("back to skeleton review: edits are unfenced; get the human's approval again, then `skel approve`.");
  },

  finalize() {
    const root = requireRoot();
    const state = requireState(root);
    const phase = state.phase;
    if (phase !== "fill") die(phase === "done" ? "already finalized" : "the skeleton hasn't been approved and filled yet");
    const { fences, errors, files: fenced } = scanSkeleton(root, state);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    requireNoDrift(root, state, fenced, "finalize");
    const pending = fences.filter((f) => f.status === "todo");
    if (pending.length) die(`still pending: ${pending.map((f) => `${f.id} (${f.file}:${f.openLine})`).join(", ")}`);
    const files = [...new Set(fences.map((f) => f.file))];
    for (const rel of files) {
      const abs = path.join(root, rel);
      writeFileAtomic(abs, stripMarkers(fs.readFileSync(abs, "utf-8")), fs.statSync(abs).mode & 0o777);
    }
    writeState(root, { ...readState(root), phase: "done", activeStep: null });
    clearSnapshot(root);
    clearConfigNotices(root);
    console.log(`finalized: stripped markers from ${files.length} file(s)`);
  },

  async hook() {
    const { runHook } = await import("../lib/hook.mjs");
    await runHook();
  },

  async "stop-hook"(args) {
    const { BLOCK_ON_DRIFT, runStopHook } = await import("../lib/stop.mjs");
    await runStopHook({ block: BLOCK_ON_DRIFT || args.includes("--block") });
  },

  async install([dir = process.cwd()]) {
    // The hook command runs through a shell: refuse an install path that a
    // shell would interpret rather than quote it and hope. Windows paths are
    // written with forward slashes (Node accepts them), so their backslashes
    // never reach the shell.
    if (/["'`$\n\r]/.test(PKG_ROOT) || (process.platform !== "win32" && PKG_ROOT.includes("\\"))) {
      die(`can't install from a path containing quotes, $, backticks${process.platform === "win32" ? "" : " or backslashes"}: ${PKG_ROOT}`);
    }
    const { target, claudeDir, settingsPath, settings } = openProjectSettings(dir, { forInstall: true });
    const { rules: stateRules, why } = denyRules(target);
    const stores = storeDenyRules();
    const rules = [...new Set([...stateRules, ...stores.map((s) => s.rule).filter(Boolean)])];
    const prevOwned = readOwned(target);
    const stale = [...legacyOwned(settings, prevOwned), ...(prevOwned ?? []).filter((r) => !rules.includes(r))];
    for (const [src, dest] of installedFiles(claudeDir)) {
      writeFileAtomic(dest, fs.readFileSync(src, "utf-8").replaceAll("{{SKEL}}", `node "${SELF}"`));
    }
    const command = `node "${HOOK}"`;
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    const matcher = "Write|Edit|MultiEdit|NotebookEdit|Bash";
    // Shared matchers and metadata belong to the user's remaining hooks.
    let ours = false;
    let firstHook = null;
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((group) => {
      if (!Array.isArray(group?.hooks)) return true;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((hook) => {
        if (!isSkelHook(hook?.command)) return true;
        firstHook ??= hook;
        return false;
      });
      const removed = group.hooks.length !== before;
      ours ||= removed;
      return !removed || group.hooks.length > 0;
    });
    settings.hooks.PreToolUse.push({ matcher, hooks: [{ ...(firstHook ?? { type: "command" }), command }] });
    // The Stop hook checks for drift at the end of every turn during a fill.
    // Found by its script, so a moved clone is updated in place, duplicates
    // (two installs, a hand-added copy) collapse to the first, and a `--block`
    // on any of them survives a reinstall.
    const stopCommand = `node "${STOP_HOOK}"`;
    settings.hooks.Stop ??= [];
    let stopOurs = null;
    let block = false;
    const emptied = new Set();
    for (const m of settings.hooks.Stop) {
      if (!Array.isArray(m?.hooks) || !m.hooks.length) continue;
      m.hooks = m.hooks.filter((hk) => {
        const found = skelStopHook(hk?.command);
        if (!found) return true;
        block ||= found.block;
        if (stopOurs) return false;
        stopOurs = hk;
        return true;
      });
      if (!m.hooks.length) emptied.add(m);
    }
    settings.hooks.Stop = settings.hooks.Stop.filter((m) => !emptied.has(m));
    if (stopOurs) stopOurs.command = stopCommand + (block ? " --block" : "");
    else settings.hooks.Stop.push({ hooks: [{ type: "command", command: stopCommand }] });
    // Freeze ordinary settings reloads during a fill. Keep other hooks and
    // groups; remove only our exact standalone command, including moved clones.
    settings.hooks.ConfigChange ??= [];
    const configGroups = settings.hooks.ConfigChange;
    const emptiedConfigs = new Set();
    for (const group of configGroups) {
      if (!Array.isArray(group?.hooks) || !group.hooks.length) continue;
      group.hooks = group.hooks.filter((hk) => !isSkelConfigHook(hk?.command));
      if (!group.hooks.length) emptiedConfigs.add(group);
    }
    settings.hooks.ConfigChange = configGroups.filter((g) => !emptiedConfigs.has(g));
    settings.hooks.ConfigChange.push({
      matcher: "user_settings|project_settings|local_settings",
      hooks: [{ type: "command", command: `node "${CONFIG_HOOK}"` }],
    });
    settings.permissions ??= {};
    settings.permissions.deny = (settings.permissions.deny ?? []).filter((r) => !stale.includes(r));
    const added = rules.filter((r) => !settings.permissions.deny.includes(r));
    settings.permissions.deny.push(...added);
    // Ours: what we add now, plus what an earlier install added and still owns.
    // A rule that was already there and isn't recorded stays the user's.
    // Settings first: a failed write must never record rules that weren't added.
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    writeOwned(target, rules.filter((r) => added.includes(r) || prevOwned?.includes(r)));
    // .skeleton/ is per-run state (and holds the human's feedback): keep it
    // out of commits, so a repo can't ship a verdict.
    const gi = path.join(target, ".gitignore");
    const giText = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
    if (!/^\/?\.skeleton\/?$/m.test(giText)) fs.appendFileSync(gi, `${giText && !giText.endsWith("\n") ? "\n" : ""}.skeleton/\n`);
    console.log(`installed /skeleton and /skeleton-fill into ${claudeDir}/skills`);
    console.log(`installed the skeleton-filler subagent into ${claudeDir}/agents (restart Claude Code if that folder is new)`);
    console.log(ours ? "scope gate hook updated" : `added scope gate hook to ${settingsPath}`);
    console.log(stopOurs ? "drift check (Stop) hook updated" : `added drift check (Stop) hook to ${settingsPath}`);
    console.log(`settings-reload guard (ConfigChange) configured; settings changes are held during a fill`);
    const addedState = added.filter((r) => stateRules.includes(r));
    if (why) console.log(`warning: no permission deny rules for ${STATE_DIR}/ state: ${why}. The hook still guards it; to get the rules too, move the project to a plainer path and re-run install`);
    else console.log(addedState.length ? `added ${addedState.length} permission deny rule(s) for ${STATE_DIR}/ state` : `permission deny rules for ${STATE_DIR}/ already present`);
    for (const { name, rule, why: noRule } of stores) {
      if (noRule) console.log(`warning: no permission deny rule for skel's ${name}: ${noRule}. The hook still asks about edits there`);
      else console.log(`${added.includes(rule) ? `added a permission deny rule for skel's ${name}` : `permission deny rule for skel's ${name} already present`}: ${rule} (it is resolved now: re-run install if you change XDG_STATE_HOME or XDG_CONFIG_HOME)`);
    }
    reportLeftInPlace(settings, rules);
    launchWarning(target);
    if (enrollment(target).protected) console.log("note: a fill is active, so a running Claude Code session won't reload these settings: it keeps enforcing the rules it loaded until you restart it.");
    const storesNote = await storeNotice(target);
    if (storesNote) console.log(`note: ${storesNote}`);
    console.log(`optional: Claude Code's Bash sandbox can enforce those rules at the OS level; see "Security model" in the README (skel needs "excludedCommands": ["node \\"${SELF}\\" *"])`);
  },

  /**
   * The one thing that moves records out of the old config dir. A human asks for
   * it (the hook asks them when an agent runs it), and never during a fill: the
   * guard then holds settings reloads, so the session's loaded deny rule still
   * names only the old dir. What a session has loaded can't be read from here,
   * so the rest is the note at the end.
   */
  async migrate(args) {
    const unknown = args.find((a) => a.startsWith("-") && a !== "--dry-run");
    if (unknown) die(`unknown option ${unknown}\nusage: skel migrate [--dry-run] [projectDir]`);
    const dirs = args.filter((a) => a !== "--dry-run");
    if (dirs.length > 1) die("usage: skel migrate [--dry-run] [projectDir]");
    const root = dirs[0] ? path.resolve(dirs[0]) : findRoot(process.cwd()) ?? process.cwd();
    if (!fs.existsSync(root)) die(`${root} doesn't exist`);
    const plan = migrationPlan(root);
    if (!plan.outcomes.length) return console.log(`nothing to migrate for ${root}: it uses ${usesLegacy(root) ? plan.from : plan.to}`);
    if (args.includes("--dry-run")) {
      console.log(`what \`skel migrate\` would do with this project's records, from ${plan.from} to ${plan.to} (nothing was changed):`);
      for (const o of plan.outcomes) console.log(`  ${path.basename(o.source)}: ${o.outcome}${o.why ? ` (${o.why})` : ""}`);
      return;
    }
    // Finishing a committed move changes nothing a session relies on.
    if (!plan.marked) {
      for (const base of new Set([root, process.env.CLAUDE_PROJECT_DIR].filter(Boolean))) {
        const status = enrollment(base);
        if (status.protected) die(`not migrating: ${status.reason}. Settings reloads are held until then, so the running session may enforce only the rule for ${plan.from}. Finish the skeleton first, or run \`skel reshape\`, which discards the approval so it has to be given again. Then restart Claude Code and run \`skel migrate\`. The records stay where they are, and skel keeps using them.`);
      }
      const install = installStatus(root, plan.to);
      if (install.status === "stale") die(`not migrating: ${install.why ?? `the settings in ${install.where} have no deny rule for ${plan.to}`}. Run \`skel install\` ${install.where ? `in ${install.where}` : "in the main checkout"} first, restart Claude Code so it loads the rule, then run \`skel migrate\`.`);
    }
    if (plan.problems.length) {
      // The real run words the refusal.
      try { migrateProject({ key: projectKey(root), from: plan.from, to: plan.to, keyOf: projectKey }); } catch (err) { die(err.message); }
    }
    // A server from before the state dir reads only the old location, and could
    // write to it during the move: stop it first. A current one follows the move.
    const running = await liveServer(root);
    if (running && running.storeProtocol < STORE_PROTOCOL) {
      try { process.kill(running.pid); } catch (err) { if (err.code !== "ESRCH") throw err; }
      console.log(`stopped the review server at ${running.url}: it could only read the old location. Run \`skel serve\` to start it again.`);
    }
    let moved;
    try {
      moved = migrateProject({ key: projectKey(root), from: plan.from, to: plan.to, keyOf: projectKey });
    } catch (err) {
      if (err.code === "SKEL_STATE_MIGRATION") die(err.message);
      throw err;
    }
    if (plan.marked) {
      console.log(`removed ${plan.stale.length} leftover file(s) from ${plan.from}`);
      for (const o of plan.outcomes.filter((x) => x.outcome === "keep")) console.log(`kept ${o.source}: ${o.why}`);
      return;
    }
    console.log(`moved ${moved} of this project's records from ${plan.from} to ${plan.to}`);
    launchWarning(root);
    console.log("note: a Claude Code session started before `skel install` still enforces only the old rule: restart it.");
  },

  uninstall([dir = process.cwd()]) {
    const { target, claudeDir, settingsPath, settings } = openProjectSettings(dir);
    const prevOwned = readOwned(target);
    const owned = [...(prevOwned ?? []), ...legacyOwned(settings, prevOwned)];
    const groups = settings.hooks?.PreToolUse ?? [];
    const emptied = new Set();
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((hook) => !isSkelHook(hook?.command));
      if (before && !group.hooks.length) emptied.add(group);
    }
    if (settings.hooks?.PreToolUse) {
      settings.hooks.PreToolUse = groups.filter((group) => !emptied.has(group));
      if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
    }
    // The drift check (Stop) hook, with or without --block.
    const stops = settings.hooks?.Stop ?? [];
    const emptiedStops = new Set();
    for (const m of stops) {
      if (!Array.isArray(m?.hooks) || !m.hooks.length) continue;
      m.hooks = m.hooks.filter((hk) => !skelStopHook(hk?.command));
      if (!m.hooks.length) emptiedStops.add(m);
    }
    if (settings.hooks?.Stop) {
      settings.hooks.Stop = stops.filter((m) => !emptiedStops.has(m));
      if (!settings.hooks.Stop.length) delete settings.hooks.Stop;
    }
    const configs = settings.hooks?.ConfigChange ?? [];
    const emptiedConfigs = new Set();
    for (const group of configs) {
      if (!Array.isArray(group?.hooks) || !group.hooks.length) continue;
      group.hooks = group.hooks.filter((hk) => !isSkelConfigHook(hk?.command));
      if (!group.hooks.length) emptiedConfigs.add(group);
    }
    if (settings.hooks?.ConfigChange) {
      settings.hooks.ConfigChange = configs.filter((g) => !emptiedConfigs.has(g));
      if (!settings.hooks.ConfigChange.length) delete settings.hooks.ConfigChange;
    }
    if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
    let removed = 0;
    let removedStores = 0;
    if (settings.permissions?.deny) {
      const gone = settings.permissions.deny.filter((r) => owned.includes(r));
      settings.permissions.deny = settings.permissions.deny.filter((r) => !owned.includes(r));
      removedStores = gone.filter((r) => STORE_SHAPED.test(r)).length;
      removed = gone.length - removedStores;
      if (!settings.permissions.deny.length) delete settings.permissions.deny;
      if (!Object.keys(settings.permissions).length) delete settings.permissions;
    }
    if (fs.existsSync(settingsPath)) writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    writeOwned(target, []);
    for (const name of SKILLS) {
      const skillDir = path.join(claudeDir, "skills", name);
      fs.rmSync(path.join(skillDir, "SKILL.md"), { force: true });
      try { fs.rmdirSync(skillDir); } catch {} // only if we left it empty
    }
    // The agents folder may hold the user's own subagents: leave it.
    fs.rmSync(path.join(claudeDir, "agents", `${AGENT}.md`), { force: true });
    console.log(`removed /skeleton, /skeleton-fill, the ${AGENT} subagent, the scope gate hook, the drift check (Stop) hook and the settings-reload (ConfigChange) hook from ${claudeDir}`);
    console.log("restart Claude Code if these hooks are already loaded; an external uninstall may not trigger a settings-reload event");
    console.log(`removed ${removed} ${STATE_DIR}/ permission deny rule(s) install added`);
    if (removedStores) console.log(`removed ${removedStores} store-dir permission deny rule(s) install added`);
    reportLeftInPlace(settings, []);
    console.log(`left in place: ${STATE_DIR}/ (delete it once you're done with it) and the ${STATE_DIR}/ line in .gitignore`);
  },
};

const [cmd = "help", ...rest] = process.argv.slice(2);
const run = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
if (!run) die(`unknown command "${cmd}"\n\n${HELP}`);
await run(rest);
