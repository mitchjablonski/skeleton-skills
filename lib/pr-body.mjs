// `skel pr`: a Markdown pull-request body from the plan. Pure rendering; the
// CLI gathers the inputs. Read-only, and it changes no state.
//
// Step titles, file paths, diagram names and sources, and marker errors are
// written by the agent. On GitHub they could otherwise inject HTML, images,
// links, emphasis, @-mentions (which notify people) or issue links, or break
// the table. So (behaviour checked with GitHub's own GFM renderer):
//   - text() HTML-escapes & < >, backslash-escapes Markdown punctuation,
//     flattens newlines, and puts a zero-width space after @ and # (a
//     backslash does not stop GitHub's mentions or issue links);
//   - code() makes a code span longer than any backtick run inside, with
//     pipes escaped when it sits in a table cell;
//   - diagrams go in a fence longer than any backtick or tilde run inside.

const ZWSP = "&#8203;";
export const text = (s) => String(s)
  .replace(/[\r\n]+/g, " ")
  .replace(/\\/g, "\\\\")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/[`*_[\]()!~|]/g, "\\$&")
  .replace(/[@#]/g, (c) => c + ZWSP) // one pass: the entity itself contains "#"
  .trim();
export const code = (s, { inTable = false } = {}) => {
  let t = String(s).replace(/[\r\n]+/g, " ");
  if (inTable) t = t.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const tick = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${tick}${pad}${t}${pad}${tick}`;
};
export const fence = (lang, body) => {
  const src = String(body);
  const longest = Math.max(2, ...[...src.matchAll(/`{3,}|~{3,}/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${src.replace(/\n+$/, "")}\n${f}`;
};

const STATUS = { filled: "filled", todo: "to do" };

/**
 * Render the PR body.
 *   title, phase:   from the skeleton state
 *   steps:          [{ id, title, status, fences: [{ file, openLine }] }] (live markers)
 *   finalized:      { steps: [{ id, title }], files: [...] } after finalize, or null
 *   activeStep:     the step being filled, if any
 *   errors:         marker/scan errors (strings), shown so missing steps aren't silent
 *   diagrams:       [{ name, source }]
 *   approvedVersion: only from a valid approval record for this skeleton, else null
 *   drift:          verifySnapshot's result in fill ({ ok, reason? }) or null
 *   coverage:       { id } from a valid record, or null
 */
export function renderPrBody({ title, phase, steps = [], finalized = null, activeStep = null, errors = [], diagrams = [], approvedVersion = null, drift = null, coverage = null }) {
  const out = [`## ${text(title)}`, ""];
  const lead = phase === "done"
    ? "Built with skel: the code's shape was reviewed and approved as a skeleton first, then each step was filled inside its fence, and the markers were removed at the end."
    : phase === "fill"
      ? "Built with skel: the code's shape was reviewed and approved as a skeleton first; steps are filled one at a time inside their fences."
      : "Built with skel: this skeleton hasn't been approved yet, so nothing below has been filled.";
  out.push(lead, "");

  out.push("### Steps", "");
  if (phase === "done") {
    if (finalized && finalized.steps.length) {
      out.push("| Step | Title |", "|---|---|");
      for (const s of finalized.steps) out.push(`| ${text(s.id)} | ${text(s.title)} |`);
      if (finalized.files.length) out.push("", `Files: ${finalized.files.map((f) => code(f)).join(", ")}`);
    } else out.push("The step list isn't recorded for this skeleton (it was finalized by an older skel).");
  } else if (steps.length) {
    out.push("| Step | Title | Status | Where |", "|---|---|---|---|");
    for (const s of steps) {
      const status = s.id === activeStep ? "being filled" : (STATUS[s.status] ?? text(s.status));
      const where = s.fences.map((f) => code(`${f.file}:${f.openLine}`, { inTable: true })).join(", ");
      out.push(`| ${text(s.id)} | ${text(s.title)} | ${status} | ${where} |`);
    }
  } else out.push("No steps found.");
  if (errors.length) {
    out.push("", "**Marker problems** (steps in these files may be missing above):", "");
    for (const e of errors) out.push(`- ${text(e)}`);
  }

  for (const d of diagrams) out.push("", `### Architecture: ${text(d.name)}`, "", fence("mermaid", d.source));

  out.push("", "### Verification", "");
  if (phase === "fill") {
    if (drift?.reason) {
      out.push(`- **The approval record can't be used** (${text(drift.reason)}), so the approved version and the drift check aren't available. Run \`skel status\` for details.`);
    } else {
      if (approvedVersion) out.push(`- Approved skeleton version: ${code(approvedVersion)}`);
      out.push(drift && drift.ok === false
        ? "- **Drift from the approved skeleton: yes.** `skel done` and `skel finalize` refuse until it's resolved; run `skel status` for details."
        : drift && drift.ok === true ? "- Drift from the approved skeleton (its own files): none." : "- The drift check didn't run.");
      if (coverage) out.push(`- Source baseline ${code(coverage.id)}, recorded at approval; the full check of other files runs at \`skel done\` and \`skel finalize\`.`);
    }
  }
  if (phase === "done") out.push(finalized && finalized.steps.length
    ? "- Finalized: skel finalize ran, which requires every step filled and no drift before it removes the markers."
    : "- Finalized: the markers were removed.");
  if (phase === "scaffold") out.push("- Not approved yet.");
  return out.join("\n") + "\n";
}
