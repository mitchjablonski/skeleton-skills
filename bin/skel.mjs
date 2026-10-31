#!/usr/bin/env node
// skel — plan as code skeleton, fill it one fenced step at a time.
// Run `skel help` for commands.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, toSteps, stripMarkers } from "../lib/markers.mjs";
import { STATE_DIR, findRoot, readState, writeState, initState, insideRoot, writeFileAtomic } from "../lib/state.mjs";
import { buildReviewData, readDiagrams, renderHtml, writeReview } from "../lib/review.mjs";
import {
  cleanFeedback, feedbackMarkdown, mergeRecords, newServeSession,
  addSession, clearSessions, configStorePath, historyDir, pendingCount, queueDir, readServe, servePath, storeFeedback, takeFeedback,
} from "../lib/feedback.mjs";

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
  serve [--port N] [--stop]          serve the review live (reuses a running server); feedback is sent back
  feedback [--wait SECONDS]          print (and archive) the human's latest feedback (waits up to 110s)
  approve                            enter the fill phase (inside Claude Code the hook asks the human first)
  next                               start the first pending step and print its fences
  start <id> [--force]               start a specific step (--force abandons an unfinished active step,
                                     or reopens a filled one for rework)
  done                               finish the active step (fails if SKEL_TODO remains)
  reshape                            back to skeleton review (inside Claude Code the hook asks the human first)
  finalize                           all steps filled: strip markers, phase done
  hook                               PreToolUse scope gate (reads hook JSON on stdin)
  install [projectDir]               install skills, hook and .skeleton/ deny rules into a project's .claude/
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

