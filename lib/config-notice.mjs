import fs from "node:fs";
import { configPath } from "./feedback.mjs";
import { writeFileAtomic } from "./state.mjs";
export const configNoticePath = root => configPath(root, ".config-notice");
export function hasApprovalRecord(root) {
  try { return !!fs.lstatSync(configPath(root, ".snapshot"), { throwIfNoEntry: false }); }
  catch { return true; } // unreadable external record still signals potential enrollment
}
export function recordConfigNotice(root, input = {}) {
  const source = ["user_settings", "project_settings", "local_settings", "policy_settings", "skills", "agents"].includes(input.source) ? input.source : "unknown";
  const file = typeof input.file_path === "string" ? input.file_path.slice(0, 1000).replace(/[\r\n]/g, " ") : "unknown";
  writeFileAtomic(configNoticePath(root), JSON.stringify({ at: new Date().toISOString(), source, file }), 0o600);
}
export function clearConfigNotice(root) { fs.rmSync(configNoticePath(root), { force: true }); }
export function readConfigNotice(root) {
  try {
    const n = JSON.parse(fs.readFileSync(configNoticePath(root), "utf8"));
    if (!n || typeof n.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(n.at) || !Number.isFinite(Date.parse(n.at)) || typeof n.file !== "string" || !["user_settings", "project_settings", "local_settings", "policy_settings", "skills", "agents", "unknown"].includes(n.source)) return null;
    n.file = n.file.slice(0, 1000).replace(/[\x00-\x1f\x7f]/g, " ");
    const owner = String(root).slice(0, 1000).replace(/[\x00-\x1f\x7f]/g, " ");
    return `skel: a settings change was blocked at ${n.at} for ${owner} (source: ${n.source}; file: ${n.file}). This is a historical notice: restarting may have applied settings. Finish or run skel reshape before changing settings, then retry the change; an allowed ConfigChange clears this notice.`;
  } catch { return null; }
}
