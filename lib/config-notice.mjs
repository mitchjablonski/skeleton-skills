import fs from "node:fs";
import crypto from "node:crypto";
import { storePath, writeFileAtomic } from "./state.mjs";
export const configNoticePath = root => storePath(root, ".config-notice");
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

/** Consume a historical notice once per session; status reads never consume it. */
export function takeConfigNotice(root, sessionId) {
  const notice = readConfigNotice(root);
  if (!notice) return null;
  if (typeof sessionId !== "string" || !sessionId) return notice;
  try {
    const file = configNoticePath(root);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    // Hash session IDs, store at most 32; no session payload or private contents.
    const key = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const delivered = Array.isArray(record.delivered) ? record.delivered.filter(x => typeof x === "string").slice(-32) : [];
    if (delivered.includes(key)) return null;
    record.delivered = [...delivered, key].slice(-32);
    writeFileAtomic(file, JSON.stringify(record), 0o600);
  } catch {} // best effort visibility; never changes the settings decision
  return notice;
}
