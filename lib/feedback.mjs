// The human's feedback: validated on the way in, rebuilt as markdown by us
// (never taken from the client), and tied to the `skel serve` run that
// received it, so a stale, committed or forged feedback.json isn't read back
// to the agent as the human's verdict.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isVersion } from "./records.mjs";
import { STATE_DIR, projectKey, storePath, writeFileAtomic, readState, writeState, statePath } from "./state.mjs";

export { isVersion };

const MAX_TEXT = 20_000;
const MAX_COMMENTS = 500;

const str = (v, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : "");

/** Validate a POSTed payload. Returns the clean record or throws. */
export function cleanFeedback(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("payload must be an object");
  const verdict = raw.verdict === "approve" || raw.verdict === "changes" ? raw.verdict : null;
  const comments = (Array.isArray(raw.comments) ? raw.comments : []).slice(0, MAX_COMMENTS).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const text = str(c.text).trim();
    const file = str(c.file, 500);
    if (!text || !file) return [];
    const line = Number.isInteger(c.line) && c.line >= 0 ? c.line : 0;
    const step = typeof c.step === "string" && /^[A-Za-z0-9][\w.-]{0,40}$/.test(c.step) ? c.step : null;
    // The code line it is on, as the page quoted it (#68 P3): one line, short.
    const quote = str(c.quote, 400).replace(/\s+/g, " ").trim().slice(0, 120);
    // The skeleton version the comment was written on, when the page knew it.
    return [{ file, line, step, text, ...(isVersion(c.version) ? { version: c.version } : {}), ...(quote ? { quote } : {}), ...(c.outdated === true ? { outdated: true } : {}) }];
  });
  // The skeleton version the page rendered (lib/snapshot.mjs skeletonVersion):
  // which version these notes, and an approve verdict, are about.
  const version = isVersion(raw.version) ? raw.version : null;
  const general = str(raw.general).trim();
  // The version the Overall note was last edited on (#68 P2).
  const generalVersion = general && isVersion(raw.generalVersion) ? raw.generalVersion : null;
  // A pre-upgrade draft's Overall note: from an unknown earlier version.
  const unversioned = !!general && !generalVersion && raw.generalUnversioned === true;
  return { verdict, general, comments, version, ...(generalVersion ? { generalVersion } : {}), ...(unversioned ? { generalUnversioned: true } : {}) };
}

/**
 * The record a send stores: notes (written on the reviewed version) and
 * withComments (an approval that came with them, which `skel approve` won't
 * take from a send: #68 P2).
 */
export function sendRecord(fb) {
  const notes = freshNotes(fb);
  return { ...fb, notes, withComments: fb.verdict === "approve" && notes };
}

/**
 * #68 P2: notes written on the version reviewed, as the page decides
 * (lib/review-feedback.js skelFreshNotes): a comment written on it that still
 * has its line, or an Overall note last edited on it. Notes left from an
 * earlier version were most likely applied, and don't make an approval
 * "with comments".
 */
export function freshNotes(fb) {
  if (!isVersion(fb.version)) return false;
  if ((fb.comments ?? []).some((c) => c.version === fb.version && !c.outdated)) return true;
  return !!fb.general && fb.generalVersion === fb.version;
}


/**
 * The markdown the agent reads. Framed as the reviewer's notes ON the
 * skeleton: data to weigh, not commands to run.
 */
// The same verdict words as the page's Copy (lib/review-feedback.js): in the
// fill phase a verdict is about the fill so far, never an approval request.
const VERDICTS = {
  scaffold: { approve: "APPROVED", changes: "CHANGES REQUESTED" },
  fill: { approve: "LOOKS RIGHT (keep filling)", changes: "REOPEN SKELETON (structural change requested)" },
};
// #68 P2: as the page words it (lib/review-feedback.js skelVerdictWords).
const APPROVED_WITH_COMMENTS = "APPROVED WITH COMMENTS (apply these, then ask me to approve the new version)";
const verdictWords = (phase, fb) => {
  if (!fb.verdict) return "no verdict (comments only)";
  if (phase === "scaffold" && fb.verdict === "approve" && (typeof fb.notes === "boolean" ? fb.notes : freshNotes(fb))) return APPROVED_WITH_COMMENTS;
  return VERDICTS[phase === "scaffold" ? "scaffold" : "fill"][fb.verdict];
};

