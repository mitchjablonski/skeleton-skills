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
import { inSkippedDir, scanFiles, scanRepo, scanText } from "./markers.mjs";
import { insideRoot, writeFileAtomic } from "./state.mjs";
import { configPath, isVersion } from "./feedback.mjs";

export const snapshotPath = (root) => configPath(root, ".snapshot");

const sha = (lines) => crypto.createHash("sha256").update(lines.join("\n")).digest("hex");

/**
 * A file's exterior: its lines with fence bodies dropped, and the line number
 * each kept line has in the file. Line endings are compared as LF, like the
 * hook does: converting a file's line endings changes no shape. Throws on
 * malformed markers. A file under a directory the scan skips (a tracked doc in
 * .claude/, say) has no fences, only example ones: it is kept whole.
 */
export function exterior(text, rel) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fences = text.includes("SKEL[") && !(rel && inSkippedDir(rel)) ? scanText(lines.join("\n"), rel) : [];
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

/**
/**
 * The skeleton as it is now: each file's exterior and the fence set, plus its
 * version, a short hash of both. The review page shows the version it
 * rendered, feedback carries it back, and `skel approve` records it, so an
 * approval can be checked against the version the human actually reviewed.
 *
 * `strict` (approve): a file's malformed markers throw an error with code
 * SKEL_MARKERS (and the file named); anything else thrown is I/O. Otherwise
 * (the page) a malformed file is hashed whole, so the page still gets a version.
 */
export function recordSkeleton(root, state, fencedFiles, read = (rel) => readText(root, rel), { strict = false } = {}) {
  const files = {};
  const fences = [];
  for (const rel of skeletonFiles(root, state, fencedFiles)) {
    const text = read(rel);
    if (text === null) continue;
    let ext;
    try {
      ext = exterior(text, rel);
    } catch (err) {
      if (strict) throw Object.assign(new Error(err.message.includes(rel) ? err.message : `${rel}: ${err.message}`), { code: "SKEL_MARKERS" });
      ext = { lines: text.replace(/\r\n/g, "\n").split("\n"), fences: [], malformed: true };
    }
    files[rel] = { sha256: sha(ext.lines), lines: ext.lines, ...(ext.malformed ? { malformed: true } : {}) };
    for (const f of ext.fences) fences.push({ file: rel, id: f.id, title: f.title });
  }
  return { files, fences, version: skeletonVersion(files, fences) };
}

/** The version of a record: 12 hex chars of a hash over its exteriors and fence set. */
export function skeletonVersion(files, fences) {
  const parts = Object.keys(files).sort().map((rel) => `${rel}\u0000${files[rel].sha256}`);
  for (const f of fences) parts.push(`fence\u0000${f.file}\u0000${f.id}\u0000${f.title}`);
  return sha(parts).slice(0, 12);
}

/** Record the approved skeleton. Called by `skel approve` once the markers parse. */
export function writeSnapshot(root, state, fencedFiles, record = recordSkeleton(root, state, fencedFiles), review = null) {
  // The exterior already holds the marker lines; the fence list is for people
  // reading the record (and for the summary line in a drift report). `fenced`
  // is the files the approve-time scan found fences in: the only files whose
  // fences are steps. A tracked file the scan excludes (gitignored, say) can
  // have fences in its exterior without them ever being steps. `version` is
  // the approved skeleton version; `review` says which reviewed version it
  // was checked against ({ version, source, at }), or null.
  const fenced = [...new Set(fencedFiles)].sort();
  const snap = { root, approvedAt: state.reviewEpoch, version: record.version, review, files: record.files, fences: record.fences, fenced };
  writeFileAtomic(snapshotPath(root), JSON.stringify(snap), 0o600);
  return snap;
}

const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * A project-relative file key as recordSkeleton writes it: forward slashes, no
 * `..` segment, not absolute. The records live outside the project, but their
 * keys name files that approve's diff and the Stop hook read and print, so one
 * pointing elsewhere (`../secret.txt`, `/etc/passwd`, `C:\\x`) is rejected.
 */
export const safeKey = (rel) => typeof rel === "string" && rel !== "" && !rel.includes("\\") && !rel.includes("\u0000") &&
  !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel) && !rel.split("/").includes("..");
