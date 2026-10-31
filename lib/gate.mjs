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
import { STATE_DIR, leavesBase } from "./state.mjs";
import { isPhaseChange, mentionsState } from "./phase.mjs";

export { isPhaseChange, mentionsState };

/** Line span [start, end] that replacing `needle` at a match starting on `startLine` touches. */
function spanAt(startLine, needle) {
  let start = startLine;
  let end = start;
  for (let i = 0; i < needle.length; i++) if (needle.charCodeAt(i) === 10) end++;
  // A leading newline belongs to the previous line's terminator, a trailing one
  // to this line's; neither moves the edit onto a neighbouring line.
  if (needle.startsWith("\n") && end > start) start++;
  if (needle.endsWith("\n") && end > start) end--;
  return [start, end];
}

/**
 * Apply one edit the way the Edit tool does: first occurrence, or all. Line
 * numbers are counted forward from the previous match, so replace_all stays
 * linear in the file size.
 */
function applyEdit(text, oldStr, newStr, all) {
  if (!oldStr) return null;
  const first = text.indexOf(oldStr);
  if (first === -1) return null;
  const spans = [];
  let out = "";
  let from = 0;
  let line = 1;
  let counted = 0;
  let i = first;
  while (i !== -1) {
    for (; counted < i; counted++) if (text.charCodeAt(counted) === 10) line++;
    spans.push(spanAt(line, oldStr));
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
const SHELL_EXT = /\.(sh|bash|zsh)$/i;
const PY_EXT = /\.pyi?$/i;
const RUST_EXT = /\.rs$/i;
const C_FAMILY_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|m|mm)$/i;
const PROSE_EXT = /\.(md|mdx|markdown|txt|rst|html?|xml|svg)$/i;
const JSX_EXT = /\.(jsx|tsx)$/i;
const TRIPLE = ['"""', "'''"];

/**
 * Does a filled body escape the block it was fenced in? Language-aware
 * heuristics, not a parser:
 *   - brackets: a running ()[]{} depth (strings and comments skipped) that
 *     dips below zero closed the enclosing block; one that doesn't end at zero
 *     left something open for the code after the fence.
 *   - indentation: a non-blank line indented less than the opening marker
 *     left the enclosing block (the Python shape of the same escape).
 * Shell bodies get only the indentation check (`case` patterns end in a bare
 * `)`); Python triple-quoted strings, Rust lifetimes, C preprocessor lines and
 * block comments are skipped. The caller treats a hit as "ask", never "deny".
 */
export function bodyEscapesFence(body, markerLine, file) {
  const indentOf = (l) => (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
  const markerIndent = indentOf(markerLine);
  const hash = HASH_COMMENT_EXT.test(file);
  const prose = PROSE_EXT.test(file); // no blocks in prose: neither check applies
  const brackets = !SHELL_EXT.test(file) && !prose;
  const jsx = JSX_EXT.test(file);
  let prev = ""; // last non-space char outside strings/comments, to spot regex literals
  const py = PY_EXT.test(file);
  const rust = RUST_EXT.test(file);
  const cfam = C_FAMILY_EXT.test(file);
  let depth = 0;
  let quote = null; // a quote char, or a Python triple quote
  let block = false; // inside /* */
  for (const line of body.split("\n")) {
    const preprocessor = cfam && /^\s*#/.test(line);
    const spanning = quote === "`" || (quote && quote.length === 3);
    if (line.trim() && !spanning && !preprocessor && !prose && indentOf(line) < markerIndent) {
      return "a line is indented outside the fence's block";
    }
    if (preprocessor) continue;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (block) {
        if (c === "*" && line[i + 1] === "/") { block = false; i++; }
        continue;
      }
      if (quote) {
        // A closed string or template is an operand: a `/` after it divides.
        if (quote.length === 3) {
          if (line.startsWith(quote, i)) { quote = null; i += 2; prev = c; }
          continue;
        }
        if (c === "\\") i++;
        else if (c === quote) { quote = null; prev = c; }
        continue;
      }
      const triple = py && TRIPLE.find((t) => line.startsWith(t, i));
      if (triple) { quote = triple; i += 2; continue; }
      if (rust && c === "'" && !/^'(\\.|[^'\\])'/.test(line.slice(i))) continue; // a lifetime, not a char
      if (jsx && c === "'" && /[A-Za-z]/.test(line[i - 1] ?? "")) continue; // an apostrophe in JSX text
      // A regex literal: `/` where an operand can't end (after ( , = : [ ! & | ? { ; or return).
      if (!hash && c === "/" && line[i + 1] !== "/" && line[i + 1] !== "*" && (prev === "" || /[(,=:[!&|?{;]/.test(prev) || /\breturn\s*$/.test(line.slice(0, i)))) {
        const m = /^\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+\/[a-z]*/.exec(line.slice(i));
        if (m) { i += m[0].length - 1; prev = "/"; continue; }
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (hash ? c === "#" : c === "/" && line[i + 1] === "/") break;
      // Only at a token boundary: `/\/*/` is a regex, not a comment.
      if (!hash && c === "/" && line[i + 1] === "*" && (i === 0 || /[\s;,(){}=]/.test(line[i - 1]))) { block = true; i++; continue; }
      if (c.trim()) prev = c;
      if (!brackets) continue;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) return "it closes the block the fence sits in";
      }
    }
    if (quote === '"' || quote === "'") quote = null; // these don't span lines
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
  if (leavesBase(rel)) return null;
  const decision = state.gate === "deny" ? "deny" : "ask";

  // The tool's own state is the human's, in every phase: an agent that rewrites
  // state.json or feedback.json can switch the gate off or forge a verdict.
  // Diagrams are the agent's to draw.
  // Any .skeleton directory, at any depth and in any case (macOS, Windows and
  // WSL's /mnt/c fold case): a planted nested state.json would otherwise
  // become the nearest skeleton for its subtree and switch the fence off.
  const segs = rel.toLowerCase().split("/");
  const at = segs.indexOf(STATE_DIR);
  if (at !== -1) {
    if (at === 0 && segs[1] === "diagrams" && segs.length > 2) return null;
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
    if (text === null && toolName === "Write") {
      return {
        decision,
        reason: `skeleton scope gate: no step is active, and this creates a new file (${rel}). New files are skeleton changes; propose it to the human.`,
      };
    }
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

  // Claude Code matches old_string against LF-normalised text and writes the
  // file's own line endings back, so compare in LF too: on a CRLF file a
  // multi-line old_string would otherwise never match, and slip through.
  const lf = (t) => String(t ?? "").replace(/\r\n/g, "\n");
  const raw = readFile(abs);
  if (raw === null) return toolName === "Write" ? refuse(`this creates a new file (${rel})`) : null;
  const original = lf(raw);

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
    next = lf(toolInput.content);
  } else {
    const edits = toolName === "MultiEdit" ? toolInput.edits ?? [] : [toolInput];
    next = original;
    for (const e of edits) {
      const applied = applyEdit(next, lf(e?.old_string), lf(typeof e?.new_string === "string" ? e.new_string : ""), e?.replace_all === true);
      // Unmatched even after normalising: Claude Code may still match it (it
      // also folds curly quotes), so ask rather than wave it through.
      if (!applied) return refuse(`an edit's old_string couldn't be located in ${rel} to check it`);
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
    // A heuristic hit asks even in deny mode: it can be wrong, and a refusal
    // would strand a legitimate fill.
    if (escape) return { ...refuse(`in ${rel}:${f.openLine}-${f.closeLine}, ${escape} (a heuristic check; the human can allow it)`), decision: "ask" };
  }
  return null;
}

/**
 * Bash is outside the edit gate, with two exceptions, both checked before the
 * hook looks for a skeleton so they fire from any working directory:
 *   - commands that change a skeleton's phase (approve, reshape, init,
 *     finalize) or would erase it (git clean -x, git stash --all) always ask. Claude Code's
 *     permission prompt is the one channel the agent can't answer for the
 *     human, so it IS the human's approval.
 *   - commands that name .skeleton/ state ask: the easy ways to undo the gate
 *     by hand.
 */
const PHASE_REASONS = {
  approve: (n) => `Claude wants to approve the skeleton${n} and start filling it. Allow only if you've reviewed its shape.`,
  reshape: (n) => `Claude wants to reopen the skeleton${n} for structural changes. Allow only if you agreed to the change.`,
  init: (n) => `Claude wants to start a new skeleton${n ? `, replacing${n}` : ""}. That unfences the current one. Allow only if you meant to.`,
  finalize: (n) => `Claude wants to finalize the skeleton${n}: strip its markers and end the fence. Allow only if you're done with it.`,
  clean: () => "This git clean removes ignored files, including .skeleton/ and with it the skeleton's fence. Allow only if you meant to.",
  stash: () => "This git stash --all also stashes and removes ignored files, including .skeleton/ and with it the skeleton's fence. Allow only if you meant to.",
};

export function evaluateBash({ command, state }) {
  if (typeof command !== "string") return null;
  const phase = isPhaseChange(command);
  if (phase) return { decision: "ask", reason: PHASE_REASONS[phase](state?.title ? ` "${state.title}"` : "") };
  if (!mentionsState(command)) return null;
  return {
    decision: state?.gate === "deny" ? "deny" : "ask",
    reason:
      "skeleton gate: this command touches the skeleton tool's own state (.skeleton/). " +
      "Agents don't edit it directly: use the skel CLI, and ask the human for anything that needs their approval.",
  };
}
