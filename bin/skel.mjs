#!/usr/bin/env node
// skel — plan as code skeleton, fill it one fenced step at a time.
// Run `skel help` for commands.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, toSteps, stripMarkers } from "../lib/markers.mjs";
import { STATE_DIR, findRoot, readState, writeState, initState } from "../lib/state.mjs";
import { buildReviewData, renderHtml, writeReview } from "../lib/review.mjs";
import { evaluate } from "../lib/gate.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.join(PKG_ROOT, "bin", "skel.mjs");

const HELP = `skel — plan as code skeleton, fill one fenced step at a time

  init "<title>" [--gate ask|deny]   start a skeleton in this project
  track <file...>                    show unfenced skeleton files (types, wiring) in the review too
  status [--json]                    phase, active step, every step's status
  review                             write .skeleton/review.html (static; copy feedback by hand)
  serve [--port N]                   serve the review live; feedback is sent back to the agent
  feedback [--wait SECONDS]          print (and archive) the human's latest feedback
  approve                            skeleton approved: enter the fill phase
  next                               start the first pending step and print its fences
  start <id>                         start a specific step
  done                               finish the active step (fails if SKEL_TODO remains)
  reshape                            back to skeleton review (for an agreed skeleton change)
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

function setActive(root, state, step) {
  if (step.status !== "todo") die(`step ${step.id} is already filled`);
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
    const title = args.join(" ").trim();
    if (!title) die('usage: skel init "<title>"');
    const root = findRoot(process.cwd()) ?? process.cwd();
    initState(root, title);
    writeState(root, { ...readState(root), gate });
    console.log(`skel: "${title}" started in ${root} (phase: scaffold, gate: ${gate})`);
  },

  track(args) {
    const root = requireRoot();
    const state = readState(root);
    const rels = args.map((a) => path.relative(root, path.resolve(a)).split(path.sep).join("/"));
    const missing = rels.filter((r) => !fs.existsSync(path.join(root, r)));
    if (missing.length) die(`not found: ${missing.join(", ")}`);
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
  },

  review() {
    const root = requireRoot();
    const out = writeReview(root, readState(root));
    console.log(out);
    console.log(`file://${out}`);
  },

  serve(args) {
    const root = requireRoot();
    const port = Number(flag(args, "port", "0"));
    const fbPath = path.join(root, STATE_DIR, "feedback.json");
    const current = () => {
      const data = buildReviewData(root, readState(root));
      const { generatedAt, ...stable } = data;
      return { data, version: crypto.createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 12) };
    };
    const server = http.createServer((req, res) => {
      try {
        if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(renderHtml(current().data));
        } else if (req.method === "GET" && req.url === "/api/version") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ version: current().version }));
        } else if (req.method === "POST" && req.url === "/api/feedback") {
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
          req.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              fs.writeFileSync(fbPath, JSON.stringify(parsed, null, 2));
              res.writeHead(204).end();
            } catch {
              res.writeHead(400).end("bad feedback payload");
            }
          });
        } else {
          res.writeHead(404).end("not found");
        }
      } catch (err) {
        res.writeHead(500).end(String(err?.message ?? err));
      }
    });
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      fs.writeFileSync(path.join(root, STATE_DIR, "serve.json"), JSON.stringify({ url, pid: process.pid }));
      console.log(`skel review: ${url}`);
    });
  },

  async feedback(args) {
    const root = requireRoot();
    const wait = Number(flag(args, "wait", "0"));
    const fbPath = path.join(root, STATE_DIR, "feedback.json");
    const deadline = Date.now() + wait * 1000;
    while (!fs.existsSync(fbPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!fs.existsSync(fbPath)) {
      console.log(wait ? `no feedback after ${wait}s` : "no feedback yet");
      return;
    }
    const fb = JSON.parse(fs.readFileSync(fbPath, "utf-8"));
    const hist = path.join(root, STATE_DIR, "feedback-history");
    fs.mkdirSync(hist, { recursive: true });
    fs.renameSync(fbPath, path.join(hist, `${Date.now()}.json`));
    console.log(fb.markdown ?? JSON.stringify(fb, null, 2));
  },

  approve() {
    const root = requireRoot();
    const { steps, errors } = snapshot(root);
    if (errors.length) die(`fix marker errors first:\n  ${errors.join("\n  ")}`);
    if (!steps.length) die("no SKEL[...] fences found — nothing to approve");
    writeState(root, { ...readState(root), phase: "fill", activeStep: null });
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

  start([id]) {
    const root = requireRoot();
    const state = readState(root);
    if (state.phase !== "fill") die(`phase is ${state.phase} — the skeleton must be approved first (skel approve)`);
    const step = snapshot(root).steps.find((s) => s.id === id);
    if (!step) die(`no step ${id}`);
    setActive(root, state, step);
  },

  done() {
    const root = requireRoot();
    const state = readState(root);
    if (!state.activeStep) die("no active step");
    const { steps } = snapshot(root);
    const step = steps.find((s) => s.id === state.activeStep);
    if (step && step.status === "todo") {
      const left = step.fences.filter((f) => f.status === "todo").map((f) => `${f.file}:${f.openLine}`);
      die(`step ${step.id} still has SKEL_TODO in ${left.join(", ")}`);
    }
    writeState(root, { ...state, activeStep: null });
    const pending = steps.filter((s) => s.status === "todo" && s.id !== state.activeStep);
    console.log(`STEP ${state.activeStep} done. ${pending.length} pending${pending[0] ? `; next: ${pending[0].id} ${pending[0].title}` : ""}.`);
  },

  reshape() {
    const root = requireRoot();
    writeState(root, { ...readState(root), phase: "scaffold", activeStep: null });
    console.log("back to skeleton review: edits are unfenced; get the human's approval again, then `skel approve`.");
  },

  finalize() {
    const root = requireRoot();
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
    // Fail open: a broken gate must never wedge the session.
    try {
      let raw = "";
      for await (const chunk of process.stdin) raw += chunk;
      const input = JSON.parse(raw || "{}");
      const root = findRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!root) return;
      const state = readState(root);
      if (!state || state.phase !== "fill" || !state.activeStep) return;
      const activeFences = scanRepo(root).fences.filter((f) => f.id === state.activeStep);
      const verdict = evaluate({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        root,
        state,
        activeFences,
        readFile: (abs) => { try { return fs.readFileSync(abs, "utf-8"); } catch { return null; } },
      });
      if (!verdict) return;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: verdict.decision,
          permissionDecisionReason: verdict.reason,
        },
      }));
    } catch {
      // no opinion
    }
  },

  install([dir = process.cwd()]) {
    const target = path.resolve(dir);
    const claudeDir = path.join(target, ".claude");
    for (const name of ["skeleton", "skeleton-fill"]) {
      const src = path.join(PKG_ROOT, "skills", name, "SKILL.md");
      const dest = path.join(claudeDir, "skills", name, "SKILL.md");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(src, "utf-8").replaceAll("{{SKEL}}", `node "${SELF}"`));
    }
    const settingsPath = path.join(claudeDir, "settings.local.json");
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
    const command = `node "${SELF}" hook`;
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    const already = settings.hooks.PreToolUse.some((m) => m.hooks?.some((hk) => hk.command === command));
    if (!already) {
      settings.hooks.PreToolUse.push({ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command }] });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`installed /skeleton and /skeleton-fill into ${claudeDir}/skills`);
    console.log(already ? "scope gate hook already present" : `added scope gate hook to ${settingsPath}`);
  },
};

const [cmd = "help", ...rest] = process.argv.slice(2);
const run = commands[cmd];
if (!run) die(`unknown command "${cmd}"\n\n${HELP}`);
await run(rest);
