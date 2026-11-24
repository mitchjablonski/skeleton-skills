#!/usr/bin/env node
// UserPromptSubmit hook (#229): an always-on input contract for strict.
//
// It settles the strict request first, from the same projectStrictStatus that
// `skel status --json` reports, and only then looks at workflow state:
// - no skeleton project here (no `.skeleton/state.json` at or above cwd,
//   the CLI's findRoot; an empty `.skeleton/` doesn't count): no output;
// - request known false: no output, even if `.skeleton/` state is missing or
//   damaged (default mode is unchanged);
// - request known true: the strict notice with strict.next verbatim, plus a
//   distinct line if the workflow state is unreadable;
// - request source inconclusive: a neutral fail-closed notice that doesn't
//   claim strict is requested.
// The project root is the CLI's: the nearest dir holding .skeleton/state.json
// (findRoot), so an empty nested `.skeleton/` can't shadow a parent project.
// "Unreadable state" therefore means a state.json that exists but can't be
// read or parsed.
//
// It reads the event only for `cwd`. It never echoes the prompt and never
// looks for anything code-shaped in it: matching codes would mean handling
// them. No network. Its hard time bound is the hook runner's `timeout` in
// hooks/hooks.json; if the runner stops it, the prompt goes ahead without a
// notice. A softer in-process timer (which a blocked synchronous read can
// delay) answers first if it can: silent when the request is known false,
// the strict notice when known true, the neutral notice only when the request
// couldn't be resolved in a skeleton project. Diagnostics are fixed strings,
// never paths or prompt text.
import path from "node:path";
import { findRoot, readState } from "../lib/state.mjs";
import { projectStrictStatus, strictPromptNotice } from "../lib/strict-status.mjs";

const MAX_EVENT = 4 * 1024 * 1024;
const SOFT_DEADLINE_MS = 8000; // under the runner's 10 s timeout

const emit = (notice) => {
  if (notice) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notice } }));
  process.exit(0);
};

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

// What is known so far, for the soft deadline and the error path.
let root = null, status, requested; // requested: true | false | undefined (unresolved)
const answerSoFar = () => {
  if (!root || requested === false) return null;
  if (requested === true) return strictPromptNotice(status, { stateUnreadable: true });
  return strictPromptNotice(null);
};
setTimeout(() => emit(answerSoFar()), SOFT_DEADLINE_MS).unref();

try {
  const base = path.resolve((await eventCwd()) ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  root = findRoot(base); // the CLI's root: nearest .skeleton/state.json
  if (!root) emit(null);
  // 1. The request, before any workflow state.
  try { status = await projectStrictStatus(root); } catch { status = undefined; }
  const r = status && typeof status === "object" ? status.requested : undefined;
  requested = r === true || r === false ? r : undefined;
  if (requested === false) emit(null);
  if (requested !== true) emit(strictPromptNotice(null));
  // 2. Confirmed request: the notice, plus a line if the workflow state can't be read.
  const state = readState(root);
  const readable = !!state && ["scaffold", "fill", "done"].includes(state.phase);
  emit(strictPromptNotice(status, { stateUnreadable: !readable }));
} catch {
  process.stderr.write("skel prompt hook: internal error\n");
  emit(answerSoFar());
}
