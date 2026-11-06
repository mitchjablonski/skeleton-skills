#!/usr/bin/env node
// Live probe for #40, not part of `npm test`: install skel from a local-path
// marketplace (this checkout) into a throwaway Claude Code config, and show
// the plugin's hooks firing in a real session, with zero model calls.
//
// Claude Code talks to a local mock of the Messages API that replays a fixed
// script (Read a file, Edit outside the active fence, end the turn), so the
// only "model" is this file. Everything lives under one scratch dir: HOME,
// CLAUDE_CONFIG_DIR, XDG_*, LOCALAPPDATA and the project. The API key is a
// dummy, nothing inherits your credentials, and the dir is removed at the end
// unless --keep is passed.
//
//   node test/live/plugin-probe.mjs [--keep] [--claude <path>]
//
// Arms:
//   plugin    the plugin's PreToolUse hook denies the out-of-fence Edit
//             (gate deny), and its Stop hook sends Claude back exactly once
//             for exterior drift.
//   migrated  a `skel install --legacy` project, then the plugin, then
//             `skel install`: settings lose skel's hooks, the gate still
//             denies (from the plugin), one Stop continuation.
//   filler    the fill skill's `skel:skeleton-filler` resolves, and the
//             subagent's request lists only its allowed tools.
//   disabled  control: the plugin disabled at local scope: the same Edit
//             goes through (acceptEdits) and no Stop continuation comes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKEL = path.join(REPO, "bin", "skel.mjs");
const keep = process.argv.includes("--keep");
const claudeBin = process.argv.includes("--claude") ? process.argv[process.argv.indexOf("--claude") + 1] : "claude";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "skel-plugin-probe-"));
const log = (...a) => console.log("[probe]", ...a);

