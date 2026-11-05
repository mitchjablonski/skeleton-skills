// The shapes of skel's trusted records, checked when they are read and when
// they are migrated (lib/migrate.mjs). No imports.

/**
 * The record format. 3: format 2 plus `coverage`, the baselined source set (#37).
 * 2: only the files in `fenced` were recorded without their fence bodies; other
 * tracked files are whole. A record without it (written before #25) dropped
 * every file's fence bodies, and is compared that way.
 */
export const RECORD_FORMAT = 3;
/** Was this record's `files` written with only the `fenced` files losing their bodies? */
export const keepsTrackedWhole = (format) => format === 2 || format === 3;

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
export const validFormat = (format) => format === undefined || keepsTrackedWhole(format);
export const validFenced = (fenced) => fenced === undefined || (Array.isArray(fenced) && fenced.every((f) => typeof f === "string"));
export const validFences = (fences) => fences === undefined || (Array.isArray(fences) &&
  fences.every((f) => isPlain(f) && typeof f.file === "string" && typeof f.id === "string" && typeof f.title === "string"));

const SHA256 = /^[0-9a-f]{64}$/;
/** A baselined member: fenced (compared by exterior), an alias or a whole-file hash, or a link recorded by target. */
const validMember = (m) => isPlain(m) && (m.tracked === undefined || m.tracked === true) && (
  m.fenced === true ||
  (typeof m.link === "string" && typeof m.state === "string") ||
  (typeof m.sha256 === "string" && SHA256.test(m.sha256) && (m.alias === undefined || safeKey(m.alias))));
/** The source set approve baselined: its discovery policy, and members by project-relative path. */
const validIgnoreFiles = (v) => v === undefined || (Array.isArray(v) && v.every((f) => isPlain(f) && typeof f.file === "string" && (f.key === undefined || typeof f.key === "string") && (f.path === undefined || typeof f.path === "string") && (f.sha256 === null || SHA256.test(f.sha256))));
export const validCoverage = (c) => isPlain(c) && Number.isInteger(c.policy) && isPlain(c.discovery) && (c.discovery.mode === "git" || c.discovery.mode === "walk") && validIgnoreFiles(c.discovery.ignoreFiles) &&
  isPlain(c.members) && Object.entries(c.members).every(([rel, m]) => safeKey(rel) && validMember(m)) &&
  (c.trackedAliases === undefined || (isPlain(c.trackedAliases) && Object.entries(c.trackedAliases).every(([rel, m]) => safeKey(rel) && validMember(m) && typeof m.alias === "string")));

/** An approved-skeleton record as approve writes it (callers fail closed on false). */
export function validSnapshot(s) {
  if (!isPlain(s) || !validFiles(s.files)) return false;
  if (s.fences !== undefined && !validFences(s.fences)) return false;
  if (!validFenced(s.fenced) || !validFormat(s.format)) return false;
  // Format 3 is the one format with a baseline: without one it claims coverage it hasn't got, and an older one can't have gained it.
  if (s.format === RECORD_FORMAT ? !validCoverage(s.coverage) : s.coverage !== undefined) return false;
  // Written by approve since approvals were bound to the reviewed version (#15).
  if (s.version !== undefined && !isVersion(s.version)) return false;
  if (s.review !== undefined && s.review !== null && !(isPlain(s.review) && isVersion(s.review.version) && typeof s.review.source === "string" && (s.review.at === null || Number.isFinite(s.review.at)))) return false;
  return true;
}
