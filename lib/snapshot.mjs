// The approved skeleton, recorded at `skel approve` and checked by `done`,
// `finalize`, `status` and the review page. The hook judges each edit before
// it lands, but only the edits it sees; this checks what actually ended up on
// disk, however it got there (Edit, Write, sed -i, a script).
//
// What is recorded: every skeleton file's *exterior* (the file with each
// fence's body lines dropped, marker lines kept), which is its shape: the
// signatures, the wiring, and the fence set (ids, titles, order) in one. The
// skeleton's files are the fenced ones plus the tracked ones (`skel track`),
// which have no fences and so are recorded whole. A file that gains fences
// after approval is drift too. Files the skeleton never touched aren't
// recorded: builds, tests and lockfiles change them during a fill.
//
// The record lives outside the project, next to the serve sessions, so nothing
// committed to (or shipped in) a repo can stand in for it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scanFiles, scanRepo, scanText } from "./markers.mjs";
import { insideRoot, writeFileAtomic } from "./state.mjs";
import { configPath } from "./feedback.mjs";

export const snapshotPath = (root) => configPath(root, ".snapshot");

const sha = (lines) => crypto.createHash("sha256").update(lines.join("\n")).digest("hex");

/**
 * A file's exterior: its lines with fence bodies dropped, and the line number
 * each kept line has in the file. Line endings are compared as LF, like the
 * hook does: converting a file's line endings changes no shape. Throws on
 * malformed markers.
 */
export function exterior(text, rel) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fences = text.includes("SKEL[") ? scanText(lines.join("\n"), rel) : [];
  const inBody = new Set();
  for (const f of fences) for (let n = f.openLine + 1; n < f.closeLine; n++) inBody.add(n);
  const out = [];
  const at = [];
  lines.forEach((l, i) => {
    if (!inBody.has(i + 1)) { out.push(l); at.push(i + 1); }
  });
  return { lines: out, at, fences };
}

/** The skeleton's files: fenced (from a scan) and tracked, inside the project. */
function skeletonFiles(root, state, fencedFiles) {
  const tracked = (state.files ?? []).map(String).filter((f) => {
    try { return insideRoot(root, path.join(root, f)) && fs.statSync(path.join(root, f)).isFile(); } catch { return false; }
  });
  return [...new Set([...fencedFiles, ...tracked])].sort();
}

const readText = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), "utf-8"); } catch { return null; } };

/** Record the approved skeleton. Called by `skel approve` once the markers parse. */
export function writeSnapshot(root, state, fencedFiles) {
  const files = {};
  const fences = [];
  for (const rel of skeletonFiles(root, state, fencedFiles)) {
    const text = readText(root, rel);
    if (text === null) continue;
    const ext = exterior(text, rel);
    files[rel] = { sha256: sha(ext.lines), lines: ext.lines };
    for (const f of ext.fences) fences.push({ file: rel, id: f.id, title: f.title });
  }
  // The exterior already holds the marker lines; the fence list is for people
  // reading the record (and for the summary line in a drift report).
  const snap = { root, approvedAt: state.reviewEpoch, files, fences };
  writeFileAtomic(snapshotPath(root), JSON.stringify(snap), 0o600);
  return snap;
}

export function readSnapshot(root) {
  try {
    const s = JSON.parse(fs.readFileSync(snapshotPath(root), "utf-8"));
    return s && typeof s.files === "object" ? s : null;
  } catch {
    return null;
  }
}

/**
 * The fences of a skeleton: the normal search, plus every file the approved
 * snapshot covers, read whatever its size. The search skips files over its
 * size cap, so without this a fence body grown past it would drop out of
 * `done`/`finalize`/the page and let them pass with SKEL_TODO still there.
 */
export function scanSkeleton(root, cache, known) {
  const base = known ? scanFiles(root, known, cache) : scanRepo(root, cache);
  const snap = readSnapshot(root);
  const seen = new Set([...base.files, ...base.errored]);
  const missing = snap ? Object.keys(snap.files).filter((rel) => !seen.has(rel)).map((rel) => path.join(root, rel)) : [];
  if (missing.length === 0) return base;
  const extra = scanFiles(root, missing, cache, { maxBytes: Infinity });
  return {
    fences: [...base.fences, ...extra.fences],
    errors: [...base.errors, ...extra.errors],
    files: [...base.files, ...extra.files],
    errored: [...base.errored, ...extra.errored],
  };
}

export function clearSnapshot(root) {
  fs.rmSync(snapshotPath(root), { force: true });
}

