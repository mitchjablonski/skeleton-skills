// Builds the review page. `skel review` writes one self-contained HTML file
// with the skeleton's files, its steps and a feedback panel, opened straight
// from disk (feedback is copied as markdown). `skel serve` hands out an empty
// shell and the same client: the client fetches this data with the token from
// the URL's fragment, and live-reloads as steps get filled.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BYTES, readResolved, toSteps } from "./markers.mjs";
import { STATE_DIR, drvfsMountOf, insideRoot, realpath, resolveInside, writeFileAtomic } from "./state.mjs";
import { noteRendered, readSnapshot, recordSkeleton, scanSkeleton, verifySnapshot } from "./snapshot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Architecture diagrams: Mermaid sources in .skeleton/diagrams/*.mmd, shown
 * above the code. A node whose id is `step_<id>` (dots as underscores, so
 * step 2.1 is `step_2_1`) is coloured by that step's status and jumps to it.
 */
export function readDiagrams(root) {
  let realRoot;
  try { realRoot = realpath(root); } catch { return []; }
  // Each path is resolved once, and the resolved path is what gets listed,
  // stat'd and read, so a link swapped in after the check can't redirect it.
  const dir = resolveInside(root, path.join(root, STATE_DIR, "diagrams"), realRoot);
  if (!dir) return [];
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".mmd")).sort(); } catch { return []; }
  return names.flatMap((n) => {
    try {
      const real = resolveInside(root, path.join(dir, n), realRoot);
      if (!real) return [];
      const st = fs.statSync(real, { bigint: true });
      if (!st.isFile() || st.size > MAX_BYTES) return [];
      const source = readResolved(real, st, MAX_BYTES);
      return source === null ? [] : [{ name: n.replace(/\.mmd$/, ""), source }];
    } catch {
      // A removed, inaccessible or dangling entry must not break the review.
      return [];
    }
  });
}

/**
 * @param cache   a Map shared across calls (`skel serve`): unchanged files are
 *                neither re-read nor re-parsed
 * @param known   absolute paths to parse instead of searching the repo: the
 *                server's cheap poll re-checks only the skeleton's own files
 * @param escapeCheck  lib/gate.mjs bodyEscapesFence (loadEscapeCheck), or
 *                null: the page then shows no "may escape its block" notes
 */
export function buildReviewData(root, state, cache, known, escapeCheck = null) {
  const { fences, errors, files: fencedFiles, errored } = scanSkeleton(root, state, cache, known);
  const steps = toSteps(fences);
  // A finalized skeleton has no markers left to find its files by: finalize
  // recorded them (and its steps), so the page can still show what was built.
  const finalized = state.phase === "done" ? finalizedRecord(state) : null;
  // Tracked files come from state.json, which a cloned repo could ship: only
  // regular files that resolve inside the project are ever read or served.
  const tracked = [...new Set([...(state.files ?? []), ...(finalized?.files ?? [])])].filter((f) => {
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
  const files = order.map((rel) => {
    // Fenced files were just stat-checked by the scan, so their cached text is
    // current; unfenced tracked files never pass through it, so read them.
    const text = (fencedFiles.includes(rel) && cache?.get(path.join(root, rel))?.text) || fs.readFileSync(path.join(root, rel), "utf-8");
    const lines = state.phase === "fill" && escapeCheck ? text.split("\n") : null;
    return {
      path: rel,
      text,
      fences: fences
        .filter((f) => f.file === rel)
        .map(({ id, title, openLine, closeLine, status, body }) => ({
          id, title, openLine, closeLine, status,
          // #68 P11: the note `skel done` prints when a filled body may close
          // its block and open another (a heuristic), shown by its step too.
          ...(lines && status === "filled" ? escapeNote(escapeCheck, body, lines[openLine - 1], rel) : {}),
        })),
    };
  });
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
    finalized: finalized && { steps: finalized.steps.length, titles: finalized.steps },
    skeletonVersion: record.version,
    approvedVersion,
    record,
    steps: steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      // #68 P4: each fence's own title, so a step fenced in several places
      // lists them all.
      locations: s.fences.map((f) => ({ file: f.file, line: f.openLine, title: f.title })),
    })),
    files,
  };
}

/**
 * The gate's escape heuristic, loaded lazily: the gate is the hook's, and a
 * broken gate must not take `skel review` (a recovery route) down with it.
 */
