// The move of a project's trusted records from the old config dir
// (~/.config/skel) to the state dir (~/.local/state/skel), #18. Only `skel
// migrate` runs it: the records leave the place a running session's deny rule
// covers when a human asks, and not during a fill.
//
// - Everything is checked before anything moves. A corrupt source, or anything
//   in the state dir for this project that doesn't match the old bytes, refuses
//   the whole project: nothing is overwritten and the project keeps using the old
//   location. A settings notice never refuses: it vouches for nothing and its
//   reader ignores a bad one, so the old location's replaces the state dir's, and
//   a corrupt old one is dropped.
// - Copies first, then a marker in the old dir, then the deletes. The marker is
//   the commit point and stays there for good: without it the old dir is
//   authoritative, with it the state dir is, and a file that turns up in the old
//   dir later (an older skel still running) is ignored and reported. It's in the
//   old dir because that's what the session's loaded rule guards. A crash leaves
//   one whole location in use, and running `skel migrate` again finishes the job.
// - Two processes can race: the destination appears through link(2), which never
//   replaces a file, with the bytes that were validated; a loser finds an
//   identical file, or a source that is gone because the winner finished.
//
// Other projects' files stay until they migrate.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPlain, validSnapshot } from "./records.mjs";
import { STORE_SUFFIXES, hasMigratedMarker, legacyConfigDir, migratedMarker, projectKey, skelStateDir, usesLegacyStore, writeFileAtomic } from "./state.mjs";

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
/** Each store's file suffix, and whether a parsed record is the shape skel writes. */
// Keep in step with STORE_SUFFIXES in state.mjs (which the hook loads without this file).
const STORES = {
  "": (r) => Array.isArray(r.sessions), // readSessions drops any non-string entry
  ".snapshot": validSnapshot,
  ".rendered": (r) => Array.isArray(r.versions), // readRenderedStore filters each version
  "-install": (r) => isStrings(r.ownedDeny),
  ".config-notice": (r) => typeof r.at === "string" && typeof r.source === "string" && typeof r.file === "string" && (r.delivered === undefined || isStrings(r.delivered)),
};
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

/**
 * On Windows a file another process is deleting stays visible for a moment and
 * answers EPERM, EACCES or EBUSY. Wait that out, so two racing `skel migrate`s
 * don't read it as a real failure.
 */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
