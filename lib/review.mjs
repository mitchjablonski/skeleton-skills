// Builds the review page: one self-contained HTML file with the skeleton's
// files, its steps, and a feedback panel. Works opened straight from disk
// (feedback is copied as markdown) or through `skel serve` (feedback is
// sent back to the agent and the page live-reloads as steps get filled).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, toSteps } from "./markers.mjs";
import { STATE_DIR } from "./state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Architecture diagrams: Mermaid sources in .skeleton/diagrams/*.mmd, shown
 * above the code. A node whose id is `step_<id>` (dots as underscores, so
 * step 2.1 is `step_2_1`) is coloured by that step's status and jumps to it.
 */
export function readDiagrams(root) {
  const dir = path.join(root, STATE_DIR, "diagrams");
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".mmd")).sort(); } catch { return []; }
  return names.map((n) => ({ name: n.replace(/\.mmd$/, ""), source: fs.readFileSync(path.join(dir, n), "utf-8") }));
}

export function buildReviewData(root, state) {
  const { fences, errors, files: fencedFiles } = scanRepo(root);
  const steps = toSteps(fences);
  const tracked = (state.files ?? []).filter((f) => fs.existsSync(path.join(root, f)));
  const order = [...new Set([...tracked, ...fencedFiles])];
  const files = order.map((rel) => ({
    path: rel,
    text: fs.readFileSync(path.join(root, rel), "utf-8"),
    fences: fences
      .filter((f) => f.file === rel)
      .map(({ id, openLine, closeLine, status }) => ({ id, openLine, closeLine, status })),
  }));
  return {
    diagrams: readDiagrams(root),
    title: state.title || path.basename(root),
    phase: state.phase,
    activeStep: state.activeStep,
    reviewKey: `${root}::${state.title}`,
    generatedAt: new Date().toISOString(),
    errors,
    steps: steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      locations: s.fences.map((f) => ({ file: f.file, line: f.openLine })),
    })),
    files,
  };
}

const escapeJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function renderHtml(data) {
  const css = fs.readFileSync(path.join(HERE, "review.css"), "utf-8");
  const js = fs.readFileSync(path.join(HERE, "review-client.js"), "utf-8");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)} · skeleton</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script id="skeleton-data" type="application/json">${escapeJson(data)}</script>
${data.diagrams.length ? `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>` : ""}
<script>${js}</script>
</body>
</html>
`;
}

export function writeReview(root, state) {
  const out = path.join(root, STATE_DIR, "review.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderHtml(buildReviewData(root, state)));
  return out;
}
