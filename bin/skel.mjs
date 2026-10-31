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
import { scanRepo, toSteps, stripMarkers } from "../lib/markers.mjs";
import { STATE_DIR, findRoot, readState, writeState, initState, insideRoot, writeFileAtomic } from "../lib/state.mjs";
import { bodyEscapesFence } from "../lib/gate.mjs";
import { buildReviewData, readDiagrams, renderHtml, writeReview } from "../lib/review.mjs";
import {
  cleanFeedback, feedbackMarkdown, mergeRecords, newServeSession,
  addSession, clearSessions, configPath, historyDir, legacyQueued, pendingCount, queueDir, readServe, servePath,
  sessionStorePath, storeFeedback, takeFeedback,
} from "../lib/feedback.mjs";
import { clearSnapshot, formatDrift, scanSkeleton, verifySnapshot, writeSnapshot } from "../lib/snapshot.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Forward slashes on every platform: these land in shell commands and skill text.
const SELF = path.join(PKG_ROOT, "bin", "skel.mjs").split(path.sep).join("/");
const HOOK = path.join(PKG_ROOT, "bin", "skel-hook.mjs").split(path.sep).join("/");

const HELP = `skel — plan as code skeleton, fill one fenced step at a time

  init "<title>" [--gate ask|deny] [--force]
                                     start a skeleton in this project (--force replaces an existing one)
  track <file...>                    show unfenced skeleton files (types, wiring) in the review too
  status [--json]                    phase, active step, every step's status
  review                             write .skeleton/review.html (static; copy feedback by hand)
  serve [--port N] [--send] [--stop] serve live read-only; --send enables feedback
  feedback [--wait SECONDS]          print (and archive) the human's latest feedback (waits up to 110s)
  approve                            enter the fill phase (inside Claude Code the hook asks the human first)
  next                               start the first pending step and print its fences
  start <id> [--force]               start a specific step (--force abandons an unfinished active step,
                                     or reopens a filled one for rework)
  done                               finish the active step (fails if SKEL_TODO remains, or on drift
                                     outside the fences from the approved skeleton)
  reshape                            back to skeleton review (inside Claude Code the hook asks the human first)
  finalize                           all steps filled and no drift: strip markers, phase done
  hook                               PreToolUse scope gate (reads hook JSON on stdin)
  install [projectDir]               install skills, filler subagent, hook and .skeleton/ deny rules into a
                                     project's .claude/
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

function snapshot(root, state = readState(root)) {
  const { fences, errors, files } = scanSkeleton(root, state);
  return { steps: toSteps(fences), errors, files };
}

/** Refuse when the working tree has drifted from the approved skeleton. */
function requireNoDrift(root, state, fencedFiles, what) {
  const drift = verifySnapshot(root, state, fencedFiles);
  if (!drift.ok) die(`can't ${what}: ${formatDrift(drift)}`);
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
 * a serve.json shipped in a repo) is never trusted, killed or handed out.
 */
async function liveServer(root) {
  const s = readServe(root);
  if (!s?.url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(s.url) || !s.serverId) return null;
  try {
    const res = await fetch(new URL("api/version", s.url), { signal: AbortSignal.timeout(1500) });
    const v = await res.json();
    return v.serverId === s.serverId && Number.isInteger(v.pid) ? { url: s.url, pid: v.pid, feedbackEnabled: v.feedbackEnabled !== false } : null;
  } catch {
    return null;
  }
}

/**
 * Feedback queued by a pre-upgrade server (whose session ids lived in the
 * project's serve.json) can't be verified, and isn't migrated: a committed
 * serve.json looks exactly like a real one, so trusting its list would let a
 * repo vouch for its own feedback again. Tell the human to send it again.
 */
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

/**
 * The deny rules for a project, or a reason they can't be written. The rule
 * path is a gitignore pattern: `[ ] * ?` are backslash-escaped so they match
 * literally (`( ) { }` aren't pattern characters and match as they are). A
 * path a rule can't spell (a newline, a literal backslash on POSIX, a Windows
 * path without a drive letter) gets no rules rather than rules that guard
 * something else; install still adds the hook and the skills.
 */
