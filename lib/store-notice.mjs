// What `skel status` and the Stop hook tell the human about where a project's
// records are. Loaded only for a project with a skeleton, never by PreToolUse.

import fs from "node:fs";
import path from "node:path";
import { STORE_SUFFIXES, legacyConfigDir, migratedMarker, migratedMarkerStatus, projectKey, skelStateDir, usesLegacyStore } from "./state.mjs";

const exists = (file) => {
  try { return !!fs.lstatSync(file, { throwIfNoEntry: false }); } catch { return true; }
};

/** What needs the human's attention about this project's stores, or null. */
export async function storeNotice(root) {
  const key = projectKey(root);
  const from = legacyConfigDir();
  const to = skelStateDir();
  if (path.relative(from, to) !== "") {
    const marker = migratedMarkerStatus(from, key);
    if (marker === "unknown") return `skel can't read ${from}, so it can't tell whether this project's records have moved. It won't read them from ${to} until it can: fix that dir's permissions. Until then, approval checks fail closed.`;
    if (marker === "present") {
      const left = STORE_SUFFIXES.filter((s) => exists(path.join(from, `${key}${s}.json`)));
      if (left.length) {
        const moved = STORE_SUFFIXES.some((s) => s !== ".config-notice" && exists(path.join(to, `${key}${s}.json`)));
        return moved
          ? `${left.length} file(s) for this project remain in ${from}. skel moved this project's records and ignores them (an interrupted move, or an older skel still running). Run \`skel migrate\` to remove them.`
          : `${from} has ${migratedMarker(key)}, which says this project's records moved, but ${to} holds none and ${left.length} file(s) remain in the old dir. If you never migrated, delete that marker to go back to them.`;
      }
    } else if (usesLegacyStore(key)) {
      return `this project's records are still in ${from}. To move them to ${to}: run \`skel install\`, restart Claude Code so it loads the new deny rule, then run \`skel migrate\` outside a fill.`;
    }
  }
  const { installStatus } = await import("./install-status.mjs");
  const install = installStatus(root, to);
  if (install.status !== "stale") return null;
  if (install.why) return `${install.why}, so skel can't tell whether a deny rule covers its state dir (${to}).`;
  return `the settings in ${install.where} have no deny rule for skel's state dir (${to}), where this project's records are written. Run \`skel install\` there and restart Claude Code.`;
}