function settled(fn) {
  for (let tries = process.platform === "win32" ? 10 : 0; ; tries--) {
    try {
      return fn();
    } catch (err) {
      if (tries <= 0 || !TRANSIENT.has(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
const removeFile = (file) => settled(() => fs.rmSync(file, { force: true }));

/** A regular file's contents and identity: { missing } | { error } | { bytes, id }. Never follows a link. */
function readRegular(file) {
  try {
    return settled(() => {
      const st = fs.lstatSync(file, { bigint: true });
      if (!st.isFile()) return { error: "not a regular file" };
      return { bytes: fs.readFileSync(file), id: `${st.dev}:${st.ino}` };
    });
  } catch (err) {
    return err.code === "ENOENT" || err.code === "ENOTDIR" ? { missing: true } : { error: err.code ?? err.message };
  }
}

/** problems: { kind: "corrupt" | "conflict" | "io" | "marker" | "changed", suffix, text } */
function refuse(from, to, problems) {
  const has = (k) => problems.some((p) => p.kind === k);
  const advice = [
    ...(has("corrupt") ? ["A corrupt old file has nothing to move: delete it, or restore a good copy."] : []),
    ...(has("conflict") ? ["skel has been reading the old location, so a differing file in the state dir isn't its record: a file written there while no deny rule covered it can't be trusted. Delete it unless you know where it came from. A short file left by an interrupted copy, or a copy from a move that didn't finish, is safe to delete: the move starts again from the old file."] : []),
    ...(has("io") ? ["Fix that path or its permissions, or point XDG_STATE_HOME somewhere writable."] : []),
    ...(has("marker") ? ["If you never migrated, delete that marker to go back to the old files."] : []),
    ...(problems.some((p) => p.suffix === ".snapshot" && p.kind === "corrupt") ? ["Without a snapshot record, the skeleton needs re-approving."] : []),
    "Then run `skel migrate` again.",
  ];
  return Object.assign(
    new Error(
      `can't move this project's state from ${from} to ${to}:\n${problems.map((p) => `  ${p.text}`).join("\n")}\n` +
        `Nothing was overwritten, and skel goes on using the location it was using. ${advice.join(" ")}`,
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
 * What `skel migrate` would do, per file, touching nothing. outcomes: { suffix,
 * source (the file concerned), outcome: "move" | "already-there" | "drop" |
 * "discard" | "replace" | "remove-leftover" | "refuse", why }.
 *
 * With no marker the old dir is authoritative: it's what skel reads, and what
 * the session's loaded rule guards. The state dir is unguarded until then, so
 * anything there for this project that doesn't match the old bytes is refused,
 * not trusted, not merged. With a marker the move is committed: all that's left
 * is removing old files, whatever they hold.
 */
export function planMigration({ key, from, to, keyOf }) {
  const moves = [];
  const stale = [];
  const notices = []; // state-dir settings notices to replace or remove
  const problems = [];
  const outcomes = [];
  const note = (suffix, source, outcome, why = null) => outcomes.push({ suffix, source, outcome, why });
  const problem = (suffix, source, kind, text) => { problems.push({ kind, suffix, text }); note(suffix, source, "refuse", text); };
  const file = (dir, suffix) => path.join(dir, `${key}${suffix}.json`);
  const sourceOf = (s) => readRegular(file(from, s));
  const marked = hasMigratedMarker(from, key);
  const anyOld = STORE_SUFFIXES.some((s) => !sourceOf(s).missing);
  if (marked) {
    const anyNew = STORE_SUFFIXES.some((s) => !readRegular(file(to, s)).missing);
    for (const suffix of STORE_SUFFIXES) {
      if (sourceOf(suffix).missing) continue;
      if (anyNew) { stale.push({ source: file(from, suffix) }); note(suffix, file(from, suffix), "remove-leftover", "skel moved this project's records and ignores this file"); }
      else problem(suffix, file(from, suffix), "marker", `${file(from, suffix)}: ${path.join(from, migratedMarker(key))} says this project's records moved, but ${to} holds none`);
    }
    return { marked, moves, stale, notices, problems, outcomes };
  }
  if (!anyOld) return { marked, moves, stale, notices, problems, outcomes };
  for (const suffix of STORE_SUFFIXES) {
    const source = file(from, suffix);
    const dest = file(to, suffix);
    const old = readRegular(source);
    const cur = readRegular(dest);
    if (old.missing) {
      if (cur.missing) continue;
      if (suffix === NOTICE) { notices.push({ dest }); note(suffix, dest, "discard", "a settings notice with no counterpart in the old location"); continue; }
      problem(suffix, dest, "conflict", `${dest}: in the state dir with no counterpart in ${from}, so skel hasn't been using it`);
      continue;
    }
    if (old.error) { problem(suffix, source, "io", `${source}: can't read it (${old.error})`); continue; }
    const why = invalid(suffix, old.bytes, key, keyOf);
    if (why && suffix === NOTICE) { stale.push({ source }); note(suffix, source, "drop", why); continue; }
    if (why) { problem(suffix, source, "corrupt", `${source}: corrupt source: ${why}`); continue; }
    if (cur.missing) { moves.push({ source, dest, bytes: old.bytes }); note(suffix, source, "move"); }
    else if (cur.id && cur.id === old.id) note(suffix, source, "already-there", "one file reached two ways"); // a symlinked dir: nothing to move
    else if (cur.bytes?.equals(old.bytes)) { stale.push({ source, dest }); note(suffix, source, "already-there"); }
    else if (suffix === NOTICE && cur.bytes) { notices.push({ dest, bytes: old.bytes }); stale.push({ source, dest }); note(suffix, source, "replace", "the state dir's differing settings notice is replaced"); }
    else problem(suffix, dest, "conflict", `${dest}: already exists and differs from ${source}${cur.error ? ` (${cur.error})` : invalid(suffix, cur.bytes, key, keyOf) ? " (and is corrupt)" : ""}`);
  }
  return { marked, moves, stale, notices, problems, outcomes };
}

/**
 * For `skel init`: while the project uses the old location, whatever the state
 * dir holds for it is unused, and clearing the old records could flip the project
 * over to trusting it (a planted file, or a copy from a move that didn't finish).
 * It goes first. The old location's ownership record stays, as it does for a
 * project in the state dir.
 */
export function discardUnusedStateDirFiles(root) {
  const key = projectKey(root);
  if (!usesLegacyStore(key)) return;
  for (const suffix of STORE_SUFFIXES) fs.rmSync(path.join(skelStateDir(), `${key}${suffix}.json`), { force: true });
}

/** What `skel migrate` would do for this project, with the dirs it would use. */
export function migrationPlan(root) {
  const d = { from: legacyConfigDir(), to: skelStateDir() };
  if (path.relative(d.from, d.to) === "") return { ...d, outcomes: [], problems: [] };
  return { ...d, ...planMigration({ key: projectKey(root), ...d, keyOf: projectKey }) };
}

/**
 * Move one project's records from `from` to `to`. Returns how many were copied.
 * `keyOf` maps a record's project path to its file key; `link` is injectable for
 * the no-hard-links path.
 *
 * Copies, a second look, the marker, then deletes. The second look catches a
 * write that landed while copying (an `approve` running alongside): the copies
 * are taken back and the old location stays whole. A write after the look is
 * left in the old dir and reported as a leftover, not deleted.
 */
export function migrateProject({ key, from, to, keyOf, link = fs.linkSync }) {
  if (path.relative(from, to) === "") return 0;
  const plan = planMigration({ key, from, to, keyOf });
  if (plan.problems.length) throw refuse(from, to, plan.problems);
  const marker = path.join(from, migratedMarker(key));
  const created = [];
  let moved = 0;
  try {
    if (plan.marked) {
      for (const { source } of plan.stale) removeFile(source);
      return 0;
    }
    if (!plan.outcomes.length) return 0;
    if (plan.moves.length) fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    sweepTemps(to, key);
    for (const { source, dest, bytes } of plan.moves) {
      if (readRegular(source).missing) continue; // finished by another process
      try {
        createExclusive(dest, bytes, link);
        created.push(dest);
        moved++;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Lost a race: fine if the winner wrote the same bytes or has finished.
        if (!readRegular(dest).bytes?.equals(bytes) && !readRegular(source).missing) {
          throw refuse(from, to, [{ kind: "conflict", suffix: dest.endsWith(".snapshot.json") ? ".snapshot" : "", text: `${dest}: already exists and differs from ${source}` }]);
        }
      }
    }
    for (const { dest, bytes } of plan.notices) {
      if (bytes) writeFileAtomic(dest, bytes, 0o600);
      else fs.rmSync(dest, { force: true });
    }
    const again = planMigration({ key, from, to, keyOf });
    if (again.marked) return moved; // another process committed
    if (again.moves.length || again.problems.length) {
      for (const dest of created) removeFile(dest);
      throw refuse(from, to, [{ kind: "changed", suffix: "", text: `${from}: this project's records changed during the move` }]);
    }
    syncDir(to);
    fs.closeSync(fs.openSync(marker, "a", 0o600));
    syncDir(from);
    for (const { source, dest } of again.stale) {
      // Written since the second look: it stays, ignored and reported, not lost unseen.
      if (!dest || readRegular(source).bytes?.equals(readRegular(dest).bytes)) removeFile(source);
    }
  } catch (err) {
    if (err.code === "SKEL_STATE_MIGRATION") throw err;
    throw refuse(from, to, [{ kind: "io", suffix: "", text: `${err.path ?? to}: ${err.code ?? err.message}` }]);
  }
  return moved;
}
