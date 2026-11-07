// What `skel status` and the Stop hook tell the human about where a project's
// records are. Loaded only for a project with a skeleton, never by PreToolUse.

import fs from "node:fs";
import path from "node:path";
import { STORE_SUFFIXES, legacyConfigDir, migratedMarker, migratedMarkerStatus, projectKey, receiptAliases, skelStateDir, storePath, usesLegacyStore } from "./state.mjs";

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
        const same = (s) => {
          try { return fs.readFileSync(path.join(from, `${key}${s}.json`)).equals(fs.readFileSync(path.join(to, `${key}${s}.json`))); } catch { return false; }
        };
        const copies = left.filter(same).length;
        const differing = left.filter((s) => !same(s)).map((s) => `${key}${s}.json`);
        return moved
          ? `${left.length} file(s) for this project remain in ${from}, and skel ignores them because its records have moved (an interrupted move, or an older skel still running).${copies ? ` Run \`skel migrate\` to remove the ${copies} that match the state dir.` : ""}${differing.length ? ` ${differing.join(", ")} differ${differing.length === 1 ? "s" : ""} from the state dir, so ${differing.length === 1 ? "it stays" : "they stay"} until you delete ${differing.length === 1 ? "it" : "them"}.` : ""}`
          : `${from} has ${migratedMarker(key)}, which says this project's records moved, but ${to} holds none and ${left.length} file(s) remain in the old dir. If you never migrated, delete that marker to go back to them.`;
      }
    } else if (usesLegacyStore(key)) {
      return `this project's records are still in ${from}. To move them to ${to}: run \`skel install\`, restart Claude Code so it loads the new deny rule, then run \`skel migrate\` outside a fill.`;
    }
  }
  const { installStatus } = await import("./install-status.mjs");
  const install = installStatus(root, to);
  if (install.status !== "stale") return aliasNotice(root);
  if (install.why) return `${install.why}, so skel can't tell whether a deny rule covers its state dir (${to}).`;
  return `the settings in ${install.where} have no deny rule for skel's state dir (${to}), where this project's records are written. Run \`skel install\` there and restart Claude Code.`;
}

/**
 * #55: with no approval record under this spelling of the project's path, one
 * written from another spelling (a case variant or 8.3 alias on WSL's
 * /mnt/c). The hooks honour a proven one; the CLI reads only this spelling's
 * key, and a lookalike that can't be proven is for the human to resolve.
 * `deleted`: the project's .skeleton is gone, so only what the hooks can't
 * decide is worth saying (a proven record already denies, with its reason).
 * Roots are quoted: a record's root is data, not text to show as is.
 */
export function aliasNotice(root, { deleted = false } = {}) {
  if (exists(storePath(root, ".snapshot"))) return null;
  const { verified, unverified } = receiptAliases(root);
  if (verified.length && !deleted) return `this project's approval record (${verified[0]}) was written from another spelling of its path. The hooks protect the project from any spelling, but skel's commands find the record only from that one: run them from the path the project was approved under (the record's "root"), or re-approve from here.`;
  if (unverified.length) return `an approval record names a path like ${JSON.stringify(root)} but can't be proven to be it, so the hooks don't count it: ${unverified.map((u) => `${u.file} names ${JSON.stringify(u.root)}: ${u.why}`).join("; ")}. If it's this project's, restore its .skeleton or re-approve from here, and delete that record; otherwise leave it.`;
  return null;
}
