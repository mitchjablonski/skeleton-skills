// The PreToolUse hook. It runs on every Edit/Write/MultiEdit/NotebookEdit/Bash
// in every project where it's installed, skeleton or not, so the common path
// loads nothing but state.mjs: the gate (and the scanner) load only once a
// skeleton exists. Fails open: a broken gate must never wedge the session.

import fs from "node:fs";
import path from "node:path";
import { isPhaseChange, mentionsState } from "./phase.mjs";
import { findRoot, readState } from "./state.mjs";

export async function runHook() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw || "{}");
    const base = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    // Phase changes and .skeleton/ state always ask — before any root lookup,
    // so they fire from a monorepo root, a sibling dir, anywhere.
    if (input.tool_name === "Bash") {
      const command = input.tool_input?.command;
      if (isPhaseChange(command) || mentionsState(command)) {
        const { evaluateBash } = await import("./gate.mjs");
        const root = outermost(findRoot(base));
        return emit(evaluateBash({ command, state: root ? readState(root) : null }));
      }
    }
    // The session's skeleton when it contains the file; otherwise the one that
    // owns the file (a session started outside the project). Either way, an
    // enclosing skeleton that is mid-fill outranks a nested one, so a state
    // file planted (or shipped) deeper down can't unfence its subtree.
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const abs = typeof target === "string" && target ? path.resolve(base, target) : null;
    const cwdRoot = findRoot(base);
    const inside = (r) => abs && !path.relative(r, abs).startsWith("..");
    const near = cwdRoot && (!abs || inside(cwdRoot)) ? cwdRoot : abs ? findRoot(path.dirname(abs)) ?? cwdRoot : cwdRoot;
    const root = outermost(near);
    if (!root) return;
    const state = readState(root);
    if (!state) return;
    const { evaluate, evaluateBash } = await import("./gate.mjs");
    let verdict;
    if (input.tool_name === "Bash") {
      verdict = evaluateBash({ command: input.tool_input?.command, state });
    } else {
      const { scanText } = await import("./markers.mjs");
      verdict = evaluate({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        root,
        state,
        // Only used to word a refusal: the edited file's own fences, no repo scan.
        activeFences: () => {
          try {
            const p = path.resolve(base, String(input.tool_input?.file_path ?? ""));
            return scanText(fs.readFileSync(p, "utf-8"), path.relative(root, p)).filter((f) => f.id === state.activeStep);
          } catch {
            return [];
          }
        },
        readFile: (abs) => { try { return fs.readFileSync(abs, "utf-8"); } catch { return null; } },
      });
    }
    emit(verdict);
  } catch {
    // no opinion
  }
}

/** The outermost skeleton at or above `root` that is mid-fill, else `root`. */
function outermost(root) {
  if (!root) return root;
  let best = root;
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    const up = findRoot(dir);
    if (!up) break;
    if (readState(up)?.phase === "fill") best = up;
    if (path.dirname(up) === up) break;
    dir = up;
  }
  return best;
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
