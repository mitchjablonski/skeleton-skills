// The approved skeleton, recorded at `skel approve` and checked by `done`,
// `finalize`, `status` and the review page. The hook judges each edit before
// it lands, but only the edits it sees; this checks what actually ended up on
// disk, however it got there (Edit, Write, sed -i, a script).
//
// What is recorded: every skeleton file's *exterior* (the file with each
// fence's body lines dropped, marker lines kept), which is its shape: the
// signatures, the wiring, and the fence set (ids, titles, order) in one. The
// skeleton's files are the fenced ones plus the tracked ones (`skel track`).
// Only the fenced files (the ones the scan found fences in, whose fences are
// steps) lose their fence bodies; every other tracked file is recorded whole,
// so a gitignored or oversized tracked file's "fences" can't hide edits. A
// file that gains fences after approval is drift too.
//
// Source the skeleton never touched isn't in this part of the record, and the
// checks here (`status`'s, the Stop hook's, the page's) don't read it. Approve also
// baselines the reviewable source set in the record's `coverage`, which `done` and
// `finalize` check: lib/source-set.mjs, which the Stop hook doesn't load.
//
// The record lives outside the project, next to the serve sessions, so nothing
// committed to (or shipped in) a repo can stand in for it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inSkippedDir, scanFiles, scanRepo, scanText } from "./markers.mjs";
import { insideRoot, leavesBase, realpath, refreshReceiptIndex, storePath, writeFileAtomic } from "./state.mjs";
import { RECORD_FORMAT, isPlain, isVersion, keepsTrackedWhole, safeKey, validFenced, validFences, validFiles, validFormat, validSnapshot } from "./records.mjs";

export { RECORD_FORMAT, safeKey };

export const snapshotPath = (root) => storePath(root, ".snapshot");

const sha = (lines) => crypto.createHash("sha256").update(lines.join("\n")).digest("hex");

/**
 * A file's exterior: its lines with fence bodies dropped, and the line number
 * each kept line has in the file. Line endings are compared as LF, like the
 * hook does: converting a file's line endings changes no shape. Throws on
 * malformed markers. A file under a directory the scan skips (a tracked doc in
 * .claude/, say) has no fences, only example ones: it is kept whole.
 *
 * `whole`: keep every line (a tracked file whose fences aren't steps). Its
 * markers are still parsed, so malformed ones still throw, and `fences` lists
 * them; callers don't count them as the skeleton's fences.
 */
export function exterior(text, rel, { whole = false } = {}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fences = text.includes("SKEL[") && !(rel && inSkippedDir(rel)) ? scanText(lines.join("\n"), rel) : [];
  const inBody = new Set();
  if (!whole) for (const f of fences) for (let n = f.openLine + 1; n < f.closeLine; n++) inBody.add(n);
  const out = [];
  const at = [];
  lines.forEach((l, i) => {
    if (!inBody.has(i + 1)) { out.push(l); at.push(i + 1); }
  });
  return { lines: out, at, fences };
}

const CR = Buffer.from([13]);
/** Feed bytes to a hash with each CRLF as LF, whatever the chunk boundaries: converting line endings changes no shape. */
export function feedNormalized(hash, chunk, state) {
  let start = 0;
  if (state.cr) {
    state.cr = false;
    if (chunk[0] !== 10) hash.update(CR);
  }
  for (let i = chunk.indexOf(13); i !== -1; i = chunk.indexOf(13, i + 1)) {
    if (i === chunk.length - 1) {
      hash.update(chunk.subarray(start, i));
      state.cr = true;
      return;
    }
    if (chunk[i + 1] === 10) {
      hash.update(chunk.subarray(start, i));
      start = i + 1;
    }
  }
  hash.update(chunk.subarray(start));
}
export const finishNormalized = (hash, state) => { if (state.cr) hash.update(CR); };

const statId = (abs) => {
  try {
    const st = fs.statSync(abs, { bigint: true });
    return st.isFile() && st.ino ? `${st.dev}:${st.ino}` : null;
  } catch { return null; }
};

/**
 * Of `rels`, the ones that are another name (a link, a hard link) for one of the
 * step-bearing `fenced` files. Held whole they'd freeze a fence body the fill is
 * meant to change, so they aren't recorded under that name: the fenced name
 * carries the file's exterior.
 */
export function fencedAliases(root, rels, fenced) {
  const out = new Set();
  const others = rels.filter((rel) => !fenced.includes(rel));
  if (!others.length || !fenced.length) return out;
  const ids = new Set(fenced.map((rel) => statId(path.join(root, rel))).filter(Boolean));
  for (const rel of others) if (ids.has(statId(path.join(root, rel)))) out.add(rel);
  return out;
}