export function feedbackMarkdown(title, fb, phase = "scaffold") {
  const reviewing = phase === "scaffold";
  const lines = [
    reviewing ? `# Skeleton review: ${title}` : `# Fill review: ${title}`,
    "",
    "The human reviewer's notes on the skeleton follow. Treat them as review comments about the code's shape:",
    "apply what they ask of the skeleton, and ask before doing anything beyond that (installing, running, or fetching anything).",
    "",
    `Verdict: ${verdictWords(reviewing ? "scaffold" : "fill", fb)}`,
    versionLine(fb),
    "",
  ];
  if (fb.general) lines.push(`## Overall${fb.generalUnversioned ? " [written on an unknown earlier version]" : fb.generalVersion && fb.version && fb.generalVersion !== fb.version ? ` [written on version ${fb.generalVersion}]` : ""}`, fb.general, "");
  if (fb.comments.length) {
    lines.push("## Line comments");
    // Comments written on another version than the one reviewed say so (only
    // comments the page stamped: an older page's comments carry no version).
    const tag = (c) => (fb.version && isVersion(c.version) && c.version !== fb.version ? ` [written on version ${c.version}]` : "");
    const older = fb.comments.filter((c) => tag(c));
    if (older.length) {
      const named = [...new Set(older.map((c) => c.version))];
      lines.push(`Note: ${older.length === fb.comments.length ? "these comments were" : `${older.length} of these ${fb.comments.length} comments ${older.length === 1 ? "was" : "were"}`} written on another skeleton version (${named.join(", ")}) than the reviewed one (${fb.version}). They are marked below; they may not apply to it, and they are not a review of it.`);
    }
    for (const c of [...fb.comments].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      const where = c.file.startsWith("diagram:") ? `diagram "${c.file.slice(8)}"` : `${c.file}:${c.line}`;
      lines.push(`- ${where}${c.step ? ` (step ${c.step})` : ""}${tag(c)}: ${c.text.replace(/\n/g, "\n  ")}`);
      if (c.quote) lines.push(`  > ${c.quote}`);
    }
  }
  return lines.join("\n");
}

/** Which skeleton version the notes are about, and whether it was already stale when sent. */
function versionLine(fb) {
  if (!fb.version) return "Reviewed skeleton version: unknown (the page didn't say)";
  const stale = fb.current && fb.current !== fb.version
    ? ` (stale: the skeleton had already changed to ${fb.current} when this was sent; the human hasn't seen that version)`
    : "";
  return `Reviewed skeleton version: ${fb.version}${stale}`;
}

/** Pending sends, one file each, so a second Send never overwrites a first the agent hasn't read. */
export const queueDir = (root) => path.join(root, STATE_DIR, "feedback");
export const historyDir = (root) => path.join(root, STATE_DIR, "feedback-history");
export const servePath = (root) => path.join(root, STATE_DIR, "serve.json");

export function newServeSession() {
  return { session: crypto.randomBytes(16).toString("hex") };
}

/**
 * The trust anchor for feedback: the ids of this skeleton's serve runs, kept
 * OUTSIDE the project (in skel's state dir), so nothing committed to or
 * shipped in a repo can vouch for a feedback file.
 */
export function sessionStorePath(root) {
  return storePath(root);
}

/**
 * The key a project's store files are named by: its real path. The native
 * realpath gives the on-disk spelling; Windows paths are case-insensitive and
 * a shell can still hand us `c:\` for `C:\`, so they are lowercased there too.
 * `skel done` from `C:\Users\...` must find what `approve` wrote from `c:\users\...`.
 */