/** files: { rel: { sha256, lines: string[] } }, as recordSkeleton writes them. */
const validFiles = (files) => isPlain(files) && Object.entries(files).every(([rel, e]) => safeKey(rel) &&
  isPlain(e) && typeof e.sha256 === "string" && Array.isArray(e.lines) && e.lines.every((l) => typeof l === "string"));
const validFences = (fences) => fences === undefined || (Array.isArray(fences) &&
  fences.every((f) => isPlain(f) && typeof f.file === "string" && typeof f.id === "string" && typeof f.title === "string"));

/**
 * The versions the review page has rendered (the last few), kept outside the
 * project like the snapshot, so `skel approve` can show what changed since the
 * version the human reviewed.
 */
export const renderedPath = (root) => configPath(root, ".rendered");
const KEEP_RENDERED = 8;

/**
 * Best effort: an unwritable config dir mustn't stop the page rendering. The
 * cost is only that approve can't show a diff since that version.
 */
export function noteRendered(root, record) {
  const all = readRendered(root);
  if (all[0]?.version === record.version) return;
  const next = [{ version: record.version, at: Date.now(), files: record.files, fences: record.fences }, ...all.filter((r) => r.version !== record.version)].slice(0, KEEP_RENDERED);
  try {
    writeFileAtomic(renderedPath(root), JSON.stringify({ root, versions: next }), 0o600);
  } catch {}
}

export function readRendered(root) {
  try {
    const v = JSON.parse(fs.readFileSync(renderedPath(root), "utf-8")).versions;
    return Array.isArray(v) ? v.filter((r) => isPlain(r) && isVersion(r.version) && validFiles(r.files) && validFences(r.fences)) : [];
  } catch {
    return [];
  }
}

export function clearRendered(root) {
  fs.rmSync(renderedPath(root), { force: true });
}

/** The record, or null when it is missing or not the shape we write (callers fail closed). */
export function readSnapshot(root) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(snapshotPath(root), "utf-8"));
  } catch {
    return null;
  }
  if (!isPlain(s) || !validFiles(s.files)) return null;
  if (s.fences !== undefined && !validFences(s.fences)) return null;
  if (s.fenced !== undefined && (!Array.isArray(s.fenced) || !s.fenced.every((f) => typeof f === "string"))) return null;
  // Written by approve since approvals were bound to the reviewed version (#15).
  if (s.version !== undefined && !isVersion(s.version)) return null;
  if (s.review !== undefined && s.review !== null && !(isPlain(s.review) && isVersion(s.review.version) && typeof s.review.source === "string" && (s.review.at === null || Number.isFinite(s.review.at)))) return null;
  return s;
}

/**
 * The fences of a skeleton: the normal search, plus every file that had fences
 * when this skeleton was approved, read whatever its size. The search skips
 * files over its size cap, so without this a fence body grown past it would
 * drop out of `done`/`finalize`/the page and let them pass with SKEL_TODO
 * still there. Only files the approve-time scan found fences in (`fenced`),
 * outside the dirs the scan skips, and only while the record is this
 * approval's: a tracked doc's example fences, a tracked file the scan excludes,
 * or a stale record must never become steps.
 *
 * `known` (the server's poll) skips the same dirs the search does, so the page
 * and the CLI agree on the steps.
 */
