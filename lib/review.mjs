// Builds the review page: one self-contained HTML file with the skeleton's
// files, its steps, and a feedback panel. Works opened straight from disk
// (feedback is copied as markdown) or through `skel serve` (feedback is
// sent back to the agent and the page live-reloads as steps get filled).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanFiles, scanRepo, toSteps } from "./markers.mjs";
import { STATE_DIR, insideRoot, writeFileAtomic } from "./state.mjs";
import { noteRendered, readSnapshot, recordSkeleton, scanSkeleton, verifySnapshot } from "./snapshot.mjs";

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

/**
 * @param cache   a Map shared across calls (`skel serve`): unchanged files are
 *                neither re-read nor re-parsed
 * @param known   absolute paths to parse instead of searching the repo: the
 *                server's cheap poll re-checks only the skeleton's own files
 */
export function buildReviewData(root, state, cache, known) {
  const { fences, errors, files: fencedFiles, errored } = scanSkeleton(root, cache, known);
  const steps = toSteps(fences);
  // Tracked files come from state.json, which a cloned repo could ship: only
  // regular files that resolve inside the project are ever read or served.
  const tracked = (state.files ?? []).filter((f) => {
    const abs = path.join(root, String(f));
    try {
      return insideRoot(root, abs) && fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  });
  // Context first (tracked, unfenced files such as new types), then files in
  // the order their first step is built.
  const firstStep = new Map();
  steps.forEach((st, i) => { for (const f of st.fences) if (!firstStep.has(f.file)) firstStep.set(f.file, i); });
  const byStep = [...fencedFiles].sort((a, b) => (firstStep.get(a) ?? 1e9) - (firstStep.get(b) ?? 1e9));
  const order = [...new Set([...tracked.filter((f) => !firstStep.has(f)), ...byStep, ...tracked])];
  // While filling, the working tree is checked against the approved skeleton;
  // the scan cache serves the fenced files' text when it is current.
  const cached = (rel) => {
    const e = cache?.get(path.join(root, rel));
    if (e && fencedFiles.includes(rel)) return e.text;
    try { return fs.readFileSync(path.join(root, rel), "utf-8"); } catch { return null; }
  };
  const drift = state.phase === "fill" ? verifySnapshot(root, state, fencedFiles, cached) : null;
  // The version this page shows: the same exteriors + fence set `skel approve`
  // records, so feedback (and the approval) can name what was reviewed.
  const record = recordSkeleton(root, state, fencedFiles, cached);
  const approvedVersion = state.phase === "fill" ? readSnapshot(root)?.version ?? null : null;
  const files = order.map((rel) => ({
    path: rel,
    // Fenced files were just stat-checked by the scan, so their cached text is
    // current; unfenced tracked files never pass through it, so read them.
    text: (fencedFiles.includes(rel) && cache?.get(path.join(root, rel))?.text) || fs.readFileSync(path.join(root, rel), "utf-8"),
    fences: fences
      .filter((f) => f.file === rel)
      .map(({ id, openLine, closeLine, status }) => ({ id, openLine, closeLine, status })),
  }));
  return {
    diagrams: readDiagrams(root),
    title: state.title || path.basename(root),
    phase: state.phase,
    activeStep: state.activeStep,
    // A stable per-project key for the viewer's local drafts — hashed, so the
    // page never carries the absolute project path.
    reviewKey: crypto.createHash("sha256").update(`${root}::${state.title}`).digest("hex").slice(0, 16),
    generatedAt: new Date().toISOString(),
    errors,
    errored,
    drift: drift && !drift.ok ? { reason: drift.reason ?? null, items: drift.items } : null,
    skeletonVersion: record.version,
    approvedVersion,
    record,
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

// Pinned past CVE-2025-54881 (sequence-label XSS, fixed in 10.9.4), with SRI so
// a tampered CDN copy can't run in the review page's origin.
const MERMAID = {
  src: "https://cdn.jsdelivr.net/npm/mermaid@10.9.8/dist/mermaid.min.js",
  integrity: "sha384-N3QqR/7q+xm3BGX+CBbNI8AUmRRqcsDzToy+0z1NLDI0QmTKW8zvwLvqulJgk3dP",
};

let assets = null;
const pageAssets = () =>
  (assets ??= {
    css: fs.readFileSync(path.join(HERE, "review.css"), "utf-8"),
    js: fs.readFileSync(path.join(HERE, "review-client.js"), "utf-8"),
  });

export function renderHtml(data, opts = {}) {
  const { css, js } = pageAssets();
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
<script id="skeleton-data" type="application/json">${escapeJson({ ...data, token: opts.token ?? null })}</script>
<script>${js}</script>
${data.diagrams.length ? `<script async src="${MERMAID.src}" integrity="${MERMAID.integrity}" crossorigin="anonymous" onload="window.dispatchEvent(new Event('skel-mermaid'))"></script>` : ""}
</body>
</html>
`;
}

export function writeReview(root, state) {
  const out = path.join(root, STATE_DIR, "review.html");
  const { record, ...data } = buildReviewData(root, state);
  noteRendered(root, record);
  writeFileAtomic(out, renderHtml(data));
  return out;
}
