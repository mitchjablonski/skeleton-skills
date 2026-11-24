#!/usr/bin/env node
// UserPromptSubmit hook (#229): an always-on input contract for strict.
//
// Exits with no output unless the session's project has a `.skeleton/` dir
// AND the project's strict status (the same projectStrictStatus that
// `skel status --json` reports) says strict was requested. Then it adds a
// fixed notice as additionalContext: strict isn't active, nothing is decided
// in this session, never use or repeat a decision code, and strict.next
// verbatim. If `.skeleton/` exists but its state can't be read, it adds the
// notice without strict.next plus an "unreadable" line (fail closed).
//
// It reads the event only for `cwd`. It never echoes the prompt and never
// looks for anything code-shaped in it: matching codes would mean handling
// them. No network; bounded time.
import fs from "node:fs";
import path from "node:path";
import { readState } from "../lib/state.mjs";
import { projectStrictStatus, strictPromptNotice } from "../lib/strict-status.mjs";

const MAX_EVENT = 4 * 1024 * 1024;
const DEADLINE_MS = 4000;

let root = null;
let done = false;
const emit = (notice) => {
  if (done) return;
  done = true;
  if (notice) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notice } }));
  process.exit(0);
};
// Out of time: fail closed only where a skeleton exists.
setTimeout(() => emit(root ? strictPromptNotice(null) : null), DEADLINE_MS).unref();

/** The event's cwd, read with a size cap; the rest of the event (the prompt) is dropped unread. */
async function eventCwd() {
  let raw = "";
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > MAX_EVENT) return null;
    }
    const cwd = JSON.parse(raw || "{}")?.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
  } catch { return null; } finally { raw = ""; }
}

/** The nearest dir at or above `start` that holds a `.skeleton/` directory. */
function skeletonRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    try { if (fs.statSync(path.join(dir, ".skeleton")).isDirectory()) return dir; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

try {
  const base = (await eventCwd()) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  root = skeletonRoot(base);
  if (!root) emit(null);
  const state = readState(root);
  if (!state || !["scaffold", "fill", "done"].includes(state.phase)) emit(strictPromptNotice(null));
  let status;
  try { status = await projectStrictStatus(root); } catch { emit(strictPromptNotice(null)); }
  emit(strictPromptNotice(status));
} catch (err) {
  process.stderr.write(`skel prompt hook: ${err?.message ?? err}\n`);
  emit(root ? strictPromptNotice(null) : null);
}
