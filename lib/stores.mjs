// Where a project's trusted stores are, and the one way to their files. Loaded
// by the CLI and the Stop and ConfigChange hooks, never by the PreToolUse hook:
// that one only needs state.mjs (skelStoreDirs, approvalReceiptStatus).
//
// A project with records in the old config dir keeps using it: the deny rule
// its running session has loaded names that dir, and nothing here can tell what
// a session has loaded. Only `skel migrate`, which a human asks for outside a
// fill, moves them. A project with no old records uses the state dir from the
// start. Decided on each access, so a running server follows a migration.

import fs from "node:fs";
import path from "node:path";
import { STORE_SUFFIXES, migrateProject, migratingMarker, planMigration } from "./migrate.mjs";
import { legacyConfigDir, projectKey, skelStateDir, writeFileAtomic } from "./state.mjs";

const dirs = () => ({ from: legacyConfigDir(), to: skelStateDir() });
/** An error other than "not there" (a dir we can't read) counts as there: the old location's readers then fail closed. */
const exists = (file) => {
  try { return !!fs.lstatSync(file, { throwIfNoEntry: false }); } catch { return true; }
};

/**
 * Does this project still use the old location? The old dir wins over anything
 * in the state dir, so a record written to the state dir before its rule was
 * loaded vouches for nothing. A migration past its commit point (the marker: all
 * the records are copied) has left it, whatever remains to be deleted.
 */
function usesLegacy(key, { from, to }) {
  if (path.relative(from, to) === "" || exists(path.join(from, migratingMarker(key)))) return false;
  return STORE_SUFFIXES.some((s) => exists(path.join(from, `${key}${s}.json`)));
}

/** A per-project file in skel's store dir (`~/.local/state/skel/<hash><suffix>.json`). */
export function storePath(root, suffix = "") {
  const key = projectKey(root);
  const d = dirs();
  return path.join(usesLegacy(key, d) ? d.from : d.to, `${key}${suffix}.json`);
}

/** What `skel migrate` would do with this project's records, touching nothing. */
export function migrationPlan(root) {
  const key = projectKey(root);
  const d = dirs();
  return { ...d, resuming: path.relative(d.from, d.to) !== "" && exists(path.join(d.from, migratingMarker(key))), ...planMigration({ key, ...d, keyOf: projectKey }) };
}

/** Move this project's records to the state dir. Only `skel migrate` calls this. Throws SKEL_STATE_MIGRATION. */
export function migrateStores(root) {
  return migrateProject({ key: projectKey(root), ...dirs(), keyOf: projectKey });
}

/** How to move this project's records, while they're in the old location; else null. */
export function legacyNotice(root) {
  const d = dirs();
  if (!usesLegacy(projectKey(root), d)) return null;
  return `this project's records are still in ${d.from}. To move them to ${d.to}: run \`skel install\`, restart Claude Code so it loads the new deny rule, then run \`skel migrate\` outside a fill.`;
}

/**
 * legacyNotice for the Stop hook: once per session, since it runs every turn and
 * the human may be mid-fill. The sessions it has told are kept in .skeleton/: at
 * worst, a forged list silences a reminder.
 */
export function takeLegacyNotice(root, sessionId) {
  const notice = legacyNotice(root);
  if (!notice || typeof sessionId !== "string" || !sessionId) return notice;
  const file = path.join(root, ".skeleton", "legacy-notice.json");
  let told = [];
  try { told = JSON.parse(fs.readFileSync(file, "utf-8")).told; } catch {}
  if (!Array.isArray(told)) told = [];
  if (told.includes(sessionId)) return null;
  try { writeFileAtomic(file, JSON.stringify({ told: [...told, sessionId].slice(-32) })); } catch {}
  return notice;
}
