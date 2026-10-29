// The PreToolUse hook. It runs on every Edit/Write/MultiEdit/NotebookEdit/Bash
// in every project where it's installed, skeleton or not, so the common path
// loads nothing but state.mjs: the gate (and the scanner) load only once a
// skeleton exists. Fails open: a broken gate must never wedge the session.

import fs from "node:fs";
import path from "node:path";
import { isPhaseChange } from "./phase.mjs";
import { findRoot, readState } from "./state.mjs";

export async function runHook() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw || "{}");
    const base = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    // Approving or reopening a skeleton always asks — before any root lookup,
    // so it fires from a monorepo root, a sibling dir, anywhere.
    if (input.tool_name === "Bash") {
      if (isPhaseChange(input.tool_input?.command)) {
        const { evaluateBash } = await import("./gate.mjs");
        const root = findRoot(base);
        return emit(evaluateBash({ command: input.tool_input.command, state: root ? readState(root) : null }));
      }
    }
    // The session's skeleton when it contains the file; otherwise the one that
    // owns the file (a session started outside the project).
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const abs = typeof target === "string" && target ? path.resolve(base, target) : null;
    const cwdRoot = findRoot(base);
    const inside = (r) => abs && !path.relative(r, abs).startsWith("..");
    const root = cwdRoot && (!abs || inside(cwdRoot)) ? cwdRoot : abs ? findRoot(path.dirname(abs)) ?? cwdRoot : cwdRoot;
    if (!root) return;
    const state = readState(root);
    if (!state) return;
    const { evaluate, evaluateBash } = await import("./gate.mjs");
    let verdict;
    if (input.tool_name === "Bash") {
      verdict = evaluateBash({ command: input.tool_input?.command, state });
    } else {
      const { scanRepo } = await import("./markers.mjs");
      verdict = evaluate({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        root,
        state,
        // Only needed to word a refusal; scanning the repo on every edit isn't.
        activeFences: () => scanRepo(root).fences.filter((f) => f.id === state.activeStep),
        readFile: (abs) => { try { return fs.readFileSync(abs, "utf-8"); } catch { return null; } },
      });
    }
    emit(verdict);
  } catch {
    // no opinion
  }
}

function emit(verdict) {
  if (!verdict) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  }));
}
