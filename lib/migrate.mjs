// The move of a project's trusted records from the old config dir
// (~/.config/skel) to the state dir (~/.local/state/skel), #18. Only `skel
// migrate` runs it: the records leave the place a running session's deny rule
// covers when a human asks, and not during a fill.
//
// - Everything is checked before anything moves. A corrupt source, or a
//   destination that already holds something else, refuses the whole project:
//   nothing is overwritten, both files stay, and the project keeps using the old
//   location. Rendered history is the exception to a differing destination: when
//   both copies are valid they merge (a `skel serve` from before the upgrade can
//   still write the old file). A settings notice never refuses: it vouches for
//   nothing and its reader ignores a bad one, so a corrupt old one is dropped and
//   a differing one merges.
// - Copies first, then a commit marker in the old dir, then the deletes. A crash
//   before the marker leaves the old location whole and in use; after it, the
//   state dir is whole and in use. Readers can't see half of each, so a half-done
//   move never reads as "no record", and running it again finishes it.
// - Two processes can race: the destination appears through link(2), which never
//   replaces a file, with the bytes that were validated; a loser finds an
//   identical file, or a source that is gone because the winner finished.
//
// Old files are handled one by one: moved, deleted when the destination already
// holds the same bytes, or named in the refusal and left for the human. The old
// dir is removed once empty. Other projects' files stay until they migrate.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KEEP_RENDERED, isPlain, validSnapshot } from "./records.mjs";
import { writeFileAtomic } from "./state.mjs";

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
/** Each store's file suffix, and whether a parsed record is the shape skel writes. */
const STORES = {
  "": (r) => Array.isArray(r.sessions), // readSessions drops any non-string entry
  ".snapshot": validSnapshot,
  ".rendered": (r) => Array.isArray(r.versions), // readRenderedStore filters each version
  "-install": (r) => isStrings(r.ownedDeny),
  ".config-notice": (r) => typeof r.at === "string" && typeof r.source === "string" && typeof r.file === "string" && (r.delivered === undefined || isStrings(r.delivered)),
};
export const STORE_SUFFIXES = Object.keys(STORES);
/** In the old dir, from when every record has been copied until the old ones are gone. */
export const migratingMarker = (key) => `${key}.migrating`;
const NOTICE = ".config-notice";

/** Why these bytes can't be this project's record, or null. */
function invalid(suffix, bytes, key, keyOf) {
  let record;
  try {
    record = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return "not valid JSON";
  }
  if (!isPlain(record) || !STORES[suffix](record)) return "not the shape skel writes";
  if (suffix === NOTICE) return null; // names no project: its file name is all there is
  if (typeof record.root !== "string") return "it doesn't name its project";
  // A root that no longer resolves (a junction since deleted) can't be checked:
  // that makes it unverifiable, not another project's.
  if (fs.existsSync(record.root) && keyOf(record.root) !== key) return `it names another project (${record.root})`;
  return null;
}

/** A regular file's contents and identity: { missing } | { error } | { bytes, id }. Never follows a link. */
function readRegular(file) {
  try {
    const st = fs.lstatSync(file, { bigint: true });
    if (!st.isFile()) return { error: "not a regular file" };
    return { bytes: fs.readFileSync(file), id: `${st.dev}:${st.ino}` };
  } catch (err) {
    return err.code === "ENOENT" || err.code === "ENOTDIR" ? { missing: true } : { error: err.code ?? err.message };
  }
}