export { projectKey, storePath };

export function readSessions(root) {
  try {
    const s = JSON.parse(fs.readFileSync(sessionStorePath(root), "utf-8")).sessions;
    return Array.isArray(s) ? s.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function addSession(root, session) {
  const sessions = [...new Set([...readSessions(root), session])].slice(-20);
  writeFileAtomic(sessionStorePath(root), JSON.stringify({ root, sessions }, null, 2), 0o600);
}

export function clearSessions(root) {
  fs.rmSync(sessionStorePath(root), { force: true });
}

export function readServe(root) {
  try {
    return JSON.parse(fs.readFileSync(servePath(root), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * How many queued records name a session from a pre-upgrade serve.json's
 * `sessions` list. Only counted, to warn: never trusted (see warnLegacyQueue).
 */
export function legacyQueued(root) {
  const serve = readServe(root);
  if (!serve || serve.serverId || !Array.isArray(serve.sessions)) return 0;
  const legacy = new Set([serve.session, ...serve.sessions].filter((x) => typeof x === "string"));
  let n = 0;
  try {
    for (const name of fs.readdirSync(queueDir(root))) {
      if (!name.endsWith(".json")) continue;
      try {
        if (legacy.has(JSON.parse(fs.readFileSync(path.join(queueDir(root), name), "utf-8")).session)) n++;
      } catch {}
    }
  } catch {}
  return n;
}

/**
 * Queue a verified record from the live server. `current` is the skeleton
 * version the server would render now, so a send from a page that was already
 * out of date says so.
 */
const modern = r => typeof r?.round === "string" && /^[0-9a-f-]{36}$/.test(r.round) && typeof r.order === "string" && /^[1-9][0-9]*$/.test(r.order);
const failure = message => Object.assign(new Error(message), { code: "SKEL_FEEDBACK_ORDER" });
export const isFeedbackError = err => ["SKEL_FEEDBACK_ORDER", "SKEL_FEEDBACK_BUSY"].includes(err?.code);
const lockRecovery = lock => `feedback ordering is locked at ${lock}. It may be active. Retry after the other operation finishes; after a crash, stop all skel servers/commands and remove that lock directory from an external terminal.`;
/** Read-only presence check: no owner/age inference, contents read, or repair. */
export function feedbackLockNotice(root) {
  const lock = path.join(queueDir(root), ".order-lock");
  try { return fs.lstatSync(lock, { throwIfNoEntry: false }) ? lockRecovery(lock) : null; }
  catch (err) {
    if (["ENOENT", "ENOTDIR"].includes(err.code)) return null;
    return `cannot inspect feedback ordering lock at ${lock} (${err.code ?? err.message}). Check that path from an external terminal; do not remove a lock while skel servers/commands may be running.`;
  }
}


/** No clock-based lock stealing: a crashed owner requires external repair. */
function safeFeedbackDirs(root) {
  try {
    for (const dir of [path.join(root, STATE_DIR), queueDir(root), historyDir(root)]) {
      let stat = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (!stat && dir === queueDir(root)) { fs.mkdirSync(dir); stat = fs.lstatSync(dir); }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw failure("feedback path must be a real directory: " + dir);
      if (!stat && dir === path.join(root, STATE_DIR)) throw failure("skeleton directory is missing: " + dir);
    }
  } catch (err) {
    if (isFeedbackError(err)) throw err;
    throw failure(`cannot access feedback directories for ${root}: ${err.message}. Repair the named path from an external terminal before retrying.`);
  }
}
// One process-lifetime guard avoids removing a signal watcher before Node has
// delivered a signal queued during synchronous work. Signal listeners alone
// do not keep a CLI process alive, and sequential calls never add more pairs.
const activeLockFinishes = new Set();
const lockSignalHandlers = new Map();
let lockSignal = null;
function guardLockSignals(finish) {
  if (lockSignal) throw failure("feedback operation cannot start while the process is stopping");
  activeLockFinishes.add(finish);
  if (lockSignalHandlers.size) return;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (lockSignal) return;
      lockSignal = signal;
      for (const done of [...activeLockFinishes]) done();
      setImmediate(() => {
        for (const [name, listener] of lockSignalHandlers) process.removeListener(name, listener);
        lockSignalHandlers.clear();
        // Keep the stopping flag set: no new lock may re-install a watcher
        // and swallow this re-raised signal before its default termination.
        process.kill(process.pid, lockSignal);
      });
    };
    lockSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}
export function withFeedbackLock(root, fn) {
  safeFeedbackDirs(root);
  const lock = path.join(queueDir(root), ".order-lock");
  let owned = false;
  const release = () => {
    if (!owned) return;
    owned = false;
    try { fs.rmdirSync(lock); } catch {}
  };
  const finish = () => {
    // Release before detaching any handlers; never remove an unowned lock.
    release();
    process.removeListener("exit", release);
    activeLockFinishes.delete(finish);
  };
  guardLockSignals(finish); // before mkdir: no unguarded ownership window
  process.once("exit", release); // CLI refusal uses process.exit.
  try { fs.mkdirSync(lock); owned = true; }
  catch (err) {
    finish();
    if (err.code === "EEXIST") throw Object.assign(failure(lockRecovery(lock)), { code: "SKEL_FEEDBACK_BUSY" });
    throw failure(`cannot claim feedback lock ${lock}: ${err.message}`);
  }
  const operationError = err => err?.code === "SKEL_FEEDBACK_BUSY" ? failure("feedback operation already started; it cannot be retried: " + err.message) : err;
  try {
    const result = fn();
    if (result && typeof result.then === "function") return Promise.resolve(result).catch(err => { throw operationError(err); }).finally(finish);
    finish();
    return result;
  } catch (err) { finish(); throw operationError(err); }
}

/** Called only while holding the ordering lock; legacy state gains no approval. */
export function ensureReviewRound(root) {
  try {
    const file = statePath(root);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure("skeleton state must be a regular file: " + file);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || !["scaffold", "fill", "done"].includes(raw.phase)) throw failure("cannot send feedback: skeleton state is invalid; repair it before retrying");
    const state = readState(root);
    if (!["ask", "deny"].includes(state.gate) || typeof state.title !== "string" || !Array.isArray(state.files) || state.files.some(file => typeof file !== "string") || !(state.activeStep === null || typeof state.activeStep === "string") || !Number.isFinite(state.reviewEpoch)) throw failure("cannot send feedback: skeleton state is invalid; repair it before retrying");
    if (state.reviewRound === undefined) return writeState(root, { ...state, reviewRound: crypto.randomUUID() });
    if (typeof state.reviewRound !== "string" || !/^[0-9a-f-]{36}$/.test(state.reviewRound)) throw failure("skeleton review round is invalid; repair state before retrying");
    return state;
  } catch (err) {
    if (isFeedbackError(err)) throw err;
    throw failure(`cannot read or update skeleton state ${statePath(root)}: ${err.message}. Repair the named state file from an external terminal before retrying.`);
  }
}

function recordsIn(root, dir) {
  let names;
  try { names = fs.readdirSync(dir).filter(n => n.endsWith(".json")); }
  catch (err) { if (err.code === "ENOENT") return []; throw failure(`cannot enumerate feedback: ${dir}`); }
  const sessions = new Set(readSessions(root));
  return names.flatMap(name => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      return record && sessions.has(record.session) && typeof record.at === "number" ? [{ name, file: path.join(dir, name), record }] : [];
    } catch { return []; }
  });
}
function orderedRecords(root) {
  const entries = [...recordsIn(root, historyDir(root)), ...recordsIn(root, queueDir(root))];
  const seen = new Map();
  for (const { record, file } of entries) {
    if (!modern(record)) continue;
    if (seen.has(record.order)) throw failure(`duplicate feedback order ${record.order}: ${seen.get(record.order)} and ${file}. Stop skel and inspect both named records from an external terminal; preserve the notes and resolve the duplicate before retrying.`);
    seen.set(record.order, file);
  }
  return entries;
}
function nextOrder(root) {
  const file = path.join(queueDir(root), ".order");
  let max = 0n;
  for (const { record } of orderedRecords(root)) if (modern(record) && BigInt(record.order) > max) max = BigInt(record.order);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw failure("feedback counter must be a small regular file: " + file);
    const value = JSON.parse(fs.readFileSync(file, "utf8")).last;
    if (typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > max) max = BigInt(value);
  } catch (err) { if (err.code && err.code !== "ENOENT") throw failure(`cannot read feedback counter: ${file}`); }
  const order = String(max + 1n);
  writeFileAtomic(file, JSON.stringify({ last: order }));
  return order;
}
export function storeFeedback(root, session, fb, current = null) {
  try {
    return withFeedbackLock(root, () => {
      const state = ensureReviewRound(root);
      if (typeof current === "function") current = current();
      const order = nextOrder(root);
      const at = Date.now(); // display only; never a round boundary or ordering key
      const name = order + "-" + crypto.randomBytes(16).toString("hex") + ".json";
      writeFileAtomic(path.join(queueDir(root), name), JSON.stringify({ ...fb, ...(isVersion(current) ? { current } : {}), session, at, round: state.reviewRound, order }, null, 2));
    });
  } catch (err) {
    if (isFeedbackError(err)) throw err;
    throw failure(`cannot store feedback for ${root}: ${err.message}. Repair the named feedback path from an external terminal before retrying.`);
  }
}

/** All verified unread sends block approval, including unknown/older rounds. */
export function lastReview(root, round = readState(root)?.reviewRound) {
  const entries = orderedRecords(root);
  const unread = recordsIn(root, queueDir(root)).length;
  const all = entries.map(e => e.record).filter(r => modern(r) && r.round === round && isVersion(r.version));
  all.sort((a, b) => BigInt(a.order) < BigInt(b.order) ? -1 : 1);
  return { record: all.at(-1) ?? null, unread, unknown: entries.some(e => !modern(e.record)) };
}

export function pendingCount(root) {
  try {
    return fs.readdirSync(queueDir(root)).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * Drain the queue in order. Records from the current serve session are the
 * human's and are archived (`approve`/`reshape` read the archive); anything
 * else — stale, shipped in a repo, written by hand — is quarantined and
 * counted, never shown as the human's. The verdict that counts is the latest.
 */
export function takeFeedback(root) {
  return withFeedbackLock(root, () => {
    orderedRecords(root); // validate duplicate logical positions before moving anything
    let names;
    try { names = fs.readdirSync(queueDir(root)).filter(n => n.endsWith(".json")); }
    catch (err) { throw failure("cannot read feedback queue: " + err.message); }
    if (!names.length) return { status: "none", records: [], quarantined: 0 };
    fs.mkdirSync(historyDir(root), { recursive: true });
    const sessions = new Set(readSessions(root)), records = [];
    let quarantined = 0;
    for (const name of names) {
      const file = path.join(queueDir(root), name);
      let fb;
      try { fb = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const verified = fb && sessions.has(fb.session) && typeof fb.at === "number";
      fs.renameSync(file, path.join(historyDir(root), verified ? name : name + ".unverified"));
      if (verified) records.push(fb); else quarantined++;
    }
    records.sort((a,b) => !modern(a) ? (modern(b) ? -1 : 0) : !modern(b) ? 1 : BigInt(a.order) < BigInt(b.order) ? -1 : 1);
    return { status: records.length ? "ok" : "unverified", records, quarantined };
  });
}

const hasNotes = (r) => (typeof r.notes === "boolean" ? r.notes : freshNotes(r));
/**
 * #68 P2: the latest send with a verdict (in `round`, for `version` when
 * given), and whether it stands as an approval WITH COMMENTS: it brought notes
 * written on its version, or a verdict-less send after it did (Send empties
 * the draft, so a further note goes out without a verdict). A later send with
 * its own verdict replaces it. `skel feedback` (mergeRecords) and `skel
 * approve` (approvalState) decide from this one record, so they agree.
 */
export function verdictState(records, round = undefined, version = undefined) {
  const known = records.filter((r) => modern(r) && (round === undefined || r.round === round))
    .sort((a, b) => (BigInt(a.order) < BigInt(b.order) ? -1 : 1));
  let at = -1;
  for (let i = known.length - 1; i >= 0; i--) if (known[i].verdict && (version === undefined || known[i].version === version)) { at = i; break; }
  if (at < 0) return { record: null, notes: false, withComments: false };
  const record = known[at];
  const notes = hasNotes(record) || known.slice(at + 1).some((r) => !r.verdict && r.version === record.version && hasNotes(r));
  return { record, notes, withComments: record.verdict === "approve" && notes };
}

/** verdictState over every verified send on record (read or not), for `skel approve`. */
export function approvalState(root, round, version) {
  return verdictState(orderedRecords(root).map((e) => e.record), round, version);
}

/** Several sends as one review: comments concatenated, the latest verdict wins. */
export function mergeRecords(records, currentRound = undefined) {
  records = [...records].sort((a,b) => !modern(a) ? (modern(b) ? -1 : 0) : !modern(b) ? 1 : BigInt(a.order) < BigInt(b.order) ? -1 : 1);
  const known = records.filter(r => modern(r) && (currentRound === undefined || r.round === currentRound));
  const verdict = [...known].reverse().find((r) => r.verdict)?.verdict ?? null;
  const latest = [...known].reverse().find((r) => isVersion(r.version));
  // #68 P2: the same rule `skel approve` applies (verdictState).
  const { notes } = verdictState(known, currentRound);
  // An Overall note edited on an earlier version is tagged in place: merged,
  // the notes no longer carry their own versions.
  const generalOf = (r) => (!r.general ? r.general
    : r.generalUnversioned === true ? `[written on an unknown earlier version] ${r.general}`
    : isVersion(r.generalVersion) && isVersion(r.version) && r.generalVersion !== r.version ? `[written on version ${r.generalVersion}] ${r.general}` : r.general);
  return {
    verdict,
    notes,
    general: [records.some(r => !modern(r)) ? "Legacy feedback has unknown ordering/round. Its versions are informational only: " + records.filter(r => !modern(r) && isVersion(r.version)).map(r => r.version).join(", ") + ". Notes are retained, but no legacy version/verdict is selected. Ask the human to review again and explicitly provide the version they reviewed, or resend any notes that still apply." : "", currentRound !== undefined && records.some(r => modern(r) && r.round !== currentRound) ? "Earlier review round: those notes are retained, but their verdict/version is not selected for this round. Ask the human to resend any old notes that still apply through the current review workflow." : "", ...records.map(generalOf)].filter(Boolean).join("\n\n"),
    comments: records.flatMap((r) => r.comments ?? []),
    version: latest?.version ?? null,
    current: latest?.current ?? null,
  };
}

/** Read-only diagnostics never repair, move, or discard authority records. */
export function feedbackOrderNotice(root) {
  try { orderedRecords(root); return null; }
  catch (err) { return "feedback ordering needs attention: " + err.message; }
}

/** Only lock acquisition contention is retried; callback/storage errors are never replayed. */
export async function storeFeedbackForHttp(root, session, fb, current = null) {
  const deadline = performance.now() + 1500;
  for (;;) {
    try { return storeFeedback(root, session, fb, current); }
    catch (err) {
      if (err.code !== "SKEL_FEEDBACK_BUSY") throw err;
      if (performance.now() >= deadline) throw Object.assign(failure("Feedback is busy with another operation. Your draft is kept; wait a moment and send again."), { code: "SKEL_FEEDBACK_BUSY" });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
