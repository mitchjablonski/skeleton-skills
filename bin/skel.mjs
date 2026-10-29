#!/usr/bin/env node
// skel — plan as code skeleton, fill it one fenced step at a time.
// Run `skel help` for commands.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, toSteps, stripMarkers } from "../lib/markers.mjs";
import { STATE_DIR, findRoot, readState, writeState, initState, insideRoot, writeFileAtomic } from "../lib/state.mjs";
import { buildReviewData, readDiagrams, renderHtml, writeReview } from "../lib/review.mjs";
import {
  cleanFeedback, feedbackMarkdown, latestVerified, mergeRecords, newServeSession,
  pendingCount, queueDir, readServe, servePath, storeFeedback, takeFeedback,
} from "../lib/feedback.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.join(PKG_ROOT, "bin", "skel.mjs");
const HOOK = path.join(PKG_ROOT, "bin", "skel-hook.mjs");

const HELP = `skel — plan as code skeleton, fill one fenced step at a time

  init "<title>" [--gate ask|deny] [--force]
                                     start a skeleton in this project (--force replaces an existing one)
  track <file...>                    show unfenced skeleton files (types, wiring) in the review too
  status [--json]                    phase, active step, every step's status
  review                             write .skeleton/review.html (static; copy feedback by hand)
  serve [--port N] [--stop]          serve the review live (reuses a running server); feedback is sent back
  feedback [--wait SECONDS]          print (and archive) the human's latest feedback (waits up to 110s)
  approve [--confirm]                enter the fill phase: needs the human's APPROVED verdict from the
                                     review page, or --confirm typed by the human in their own terminal
  next                               start the first pending step and print its fences
  start <id> [--force]               start a specific step (--force abandons an unfinished active step,
                                     or reopens a filled one for rework)
  done                               finish the active step (fails if SKEL_TODO remains)
  reshape [--confirm]                back to skeleton review: needs a "Request changes" verdict sent
                                     after approval, or --confirm typed by the human in their terminal
  finalize                           all steps filled: strip markers, phase done
  hook                               PreToolUse scope gate (reads hook JSON on stdin)
  install [projectDir]               install skills + hook into a project's .claude/
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
 * Ask the human directly, on their terminal. An agent's Bash tool has no
 * controlling terminal, so it can't answer this for them.
 */
function confirmOnTerminal(question) {
  let fd;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return false;
  }
  try {
    fs.writeSync(fd, `${question} Type "yes" to confirm: `);
    const buf = Buffer.alloc(256);
    let answer = "";
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      answer += buf.toString("utf-8", 0, n);
      if (answer.includes("\n")) break;
    }
    return answer.trim().toLowerCase() === "yes";
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** The human's authority for a phase change: a verified verdict, or the terminal. */
function humanSays(root, state, verdict, args, question) {
  if (pendingCount(root) > 0) {
    const taken = takeFeedback(root);
    if (taken.status === "ok") console.log(feedbackMarkdown(state.title, mergeRecords(taken.records)) + "\n");
  }
  const fb = latestVerified(root, state.reviewEpoch ?? 0);
  if (fb?.verdict === verdict) return "review";
  if (args.includes("--confirm") && confirmOnTerminal(question)) return "terminal";
  return null;
}

function setActive(root, state, step, force = false) {
  if (step.status !== "todo" && !force) die(`step ${step.id} is already filled; \`skel start ${step.id} --force\` reopens it for rework`);
  writeState(root, { ...state, phase: "fill", activeStep: step.id });
  console.log(`STEP ${step.id} active: ${step.title}`);
  console.log(`Edit only inside these fences; replace each SKEL_TODO stub. Leave the marker lines in place.`);
  printFences(step);
}