/** problems: { kind: "corrupt" | "conflict" | "io", suffix, text } */
function refuse(from, to, problems, moved = false) {
  const has = (k) => problems.some((p) => p.kind === k);
  const advice = [
    ...(has("corrupt") ? ["A corrupt old file has nothing to move: delete it, or restore a good copy."] : []),
    ...(has("conflict") ? ["Where both exist, keep the one you trust and delete the other. A short file at the new location, left by an interrupted copy, is safe to delete: the move resumes from the old file."] : []),
    ...(has("io") ? ["Fix that path or its permissions, or point XDG_STATE_HOME somewhere writable."] : []),
    ...(problems.some((p) => p.suffix === ".snapshot" && p.kind !== "io") ? ["Without a snapshot record, the skeleton needs re-approving."] : []),
    "Then run `skel migrate` again.",
  ];
  return Object.assign(
    new Error(
      `can't move this project's state from ${from} to ${to}${moved ? " (some of it has moved)" : "; nothing was moved"}:\n` +
        `${problems.map((p) => `  ${p.text}`).join("\n")}\nNothing was overwritten, and this project keeps using the old location until this is resolved. ${advice.join(" ")}`,
    ),
    { code: "SKEL_STATE_MIGRATION" },
  );
}

/** Put `bytes` at `dest`, or throw EEXIST: never replaces a file, and a link makes it appear whole. */
function createExclusive(dest, bytes, link) {
  const tmp = `${dest}.migrate.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      link(tmp, dest);
    } catch (err) {
      if (err.code === "EEXIST") throw err;
      // A filesystem without hard links. A crash mid-copy leaves a short
      // destination, which the next run refuses as a conflict: closed, not silent.
      fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Both rendered histories, newest first (approve falls back to the newest), as many as a store keeps. */
function mergeRendered(oldBytes, curBytes) {
  const cur = JSON.parse(curBytes.toString("utf-8"));
  const at = (v) => (Number.isFinite(v?.at) ? v.at : 0);
  const byVersion = new Map();
  for (const v of [...cur.versions, ...JSON.parse(oldBytes.toString("utf-8")).versions]) {
    if (isPlain(v) && (!byVersion.has(v.version) || at(v) > at(byVersion.get(v.version)))) byVersion.set(v.version, v);
  }
  return JSON.stringify({ root: cur.root, versions: [...byVersion.values()].sort((a, b) => at(b) - at(a)).slice(0, KEEP_RENDERED) });
}

/** The newer notice, keeping which sessions have seen either. A corrupt current one has nothing to keep. */
function mergeNotice(oldBytes, curBytes) {
  const old = JSON.parse(oldBytes.toString("utf-8"));
  let cur;
  try { cur = JSON.parse(curBytes.toString("utf-8")); } catch { return oldBytes; }
  if (!isPlain(cur) || !STORES[NOTICE](cur)) return oldBytes;
  const newer = Date.parse(old.at) > Date.parse(cur.at) ? old : cur;
  const delivered = [...new Set([...(cur.delivered ?? []), ...(old.delivered ?? [])])].slice(-32);
  return JSON.stringify({ ...newer, ...(delivered.length ? { delivered } : {}) });
}
const MERGES = { ".rendered": mergeRendered, [NOTICE]: mergeNotice };

/** Temp files of migrations that crashed: their process is gone. */
function sweepTemps(to, key) {
  let names;
  try { names = fs.readdirSync(to); } catch { return; }
  for (const name of names) {
    const m = name.startsWith(key) && /\.migrate\.(\d+)\.[0-9a-f]+$/.exec(name);
    if (!m) continue;
    try {
      process.kill(Number(m[1]), 0);
    } catch (err) {
      if (err.code === "ESRCH") fs.rmSync(path.join(to, name), { force: true });
    }
  }
}

/** Make the new names durable before the old files go. Not possible on every platform. */
function syncDir(dir) {
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}

/**
 * What a move would do, per file, touching nothing. outcomes: { suffix, source,
 * outcome: "move" | "merge" | "already-there" | "drop" | "refuse", why }.
 */
export function planMigration({ key, from, to, keyOf }) {
  const moves = [];
  const merges = [];
  const stale = [];
  const problems = [];
  const outcomes = [];
  const note = (suffix, source, outcome, why = null) => outcomes.push({ suffix, source, outcome, why });
  const problem = (suffix, source, kind, text) => { problems.push({ kind, suffix, text }); note(suffix, source, "refuse", text); };
  for (const suffix of STORE_SUFFIXES) {
    const source = path.join(from, `${key}${suffix}.json`);
    const dest = path.join(to, `${key}${suffix}.json`);
    const old = readRegular(source);
    if (old.missing) continue;
    if (old.error) { problem(suffix, source, "io", `${source}: can't read it (${old.error})`); continue; }
    const why = invalid(suffix, old.bytes, key, keyOf);
    if (why && suffix === NOTICE) { stale.push(source); note(suffix, source, "drop", why); continue; }
    if (why) { problem(suffix, source, "corrupt", `${source}: corrupt source: ${why}`); continue; }
    const cur = readRegular(dest);
    if (cur.missing) { moves.push({ source, dest, bytes: old.bytes }); note(suffix, source, "move"); }
    else if (cur.id && cur.id === old.id) note(suffix, source, "already-there", "one file reached two ways"); // a symlinked dir: nothing to move
    else if (cur.bytes?.equals(old.bytes)) { stale.push(source); note(suffix, source, "already-there"); }
    else if (readRegular(source).missing) continue; // a process that finished the move removed the source, then updated the destination
    else if (MERGES[suffix] && cur.bytes && (suffix === NOTICE || !invalid(suffix, cur.bytes, key, keyOf))) { merges.push({ source, dest, old: old.bytes, cur: cur.bytes, merge: MERGES[suffix] }); note(suffix, source, "merge"); }
    else problem(suffix, source, "conflict", `${dest}: already exists and differs from ${source}${cur.error ? ` (${cur.error})` : invalid(suffix, cur.bytes, key, keyOf) ? " (and is corrupt)" : ""}`);
  }
  return { moves, merges, stale, problems, outcomes };
}

