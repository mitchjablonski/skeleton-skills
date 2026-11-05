// The PreToolUse hook. It runs on every Edit/Write/MultiEdit/NotebookEdit/Bash
// in every project where it's installed, skeleton or not, so the common path
// loads state, phase and enrollment helpers: the gate (and the scanner) load
// only once a skeleton exists, or a call names skel's own state. Hook faults deny during enrolled fills.

import fs from "node:fs";
import { enrollment } from "./config-hook.mjs";
import path from "node:path";
import { isPhaseChange, mentionsConfig, mentionsState } from "./phase.mjs";
import { findRoot, inSkelConfig, leavesBase, readState, skelConfigDir } from "./state.mjs";

export async function runHook({ loadGate = () => import("./gate.mjs") } = {}) {
  const enrollmentCache = new Map();
  const inspect = base => enrollment(base, enrollmentCache, { boundary: sessionBase });
  const sessionBase = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let failureBase = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let failureTarget = null;
  let repairCommand = false;
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw || "{}");
    const base = typeof input?.cwd === "string" && input.cwd ? input.cwd : failureBase;
    failureBase = base;
    // Phase changes and .skeleton/ state always ask — before any root lookup,
    // so they fire from a monorepo root, a sibling dir, anywhere.
    // So do skel's own trusted stores in its config dir, outside every project.
    const configDir = skelConfigDir();
    if (input.tool_name === "Bash") {
      const command = input.tool_input?.command;
      repairCommand = isPhaseChange(command) || mentionsState(command);
      if (isPhaseChange(command) || mentionsState(command)) {
        const { evaluateBash } = await loadGate();
        const root = inspect(base).root;
        return emit(evaluateBash({ command, state: root ? readState(root) : null, configDir }));
      }
    }
    const sessionProtection = inspect(sessionBase);
    if (sessionProtection.invalid) throw new Error(sessionProtection.reason);
    const protection = inspect(base);
    if (protection.invalid) throw new Error(protection.reason);
    if (input.tool_name === "Bash" && mentionsConfig(input.tool_input?.command, configDir)) {
      const { evaluateBash } = await loadGate();
      const root = protection.root;
      return emit(evaluateBash({ command: input.tool_input.command, state: root ? readState(root) : null, configDir }));
    }
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const abs = typeof target === "string" && target ? path.resolve(base, target) : null;
    // The cwd skeleton owns paths inside its nearest root, including nested
    // skeletons. Match root selection below rather than scanning ignored state.
    const ownedByCwd = abs && protection.nearest && !leavesBase(path.relative(protection.nearest, abs));
    failureTarget = abs && !ownedByCwd ? path.dirname(abs) : null;
    if (failureTarget) {
      const targetProtection = inspect(failureTarget);
      if (targetProtection.invalid) throw new Error(targetProtection.reason);
    }
    // Textual unless the path is outside the session's project (see inSkelConfig).
    const project = process.env.CLAUDE_PROJECT_DIR || base;
    if (abs && inSkelConfig(abs, { dir: configDir, project })) {
      const { evaluateConfigEdit } = await loadGate();
      const root = protection.root;
      return emit(evaluateConfigEdit({ toolName: input.tool_name, toolInput: input.tool_input, base, project, state: root ? readState(root) : null, configDir }));
    }
    // The session's skeleton when it contains the file; otherwise the one that
    // owns the file (a session started outside the project). Either way, an
    // enclosing skeleton that is mid-fill outranks a nested one, so a state
    // file planted (or shipped) deeper down can't unfence its subtree.
    const cwdRoot = protection.nearest;
    const inside = (r) => abs && !leavesBase(path.relative(r, abs));
    const owner = cwdRoot && (!abs || inside(cwdRoot)) ? protection : failureTarget ? inspect(failureTarget) : protection;
    const root = owner.root ?? protection.root;
    if (!root) return;
    const state = readState(root);
    if (!state) return;
    const { evaluate, evaluateBash } = await loadGate();
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
  } catch (err) {
    if (repairCommand) {
      emit({ decision: "ask", reason: "skel: explicit phase/state repair requires your approval; the normal gate could not run." });
      return;
    }
    process.stderr.write(`skel PreToolUse: ${err?.message ?? String(err)}\n`);
    if (inspect(sessionBase).protected || inspect(failureBase).protected || (failureTarget && inspect(failureTarget).protected)) emit({ decision: "deny", reason: `skel: hook failed: ${err?.message ?? String(err)}. Repair the hook or state before continuing.` });
  }
}

/** The outermost skeleton at or above `root` that is mid-fill, else `root`. */
export function outermost(root) {
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