const commands = {
  help() {
    console.log(HELP);
  },

  init(args) {
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
    // A new skeleton starts with no feedback: nothing left over (or shipped in
    // the repo) can pose as this review's verdict.
    for (const f of [queueDir(root), servePath(root)]) fs.rmSync(f, { force: true, recursive: true });
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

  serve(args) {
    const root = requireRoot();
    const running = readServe(root);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    if (args.includes("--stop")) {
      if (running?.pid && alive(running.pid)) { process.kill(running.pid); console.log(`stopped the review server (${running.url})`); }
      else console.log("no review server running");
      fs.rmSync(servePath(root), { force: true });
      return;
    }
    if (running?.pid && running.pid !== process.pid && alive(running.pid)) {
      console.log(`skel review: ${running.url} (already running; \`skel serve --stop\` stops it)`);
      return;
    }
    const port = Number(flag(args, "port", "0"));
    const { session, token } = newServeSession();
    // Page loads search the repo; the 2s polls only re-stat the skeleton's own
    // files (cheap even on slow mounts), with a full search every 30s to pick
    // up fences in new files. Parses are cached by mtime and size.
    const cache = new Map();
    let known = null;
    let lastFull = 0;
    const current = (full) => {
      const state = readState(root);
      const tracked = (state.files ?? []).map((f) => path.join(root, String(f)));
      const rescan = full || !known || Date.now() - lastFull > 30_000;
      const data = buildReviewData(root, state, cache, rescan ? null : [...known, ...tracked]);
      if (rescan) {
        known = data.files.map((f) => path.join(root, f.path));
        lastFull = Date.now();
      }
      const { generatedAt, ...stable } = data;
      return { data, version: crypto.createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 12) };
    };
    let origin = "";
    const hosts = new Set();
    const server = http.createServer((req, res) => {
      try {
        // DNS rebinding: only answer requests addressed to us by name.
        if (!hosts.has(String(req.headers.host ?? "").toLowerCase())) return void res.writeHead(421).end("misdirected request");
        if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
          });
          res.end(renderHtml(current(true).data, { token }));
        } else if (req.method === "GET" && req.url === "/api/version") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ version: current(false).version }));
        } else if (req.method === "POST" && req.url === "/api/feedback") {
          // Cross-site writes: same origin, a JSON content type (forces a CORS
          // preflight we never answer), and the per-run token from the page.
          const sameOrigin = !req.headers.origin || hosts.has(String(req.headers.origin).replace(/^https?:\/\//, "").toLowerCase());
          const json = String(req.headers["content-type"] ?? "").split(";")[0].trim() === "application/json";
          const tokenOk = String(req.headers["x-skeleton-token"] ?? "") === token;
          if (!sameOrigin || !json || !tokenOk) return void res.writeHead(403).end("forbidden");
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
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      for (const h of [`127.0.0.1:${p}`, `localhost:${p}`]) hosts.add(h);
      origin = `http://127.0.0.1:${p}`;
      writeFileAtomic(servePath(root), JSON.stringify({ url: `${origin}/`, pid: process.pid, session }), 0o600);
      console.log(`skel review: ${origin}/`);
    });
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
    const by = humanSays(root, state, "approve", args, `Approve the skeleton "${state.title}" (${steps.length} steps)?`);
    if (!by) {
      die(
        "approval has to come from the human: they click Approve skeleton and Send in the review page (`skel serve`), " +
          "or run `skel approve --confirm` in their own terminal.",
      );
    }
    writeState(root, { ...state, phase: "fill", activeStep: null, approvedBy: by, reviewEpoch: Date.now() });
    console.log(`skeleton approved (${by === "review" ? "in the review page" : "on the terminal"}): ${steps.length} steps. Run \`skel next\` to start filling.`);
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
    const by = humanSays(root, state, "changes", args, `Reopen the skeleton "${state.title}" for structural changes?`);
    if (!by) {
      die(
        "reopening the skeleton has to come from the human: they click Request changes and Send in the review page, " +
          "or run `skel reshape --confirm` in their own terminal.",
      );
    }
    writeState(root, { ...state, phase: "scaffold", activeStep: null, approvedBy: null, reviewEpoch: Date.now() });
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
      fs.writeFileSync(abs, stripMarkers(fs.readFileSync(abs, "utf-8")));
    }
    writeState(root, { ...readState(root), phase: "done", activeStep: null });
    console.log(`finalized: stripped markers from ${files.length} file(s)`);
  },

  async hook() {
    const { runHook } = await import("../lib/hook.mjs");
    await runHook();
  },

  install([dir = process.cwd()]) {
    const target = path.resolve(dir);
    const claudeDir = path.join(target, ".claude");
    // The hook command runs through a shell: refuse an install path that a
    // shell would interpret rather than quote it and hope.
    if (/["'`$\\\n\r]/.test(PKG_ROOT)) die(`can't install from a path containing quotes, $, backticks or backslashes: ${SELF}`);
    const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
    const settingsPath = path.join(claudeDir, "settings.local.json");
    for (const p of [claudeDir, settingsPath, path.join(target, ".gitignore")]) {
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
    for (const name of ["skeleton", "skeleton-fill"]) {
      const src = path.join(PKG_ROOT, "skills", name, "SKILL.md");
      const dest = path.join(claudeDir, "skills", name, "SKILL.md");
      writeFileAtomic(dest, fs.readFileSync(src, "utf-8").replaceAll("{{SKEL}}", `node "${SELF}"`));
    }
    const command = `node "${HOOK}"`;
    const legacy = `node "${SELF}" hook`;
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    const matcher = "Write|Edit|MultiEdit|NotebookEdit|Bash";
    const ours = settings.hooks.PreToolUse.find((m) => m.hooks?.some((hk) => hk.command === command || hk.command === legacy));
    if (ours) {
      ours.matcher = matcher;
      for (const hk of ours.hooks) if (hk.command === legacy) hk.command = command;
    } else {
      settings.hooks.PreToolUse.push({ matcher, hooks: [{ type: "command", command }] });
    }
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    // .skeleton/ is per-run state (and holds the human's feedback): keep it
    // out of commits, so a repo can't ship a verdict.
    const gi = path.join(target, ".gitignore");
    const giText = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
    if (!/^\/?\.skeleton\/?$/m.test(giText)) fs.appendFileSync(gi, `${giText && !giText.endsWith("\n") ? "\n" : ""}.skeleton/\n`);
    console.log(`installed /skeleton and /skeleton-fill into ${claudeDir}/skills`);
    console.log(ours ? "scope gate hook updated" : `added scope gate hook to ${settingsPath}`);
  },
};

const [cmd = "help", ...rest] = process.argv.slice(2);
const run = commands[cmd];
if (!run) die(`unknown command "${cmd}"\n\n${HELP}`);
await run(rest);
