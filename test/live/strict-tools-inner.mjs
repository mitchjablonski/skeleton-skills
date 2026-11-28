// Fixed, no-inference Messages API tool script. This runs inside the same
// Bubblewrap network namespace as the pinned Claude CLI it launches.
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const MAX_CLIENT_OUTPUT = 1024 * 1024;
const MAX_RESULT_TEXT = 2048;
const privatePath = process.env.PROBE_PRIVATE_PATH;
if (typeof privatePath !== "string" || !privatePath.startsWith("/") || /[\0\r\n]/.test(privatePath))
  throw Error("missing disposable host-private fixture path");
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const fileTools = process.env.PROBE_CASE === "file-tools";
const searchTools = process.env.PROBE_CASE === "search-tools";
const fixedTools = searchTools ? "Glob,Grep" : fileTools ? "Write,Read,Edit" : "Read,Edit,Bash";
const steps = searchTools ? [
  { name: "Glob", input: { pattern: "*.txt", path: "/work/search-corpus" } },
  { name: "Grep", input: { pattern: "^SEARCH_NEEDLE$", path: "/work/search-corpus/alpha.txt", output_mode: "content", "-n": false } },
] : fileTools ? [
 { name: "Write", input: { file_path: "/work/file-tools.txt", content: "FILE_INITIAL\n" } },
 { name: "Read", input: { file_path: "/work/file-tools.txt" } },
 { name: "Edit", input: { file_path: "/work/file-tools.txt", old_string: "FILE_INITIAL", new_string: "FILE_EDITED" } },
 { name: "Read", input: { file_path: "/work/file-tools.txt" } },
] : [
  { name: "Read", input: { file_path: "/work/inside.txt" } },
  { name: "Edit", input: { file_path: "/work/inside.txt", old_string: "PUBLIC_PROBE", new_string: "PUBLIC_EDITED" } },
  { name: "Read", input: { file_path: "/opt/public-control.txt" } },
  { name: "Read", input: { file_path: privatePath } },
  {
    name: "Bash",
    input: {
      command: "cat /work/inside.txt || exit 1; if cat " + shellQuote(privatePath) + " >/dev/null 2>&1; then printf 'PRIVATE_READ_SUCCEEDED'; else printf 'BASH_RAN_PRIVATE_UNAVAILABLE'; fi",
      description: "Check the disposable private-path boundary",
    },
  },
];

function sse(res, blocks, stop) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", { message: { id: "msg_strict_probe", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  res.end();
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => typeof block?.text === "string" ? block.text : "").join("");
  return content == null ? "" : JSON.stringify(content);
}

const apiRequests = [];
let latestToolResults = [];
let malformedRequests = 0;
let initialFileBytesExact = false;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > MAX_CLIENT_OUTPUT) req.destroy();
  });
  req.on("end", () => {
    let body;
    try { body = JSON.parse(raw || "{}"); }
    catch {
      malformedRequests += 1;
      res.writeHead(400);
      return res.end("{}");
    }
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 1 }));
    }
    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(404);
      return res.end("{}");
    }

    const results = (body.messages ?? [])
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((item) => item.type === "tool_result");
    latestToolResults = results.map((result, index) => ({
      toolUseId: result.tool_use_id,
      tool: steps[index]?.name ?? "unexpected",
      isError: result.is_error === true,
      content: textOf(result.content).slice(0, MAX_RESULT_TEXT),
    }));
    const offeredNames = Array.isArray(body.tools) ? body.tools.map((tool) => tool.name).filter((name) => typeof name === "string") : [];
    const offeredSet = [...new Set(offeredNames)].sort();
    const hasFixedTools = offeredSet.join(",") === fixedTools.split(",").sort().join(",") && offeredNames.length === fixedTools.split(",").length;
    if (fileTools && hasFixedTools && results.length === 1) {
      initialFileBytesExact = fs.existsSync("/work/file-tools.txt") && fs.readFileSync("/work/file-tools.txt").equals(Buffer.from("FILE_INITIAL\n"));
    }
    const stepIndex = hasFixedTools ? results.length : steps.length;
    const step = steps[stepIndex];
    const blocks = step
      ? [{ type: "tool_use", id: `toolu_strict_probe_${stepIndex + 1}`, name: step.name, input: step.input }]
      : [{ type: "text", text: "Deterministic tool probe complete." }];
    apiRequests.push({
      endpoint: req.url,
      streaming: body.stream === true,
      offeredTools: offeredNames.slice(0, 32),
      offeredToolCount: offeredNames.length,
      exactFixedToolSet: hasFixedTools,
      nextTool: step?.name ?? null,
      priorToolResultCount: results.length,
    });
    const stop = step ? "tool_use" : "end_turn";
    if (body.stream) return sse(res, blocks, stop);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_strict_probe",
      type: "message",
      role: "assistant",
      model: "mock",
      content: blocks,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const childEnv = {
  HOME: "/home/agent",
  USER: "agent",
  SHELL: "/bin/bash",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  CLAUDE_CONFIG_DIR: "/home/agent/.claude",
  ANTHROPIC_API_KEY: "sk-ant-local-dummy-only",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_ERROR_REPORTING: "1",
};

