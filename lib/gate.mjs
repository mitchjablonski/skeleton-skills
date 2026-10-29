// The scope gate: while a step is being filled, an edit may only change code
// inside that step's fences. Anything else is a skeleton change, and skeleton
// changes go back to the human.
//
// The edit's RESULT is what gets checked, not just where old_string sat:
// new_string can carry markers or close the enclosing function, and MultiEdit
// applies its edits in sequence. evaluate() is pure over (tool call, state,
// file reader) so it can be tested without a hook process. It returns null
// when it has no opinion.

import fs from "node:fs";
import path from "node:path";
import { scanText } from "./markers.mjs";
import { STATE_DIR } from "./state.mjs";

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

/** Apply one edit the way the Edit tool does: first occurrence, or all. */
function applyEdit(text, oldStr, newStr, all) {
  if (!oldStr) return null;
  const first = text.indexOf(oldStr);
  if (first === -1) return null;
  const spans = [];
  let out = "";
  let from = 0;
  let i = first;
  while (i !== -1) {
    spans.push(spanOf(text, i, oldStr));
    out += text.slice(from, i) + newStr;
    from = i + oldStr.length;
    if (!all) break;
    i = text.indexOf(oldStr, from);
  }
  return { text: out + text.slice(from), spans };
}

/**
 * Every line outside the given fences' bodies (marker lines included) must
 * survive whole and in order. Compared line by line, so nothing can be
 * appended to or prefixed onto a marker line.
 */
function preservesOutside(original, next, fences) {
  const lines = original.split("\n");
  const out = next.split("\n");
  const sorted = [...fences].sort((a, b) => a.openLine - b.openLine);
  const segments = [];
  let from = 0;
  for (const f of sorted) {
    segments.push(lines.slice(from, f.openLine));
    from = f.closeLine - 1;
  }
  segments.push(lines.slice(from));
  const matchesAt = (seg, at) => at >= 0 && at + seg.length <= out.length && seg.every((l, i) => out[at + i] === l);
  let pos = 0;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    if (k === 0) {
      if (!matchesAt(seg, 0)) return false;
      pos = seg.length;
    } else if (k === segments.length - 1) {
      if (out.length - seg.length < pos || !matchesAt(seg, out.length - seg.length)) return false;
    } else {
      let at = pos;
      while (at + seg.length <= out.length && !matchesAt(seg, at)) at++;
      if (!matchesAt(seg, at)) return false;
      pos = at + seg.length;
    }
  }
  return true;
}

const signature = (fences) => fences.map((f) => `${f.id}\u0000${f.title}`).join("\u0001");

const HASH_COMMENT_EXT = /\.(py|pyi|rb|sh|bash|zsh|ya?ml|toml|r|pl|ex|exs|nim|cr|coffee)$/i;

/**
 * Does a filled body escape the block it was fenced in? Language-agnostic
 * heuristics, so a miss errs toward asking:
 *   - brackets: a running ()[]{} depth (strings and line comments skipped)
 *     that dips below zero closed the enclosing block; one that doesn't end
 *     at zero left something open for the code after the fence.
 *   - indentation: a non-blank line indented less than the opening marker
 *     left the enclosing block (the Python shape of the same escape).
 */
export function bodyEscapesFence(body, markerLine, file) {
  const indentOf = (l) => (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
  const markerIndent = indentOf(markerLine);
  const hash = HASH_COMMENT_EXT.test(file);
  let depth = 0;
  let quote = null;
  for (const line of body.split("\n")) {
    if (line.trim() && !quote && indentOf(line) < markerIndent) return "a line is indented outside the fence's block";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if ((c === "/" && line[i + 1] === "/") || (hash && c === "#")) break;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) return "it closes the block the fence sits in";
      }
    }
    if (quote && quote !== "`") quote = null; // ' and " don't span lines
  }
  return depth === 0 ? null : "it leaves a bracket open past the fence";
}

