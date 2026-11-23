import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scope = fileURLToPath(new URL("./strict-owned-listener-scope.py", import.meta.url));
const MAX_OUT = 16 * 1024 * 1024;
const MAX_ERR = 64 * 1024;
const SCOPE_STOP_MS = 15_000;

export function superviseC9Process(executable, args, { cwd, env, timeoutMs, afterResultMs = 5000 }) {
  const child = spawn("/usr/bin/python3", ["-I", scope, "--process", "3", executable, ...args], {
    cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const lifeline = child.stdio[3];
  let stdout = "", stderr = "", error = null;
  let settled = false, stopping = false, spawnFailed = false, resultSeen = false;
  let resultTimer, stopTimer;
  let resolveResult;
  const done = new Promise(resolve => { resolveResult = resolve; });
  const finish = (cleanupProven) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(resultTimer);
    clearTimeout(stopTimer);
    lifeline.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    resolveResult({ stdout, stderr, error, cleanupProven });
  };
  const stop = (reason) => {
    if (settled) return;
    error ??= reason;
    if (stopping) return;
    stopping = true;
    clearTimeout(timeout);
    clearTimeout(resultTimer);
    lifeline.destroy();
    stopTimer = setTimeout(() => finish(false), SCOPE_STOP_MS);
  };
  const timeout = setTimeout(() => stop("model-timeout"), timeoutMs);
  lifeline.on("error", () => stop("scope-lifeline-failed"));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > MAX_OUT) {
      stop("model-output-limit");
      return;
    }
    stdout += chunk;
    if (!stopping && !resultSeen && /"type":"result"/.test(stdout)) {
      resultSeen = true;
      resultTimer = setTimeout(() => stop(null), afterResultMs);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.slice(0, MAX_ERR - stderr.length); });
  child.on("error", () => {
    spawnFailed = true;
    error ??= "scope-spawn-failed";
  });
  child.on("close", (code) => {
    const cleanupProven = spawnFailed || (Number.isInteger(code) && code !== 125);
    if (!error && code !== 0 && !resultSeen) error = "model-exited-before-result";
    finish(cleanupProven);
  });
  return { done, stop: () => stop("interrupted") };
}

export function privateTranscriptDirectory(requested) {
  if (requested === undefined) return fs.mkdtempSync(path.join(os.tmpdir(), "skel-c9-transcripts-"));
  const directory = path.resolve(requested);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.closeSync(openPrivateDirectory(directory));
  return directory;
}

function openPrivateDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700)
      throw new Error("transcript directory must be private and owned");
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}

export function writePrivateTranscript(directory, name, body) {
  if (!/^S[123]-run[1-3]$/.test(name)) throw new Error("invalid transcript name");
  const fd = openPrivateDirectory(directory);
  try {
    fs.writeFileSync(`/proc/self/fd/${fd}/${name}.jsonl`, body, { flag: "wx", mode: 0o600 });
  } finally {
    fs.closeSync(fd);
  }
}