let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
let outputOverflow = false;
let errorOverflow = false;
let child;
let childExit = null;
let clientNamespace = null;
try {
  clientNamespace = {
    net: fs.readlinkSync("/proc/self/ns/net"),
    pid: fs.readlinkSync("/proc/self/ns/pid"),
  };
  child = spawn("/opt/claude", [
    "-p", "Run the deterministic fixture tool sequence.",
    "--output-format", "stream-json", "--verbose", "--max-turns", "8",
    "--model", "claude-sonnet-4-5",
    "--tools", fixedTools, "--allowedTools", fixedTools,
    "--permission-mode", "bypassPermissions", "--no-session-persistence",
    "--strict-mcp-config", "--disable-slash-commands",
  ], { cwd: "/work", env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });

  const cap = (target, chunk, markOverflow) => {
    const room = MAX_CLIENT_OUTPUT - target.length;
    if (room > 0) target = Buffer.concat([target, chunk.subarray(0, room)]);
    if (chunk.length > room) markOverflow();
    return target;
  };
  child.stdout.on("data", (chunk) => {
    stdout = cap(stdout, chunk, () => { outputOverflow = true; });
    if (outputOverflow) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = cap(stderr, chunk, () => { errorOverflow = true; });
    if (errorOverflow) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  });
  childExit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
} catch (error) {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  childExit = null;
  stderr = Buffer.from(String(error).slice(0, MAX_CLIENT_OUTPUT));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const insideText = fs.readFileSync("/work/inside.txt", "utf8");
const results = latestToolResults;
const privatePathMissing = /(?:file does not exist|enoent|no such file or directory)/i;
// The pinned client appends its own token-budget reminder to tool results.
const searchResult = (result) => result?.content.replace(
  /\n\n<system-reminder>\n<total_tokens>[0-9]{1,10} tokens left<\/total_tokens>\n<\/system-reminder>$/,
  "",
);
function searchCorpusMatches() {
  let directory;
  try {
    directory = fs.openSync("/work/search-corpus", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const base = `/proc/self/fd/${directory}`;
    const expected = { "alpha.txt": "SEARCH_NEEDLE\n", "beta.md": "SEARCH_CONTROL\n" };
    if (JSON.stringify(fs.readdirSync(base).sort()) !== JSON.stringify(Object.keys(expected).sort())) return false;
    return Object.entries(expected).every(([name, content]) => {
      const descriptor = fs.openSync(`${base}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      try {
        const entry = fs.fstatSync(descriptor);
        const bytes = Buffer.alloc(Buffer.byteLength(content) + 1);
        const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
        return entry.isFile() && entry.nlink === 1 && entry.size === Buffer.byteLength(content)
          && length === Buffer.byteLength(content) && bytes.subarray(0, length).equals(Buffer.from(content));
      } finally { fs.closeSync(descriptor); }
    });
  } catch { return false; }
  finally { if (directory !== undefined) fs.closeSync(directory); }
}
const checks = searchTools ? {
  clientExitZero: childExit === 0,
  exactSearchToolResultOrder: results.length === 2 && results.every((r, i) => r.toolUseId === `toolu_strict_probe_${i + 1}` && !r.isError),
  globResultExact: searchResult(results[0]) === "search-corpus/alpha.txt",
  grepResultExact: searchResult(results[1]) === "SEARCH_NEEDLE",
  searchCorpusUnchanged: searchCorpusMatches(),
  requestOrderExact: apiRequests.length === 3 && apiRequests.every((r, i) => r.priorToolResultCount === i && r.nextTool === (steps[i]?.name ?? null)),
  noOutputOverflow: !outputOverflow && !errorOverflow,
  noMalformedApiRequests: malformedRequests === 0,
  apiOfferedOnlyFixedTools: apiRequests.length > 0 && apiRequests.every(r => r.exactFixedToolSet),
} : fileTools ? {
 clientExitZero: childExit === 0,
 exactFileToolResultOrder: results.length === 4 && results.every((r, i) => r.toolUseId === `toolu_strict_probe_${i + 1}` && !r.isError),
 fileReadInitial: results[1]?.content.includes("FILE_INITIAL") === true,
 fileReadEdited: results[3]?.content.includes("FILE_EDITED") === true,
 initialFileBytesExact,
 fileBytesExact: fs.existsSync("/work/file-tools.txt") && fs.readFileSync("/work/file-tools.txt").equals(Buffer.from("FILE_EDITED\n")),
 requestOrderExact: apiRequests.length === 5 && apiRequests.every((r, i) => r.priorToolResultCount === i && r.nextTool === (steps[i]?.name ?? null)),
 noOutputOverflow: !outputOverflow && !errorOverflow,
 noMalformedApiRequests: malformedRequests === 0,
 apiOfferedOnlyFixedTools: apiRequests.length > 0 && apiRequests.every(r => r.exactFixedToolSet),
} : {
  clientExitZero: childExit === 0,
  exactlyFiveToolResults: results.length === 5 && results.every((result, index) => result.toolUseId === `toolu_strict_probe_${index + 1}`),
  workspaceReadReturnedFixture: results[0]?.isError === false && results[0]?.content.includes("PUBLIC_PROBE") === true,
  workspaceEditApplied: insideText === "PUBLIC_EDITED\n",
  absolutePublicControlReadable: results[2]?.tool === "Read" && results[2]?.isError === false && results[2]?.content.includes("PUBLIC_CONTROL"),
  privateReadReportsMissingPath: results[3]?.tool === "Read" && results[3]?.isError === true && privatePathMissing.test(results[3]?.content ?? "") && !results[3]?.content.includes("PRIVATE_RECEIPT_DO_NOT_MOUNT"),
  bashRanWithWorkspaceControlAndPrivatePathUnavailable: results[4]?.isError === false && results[4]?.content.includes("PUBLIC_EDITED") === true && results[4]?.content.includes("BASH_RAN_PRIVATE_UNAVAILABLE") === true,
  noOutputOverflow: !outputOverflow && !errorOverflow,
  noMalformedApiRequests: malformedRequests === 0,
  apiOfferedOnlyFixedTools: apiRequests.length > 0 && apiRequests.every((request) => request.exactFixedToolSet),
};
const passed = Object.values(checks).every(Boolean);
const redact = (text) => text
  .replaceAll("sk-ant-local-dummy-only", "[dummy key redacted]")
  .slice(0, MAX_RESULT_TEXT * 4);
const result = {
  ok: passed,
  code: passed ? "probe-passed" : "probe-acceptance-failed",
  scope: "pinned Claude CLI with fixed local mock API tool sequence; no model inference",
  strictState: "unverified",
  clientExit: childExit,
  insideNamespaces: clientNamespace,
  apiRequestCount: apiRequests.length,
  apiRequests,
  toolResults: results,
  insideWorkspaceFile: insideText.slice(0, MAX_RESULT_TEXT),
  checks,
  clientStdout: redact(stdout.toString("utf8")),
  clientStderr: redact(stderr.toString("utf8")),
  clientOutputTruncated: outputOverflow || errorOverflow,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!passed) process.exitCode = 1;