/** Resolve symlinks on the longest existing prefix (the file may not exist yet). */
export function realish(p) {
  let cur = p;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function describe(step, fences) {
  const where = fences.map((f) => `${f.file}:${f.openLine}-${f.closeLine}`).join(", ");
  return `STEP ${step} is active${fences[0]?.title ? ` ("${fences[0].title}")` : ""}; its fence${fences.length > 1 ? "s are" : " is"} ${where}`;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * @param {object} args
 * @param {string} args.toolName   Edit | MultiEdit | Write | NotebookEdit
 * @param {object} args.toolInput
 * @param {string} args.root       project root
 * @param {object} args.state      .skeleton/state.json contents
 * @param {(abs: string) => string|null} args.readFile  null when missing
 * @param {object[] | (() => object[])} args.activeFences  every fence of the active step,
 *   repo-wide (only used to word a refusal, so a getter keeps the common path scan-free)
 * @param {(p: string) => string} [args.resolve]  symlink resolver (tests pass identity)
 * @returns {null | { decision: "ask"|"deny", reason: string }}
 */
export function evaluate({ toolName, toolInput, root, state, readFile, activeFences, resolve = realish }) {
  if (!state || !EDIT_TOOLS.has(toolName)) return null;
  const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
  if (typeof filePath !== "string" || !filePath) return null;

  const realRoot = resolve(path.resolve(root));
  const abs = resolve(path.resolve(root, filePath));
  const rel = path.relative(realRoot, abs).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const decision = state.gate === "deny" ? "deny" : "ask";

  // The tool's own state is the human's, in every phase: an agent that rewrites
  // state.json or feedback.json can switch the gate off or forge a verdict.
  // Diagrams are the agent's to draw.
  if (rel === STATE_DIR || rel.startsWith(`${STATE_DIR}/`)) {
    if (rel.startsWith(`${STATE_DIR}/diagrams/`)) return null;
    return {
      decision,
      reason:
        `skeleton gate: ${rel} is the skeleton tool's own state (phase, active step, the human's feedback). ` +
        `Agents don't edit it: use the skel CLI, and ask the human for anything that needs their approval.`,
    };
  }

  if (state.phase !== "fill") return null;
  if (!state.activeStep) {
    // Between steps (right after approve, or after each done) nothing is
    // being filled, so nothing in the skeleton should change either.
    if (toolName === "NotebookEdit") return null;
    const text = readFile(abs);
    const tracked = (state.files ?? []).includes(rel);
    if (!tracked && (text === null || !text.includes("SKEL["))) return null;
    return {
      decision,
      reason:
        `skeleton scope gate: no step is active, and ${rel} is part of the approved skeleton. ` +
        "Start the step this belongs to (skel next / skel start <id>), or propose the change to the human.",
    };
  }
  const step = state.activeStep;
  const refuse = (what) => ({
    decision,
    reason:
      `skeleton scope gate: ${what}. ${describe(step, typeof activeFences === "function" ? activeFences() : activeFences)}. Filling a step may only change code inside its fence — ` +
      `anything else is a skeleton change. Stop and propose it to the human (what, where, why) instead.`,
  });

  if (toolName === "NotebookEdit") return refuse(`notebook edits aren't checked against fences (${rel})`);

  const original = readFile(abs);
  if (original === null) return toolName === "Write" ? refuse(`this creates a new file (${rel})`) : null;

  let before;
  try {
    before = scanText(original, rel);
  } catch {
    return refuse(`${rel} has malformed SKEL markers`);
  }
  const active = before.filter((f) => f.id === step);
  if (active.length === 0) return refuse(`${rel} has no SKEL[${step}] fence`);

  // 1. Build the result, checking each edit against the text it actually
  //    lands in. A span may include the fence's own marker lines: with
  //    identical stubs the marker is often the only unique anchor.
  let next;
  if (toolName === "Write") {
    next = String(toolInput.content ?? "");
  } else {
    const edits = toolName === "MultiEdit" ? toolInput.edits ?? [] : [toolInput];
    next = original;
    for (const e of edits) {
      const applied = applyEdit(next, e?.old_string, typeof e?.new_string === "string" ? e.new_string : "", e?.replace_all === true);
      // A lone Edit that misses fails on its own; inside a MultiEdit the miss
      // may only be a miss against the ORIGINAL text, so don't wave it through.
      if (!applied) return toolName === "Edit" ? null : refuse(`an edit's old_string isn't in ${rel} at that point`);
      let current;
      try {
        current = scanText(next, rel).filter((f) => f.id === step);
      } catch {
        return refuse(`${rel} has malformed SKEL markers`);
      }
      for (const [start, end] of applied.spans) {
        if (!current.some((f) => start >= f.openLine && end <= f.closeLine)) {
          return refuse(`this edit touches ${rel}:${start}${end > start ? `-${end}` : ""}`);
        }
      }
      next = applied.text;
    }
  }

  // 2. The markers must survive exactly: same fences, same order, same titles.
  let after;
  try {
    after = scanText(next, rel);
  } catch {
    return refuse(`this leaves malformed SKEL markers in ${rel}`);
  }
  if (signature(after) !== signature(before)) return refuse(`this adds, removes or retitles SKEL markers in ${rel}`);

  // 3. Everything outside the active bodies must be unchanged, line for line.
  if (!preservesOutside(original, next, active)) return refuse(`this changes ${rel} outside the SKEL[${step}] fence`);

  // 4. And each filled body must stay inside the block it was fenced in.
  const lines = next.split("\n");
  for (const f of after.filter((x) => x.id === step)) {
    const escape = bodyEscapesFence(lines.slice(f.openLine, f.closeLine - 1).join("\n"), lines[f.openLine - 1] ?? "", rel);
    if (escape) return refuse(`in ${rel}:${f.openLine}-${f.closeLine}, ${escape}`);
  }
  return null;
}

/**
 * Bash is outside the edit gate, but the commands that would quietly undo it
 * are easy to spot: anything naming the .skeleton/ state files. Ask about those.
 */
export function evaluateBash({ command, state }) {
  if (!state || typeof command !== "string") return null;
  if (!/\.skeleton[\\/]+(state|feedback|serve)/.test(command)) return null;
  return {
    decision: state.gate === "deny" ? "deny" : "ask",
    reason:
      "skeleton gate: this command touches the skeleton tool's own state (.skeleton/state.json or feedback). " +
      "Agents don't edit it directly: use the skel CLI, and ask the human for anything that needs their approval.",
  };
}