function denyRules(target) {
  let real = realDir(target);
  if (process.platform === "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(real);
    if (!m) return { rules: [], why: "only drive-letter paths can be written as rules on Windows" };
    real = `/${m[1].toLowerCase()}/${m[2].split("\\").join("/")}`;
  }
  real = real.replace(/\/+$/, "");
  if (/[\n\r\\]/.test(real)) return { rules: [], why: "the path contains a newline or a backslash, which a rule can't spell" };
  const escaped = real.replace(/[[\]*?]/g, (c) => `\\${c}`);
  return { rules: STATE_PATHS.map((p) => `Edit(/${escaped}/${STATE_DIR}/${p})`), why: null };
}

/**
 * Any deny rule shaped like one skel writes, for any project: the absolute
 * form or the old project-relative one. Used to report rules install and
 * uninstall leave alone (a moved project's, or ones whose ownership record
 * was lost), never to remove them.
 */
const SKEL_SHAPED = new RegExp(`^Edit\\((//.*)?/\\.skeleton/(${STATE_PATHS.map((p) => p.replace(/[.*]/g, (c) => `\\${c}`)).join("|")})\\)$`);
function reportLeftInPlace(settings, notOurs) {
  const left = (settings.permissions?.deny ?? []).filter((r) => typeof r === "string" && SKEL_SHAPED.test(r) && !notOurs.includes(r));
  if (!left.length) return;
  console.log(`left in place: ${left.length} ${STATE_DIR}/ deny rule(s) this install didn't add (a moved project's, a lost ownership record's, or your own); remove any you no longer want by hand:`);
  for (const r of left) console.log(`  ${r}`);
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
        if (!same(path.resolve(real, git("rev-parse", "--git-dir")), path.resolve(real, git("rev-parse", "--git-common-dir")))) why = "in a git worktree, Claude Code loads it from the main checkout's root";
      } catch {}
    }
  }
  if (why) console.log(`warning: the hook and the deny rules live in .claude/settings.local.json, and ${why}. Start Claude Code in ${real} itself, not a subdirectory.`);
}

/**
 * Which deny rules this install added, kept OUTSIDE the project (next to the
 * serve-session store), so uninstall removes only those: a rule the user
 * already had survives install + uninstall.
 */
