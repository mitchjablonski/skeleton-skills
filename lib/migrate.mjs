// One-time move of a project's trusted records from the old config dir
// (~/.config/skel) to the state dir (~/.local/state/skel), #18. It runs before
// the first store access of each process (storePath), per project:
//
// - Everything is checked before anything moves. A corrupt source, or a
//   destination that already holds something else, refuses the whole project:
//   nothing is overwritten, both files stay, and every store access throws
//   SKEL_STATE_MIGRATION. Readers turn that into their "can't tell" answers,
//   never into "no record, carry on".
// - A crash part way leaves each file in exactly one place (or identical in
//   both), and the next run resumes from there. Until it finishes, no process
//   reads a store, because each one runs this first.
// - Two processes can race: the destination appears through link(2), which
//   never replaces a file, with the bytes that were validated; a loser finds
//   an identical file, or a source that is gone because the winner finished.
//
// Old files are handled one by one: moved, deleted when the destination already
// holds the same bytes, or named in the refusal and left for the human. The old
// dir is removed once empty. Other projects' files stay until they next run.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPlain, validSnapshot } from "./records.mjs";

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
/** Each store's file suffix, and whether a parsed record is the shape skel writes. */
const STORES = {
  "": (r) => Array.isArray(r.sessions), // readSessions drops any non-string entry
  ".snapshot": validSnapshot,
  ".rendered": (r) => Array.isArray(r.versions), // readRenderedStore filters each version
  "-install": (r) => isStrings(r.ownedDeny),
};

/** Why these bytes can't be this project's record, or null. */
function invalid(suffix, bytes, key, keyOf) {
  let record;
  try {
    record = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return "not valid JSON";
  }
  if (!isPlain(record) || !STORES[suffix](record)) return "not the shape skel writes";
  if (typeof record.root !== "string") return "it doesn't name its project";
  if (keyOf(record.root) !== key) return `it names another project (${record.root})`;
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

function refuse(from, to, problems, moved = false) {
  const lines = problems.map((p) => `  ${p}`).join("\n");
  return Object.assign(
    new Error(
      `can't move this project's state from ${from} to ${to}${moved ? " (some of it has moved)" : "; nothing was moved"}:\n${lines}\n` +
        "Nothing was overwritten. Keep the file you trust at the new location and delete the other (without a snapshot record, the skeleton needs re-approving), then run skel again.",
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

const finished = new Set();

/**
 * Move one project's records from `from` to `to`. Returns how many moved.
 * `keyOf` maps a record's project path to its file key; `link` is injectable
 * for the no-hard-links path. Only success is remembered, so a refusal is
 * re-checked (and can clear) on the next call.
 */
export function migrateProject({ key, from, to, keyOf, link = fs.linkSync, log = (m) => process.stderr.write(`skel: ${m}\n`) }) {
  const memo = `${key}\u0000${from}\u0000${to}`;
  if (finished.has(memo) || path.relative(from, to) === "") return 0;
  const moves = [];
  const stale = [];
  const problems = [];
  for (const suffix of Object.keys(STORES)) {
    const source = path.join(from, `${key}${suffix}.json`);
    const dest = path.join(to, `${key}${suffix}.json`);
    const old = readRegular(source);
    if (old.missing) continue;
    if (old.error) { problems.push(`${source}: can't read it (${old.error})`); continue; }
    const why = invalid(suffix, old.bytes, key, keyOf);
    if (why) { problems.push(`${source}: corrupt source: ${why}`); continue; }
    const cur = readRegular(dest);
    if (cur.missing) moves.push({ source, dest, bytes: old.bytes });
    else if (cur.id && cur.id === old.id) continue; // one file reached two ways (a symlinked dir): nothing to move
    else if (cur.bytes?.equals(old.bytes)) stale.push(source);
    // A process that finished the move can have updated the destination since
    // we read the source, and it removed the source first.
    else if (!readRegular(source).missing) problems.push(`${dest}: already exists and differs from ${source}${cur.error ? ` (${cur.error})` : invalid(suffix, cur.bytes, key, keyOf) ? " (and is corrupt)" : ""}`);
  }
  if (problems.length) throw refuse(from, to, problems);

  let moved = 0;
  try {
    if (moves.length) fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const { source, dest, bytes } of moves) {
      try {
        createExclusive(dest, bytes, link);
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Lost a race: fine if the winner wrote the same bytes or has finished.
        if (!readRegular(dest).bytes?.equals(bytes) && !readRegular(source).missing) throw refuse(from, to, [`${dest}: already exists and differs from ${source}`], moved > 0);
        stale.push(source);
        continue;
      }
      fs.rmSync(source, { force: true });
      moved++;
    }
    for (const source of stale) fs.rmSync(source, { force: true });
  } catch (err) {
    if (err.code === "SKEL_STATE_MIGRATION") throw err;
    throw refuse(from, to, [`${to}: ${err.code ?? err.message}`], moved > 0);
  }
  if (moves.length || stale.length) {
    try { fs.rmdirSync(from); } catch {} // only if we left it empty
  }
  if (moved) log(`moved this project's state from ${from} to ${to}. Re-run \`skel install\` where it's installed, so the deny rules cover the new location (see "Upgrading" in the README).`);
  finished.add(memo);
  return moved;
}