export async function loadEscapeCheck() {
  try { return (await import("./gate.mjs")).bodyEscapesFence; } catch { return null; }
}

function escapeNote(check, body, marker, rel) {
  try {
    const escape = check(String(body ?? "").replace(/\r$/gm, ""), String(marker ?? "").replace(/\r$/, ""), rel);
    return escape ? { escape } : {};
  } catch {
    return {};
  }
}

/** What `skel finalize` recorded in state.json ({ steps: [{ id, title }], files }), checked: state.json can be hand-edited or shipped. */
export function finalizedRecord(state) {
  const f = state.finalized;
  if (!f || typeof f !== "object" || !Array.isArray(f.steps)) return null;
  const steps = f.steps.filter((s) => s && typeof s.id === "string" && typeof s.title === "string").map(({ id, title }) => ({ id, title }));
  const files = (Array.isArray(f.files) ? f.files : []).filter((x) => typeof x === "string");
  return { steps, files };
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

// HTML normalises line endings inside a script, and a CSP hash is taken after
// that: normalised here, the static page's hash holds on a CRLF checkout too.
let assets = null;
const pageAssets = () =>
  (assets ??= {
    css: fs.readFileSync(path.join(HERE, "review.css"), "utf-8"),
    js: ["review-poll.js", "review-feedback.js", "review-progress.js", "review-client.js"].map((f) => fs.readFileSync(path.join(HERE, f), "utf-8")).join("\n").replace(/\r\n?/g, "\n"),
  });

/** The review page's script, which the live shell loads from the server. */
export const clientScript = () => pageAssets().js;

// Mermaid injects <style> into each diagram and the client sets style
// attributes, so styles stay inline; scripts don't. No directive names the
// token or the data: this is the same for every project and every run.
const COMMON_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'"];

/** The live page's CSP: its own script, the pinned Mermaid file, and its own API. */
export const SHELL_CSP = [...COMMON_CSP, `script-src 'self' ${MERMAID.src}`, "connect-src 'self'", "frame-ancestors 'none'"].join("; ");

/** What the client reads: the data plus how this page is served. It never holds a token. */
export function pagePayload(data, { version, feedbackEnabled = false, serverId = null } = {}) {
  return { ...data, ...(version ? { version } : {}), feedbackEnabled, serverId, mermaid: data.diagrams.length ? MERMAID : null };
}

/**
 * The live page before it has its token: no project source, title or token.
 * Anything that can connect to the port gets this and the client script, and
 * nothing else without the token.
 */
export function renderShell() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skeleton review</title>
<style>${pageAssets().css}</style>
</head>
<body>
<div id="app"><div class="panel empty">Loading the review…</div></div>
<script src="/assets/review.js"></script>
</body>
</html>
`;
}

/** The static page: the data is embedded, so it needs no connection at all, and its CSP allows none. */
export function renderHtml(data) {
  const { css, js } = pageAssets();
  const hash = crypto.createHash("sha256").update(js, "utf-8").digest("base64");
  const csp = [...COMMON_CSP, `script-src 'sha256-${hash}'${data.diagrams.length ? ` ${MERMAID.src}` : ""}`].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)} · skeleton</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script id="skeleton-data" type="application/json">${escapeJson(pagePayload(data))}</script>
<script>${js}</script>
</body>
</html>
`;
}

export function writeReview(root, state, escapeCheck = null) {
  const out = path.join(root, STATE_DIR, "review.html");
  const { record, ...data } = buildReviewData(root, state, undefined, undefined, escapeCheck);
  noteRendered(root, record);
  writeFileAtomic(out, renderHtml(data));
  return out;
}

/**
 * #68 P8: on WSL, a path to the static review that a Windows browser can
 * open (a file:///tmp/... URL can't be): C:\... on a Windows drive, else
 * \\wsl.localhost\<distro>\.... Null when not on WSL.
 */
export function windowsReviewPath(abs, { platform = process.platform, distro = process.env.WSL_DISTRO_NAME, mountOf = drvfsMountOf } = {}) {
  if (platform !== "linux" || !distro || !abs.startsWith("/")) return null;
  let at = null;
  try { at = mountOf(abs); } catch {}
  const drive = at && /^\/mnt\/([a-z])$/i.exec(at);
  if (drive) return `${drive[1].toUpperCase()}:${abs.slice(at.length).replace(/\//g, "\\") || "\\"}`;
  return `\\\\wsl.localhost\\${distro}${abs.replace(/\//g, "\\")}`;
}
