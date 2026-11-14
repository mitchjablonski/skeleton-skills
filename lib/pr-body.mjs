// `skel pr`: a Markdown pull-request body from the plan. Pure rendering; the
// CLI gathers the inputs. Read-only, and it changes no state.
//
// Step titles, file paths and diagram sources are written by the agent, so
// they are escaped for the table and fenced so they can't break out of their
// code block or inject Markdown structure into the body.

const cell = (s) => String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
const code = (s) => {
  const text = String(s).replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const tick = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${tick}${pad}${text}${pad}${tick}`;
};
const fence = (lang, body) => {
  const longest = Math.max(2, ...[...String(body).matchAll(/`{3,}/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${String(body).replace(/\n+$/, "")}\n${f}`;
};

const STATUS = { filled: "filled", todo: "to do" };

/**
 * Render the PR body.
 *   title, phase:   from the skeleton state
 *   steps:          [{ id, title, status, fences: [{ file, openLine }] }] (live markers), or
 *   finalized:      { steps: [{ id, title }], files: [...] } after finalize
 *   activeStep:     the step being filled, if any
 *   diagrams:       [{ name, source }]
 *   approvedVersion, drift ({ ok, ... } or null), coverage ({ id } or null)
 */
export function renderPrBody({ title, phase, steps = [], finalized = null, activeStep = null, diagrams = [], approvedVersion = null, drift = null, coverage = null }) {
  const out = [`## ${cell(title)}`, ""];
  const lead = phase === "done"
    ? "Built with skel: the code's shape was reviewed and approved as a skeleton first, then each step was filled inside its fence, and the markers were removed at the end."
    : phase === "fill"
      ? "Built with skel: the code's shape was reviewed and approved as a skeleton first; steps are filled one at a time inside their fences."
      : "Built with skel: this skeleton hasn't been approved yet, so nothing below has been filled.";
  out.push(lead, "");

  out.push("### Steps", "");
  if (phase === "done" && finalized) {
    out.push("| Step | Title |", "|---|---|");
    for (const s of finalized.steps) out.push(`| ${cell(s.id)} | ${cell(s.title)} |`);
    if (finalized.files.length) out.push("", `Files: ${finalized.files.map(code).join(", ")}`);
  } else if (steps.length) {
    out.push("| Step | Title | Status | Where |", "|---|---|---|---|");
    for (const s of steps) {
      const status = s.id === activeStep ? "being filled" : (STATUS[s.status] ?? cell(s.status));
      const where = s.fences.map((f) => code(`${f.file}:${f.openLine}`)).join(", ");
      out.push(`| ${cell(s.id)} | ${cell(s.title)} | ${status} | ${where} |`);
    }
  } else out.push("No steps found.");

  for (const d of diagrams) out.push("", `### Architecture: ${cell(d.name)}`, "", fence("mermaid", d.source));

  out.push("", "### Verification", "");
  if (approvedVersion) out.push(`- Approved skeleton version: ${code(approvedVersion)}`);
  if (phase === "fill") {
    out.push(drift && !drift.ok
      ? "- **Drift from the approved skeleton: yes.** `skel done` and `skel finalize` refuse until it's resolved; run `skel status` for details."
      : "- Drift from the approved skeleton (its own files): none.");
    if (coverage) out.push(`- Source baseline ${code(coverage.id)}, recorded at approval; the full check of other files runs at \`skel done\` and \`skel finalize\`.`);
  }
  if (phase === "done") out.push("- Finalized: every step filled and the full drift check passed before the markers were removed.");
  if (phase === "scaffold") out.push("- Not approved yet.");
  return out.join("\n") + "\n";
}