const ownedStorePath = (target) => configPath(target, "-install");
function readOwned(target) {
  try {
    const o = JSON.parse(fs.readFileSync(ownedStorePath(target), "utf-8")).ownedDeny;
    return Array.isArray(o) ? o.filter((x) => typeof x === "string") : null;
  } catch {
    return null;
  }
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

/** The scope-gate hook command from any skel checkout (current or legacy form). */
const isSkelHook = (cmd) => typeof cmd === "string" && /^node "[^"]*[\\/]bin[\\/](skel-hook\.mjs"|skel\.mjs" hook)$/.test(cmd);

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
    // A new skeleton starts with no feedback and no review server: nothing
    // left over (or shipped in the repo) can pose as this review's notes.
    const old = await liveServer(root);
    if (old) { try { process.kill(old.pid); } catch {} }
    for (const f of [queueDir(root), historyDir(root), servePath(root)]) fs.rmSync(f, { force: true, recursive: true });
    try {
      clearSessions(root);
      clearSnapshot(root);
    } catch (err) {
      console.error(`skel: warning: couldn't clear the previous skeleton's review sessions and approval record in ${path.dirname(sessionStorePath(root))} (${err.code ?? err.message})`);
    }
    console.log(`skel: "${title}" started in ${root} (phase: scaffold, gate: ${gate})`);
  },

  track(args) {
    if (!args.length) die("usage: skel track <file...>");
    const root = requireRoot();
    const state = readState(root);
    const rels = args.map((a) => path.relative(root, path.resolve(a)).split(path.sep).join("/"));
    const missing = rels.filter((r) => !fs.existsSync(path.join(root, r)));
    if (missing.length) die(`not found: ${missing.join(", ")}`);
    const outside = rels.filter((r) => !insideRoot(root, path.join(root, r)) || !fs.statSync(path.join(root, r)).isFile());
    if (outside.length) die(`only files inside the project can be tracked: ${outside.join(", ")}`);
    writeState(root, { ...state, files: [...new Set([...(state.files ?? []), ...rels])] });
    console.log(`tracking ${rels.join(", ")}`);
  },

  status(args) {
    const root = requireRoot();
    const state = readState(root);
    const { steps, errors, files } = snapshot(root);
    const drift = state.phase === "fill" ? verifySnapshot(root, state, files) : null;
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ...state, errors, drift, steps: steps.map(({ fences, ...s }) => ({
        ...s, fences: fences.map(({ body, ...f }) => f),
      })) }, null, 2));
      return;
    }
    const done = steps.filter((s) => s.status === "filled").length;
    console.log(`${state.title} — phase: ${state.phase}${state.activeStep ? `, active: ${state.activeStep}` : ""} — ${done}/${steps.length} filled`);
    for (const s of steps) {
      const mark = s.id === state.activeStep ? "▶" : s.status === "filled" ? "✓" : "·";
      console.log(`  ${mark} ${s.id.padEnd(5)} ${s.title}  (${s.fences.map((f) => `${f.file}:${f.openLine}`).join(", ")})`);
    }
    for (const e of errors) console.log(`  ! ${e}`);
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
    const out = writeReview(root, readState(root));
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
    const feedbackEnabled = args.includes("--send");
    const mode = feedbackEnabled ? "feedback enabled" : "read-only";
    if (running && running.feedbackEnabled === feedbackEnabled) {
      console.log(`skel review: ${running.url} (${mode}; already running; \`skel serve --stop\` stops it)`);
      return;
    }
    if (running) { try { process.kill(running.pid); } catch (err) { if (err.code !== "ESRCH") throw err; } }
    const { session, token } = feedbackEnabled ? newServeSession() : {};
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
        `skel: warning: can't record this review session in ${sessionStorePath(root)} (${err.code ?? err.message}). ` +
          "The page works, but it can't send feedback; copy it by hand, or make that directory writable (or set XDG_CONFIG_HOME) and restart `skel serve`.",
      );
    }
    warnLegacyQueue(root);
    // Polls re-stat only the skeleton's own files; finding fences in NEW files
    // takes a full search, which runs in a child process so it never blocks a
    // request (a git grep on WSL's /mnt/c can take seconds). It runs every 30s
    // while a page is polling, and on a page load once the last one is >5s old.
    const cache = new Map();
    let known = scanRepo(root, cache).files.map((f) => path.join(root, f));
    let searching = false;
    let lastSearch = Date.now();
    let lastPoll = 0;
    const refresh = () => {
      if (searching) return;
      searching = true;
      execFile(process.execPath, [SELF, "__candidates"], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, out) => {
        searching = false;
        lastSearch = Date.now();
        if (!err) { try { known = JSON.parse(out); } catch {} }
      });
    };
    setInterval(() => { if (Date.now() - lastPoll < 60_000) refresh(); }, 30_000).unref();
    const current = () => {
      const state = readState(root);
      // Tracked files aren't polled for fences: the CLI's search doesn't see
      // the ones it excludes (gitignored, under .claude/), so neither does the
      // page. buildReviewData reads their text itself. Keep watching files
      // that have fences or malformed markers until the next search.
      const data = buildReviewData(root, state, cache, known);
      const watched = [...data.steps.flatMap((st) => st.locations.map((l) => l.file)), ...data.errored];
      known = [...new Set([...known, ...watched.map((f) => path.join(root, f))])];
      const { generatedAt, errored, ...stable } = data;
      return { data, version: crypto.createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 12) };
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
          lastPoll = Date.now();
          // Serve what we know now; the page's polls pick up the search's result.
          if (Date.now() - lastSearch > 5_000) refresh();
          const { data, version } = current();
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
          });
          res.end(renderHtml({ ...data, version }, { token: token ?? null, feedbackEnabled, serverId }));
        } else if (req.method === "GET" && req.url === "/api/version") {
          lastPoll = Date.now();
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ version: current().version, serverId, pid: process.pid, feedbackEnabled }));
        } else if (req.method === "POST" && req.url === "/api/feedback") {
          if (!feedbackEnabled) { req.resume(); return void res.writeHead(405, { Allow: "GET", connection: "close" }).end("read-only review; reload and use Copy feedback for Claude"); }
          // Cross-site writes: same origin, a JSON content type (forces a CORS
          // preflight we never answer), and the per-run token from the page.
          const sameOrigin = !req.headers.origin || hosts.has(String(req.headers.origin).replace(/^https?:\/\//, "").toLowerCase());
          const json = String(req.headers["content-type"] ?? "").split(";")[0].trim() === "application/json";
          const tokenOk = String(req.headers["x-skeleton-token"] ?? "") === token;
          if (!sameOrigin || !json || !tokenOk) return void refuse(403, "forbidden");
          // A newer server (or a new skeleton) took over: don't accept notes
          // the agent would no longer trust.
          if (superseded()) return void refuse(409, `this review page is out of date; reload ${readServe(root)?.url ?? "the new review URL"}`);
          if (!recorded) return void refuse(503, "skel serve couldn't record its session, so Claude wouldn't trust this feedback; copy it to Claude by hand");
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
          req.on("end", () => {
            try {
              storeFeedback(root, session, cleanFeedback(JSON.parse(body)));
              res.writeHead(204).end();
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
      writeFileAtomic(servePath(root), JSON.stringify({ url: `${origin}/`, port: p, pid: process.pid, serverId, feedbackEnabled }), 0o600);
      console.log(`skel review: ${origin}/ (${mode})`);
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
    while (pendingCount(root) === 0) {
      if ((await liveServer(root))?.feedbackEnabled === false) { readonly = true; break; }
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
    if (taken.status === "ok") console.log(feedbackMarkdown(readState(root).title, mergeRecords(taken.records)));
    else if (readonly) console.log("READ_ONLY (review server has feedback disabled; use `skel serve --send` to enable it)");
    else console.log(`NO_FEEDBACK${wait ? ` (waited ${wait}s)` : ""}`);
  },

  approve(args) {
    const root = requireRoot();
    const state = readState(root);
    if (state.phase !== "scaffold") die(`the skeleton is already ${state.phase === "fill" ? "approved and being filled" : "finalized"}`);
    const { steps, errors, files } = snapshot(root);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    if (!steps.length) die("no SKEL[...] fences found — nothing to approve");
    // The human's say-so is Claude Code's permission prompt: the hook always
    // asks before an agent runs `skel approve` (see evaluateBash). What they
    // approved is recorded, so done/finalize can check the fill against it.
    const next = { ...state, phase: "fill", activeStep: null, reviewEpoch: Date.now() };
    try {
      writeSnapshot(root, next, files);
    } catch (err) {
      if (err.code === "SKEL_MARKERS") die(`fix marker errors first:\n  ${err.message}`);
      die(`couldn't record the approved skeleton: ${err.message}`);
    }
    writeState(root, next);
    console.log(`skeleton approved: ${steps.length} steps. Run \`skel next\` to start filling.`);
  },

  next() {
    const root = requireRoot();
    const state = readState(root);
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
    const state = readState(root);
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

  done() {
    const root = requireRoot();
    const state = readState(root);
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
    const state = readState(root);
    if (state.phase !== "fill") die(state.phase === "done" ? "this skeleton is finalized; start a new one with skel init" : "the skeleton is already open for changes");
    writeState(root, { ...state, phase: "scaffold", activeStep: null, reviewEpoch: Date.now() });
    // The record is of the shape being reopened; approve writes the new one.
    clearSnapshot(root);
    console.log("back to skeleton review: edits are unfenced; get the human's approval again, then `skel approve`.");
  },

  finalize() {
    const root = requireRoot();
    const state = readState(root);
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
    console.log(`finalized: stripped markers from ${files.length} file(s)`);
  },

  async hook() {
    const { runHook } = await import("../lib/hook.mjs");
    await runHook();
  },

  install([dir = process.cwd()]) {
    // The hook command runs through a shell: refuse an install path that a
    // shell would interpret rather than quote it and hope. Windows paths are
    // written with forward slashes (Node accepts them), so their backslashes
    // never reach the shell.
    if (/["'`$\n\r]/.test(PKG_ROOT) || (process.platform !== "win32" && PKG_ROOT.includes("\\"))) {
      die(`can't install from a path containing quotes, $, backticks${process.platform === "win32" ? "" : " or backslashes"}: ${PKG_ROOT}`);
    }
    const { target, claudeDir, settingsPath, settings } = openProjectSettings(dir, { forInstall: true });
    const { rules, why } = denyRules(target);
    const prevOwned = readOwned(target);
    const stale = [...legacyOwned(settings, prevOwned), ...(prevOwned ?? []).filter((r) => !rules.includes(r))];
    for (const [src, dest] of installedFiles(claudeDir)) {
      writeFileAtomic(dest, fs.readFileSync(src, "utf-8").replaceAll("{{SKEL}}", `node "${SELF}"`));
    }
    const command = `node "${HOOK}"`;
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    const matcher = "Write|Edit|MultiEdit|NotebookEdit|Bash";
    const ours = settings.hooks.PreToolUse.find((m) => m?.hooks?.some?.((hk) => isSkelHook(hk?.command)));
    if (ours) {
      ours.matcher = matcher;
      for (const hk of ours.hooks) if (isSkelHook(hk?.command)) hk.command = command; // legacy or moved clone
    } else {
      settings.hooks.PreToolUse.push({ matcher, hooks: [{ type: "command", command }] });
    }
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
    if (why) console.log(`warning: no permission deny rules for ${STATE_DIR}/ state: ${why}. The hook still guards it; to get the rules too, move the project to a plainer path and re-run install`);
    else console.log(added.length ? `added ${added.length} permission deny rule(s) for ${STATE_DIR}/ state` : `permission deny rules for ${STATE_DIR}/ already present`);
    reportLeftInPlace(settings, rules);
    launchWarning(target);
    console.log(`optional: Claude Code's Bash sandbox can enforce those rules at the OS level; see "Security model" in the README (skel needs "excludedCommands": ["node \\"${SELF}\\" *"])`);
  },

  uninstall([dir = process.cwd()]) {
    const { target, claudeDir, settingsPath, settings } = openProjectSettings(dir);
    const prevOwned = readOwned(target);
    const owned = [...(prevOwned ?? []), ...legacyOwned(settings, prevOwned)];
    const groups = settings.hooks?.PreToolUse ?? [];
    for (const m of groups) if (Array.isArray(m?.hooks)) m.hooks = m.hooks.filter((hk) => !isSkelHook(hk?.command));
    if (settings.hooks?.PreToolUse) {
      settings.hooks.PreToolUse = groups.filter((m) => !Array.isArray(m?.hooks) || m.hooks.length);
      if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
    }
    let removed = 0;
    if (settings.permissions?.deny) {
      const before = settings.permissions.deny.length;
      settings.permissions.deny = settings.permissions.deny.filter((r) => !owned.includes(r));
      removed = before - settings.permissions.deny.length;
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
    console.log(`removed /skeleton, /skeleton-fill, the ${AGENT} subagent and the scope gate hook from ${claudeDir}`);
    console.log(`removed ${removed} ${STATE_DIR}/ permission deny rule(s) install added`);
    reportLeftInPlace(settings, []);
    console.log(`left in place: ${STATE_DIR}/ (delete it once you're done with it) and the ${STATE_DIR}/ line in .gitignore`);
  },
};

const [cmd = "help", ...rest] = process.argv.slice(2);
const run = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
if (!run) die(`unknown command "${cmd}"\n\n${HELP}`);
await run(rest);