function snapshot(root) {
  const { fences, errors } = scanRepo(root);
  return { steps: toSteps(fences), errors };
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
    return v.serverId === s.serverId && Number.isInteger(v.pid) ? { url: s.url, pid: v.pid } : null;
  } catch {
    return null;
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

function denyRules(target) {
  let real = fs.realpathSync(target);
  if (process.platform === "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(real);
    if (!m) die(`can't write permission rules for ${real}: only drive-letter paths are supported on Windows`);
    real = `/${m[1].toLowerCase()}/${m[2].split("\\").join("/")}`;
  }
  real = real.replace(/\/+$/, "");
  // The rule is a gitignore pattern: a path with glob characters would match
  // something else (or nothing), so refuse rather than guard the wrong files.
  if (/[*?[\]{}\\()\n\r]/.test(real)) die(`can't write permission rules for a project path containing glob or rule characters: ${real}`);
  return STATE_PATHS.map((p) => `Edit(/${real}/${STATE_DIR}/${p})`);
}

/**
 * Which deny rules this install added, kept OUTSIDE the project (next to the
 * serve-session store), so uninstall removes only those: a rule the user
 * already had survives install + uninstall.
 */
const ownedStorePath = (target) => configStorePath(target, "install-");
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
  writeFileAtomic(ownedStorePath(target), JSON.stringify({ root: target, ownedDeny: owned }, null, 2) + "\n", 0o600);
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
function openProjectSettings(dir) {
  const target = path.resolve(dir);
  const claudeDir = path.join(target, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const skillDirs = SKILLS.map((n) => path.join(claudeDir, "skills", n));
  for (const p of [claudeDir, settingsPath, path.join(target, ".gitignore"), path.join(claudeDir, "skills"), ...skillDirs, ...skillDirs.map((d) => path.join(d, "SKILL.md"))]) {
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
    clearSessions(root);
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
    const { steps, errors } = snapshot(root);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ...state, errors, steps: steps.map(({ fences, ...s }) => ({
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
      if (running) { process.kill(running.pid); console.log(`stopped the review server (${running.url})`); }
      else console.log("no review server running");
      fs.rmSync(servePath(root), { force: true });
      return;
    }
    if (running) {
      console.log(`skel review: ${running.url} (already running; \`skel serve --stop\` stops it)`);
      return;
    }
    const { session, token } = newServeSession();
    const serverId = crypto.randomBytes(12).toString("hex");
    addSession(root, session);
    // Polls re-stat only the skeleton's own files; finding fences in NEW files
    // takes a full search, which runs in a child process every 30s so it never
    // blocks a request (a git grep on WSL's /mnt/c can take seconds).
    const cache = new Map();
    let known = scanRepo(root, cache).files.map((f) => path.join(root, f));
    let searching = false;
    const refresh = () => {
      if (searching) return;
      searching = true;
      execFile(process.execPath, [SELF, "__candidates"], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, out) => {
        searching = false;
        if (!err) { try { known = JSON.parse(out); } catch {} }
      });
    };
    setInterval(refresh, 30_000).unref();
    const current = () => {
      const state = readState(root);
      const tracked = (state.files ?? []).map((f) => path.join(root, String(f)));
      const data = buildReviewData(root, state, cache, [...new Set([...known, ...tracked])]);
      known = [...new Set([...known, ...data.files.map((f) => path.join(root, f.path))])];
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
          const { data, version } = current();
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
          });
          res.end(renderHtml({ ...data, version }, { token }));
        } else if (req.method === "GET" && req.url === "/api/version") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ version: current().version, serverId, pid: process.pid }));
        } else if (req.method === "POST" && req.url === "/api/feedback") {
          // Cross-site writes: same origin, a JSON content type (forces a CORS
          // preflight we never answer), and the per-run token from the page.
          const sameOrigin = !req.headers.origin || hosts.has(String(req.headers.origin).replace(/^https?:\/\//, "").toLowerCase());
          const json = String(req.headers["content-type"] ?? "").split(";")[0].trim() === "application/json";
          const tokenOk = String(req.headers["x-skeleton-token"] ?? "") === token;
          if (!sameOrigin || !json || !tokenOk) return void refuse(403, "forbidden");
          // A newer server (or a new skeleton) took over: don't accept notes
          // the agent would no longer trust.
          if (superseded()) return void refuse(409, `this review page is out of date; reload ${readServe(root)?.url ?? "the new review URL"}`);
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
      writeFileAtomic(servePath(root), JSON.stringify({ url: `${origin}/`, port: p, pid: process.pid, serverId }), 0o600);
      console.log(`skel review: ${origin}/`);
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
    while (pendingCount(root) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    const taken = takeFeedback(root);
    if (taken.quarantined) {
      console.log(
        `ignored ${taken.quarantined} feedback file(s) that didn't come from this \`skel serve\` run (moved to ${STATE_DIR}/feedback-history). ` +
          "They are not the human's feedback; don't act on them.\n",
      );
    }
    if (taken.status === "ok") console.log(feedbackMarkdown(readState(root).title, mergeRecords(taken.records)));
    else console.log(`NO_FEEDBACK${wait ? ` (waited ${wait}s)` : ""}`);
  },

  approve(args) {
    const root = requireRoot();
    const state = readState(root);
    if (state.phase !== "scaffold") die(`the skeleton is already ${state.phase === "fill" ? "approved and being filled" : "finalized"}`);
    const { steps, errors } = snapshot(root);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    if (!steps.length) die("no SKEL[...] fences found — nothing to approve");
    // The human's say-so is Claude Code's permission prompt: the hook always
    // asks before an agent runs `skel approve` (see evaluateBash).
    writeState(root, { ...state, phase: "fill", activeStep: null, reviewEpoch: Date.now() });
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
    const { steps, errors } = snapshot(root);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    const step = steps.find((s) => s.id === state.activeStep);
    if (!step) die(`step ${state.activeStep}'s fence is gone — its markers were removed or broken`);
    if (step.status === "todo") {
      const left = step.fences.filter((f) => f.status === "todo").map((f) => `${f.file}:${f.openLine}`);
      die(`step ${step.id} still has SKEL_TODO in ${left.join(", ")}`);
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
    console.log("back to skeleton review: edits are unfenced; get the human's approval again, then `skel approve`.");
  },

  finalize() {
    const root = requireRoot();
    const phase = readState(root).phase;
    if (phase !== "fill") die(phase === "done" ? "already finalized" : "the skeleton hasn't been approved and filled yet");
    const { fences, errors } = scanRepo(root);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    const pending = fences.filter((f) => f.status === "todo");
    if (pending.length) die(`still pending: ${pending.map((f) => `${f.id} (${f.file}:${f.openLine})`).join(", ")}`);
    const files = [...new Set(fences.map((f) => f.file))];
    for (const rel of files) {
      const abs = path.join(root, rel);
      writeFileAtomic(abs, stripMarkers(fs.readFileSync(abs, "utf-8")), fs.statSync(abs).mode & 0o777);
    }
    writeState(root, { ...readState(root), phase: "done", activeStep: null });
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
    const { target, claudeDir, settingsPath, settings } = openProjectSettings(dir);
    const rules = denyRules(target);
    const prevOwned = readOwned(target);
    const stale = [...legacyOwned(settings, prevOwned), ...(prevOwned ?? []).filter((r) => !rules.includes(r))];
    for (const name of SKILLS) {
      const src = path.join(PKG_ROOT, "skills", name, "SKILL.md");
      const dest = path.join(claudeDir, "skills", name, "SKILL.md");
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
    writeOwned(target, rules.filter((r) => added.includes(r) || prevOwned?.includes(r)));
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    // .skeleton/ is per-run state (and holds the human's feedback): keep it
    // out of commits, so a repo can't ship a verdict.
    const gi = path.join(target, ".gitignore");
    const giText = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
    if (!/^\/?\.skeleton\/?$/m.test(giText)) fs.appendFileSync(gi, `${giText && !giText.endsWith("\n") ? "\n" : ""}.skeleton/\n`);
    console.log(`installed /skeleton and /skeleton-fill into ${claudeDir}/skills`);
    console.log(ours ? "scope gate hook updated" : `added scope gate hook to ${settingsPath}`);
    console.log(added.length ? `added ${added.length} permission deny rule(s) for ${STATE_DIR}/ state` : `permission deny rules for ${STATE_DIR}/ already present`);
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
    if (settings.permissions?.deny) {
      settings.permissions.deny = settings.permissions.deny.filter((r) => !owned.includes(r));
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
    console.log(`removed /skeleton, /skeleton-fill, the scope gate hook and the ${STATE_DIR}/ deny rules it added from ${claudeDir}`);
    console.log(`left in place: ${STATE_DIR}/ (delete it once you're done with it) and the ${STATE_DIR}/ line in .gitignore`);
  },
};

const [cmd = "help", ...rest] = process.argv.slice(2);
const run = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
if (!run) die(`unknown command "${cmd}"\n\n${HELP}`);
await run(rest);
