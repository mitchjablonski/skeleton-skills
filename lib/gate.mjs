// The scope gate: while a step is being filled, an edit may only change code
// inside that step's fences. Anything else is a skeleton change, and skeleton
// changes go back to the human.
//
// evaluate() is pure over (tool call, state, file reader) so it can be tested
// without a hook process. It returns null when it has no opinion.

import path from "node:path";
import { scanText } from "./markers.mjs";

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Line span [start, end] that replacing `needle` at `index` touches. */
function spanOf(text, index, needle) {
  let start = lineOf(text, index);
  let end = start;
  for (let i = 0; i < needle.length; i++) if (needle.charCodeAt(i) === 10) end++;
  // A leading newline belongs to the previous line's terminator, a trailing one
  // to this line's; neither moves the edit onto a neighbouring line.
  if (needle.startsWith("\n") && end > start) start++;
  if (needle.endsWith("\n") && end > start) end--;
  return [start, end];
}

function occurrences(text, needle, all) {
  const out = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    if (!all) break;
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

const inside = (fence, [start, end]) => start > fence.openLine && end < fence.closeLine;

/** Text outside the given fences must survive a whole-file Write unchanged. */
function preservesOutside(original, next, fences) {
  const lines = original.split("\n");
  const sorted = [...fences].sort((a, b) => a.openLine - b.openLine);
  const segments = [];
  let from = 0;
  for (const f of sorted) {
    segments.push(lines.slice(from, f.openLine).join("\n"));
    from = f.closeLine - 1;
  }
  segments.push(lines.slice(from).join("\n"));
  let pos = 0;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    if (k === 0 && !next.startsWith(seg)) return false;
    if (k === segments.length - 1) return next.endsWith(seg) && next.length - seg.length >= pos;
    const idx = next.indexOf(seg, pos);
    if (idx === -1) return false;
    pos = idx + seg.length;
  }
  return true;
}

function describe(step, fences) {
  const where = fences.map((f) => `${f.file}:${f.openLine}-${f.closeLine}`).join(", ");
  return `STEP ${step} is active${fences[0]?.title ? ` ("${fences[0].title}")` : ""}; its fence${fences.length > 1 ? "s are" : " is"} ${where}`;
}

/**
 * @param {object} args
 * @param {string} args.toolName   Edit | MultiEdit | Write
 * @param {object} args.toolInput
 * @param {string} args.root       project root
 * @param {object} args.state      .skeleton/state.json contents
 * @param {(abs: string) => string|null} args.readFile  null when missing
 * @param {object[]} args.activeFences  every fence of the active step, repo-wide
 * @returns {null | { decision: "ask"|"deny", reason: string }}
 */
export function evaluate({ toolName, toolInput, root, state, readFile, activeFences }) {
  if (!state || state.phase !== "fill" || !state.activeStep) return null;
  if (!["Edit", "MultiEdit", "Write"].includes(toolName)) return null;
  const filePath = toolInput?.file_path;
  if (typeof filePath !== "string") return null;

  const abs = path.resolve(root, filePath);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel.startsWith(".skeleton/")) return null;

  const step = state.activeStep;
  const decision = state.gate === "deny" ? "deny" : "ask";
  const context = describe(step, activeFences);
  const refuse = (what) => ({
    decision,
    reason:
      `skeleton scope gate: ${what}. ${context}. Filling a step may only change code inside its fence — ` +
      `anything else is a skeleton change. Stop and propose it to the human (what, where, why) instead.`,
  });

  const original = readFile(abs);
  if (original === null) {
    if (toolName === "Write") return refuse(`this creates a new file (${rel})`);
    return null; // Edit on a missing file fails on its own.
  }

  let fences;
  try {
    fences = scanText(original, rel).filter((f) => f.id === step);
  } catch {
    return refuse(`${rel} has malformed SKEL markers`);
  }
  if (fences.length === 0) return refuse(`${rel} has no SKEL[${step}] fence`);

  if (toolName === "Write") {
    const next = String(toolInput.content ?? "");
    return preservesOutside(original, next, fences)
      ? null
      : refuse(`this rewrites ${rel} outside the SKEL[${step}] fence`);
  }

  const edits = toolName === "MultiEdit" ? toolInput.edits ?? [] : [toolInput];
  for (const e of edits) {
    for (const idx of occurrences(original, e.old_string, e.replace_all)) {
      const span = spanOf(original, idx, e.old_string);
      if (!fences.some((f) => inside(f, span))) {
        return refuse(`this edit touches ${rel}:${span[0]}-${span[1]}`);
      }
    }
  }
  return null;
}