export function scanSkeleton(root, state, cache, known) {
  const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const base = known ? scanFiles(root, known.filter((abs) => !inSkippedDir(rel(abs))), cache) : scanRepo(root, cache);
  const snap = readSnapshot(root);
  const seen = new Set([...base.files, ...base.errored]);
  const fenced = snap && state?.phase === "fill" && snap.approvedAt === state.reviewEpoch ? new Set(snap.fenced ?? []) : new Set();
  const missing = [...fenced]
    .filter((f) => !seen.has(f) && !inSkippedDir(f) && insideRoot(root, path.join(root, f)))
    .map((f) => path.join(root, f));
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
 *   { file, line, lines, removed: string[], added: string[], whitespace? } for a
 *   changed region (line: where it sits in the file now; lines: each added
 *   line's number in the file; whitespace: indices of removed/added lines that
 *   differ from their counterpart only in whitespace), or { file, note } for a
 *   whole file.
 */
export function verifySnapshot(root, state, fencedFiles, read = (rel) => readText(root, rel)) {
  const snap = readSnapshot(root);
  // Missing or stale fails closed: deleting the record must not switch the check off.
  if (!snap) return { ok: false, reason: "there is no record of the approved skeleton (it was approved by an older skel, or the record was deleted)", items: [] };
  if (snap.approvedAt !== state.reviewEpoch) return { ok: false, reason: "the record of the approved skeleton belongs to a different approval", items: [] };
  return compareWith(snap, root, state, fencedFiles, read);
}

/**
 * The working tree against a recorded skeleton (the approved snapshot, or a
 * version the review page rendered): what changed outside the fence bodies.
 */
export function compareWith(snap, root, state, fencedFiles, read = (rel) => readText(root, rel)) {
  const items = [];
  const now = [];
  // A recorded key must name a file in the project: a symlink out of it is
  // skipped like an unsafe key (a missing file still reports as deleted).
  const inProject = (rel) => {
    if (!safeKey(rel)) return false;
    const abs = path.join(root, rel);
    try { fs.lstatSync(abs); } catch { return true; }
    return insideRoot(root, abs);
  };
  for (const rel of [...new Set([...Object.keys(snap.files), ...skeletonFiles(root, state, fencedFiles)])].filter(inProject).sort()) {
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
      // A hunk can straddle a fence body, so its added lines needn't be
      // consecutive in the file: carry each one's own line number.
      const lines = h.added.map((_, k) => ext.at[h.bStart + k]);
      const line = lines[0] ?? ext.at[h.bStart] ?? (ext.at.length ? ext.at[ext.at.length - 1] + 1 : 1);
      const item = { file: rel, line, lines, removed: h.removed, added: h.added };
      const ws = whitespaceOnly(h.removed, h.added);
      if (ws.removed.length || ws.added.length) item.whitespace = ws;
      items.push(item);
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

/**
 * Which lines of a hunk are whitespace-only changes: paired by position with
 * the other side (an unpaired line, such as an added blank one, is paired with
 * nothing), equal once all whitespace is removed. Format-on-save after
 * approval shows up as these.
 */
export function whitespaceOnly(removed, added) {
  const bare = (l) => (l ?? "").replace(/\s+/g, "");
  const pick = (mine, other) => mine.flatMap((l, k) => (bare(l) === bare(other[k]) && l !== other[k] ? [k] : []));
  // A paired change is labelled once, on its added line.
  return { removed: pick(removed, added).filter((k) => k >= added.length), added: pick(added, removed) };
}

/** "4", "4-6", or "4, 6" for lines that aren't consecutive. */
function lineSpan(lines, fallback) {
  if (!lines?.length) return String(fallback);
  const runs = [];
  for (const n of lines) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/** The drift report `done`, `finalize` and `status` print. */
export function formatDrift(result, max = 8, opts = {}) {
  if (result.reason) return `${result.reason}. Ask the human to \`skel reshape\` and approve the skeleton again.`;
  const out = [opts.header ?? "drift from the approved skeleton (changes outside the fences):"];
  const clip = (lines, mark, ws = []) => [
    ...lines.slice(0, max).map((l, k) => `      ${mark} ${l}${ws.includes(k) ? "   (whitespace only)" : ""}`),
    ...(lines.length > max ? [`      … ${lines.length - max} more`] : []),
  ];
  for (const it of result.items) {
    if (it.note) { out.push(`  ${it.file}: ${it.note}`); continue; }
    out.push(`  ${it.file}:${lineSpan(it.lines, it.line)}`, ...clip(it.removed, "-", it.whitespace?.removed), ...clip(it.added, "+", it.whitespace?.added));
  }
  const { added = [], removed = [] } = result.fenceChanges ?? {};
  if (added.length || removed.length) {
    out.push(`  fence set: ${[added.length ? `added or retitled ${[...new Set(added)].join(", ")}` : "", removed.length ? `removed or retitled ${[...new Set(removed)].join(", ")}` : ""].filter(Boolean).join("; ")}`);
  }
  out.push(opts.footer ?? "Put these lines back as they were, or propose the change: the human can `skel reshape` and approve the new shape.");
  return out.join("\n");
}
