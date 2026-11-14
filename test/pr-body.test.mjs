// `skel pr`: Markdown PR body from the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrBody } from "../lib/pr-body.mjs";

const steps = [
  { id: "1", title: "parse input", status: "filled", fences: [{ file: "src/a.js", openLine: 3 }] },
  { id: "2", title: "write | output", status: "todo", fences: [{ file: "src/b.js", openLine: 10 }, { file: "src/c.js", openLine: 1 }] },
];

test("fill phase: step table with status and locations, active step, approved version, no drift", () => {
  const md = renderPrBody({ title: "Add exporter", phase: "fill", steps, activeStep: "2", approvedVersion: "abc123", drift: { ok: true }, coverage: { id: "cov1" } });
  assert.match(md, /^## Add exporter\n/);
  assert.match(md, /\| 1 \| parse input \| filled \| `src\/a.js:3` \|/);
  assert.match(md, /\| 2 \| write \\\| output \| being filled \| `src\/b.js:10`, `src\/c.js:1` \|/);
  assert.match(md, /Approved skeleton version: `abc123`/);
  assert.match(md, /Drift from the approved skeleton \(its own files\): none\./);
  assert.match(md, /Source baseline `cov1`, recorded at approval/);
});

test("drift is called out, and scaffold says not approved", () => {
  assert.match(renderPrBody({ title: "T", phase: "fill", steps, drift: { ok: false } }), /\*\*Drift from the approved skeleton: yes\.\*\*/);
  const s = renderPrBody({ title: "T", phase: "scaffold", steps });
  assert.match(s, /hasn't been approved yet/);
  assert.match(s, /- Not approved yet\./);
  assert.doesNotMatch(s, /Approved skeleton version/);
});

test("done phase uses the finalized record (markers are gone)", () => {
  const md = renderPrBody({ title: "T", phase: "done", finalized: { steps: [{ id: "1", title: "a" }, { id: "2", title: "b" }], files: ["src/a.js"] }, approvedVersion: "v9" });
  assert.match(md, /\| Step \| Title \|\n\|---\|---\|\n\| 1 \| a \|\n\| 2 \| b \|/);
  assert.match(md, /Files: `src\/a.js`/);
  assert.match(md, /Finalized: every step filled/);
});

test("agent-written text can't break the table, a code span or the diagram fence", () => {
  const md = renderPrBody({
    title: "x\n## injected heading", phase: "fill",
    steps: [{ id: "1", title: "a|b\n| fake | row |", status: "todo", fences: [{ file: "we`ird.js", openLine: 1 }] }],
    diagrams: [{ name: "arch", source: "flowchart TD\n  A --> B\n```\n## escaped heading\n" }],
  });
  assert.doesNotMatch(md, /^## injected heading/m, "title newline can't start a heading");
  assert.match(md, /\| a\\\|b \\\| fake \\\| row \\\| \|/);
  assert.match(md, /``we`ird.js:1``/);
  const fenceOpen = md.indexOf("````mermaid");
  assert.ok(fenceOpen > 0, "fence is longer than any backtick run inside");
  const fenceClose = md.indexOf("\n````", fenceOpen + 1);
  assert.ok(md.slice(fenceOpen, fenceClose).includes("## escaped heading"), "inner ``` stays inside the block");
});