/**
 * Move one project's records from `from` to `to`. Returns how many moved.
 * `keyOf` maps a record's project path to its file key; `link` is injectable
 * for the no-hard-links path.
 */
export function migrateProject({ key, from, to, keyOf, link = fs.linkSync }) {
  if (path.relative(from, to) === "") return 0;
  const { moves, merges, stale, problems } = planMigration({ key, from, to, keyOf });
  if (problems.length) throw refuse(from, to, problems);
  const marker = path.join(from, migratingMarker(key));

  let moved = 0;
  try {
    if (moves.length) fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    if (moves.length || merges.length || stale.length) sweepTemps(to, key);
    const done = [];
    for (const { source, dest, bytes } of moves) {
      // Finished by another process since we read it (and perhaps cleared by
      // `init --force` since): these bytes mustn't come back.
      if (readRegular(source).missing) continue;
      try {
        createExclusive(dest, bytes, link);
        moved++;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Lost a race: fine if the winner wrote the same bytes or has finished.
        if (!readRegular(dest).bytes?.equals(bytes) && !readRegular(source).missing) {
          throw refuse(from, to, [{ kind: "conflict", suffix: dest.endsWith(".snapshot.json") ? ".snapshot" : "", text: `${dest}: already exists and differs from ${source}` }], moved > 0);
        }
      }
      done.push(source);
    }
    for (const { source, dest, old, cur, merge } of merges) {
      writeFileAtomic(dest, merge(old, cur), 0o600);
      done.push(source);
      moved++;
    }
    if (done.length) syncDir(to);
    if (done.length || stale.length) {
      try {
        fs.closeSync(fs.openSync(marker, "a", 0o600));
      } catch (err) {
        if (err.code !== "ENOENT") throw err; // another process finished and removed the old dir
      }
    }
    for (const source of [...done, ...stale]) fs.rmSync(source, { force: true });
    fs.rmSync(marker, { force: true });
  } catch (err) {
    if (err.code === "SKEL_STATE_MIGRATION") throw err;
    throw refuse(from, to, [{ kind: "io", suffix: "", text: `${err.path ?? to}: ${err.code ?? err.message}` }], moved > 0);
  }
  try { fs.rmdirSync(from); } catch {} // only if we left it empty
  return moved;
}