/**
 * Line diff of a against b: hunks of { aStart, removed, bStart, added } (0-based
 * indices). Common prefix and suffix are trimmed first, so the usual small
 * drift costs nothing; the middle is an LCS, or one hunk when it is too big.
 */
export function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length) return [];
  if (!am.length || !bm.length || am.length * bm.length > 4_000_000) {
    return [{ aStart: pre, removed: am, bStart: pre, added: bm }];
  }
  const n = am.length;
  const m = bm.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const hunks = [];
  let cur = null;
  const flush = () => { if (cur) hunks.push(cur); cur = null; };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) { flush(); i++; j++; continue; }
    cur ??= { aStart: pre + i, removed: [], bStart: pre + j, added: [] };
    if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) cur.added.push(bm[j++]);
    else cur.removed.push(am[i++]);
  }
  flush();
  return hunks;
}

/**
 * Compare the working tree with the approved skeleton.
 *
 * @param fencedFiles  files that have fences now (from a scan), to catch new ones
 * @param read         (rel) => text | null; the server passes its cache
 * @returns {{ ok: boolean, reason?: string, items: object[] }}  each item is
 *   { file, line, removed: string[], added: string[] } for a changed region
 *   (line: where it sits in the file now), or { file, note } for a whole file.
 */
export function verifySnapshot(root, state, fencedFiles, read = (rel) => readText(root, rel)) {
  const snap = readSnapshot(root);
  // Missing or stale fails closed: deleting the record must not switch the check off.
  if (!snap) return { ok: false, reason: "there is no record of the approved skeleton (it was approved by an older skel, or the record was deleted)", items: [] };
  if (snap.approvedAt !== state.reviewEpoch) return { ok: false, reason: "the record of the approved skeleton belongs to a different approval", items: [] };
  const items = [];
  const now = [];
  for (const rel of [...new Set([...Object.keys(snap.files), ...skeletonFiles(root, state, fencedFiles)])].sort()) {
    const was = snap.files[rel];
    const text = read(rel);
    if (text === null) {
      if (was) items.push({ file: rel, note: "deleted (it is part of the approved skeleton)" });
      continue;
    }
    let ext;
    try {
      ext = exterior(text, rel);
    } catch (err) {
      items.push({ file: rel, note: `malformed markers: ${err.message}` });
      continue;
    }
    for (const f of ext.fences) now.push(`${rel}\u0000${f.id}\u0000${f.title}`);
    if (!was) {
      if (ext.fences.length) items.push({ file: rel, note: "has fences but isn't in the approved skeleton" });
      continue;
    }
    if (sha(ext.lines) === was.sha256) continue;
    for (const h of lineDiff(was.lines, ext.lines)) {
      const line = ext.at[h.bStart] ?? (ext.at.length ? ext.at[ext.at.length - 1] + 1 : 1);
      items.push({ file: rel, line, removed: h.removed, added: h.added });
    }
  }
  const approved = new Set((snap.fences ?? []).map((f) => `${f.file}\u0000${f.id}\u0000${f.title}`));
  const current = new Set(now);
  const fenceChanges = {
    added: [...current].filter((k) => !approved.has(k)).map((k) => k.split("\u0000")[1]),
    removed: [...approved].filter((k) => !current.has(k)).map((k) => k.split("\u0000")[1]),
  };
  return { ok: items.length === 0, items, fenceChanges };
}

/** The drift report `done`, `finalize` and `status` print. */
export function formatDrift(result, max = 8) {
  if (result.reason) return `${result.reason}. Ask the human to \`skel reshape\` and approve the skeleton again.`;
  const out = ["drift from the approved skeleton (changes outside the fences):"];
  const clip = (lines, mark) => [
    ...lines.slice(0, max).map((l) => `      ${mark} ${l}`),
    ...(lines.length > max ? [`      … ${lines.length - max} more`] : []),
  ];
  for (const it of result.items) {
    if (it.note) { out.push(`  ${it.file}: ${it.note}`); continue; }
    const span = it.added.length > 1 ? `-${it.line + it.added.length - 1}` : "";
    out.push(`  ${it.file}:${it.line}${span}`, ...clip(it.removed, "-"), ...clip(it.added, "+"));
  }
  const { added = [], removed = [] } = result.fenceChanges ?? {};
  if (added.length || removed.length) {
    out.push(`  fence set: ${[added.length ? `added or retitled ${[...new Set(added)].join(", ")}` : "", removed.length ? `removed or retitled ${[...new Set(removed)].join(", ")}` : ""].filter(Boolean).join("; ")}`);
  }
  out.push("Put these lines back as they were, or propose the change: the human can `skel reshape` and approve the new shape.");
  return out.join("\n");
}
