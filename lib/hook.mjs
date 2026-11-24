// The PreToolUse hook. It runs on every Edit/Write/MultiEdit/NotebookEdit/Bash
// in every project where it's installed, skeleton or not, so the common path
// loads state, phase and enrollment helpers: the gate (and the scanner) load
// only once a skeleton exists, or a call names skel's own state. Hook faults deny during enrolled fills.

import fs from "node:fs";
import { enrollment } from "./config-hook.mjs";
import path from "node:path";
import { isPhaseChange, mentionsStores, mentionsState } from "./phase.mjs";
import { findRoot, inSkelStores, leavesBase, readState, skelStoreDirs } from "./state.mjs";

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
    // So do skel's own trusted stores, outside every project: the state dir and
    // the old config dir a migration still reads from.
    const storeDirs = skelStoreDirs();
    if (input.tool_name === "Bash") {
      const command = input.tool_input?.command;
      repairCommand = isPhaseChange(command);
      if (isPhaseChange(command) || mentionsState(command)) {
        const { evaluateBash } = await loadGate();
        const root = inspect(base).root;
        return emit(evaluateBash({ command, state: root ? readState(root) : null, storeDirs }));
      }
    }
    const sessionProtection = inspect(sessionBase);
    if (sessionProtection.invalid) throw new Error(sessionProtection.reason);
    const protection = inspect(base);
    if (protection.invalid) throw new Error(protection.reason);
    if (input.tool_name === "Bash" && mentionsStores(input.tool_input?.command, storeDirs)) {
      const { evaluateBash } = await loadGate();
      const root = protection.root;
      return emit(evaluateBash({ command: input.tool_input.command, state: root ? readState(root) : null, storeDirs }));
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
    // Textual unless the path is outside the session's project (see inSkelStores).
    const project = process.env.CLAUDE_PROJECT_DIR || base;
    if (abs && inSkelStores(abs, { dir: storeDirs, project })) {
      const { evaluateStoreEdit } = await loadGate();
      const root = protection.root;
      return emit(evaluateStoreEdit({ toolName: input.tool_name, toolInput: input.tool_input, base, project, state: root ? readState(root) : null, storeDirs }));
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
        yieldIds: await deepPairingYield(root, state, input, base),
      });
    }
    emit(verdict);
  } catch (err) {
    if (repairCommand) {
      emit({ decision: "ask", reason: "skel: the gate could not run. This command matches a phase-change pattern and requires your approval; inspect the entire command." });
      return;
    }
    process.stderr.write(`skel PreToolUse: ${err?.message ?? String(err)}\n`);
    if (inspect(sessionBase).protected || inspect(failureBase).protected || (failureTarget && inspect(failureTarget).protected)) emit({ decision: "deny", reason: `skel: hook failed: ${err?.message ?? String(err)}. Repair the checkout or state using a terminal or Claude Code's ! shell mode before continuing.` });
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

/**
 * #192: fence ids skel's gate leaves to deepPairing's own gate for this edit,
 * or null (skel gates as usual). Off unless the human opted in with
 * `skel install --deeppairing-yield` (recorded outside the project). Then,
 * cheapest first and stopping at the first miss: an Edit or MultiEdit during
 * a fill; skel's approval record readable; the file not one of the record's
 * files; the file holding a SKEL fence whose id the record doesn't hold. Only
 * then is .deeppairing/ read (bounded; anything unreadable means no yield),
 * and only ids a fresh scope of an approved plan fences for this session's
 * edits inside its workspaceRoot (deepPairing's selectSkeletonScope) count.
 * Nothing an agent writes under .deeppairing/ can name one of skel's fences.
 */
async function deepPairingYield(root, state, input, base) {
  try {
    if (state.phase !== "fill" || (input.tool_name !== "Edit" && input.tool_name !== "MultiEdit")) return null;
    const { deepPairingYieldEnabled, deepPairingSessionIds, gateIdsFor, readDeepPairing, recordFenceIds } = await import("./deeppairing.mjs");
    const { storePath } = await import("./state.mjs");
    if (!deepPairingYieldEnabled([root, process.env.CLAUDE_PROJECT_DIR].filter(Boolean), storePath)) return null;
    const { readSnapshot } = await import("./snapshot.mjs");
    const record = readSnapshot(root);
    if (!Array.isArray(record?.fences) || record.approvedAt !== state.reviewEpoch) return null;
    const abs = path.resolve(base, String(input.tool_input?.file_path ?? ""));
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || Object.hasOwn(record.files ?? {}, rel) || (record.fenced ?? []).includes(rel)) return null;
    const text = fs.readFileSync(abs, "utf-8");
    if (!text.includes("SKEL[")) return null;
    const { scanText } = await import("./markers.mjs");
    const skels = recordFenceIds(record);
    const candidates = new Set(scanText(text.replace(/\r\n/g, "\n"), rel).map((f) => f.id).filter((id) => !skels.has(id)));
    if (!candidates.size) return null;
    const dp = readDeepPairing(root);
    if (dp.unreadable) return null;
    const live = gateIdsFor(dp, { sessionIds: deepPairingSessionIds(root, input.session_id), abs });
    const ids = new Set([...candidates].filter((id) => live.has(id)));
    return ids.size ? ids : null;
  } catch { return null; }
}