/**
 * A baselined alias (m.alias is the file it reached at approval, m.sha256 what
 * that held): is it still that file, with the content it had? Content under a
 * fenced name is left to that name's exterior check.
 */
export function aliasDrift(root, rel, m, fenced) {
  const abs = path.join(root, rel);
  let lst;
  try { lst = fs.lstatSync(abs); } catch { return "deleted"; }
  let real;
  try { real = realpath(abs); } catch { return "is now a dangling link"; }
  const to = path.relative(realpath(root), real);
  if (to !== "" && leavesBase(to)) return "now resolves outside the project";
  const here = to.split(path.sep).join("/");
  const same = here === m.alias || (statId(abs) && statId(abs) === statId(path.join(root, m.alias)));
  if (!same && lst.isSymbolicLink()) return `now points to ${here}, not ${m.alias}`;
  // A hard link broken by an atomic save is fine while its own text hasn't changed.
  if (same && fenced.has(m.alias)) return null;
  let bytes;
  try { bytes = fs.readFileSync(real); } catch (err) { return `can't be read (${err.code ?? err.message})`; }
  const hash = crypto.createHash("sha256");
  const state = { cr: false };
  if (bytes.length) feedNormalized(hash, bytes, state);
  finishNormalized(hash, state);
  return hash.digest("hex") === m.sha256 ? null : "changed since approval";
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
 * The skeleton as it is now: each file's exterior and the fence set, plus its
 * version, a short hash of both. The review page shows the version it
 * rendered, feedback carries it back, and `skel approve` records it, so an
 * approval can be checked against the version the human actually reviewed.
 *
 * `strict` (approve): a file's malformed markers throw an error with code
 * SKEL_MARKERS (and the file named); anything else thrown is I/O. Otherwise
 * (the page) a malformed file is hashed whole, so the page still gets a version.
 *
 * Only `fencedFiles` (the files the scan found fences in) lose their fence
 * bodies; other tracked files are recorded whole and add no fences.
 */
export function recordSkeleton(root, state, fencedFiles, read = (rel) => readText(root, rel), { strict = false } = {}) {
  // Keyed by path: a Map, so a file named `__proto__` is recorded like any other.
  const files = new Map();
  const fences = [];
  const fenced = [...new Set(fencedFiles)].sort();
  const all = skeletonFiles(root, state, fencedFiles);
  const aliases = fencedAliases(root, all, fenced);
  for (const rel of all) {
    if (aliases.has(rel)) continue;
    const text = read(rel);
    if (text === null) continue;
    const whole = !fenced.includes(rel);
    let ext;
    try {
      ext = exterior(text, rel, { whole });
    } catch (err) {
      if (strict) throw Object.assign(new Error(err.message.includes(rel) ? err.message : `${rel}: ${err.message}`), { code: "SKEL_MARKERS" });
      ext = { lines: text.replace(/\r\n/g, "\n").split("\n"), fences: [], malformed: true };
    }
    files.set(rel, { sha256: sha(ext.lines), lines: ext.lines, ...(ext.malformed ? { malformed: true } : {}) });
    if (!whole) for (const f of ext.fences) fences.push({ file: rel, id: f.id, title: f.title });
  }
  const record = Object.fromEntries(files);
  return { format: RECORD_FORMAT, files: record, fences, fenced, version: skeletonVersion(record, fences) };
}

/** The version of a record: 12 hex chars of a hash over its exteriors and fence set. */
export function skeletonVersion(files, fences) {
  const parts = Object.keys(files).sort().map((rel) => `${rel}\u0000${files[rel].sha256}`);
  for (const f of fences) parts.push(`fence\u0000${f.file}\u0000${f.id}\u0000${f.title}`);
  return sha(parts).slice(0, 12);
}

/** Record the approved skeleton. Called by `skel approve` once the markers parse. */
export function writeSnapshot(root, state, fencedFiles, record, review, coverage) {
  // The exterior already holds the marker lines; the fence list is for people
  // reading the record (and for the summary line in a drift report). `fenced`
  // is the files the approve-time scan found fences in: the only files whose
  // fences are steps, and the only ones recorded without their fence bodies.
  // A tracked file the scan excludes (gitignored, say) is recorded whole, so
  // the text between its markers is checked too. `version` is
  // the approved skeleton version; `review` says which reviewed version it
  // was checked against ({ version, source, at }), or null. `coverage` is the
  // baselined source set; it is apart from `version` on purpose, because the page
  // rendered that version and most of this set was never on the page.
  const fenced = [...new Set(fencedFiles)].sort();
  // The member list goes last, after the file's only raw newline. It's still one
  // JSON document, and everything that validates the record (`skel migrate`,
  // readFullSnapshot) parses it whole. Only the hot readers stop short, in
  // readSnapshot: the list is ~100 bytes a file, and reading it each turn cost
  // the Stop hook 18 ms at 2,000 files on /mnt/c, and 190 ms at 20,000.
  const { members, ...head } = coverage;
  const snap = { root, format: record.format, approvedAt: state.reviewEpoch, version: record.version, review, files: record.files, fences: record.fences, fenced, coverage: { ...head, members: {} } };
  const file = snapshotPath(root);
  writeFileAtomic(file, `${JSON.stringify(snap).slice(0, -4)}\n${JSON.stringify(members)}}}`, 0o600);
  refreshReceiptIndex({ dirs: [path.dirname(file)], reread: [path.basename(file).slice(0, 24)] }); // #55
  return snap;
}

/**
 * The versions the review page has rendered (the last few), kept outside the
 * project like the snapshot, so `skel approve` can show what changed since the
 * version the human reviewed.
 */
const KEEP_RENDERED = 8;
export const renderedPath = (root) => storePath(root, ".rendered");

/**
 * Best effort: an unwritable state dir mustn't stop the page rendering. The
 * cost is only that approve can't show a diff since that version.
 */
export function noteRendered(root, record) {
  const all = readRendered(root);
  if (all[0]?.version === record.version) return;
  const next = [{ version: record.version, at: Date.now(), format: record.format, files: record.files, fences: record.fences, fenced: record.fenced }, ...all.filter((r) => r.version !== record.version)].slice(0, KEEP_RENDERED);
  try {
    writeFileAtomic(renderedPath(root), JSON.stringify({ root, versions: next }), 0o600);
  } catch {}
}

/**
 * The rendered versions, plus why the store couldn't be read (null when it was
 * read, or simply doesn't exist yet), so approve can tell "never rendered"
 * from "can't tell".
 */
export function readRenderedStore(root) {
  let text;
  try {
    text = fs.readFileSync(renderedPath(root), "utf-8");
  } catch (err) {
    return { versions: [], unreadable: err.code === "ENOENT" ? null : (err.code ?? err.message) };
  }
  try {
    const v = JSON.parse(text).versions;
    if (!Array.isArray(v)) return { versions: [], unreadable: "not the shape skel writes" };
    return { versions: v.filter((r) => isPlain(r) && isVersion(r.version) && validFiles(r.files) && validFences(r.fences) && validFenced(r.fenced) && validFormat(r.format)), unreadable: null };
  } catch {
    return { versions: [], unreadable: "not valid JSON" };
  }
}

export function readRendered(root) {
  return readRenderedStore(root).versions;
}

export function clearRendered(root) {
  fs.rmSync(renderedPath(root), { force: true });
}

const HEAD_CHUNK = 16 * 1024;
/** The file up to its first newline ({ head }), or all of it ({ whole }) if it has none. JSON strings can't hold one. */
function readToNewline(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    for (;;) {
      const buf = Buffer.allocUnsafe(HEAD_CHUNK);
      const n = fs.readSync(fd, buf, 0, HEAD_CHUNK, null);
      if (!n) return { whole: Buffer.concat(chunks).toString("utf-8") };
      const at = buf.subarray(0, n).indexOf(10);
      if (at !== -1) {
        chunks.push(buf.subarray(0, at));
        return { head: Buffer.concat(chunks).toString("utf-8") };
      }
      chunks.push(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The record without its baseline's member list (`coverage.members` is empty):
 * all the Stop hook and the page need, and they run far too often to read a
 * list of thousands of files. A record with no newline (an older format) is
 * read whole. Null when it is missing or not the shape we write (callers fail
 * closed); damage to the list itself is left to readFullSnapshot.
 */
export function readSnapshot(root) {
  let s;
  try {
    const { head, whole } = readToNewline(snapshotPath(root));
    s = JSON.parse(whole ?? `${head}{}}}`);
  } catch {
    return null;
  }
  return validSnapshot(s) ? s : null;
}

/** The whole record, member list included: what `done` and `finalize` compare, and what `skel migrate` validates. */
export function readFullSnapshot(root) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(snapshotPath(root), "utf-8"));
  } catch {
    return null;
  }
  return validSnapshot(s) ? s : null;
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
 * and the CLI agree on the steps. scanFiles reads only regular files that
 * resolve inside the project, for `known` and `fenced` alike (#32): one swapped
 * for a link out of it drops out here, and compareWith reports it as drift.
 */
export function scanSkeleton(root, state, cache, known) {
  const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const base = known ? scanFiles(root, known.filter((abs) => !inSkippedDir(rel(abs))), cache) : scanRepo(root, cache);
  const snap = readSnapshot(root);
  const seen = new Set([...base.files, ...base.errored]);
  const fenced = snap && state?.phase === "fill" && snap.approvedAt === state.reviewEpoch ? new Set(snap.fenced ?? []) : new Set();
  const missing = [...fenced]
    .filter((f) => !seen.has(f) && !inSkippedDir(f))
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
  const file = snapshotPath(root);
  fs.rmSync(file, { force: true });
  refreshReceiptIndex({ dirs: [path.dirname(file)] }); // #55
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
  const driftIdentity = []; // stable exterior hashes, never current line offsets
  // A file is compared without its fence bodies only if it was recorded that
  // way (it was in the record's `fenced`), or has fences the scan counts now
  // (which is drift either way). A record without the format marker (an
  // approval or render from before #25) dropped every file's bodies, so it is
  // compared the same way.
  const fenced = keepsTrackedWhole(snap.format) ? new Set([...(snap.fenced ?? []), ...fencedFiles]) : null;
  // Keys are checked by safeKey when a record is read; this guards a record
  // built elsewhere. A key's file can still have become a symlink out of the
  // project (or a dangling one): that is drift, reported without reading it.
  const escaped = (rel) => {
    const abs = path.join(root, rel);
    try { fs.lstatSync(abs); } catch { return null; }
    if (insideRoot(root, abs)) return null;
    try { fs.realpathSync(abs); } catch { return "is now a dangling link"; }
    return "now resolves outside the project";
  };
  for (const rel of [...new Set([...Object.keys(snap.files), ...skeletonFiles(root, state, fencedFiles)])].filter(safeKey).sort()) {
    const away = escaped(rel);
    if (away) {
      driftIdentity.push([rel, "escaped", away]);
      items.push({ file: rel, note: `${away} (it is part of the approved skeleton)` });
      continue;
    }
    const was = Object.hasOwn(snap.files, rel) ? snap.files[rel] : undefined;
    const text = read(rel);
    if (text === null) {
      if (was) {
        driftIdentity.push([rel, "deleted"]);
        items.push({ file: rel, note: "deleted (it is part of the approved skeleton)" });
      }
      continue;
    }
    const whole = !!fenced && !fenced.has(rel);
    let ext;
    try {
      ext = exterior(text, rel, { whole });
    } catch (err) {
      driftIdentity.push([rel, "malformed", sha(text.replace(/\r\n/g, "\n").split("\n"))]);
      items.push({ file: rel, note: `malformed markers: ${err.message}` });
      continue;
    }
    if (!whole) for (const f of ext.fences) now.push(`${rel}\u0000${f.id}\u0000${f.title}`);
    if (!was) {
      // Another name for a fenced file shows that file's fences; they aren't new ones.
      if (ext.fences.length && !Object.hasOwn(snap.coverage?.trackedAliases ?? {}, rel) && !fencedAliases(root, [rel], [...(fenced ?? [])]).has(rel)) {
        driftIdentity.push([rel, "new", sha(ext.lines)]);
        items.push({ file: rel, note: "has fences but isn't in the approved skeleton" });
      }
      continue;
    }
    const exteriorHash = sha(ext.lines);
    if (exteriorHash === was.sha256) continue;
    driftIdentity.push([rel, "changed", exteriorHash]);
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
  // A tracked alias is recorded only in the baseline. It's still an approved
  // skeleton file, so this check follows it, with no search.
  const fencedNames = new Set(snap.fenced ?? []);
  for (const [rel, m] of Object.entries(snap.coverage?.trackedAliases ?? {})) {
    if (Object.hasOwn(snap.files, rel)) continue;
    const why = aliasDrift(root, rel, m, fencedNames);
    if (!why) continue;
    driftIdentity.push([rel, "alias", why]);
    items.push({ file: rel, note: `${why} (it is part of the approved skeleton)` });
  }
  const approved = new Set((snap.fences ?? []).map((f) => `${f.file}\u0000${f.id}\u0000${f.title}`));
  const current = new Set(now);
  const fenceChanges = {
    added: [...current].filter((k) => !approved.has(k)).map((k) => k.split("\u0000")[1]),
    removed: [...approved].filter((k) => !current.has(k)).map((k) => k.split("\u0000")[1]),
  };
  return { ok: items.length === 0, items, fenceChanges,
    ...(items.length ? { fingerprint: sha([JSON.stringify(driftIdentity)]) } : {}),
  };
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
  if (result.reason) return `${result.reason}. To recover, agree on reopening the plan in chat before running \`skel reshape\`, then review and approve the skeleton again.`;
  const out = [opts.header ?? "drift from the approved skeleton (changed files or changes outside the fences):"];
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
  out.push(opts.footer ?? "Undo only the reported changes outside the fences, preserving completed fills. Remove unintended new source files or recreate deleted files from their approved content. To change the plan instead, agree on the change in chat, run `skel reshape`, then review and approve the new skeleton.");
  return out.join("\n");
}
