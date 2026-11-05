// The shapes of skel's trusted records, checked when they are read and when
// they are migrated (lib/migrate.mjs). No imports.

/**
 * The record format. 2: only the files in `fenced` were recorded without their
 * fence bodies; other tracked files are whole. A record without it (written
 * before #25) dropped every file's fence bodies, and is compared that way.
 */
export const RECORD_FORMAT = 2;

/** How many rendered versions a project keeps. */
export const KEEP_RENDERED = 8;

export const isVersion = (v) => typeof v === "string" && /^[0-9a-f]{12}$/.test(v);
export const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A project-relative file key as recordSkeleton writes it: forward slashes, no
 * `..` segment, not absolute. The records live outside the project, but their
 * keys name files that approve's diff and the Stop hook read and print, so one
 * pointing elsewhere (`../secret.txt`, `/etc/passwd`) is rejected. On Windows
 * a drive prefix (`C:x`) or a backslash would also leave the project; on Linux
 * both are ordinary filename characters (`a:b.ts`, `a\\b`), so they're allowed.
 */
export const safeKey = (rel, platform = process.platform) => typeof rel === "string" && rel !== "" && !rel.includes("\u0000") &&
  !rel.startsWith("/") && !rel.split("/").includes("..") &&
  (platform !== "win32" || (!rel.includes("\\") && !/^[A-Za-z]:/.test(rel)));
/** files: { rel: { sha256, lines: string[] } }, as recordSkeleton writes them. */
export const validFiles = (files) => isPlain(files) && Object.entries(files).every(([rel, e]) => safeKey(rel) &&
  isPlain(e) && typeof e.sha256 === "string" && Array.isArray(e.lines) && e.lines.every((l) => typeof l === "string"));
export const validFormat = (format) => format === undefined || format === RECORD_FORMAT;
export const validFenced = (fenced) => fenced === undefined || (Array.isArray(fenced) && fenced.every((f) => typeof f === "string"));
export const validFences = (fences) => fences === undefined || (Array.isArray(fences) &&
  fences.every((f) => isPlain(f) && typeof f.file === "string" && typeof f.id === "string" && typeof f.title === "string"));

/** An approved-skeleton record as approve writes it (callers fail closed on false). */
export function validSnapshot(s) {
  if (!isPlain(s) || !validFiles(s.files)) return false;
  if (s.fences !== undefined && !validFences(s.fences)) return false;
  if (!validFenced(s.fenced) || !validFormat(s.format)) return false;
  // Written by approve since approvals were bound to the reviewed version (#15).
  if (s.version !== undefined && !isVersion(s.version)) return false;
  if (s.review !== undefined && s.review !== null && !(isPlain(s.review) && isVersion(s.review.version) && typeof s.review.source === "string" && (s.review.at === null || Number.isFinite(s.review.at)))) return false;
  return true;
}