// ---- the mock Messages API ----
const requests = [];
function sse(res, blocks, stop) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", { message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  res.end();
}
let script = null; // set per arm: (body) => { blocks, stop }
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    requests.push({ url: req.url, body });
    if (req.url.includes("count_tokens")) return res.end(JSON.stringify({ input_tokens: 1 }));
    if (!req.url.startsWith("/v1/messages")) { res.writeHead(404); return res.end("{}"); }
    const main = Array.isArray(body.tools) && body.tools.some((t) => t.name === "Edit");
    const { blocks, stop } = main && script ? script(body) : { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" };
    if (body.stream) return sse(res, blocks, stop);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: "mock", content: blocks.map((b) => (b.type === "text" ? b : { type: "tool_use", id: b.id, name: b.name, input: b.input })), stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${server.address().port}`;
log("mock Messages API at", API);

/** Read, then an out-of-fence Edit, then end the turn; any later request (a Stop continuation) ends the turn. */
const editScript = (file) => (body) => {
  const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool_result");
  if (results.length === 0) return { blocks: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: file } }], stop: "tool_use" };
  if (results.length === 1) return { blocks: [{ type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: file, old_string: "// outside the fence", new_string: "// edited outside the fence" } }], stop: "tool_use" };
  return { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
};

// ---- an isolated environment ----
function makeEnv(name) {
  const base = path.join(scratch, name);
  const dirs = { home: path.join(base, "home"), claude: path.join(base, "claude-config"), xdgc: path.join(base, "xdg-config"), xdgs: path.join(base, "xdg-state"), lad: path.join(base, "localappdata"), project: path.join(base, "project") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: dirs.home, USERPROFILE: dirs.home, CLAUDE_CONFIG_DIR: dirs.claude,
    XDG_CONFIG_HOME: dirs.xdgc, XDG_STATE_HOME: dirs.xdgs, LOCALAPPDATA: dirs.lad, TMPDIR: os.tmpdir(),
    ANTHROPIC_API_KEY: "sk-ant-dummy-probe-key", ANTHROPIC_BASE_URL: API,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1",
  };
  const run = (cmd, args, { cwd = dirs.project, timeout = 120_000, input } = {}) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout, input });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "", error: r.error };
  };
  const must = (cmd, args, opts) => { const r = run(cmd, args, opts); assert.equal(r.status, 0, `${cmd} ${args.join(" ")}\n${r.out}`); return r.out; };
  const skel = (...args) => must(process.execPath, [SKEL, ...args]);
  const claude = (...args) => must(claudeBin, args);
  return { dirs, env, run, must, skel, claude };
}

function project(e) {
  const p = e.dirs.project;
  e.must("git", ["init", "-q", p]);
  fs.writeFileSync(path.join(p, "code.js"), "// outside the fence\nexport function f() {\n  // SKEL[1] fill f\n  throw new Error(\"SKEL_TODO\");\n  // /SKEL[1]\n}\n");
  e.must("git", ["-C", p, "-c", "user.email=p@x", "-c", "user.name=p", "add", "."]);
  e.must("git", ["-C", p, "-c", "user.email=p@x", "-c", "user.name=p", "commit", "-qm", "init"]);
}

function installPlugin(e) {
  e.claude("plugin", "marketplace", "add", REPO, "--scope", "local");
  e.claude("plugin", "install", "skel@skeleton-skills", "--scope", "local");
}

function startFill(e) {
  e.skel("init", "probe", "--gate", "deny");
  e.skel("approve");
  e.skel("next");
}

/** One headless turn against the mock; returns the parsed stream-json events. */
async function session(e, extraArgs = []) {
  const file = path.join(e.dirs.project, "code.js");
  script = editScript(file);
  requests.length = 0;
  const args = ["-p", "fill step 1", "--output-format", "stream-json", "--verbose", "--max-turns", "8", "--model", "claude-sonnet-4-5", ...extraArgs];
  const child = spawn(claudeBin, args, { cwd: e.dirs.project, env: e.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  const code = await new Promise((r) => child.on("close", r));
  clearTimeout(timer);
  const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return { code, events, err, requests: [...requests] };
}

const toolResults = (s) => s.events.filter((ev) => ev.type === "user").flatMap((ev) => ev.message?.content ?? []).filter((c) => c.type === "tool_result");
const editResult = (s) => toolResults(s).find((c) => c.tool_use_id === "toolu_edit");
const text = (c) => (typeof c?.content === "string" ? c.content : JSON.stringify(c?.content ?? ""));
const stopContinuations = (s) => s.requests.filter((r) => JSON.stringify(r.body.messages ?? []).includes("Resolve this drift before you stop")).length;
const mainRequests = (s) => s.requests.filter((r) => Array.isArray(r.body.tools) && r.body.tools.some((t) => t.name === "Edit")).length;

const results = {};
try {
  log("claude version:", spawnSync(claudeBin, ["--version"], { encoding: "utf8", timeout: 30_000 }).stdout.trim());

  // ---- plugin arm ----
  {
    const e = makeEnv("plugin");
    project(e);
    installPlugin(e);
    const local = JSON.parse(fs.readFileSync(path.join(e.dirs.project, ".claude", "settings.local.json"), "utf8"));
    log("plugin arm: settings.local.json after install:", JSON.stringify(local));
    log("plugin arm: skel install:\n" + e.skel("install"));
    startFill(e);
    // Exterior drift the Stop hook will report (a comment line outside the fence).
    fs.appendFileSync(path.join(e.dirs.project, "code.js"), "// drift\n");
    const s = await session(e);
    const init = s.events.find((ev) => ev.type === "system" && ev.subtype === "init");
    const result = s.events.find((ev) => ev.type === "result");
    results.plugin = {
      exit: s.code,
      plugins: init?.plugins,
      slashCommands: (init?.slash_commands ?? []).filter((c) => /skel/.test(c)),
      agents: (init?.agents ?? []).filter((a) => /skel/.test(a)),
      editResult: text(editResult(s)).slice(0, 400),
      editIsError: editResult(s)?.is_error,
      fileUnchangedOutsideFence: fs.readFileSync(path.join(e.dirs.project, "code.js"), "utf8").startsWith("// outside the fence\n"),
      stopContinuations: stopContinuations(s),
      mainRequests: mainRequests(s),
      result: result && { num_turns: result.num_turns, total_cost_usd: result.total_cost_usd, is_error: result.is_error },
      stderrTail: s.err.slice(-400),
    };
    log("plugin arm:", JSON.stringify(results.plugin, null, 2));
  }

  // ---- migrated arm ----
  {
    const e = makeEnv("migrated");
    project(e);
    log("migrated arm: legacy install:\n" + e.skel("install", "--legacy").split("\n").slice(0, 4).join("\n"));
    installPlugin(e);
    const out = e.skel("install");
    log("migrated arm: skel install:\n" + out);
    const settings = JSON.parse(fs.readFileSync(path.join(e.dirs.project, ".claude", "settings.local.json"), "utf8"));
    startFill(e);
    fs.appendFileSync(path.join(e.dirs.project, "code.js"), "// drift\n");
    const s = await session(e);
    const init = s.events.find((ev) => ev.type === "system" && ev.subtype === "init");
    results.migrated = {
      exit: s.code,
      settingsHooksLeft: settings.hooks ?? null,
      legacyCopiesLeft: ["skills/skeleton/SKILL.md", "skills/skeleton-fill/SKILL.md", "agents/skeleton-filler.md"].filter((r) => fs.existsSync(path.join(e.dirs.project, ".claude", r))),
      slashCommands: (init?.slash_commands ?? []).filter((c) => /skeleton/.test(c)),
      agents: (init?.agents ?? []).filter((a) => /skeleton/.test(a)),
      editResult: text(editResult(s)).slice(0, 400),
      denyMessages: (text(editResult(s)).match(/skel:/g) ?? []).length,
      stopContinuations: stopContinuations(s),
      result: (({ num_turns, total_cost_usd }) => ({ num_turns, total_cost_usd }))(s.events.find((ev) => ev.type === "result") ?? {}),
    };
    log("migrated arm:", JSON.stringify(results.migrated, null, 2));
  }

  // ---- disabled control ----
  {
    const e = makeEnv("disabled");
    project(e);
    installPlugin(e);
    e.skel("install");
    startFill(e);
    e.claude("plugin", "disable", "skel@skeleton-skills", "--scope", "local");
    fs.appendFileSync(path.join(e.dirs.project, "code.js"), "// drift\n");
    const s = await session(e, ["--permission-mode", "acceptEdits"]);
    results.disabled = {
      exit: s.code,
      enabledPlugins: JSON.parse(fs.readFileSync(path.join(e.dirs.project, ".claude", "settings.local.json"), "utf8")).enabledPlugins,
      editResult: text(editResult(s)).slice(0, 300),
      edited: fs.readFileSync(path.join(e.dirs.project, "code.js"), "utf8").startsWith("// edited outside the fence"),
      stopContinuations: stopContinuations(s),
      skelStatus: e.run(process.execPath, [SKEL, "status"]).out.split("\n").slice(0, 6).join("\n"),
    };
    log("disabled control:", JSON.stringify(results.disabled, null, 2));
  }

  // ---- the namespaced filler: what tools does the plugin's agent get? ----
  {
    const e = makeEnv("filler");
    project(e);
    installPlugin(e);
    e.skel("install");
    startFill(e);
    const isSub = (body) => JSON.stringify(body.messages?.[0] ?? "").includes("FILLER-PROBE");
    let agentTool = null;
    let subTools = null;
    script = (body) => {
      if (isSub(body)) {
        subTools ??= body.tools.map((t) => t.name);
        return { blocks: [{ type: "text", text: "STATUS: blocked\nBLOCKER: probe" }], stop: "end_turn" };
      }
      agentTool ??= body.tools.map((t) => t.name).find((n) => n === "Agent" || n === "Task");
      const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool_result");
      if (!results.length) return { blocks: [{ type: "tool_use", id: "toolu_agent", name: agentTool, input: { subagent_type: "skel:skeleton-filler", description: "fill step 1", prompt: "FILLER-PROBE: report STATUS: blocked" } }], stop: "tool_use" };
      return { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
    };
    requests.length = 0;
    const child = spawn(claudeBin, ["-p", "delegate", "--output-format", "stream-json", "--verbose", "--max-turns", "6", "--model", "claude-sonnet-4-5"], { cwd: e.dirs.project, env: e.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    const code = await new Promise((r) => child.on("close", r));
    clearTimeout(timer);
    const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const agentResult = events.filter((ev) => ev.type === "user").flatMap((ev) => ev.message?.content ?? []).find((c) => c.tool_use_id === "toolu_agent");
    results.filler = {
      exit: code,
      agentTool,
      subagentTools: subTools,
      noShellNoWrite: !!subTools && !subTools.some((t) => ["Bash", "PowerShell", "Write", "NotebookEdit", "Agent", "Task", "Monitor"].includes(t)),
      agentResult: text(agentResult).slice(0, 200),
      result: (({ num_turns, total_cost_usd }) => ({ num_turns, total_cost_usd }))(events.find((ev) => ev.type === "result") ?? {}),
    };
    log("filler arm:", JSON.stringify(results.filler, null, 2));
  }

  const calls = requests.length;
  log(`mock requests in the last arm: ${calls}; no request left this machine (ANTHROPIC_BASE_URL=${API}).`);
  fs.writeFileSync(path.join(os.tmpdir(), "skel-plugin-probe-results.json"), JSON.stringify(results, null, 2));
} finally {
  server.close();
  if (!keep) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  else log("kept", scratch);
}
