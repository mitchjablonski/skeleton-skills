// Linux trusted-host capture of an EXPLICIT host-owned manifest, not policy
// enumeration, authority, a frozen workspace, or an atomic multi-file snapshot.
// The host supplies/owns a pinned root directory descriptor and must not close
// or reuse it during this synchronous call. Future publication needs a separate
// freeze/stage protocol: observable metadata checks cannot detect all same-size
// writes. Requires genuine host-controlled procfs at /proc, not a procfs proof.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { scanText } from "./markers.mjs"; // Pure parser only; no scanning/git calls.

export const STRICT_CAPTURE_LIMITS = Object.freeze({ maxFileLines: 32768, maxTotalLines: 131072, maxFiles: 256, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 });
export class StrictCaptureError extends Error {
  constructor(code, relativePath, line, reason) {
    const safe = typeof relativePath === "string" && safePath(relativePath) ? relativePath : undefined;
    const descriptions = {CAPTURE_ROOT:'requires Linux O_DIRECTORY root descriptor',CAPTURE_DUPLICATE:'duplicate capture path',CAPTURE_VALIDATION:'invalid capture path/mode/options',CAPTURE_MARKERS:'malformed marker or no fences',CAPTURE_LINK:'symlink hardlinked or nonregular file',CAPTURE_LIMIT:'capture limit count',CAPTURE_CHANGED:'file changed during capture',CAPTURE_SEPARATOR:'ambiguous separator',CAPTURE_BOM:'BOM unsupported'};
    super(code + ' ' + (descriptions[code] ?? '') + (typeof reason === 'string' && /^[A-Z0-9_]+$/.test(reason) ? ' '+reason : '') + (safe ? `: ${safe}` : "") + (line ? `:${line}` : ""));
    this.name = "StrictCaptureError"; this.code = code;
    if (safe) this.path = safe;
    if (Number.isSafeInteger(line) && line > 0) this.line = line;
    if (typeof reason === "string" && /^[A-Z0-9_]+$/.test(reason)) this.reason = reason;
  }
}
const freeze = Object.freeze;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const safePath = p => typeof p === "string" && p.length > 0 && Buffer.byteLength(p, "utf8") <= 4096
  && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(p) && !p.startsWith("/") && !/^[A-Za-z]:/.test(p)
  && !/[\uD800-\uDFFF]/u.test(p) // Reject unpaired surrogates; valid pairs are one code point under /u.
  && p.split("/").length <= 64 && p.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
function data(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid capture options/manifest entry");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw Error("invalid capture object prototype");
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => !names.includes(k))) throw Error("unexpected capture field");
  const out = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !("value" in d)) throw Error("capture accessors are unsupported");
    out[key] = d.value;
  }
  return out;
}
function limits(value) {
  const options = data(value, Object.keys(STRICT_CAPTURE_LIMITS));
  const out = { ...STRICT_CAPTURE_LIMITS, ...options };
  for (const key of Object.keys(out)) if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > STRICT_CAPTURE_LIMITS[key])
    throw Error(`invalid capture limit ${key}`);
  return out;
}
// Every atom is independently byte-length-prefixed. Counts and domain labels
// distinguish arrays/records, so paths, lines and fence titles cannot blur tuple
// boundaries. All approval identities use the FULL SHA256, never the legacy 12 hex.
function atom(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length); hash.update(bytes);
}
function metadataEqual(a, b) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs", "nlink"].every(k => a[k] === b[k]);
}
function readPinned(rootFd, rel, cap) {
  const opened = [];
  let parent = rootFd;
  try {
    const parts = rel.split("/");
    for (const part of parts.slice(0, -1)) {
      const fd = fs.openSync(`/proc/self/fd/${parent}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      opened.push(fd); parent = fd;
      if (!fs.fstatSync(fd).isDirectory()) throw Error(`not a directory: ${rel}`);
    }
    const leaf = `/proc/self/fd/${parent}/${parts.at(-1)}`;
    // Nonblocking is essential: opening a FIFO must not hang before fstat.
    const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    opened.push(fd);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw Error(`not a regular file: ${rel}`);
    if (before.nlink !== 1n) throw Error(`hardlinked capture file is unsupported: ${rel}`);
    if (before.size > BigInt(cap)) throw Error(`capture byte limit exceeded: ${rel}`);
    const chunks = []; let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, cap + 1 - size));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      size += count;
      if (size > cap) throw Error(`capture byte limit exceeded: ${rel}`);
      chunks.push(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(leaf, { bigint: true });
    if (!metadataEqual(before, after) || BigInt(size) !== before.size || !named.isFile()
      || named.dev !== after.dev || named.ino !== after.ino) throw Error(`file changed during capture: ${rel}`);
    return { bytes: Buffer.concat(chunks, size), unixMode: Number(after.mode & 0o7777n) };
  } finally { for (const fd of opened.reverse()) fs.closeSync(fd); }
}
const markerCandidate = /^\s*(?:\/\/|#|--|;|\/\*|<!--|\{\/\*)\s*\/?SKEL\[/;
function shape(text, rel, mode, lineCap) {
  if (text.startsWith("\uFEFF")) throw new StrictCaptureError("CAPTURE_BOM", rel, 1);
  if (mode === "fenced" && /\r(?!\n)|[\v\f\u0085\u2028\u2029]/u.test(text))
    throw new StrictCaptureError("CAPTURE_SEPARATOR", rel);
  const separator = mode === "whole" ? /\r\n|[\n\r\v\f\u0085\u2028\u2029]/gu : /\r\n|\n/gu;
  let count = 1;
  if (lineCap < 1) throw new StrictCaptureError("CAPTURE_LINE_LIMIT", rel);
  for (const ignored of text.matchAll(separator)) if (++count > lineCap) throw new StrictCaptureError("CAPTURE_LINE_LIMIT", rel);
  const display = []; let start = 0;
  for (const match of text.matchAll(separator)) {
    display.push({ line: display.length + 1, text: text.slice(start, match.index), ending: match[0], kind: "exterior" });
    start = match.index + match[0].length;
  }
  display.push({ line: display.length + 1, text: text.slice(start), ending: "", kind: "exterior" });
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Context/source baseline files are checked whole, even when they contain
  // example or malformed marker text. They never gain editable fence bodies.
  if (mode === "whole") return { exterior: freeze([text]), fences: freeze([]), display: freeze(display.map(freeze)) };
  let parsed;
  try { parsed = scanText(lines.join("\n"), rel); }
  catch (error) {
    const suffix = error.message.startsWith(`${rel}:`) ? error.message.slice(rel.length + 1) : "";
    throw new StrictCaptureError("CAPTURE_MARKERS", rel, Number(/^(\d+):/.exec(suffix)?.[1]) || undefined);
  }
  const markers = new Set(parsed.flatMap(f => [f.openLine, f.closeLine]));
  for (let n = 0; n < lines.length; n++) if (markerCandidate.test(lines[n]) && !markers.has(n + 1))
    throw new StrictCaptureError("CAPTURE_MARKERS", rel, n + 1);
  if (mode === "fenced" && !parsed.length) throw Error(`fenced manifest file has no fences: ${rel}`);
  for (const f of parsed) {
    display[f.openLine - 1].kind = "marker"; display[f.closeLine - 1].kind = "marker";
    for (let n = f.openLine; n < f.closeLine - 1; n++) display[n].kind = "body";
  }
  return { exterior: freeze(display.filter(l => l.kind !== "body").map(l => l.text + l.ending)),
    fences: freeze(parsed.map(f => freeze({ id: f.id, title: f.title, openLine: f.openLine, closeLine: f.closeLine }))), display: freeze(display.map(freeze)) };
}

/** Throws on ANY missing/unreadable/invalid file; never silently drops members.
 * Manifest entries are exactly {path, mode:'fenced'|'whole'}. Limits may only
 * lower defaults. BOM is refused. Shape retains exact exterior line endings.
 * Display lines are host-parsed; raw hashes retain every original byte.
 */
function capture(rootFd, manifest, options = {}) {
  if (process.platform !== "linux") throw Error("strict capture requires Linux descriptor traversal");
  const cap = limits(options);
  if (!Number.isInteger(rootFd) || rootFd < 0 || !fs.fstatSync(rootFd).isDirectory()) throw Error("capture needs a pinned root directory descriptor");
  const flags = /^flags:\s+([0-7]+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${rootFd}`, "utf8"));
  if (!flags || !(parseInt(flags[1], 8) & fs.constants.O_DIRECTORY)) throw Error("capture root descriptor requires O_DIRECTORY");
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > cap.maxFiles) throw Error("invalid capture file count");
  if (Reflect.ownKeys(manifest).length !== manifest.length + 1) throw Error("invalid capture manifest array");
  const entries = [], seen = new Set();
  for (let n = 0; n < manifest.length; n++) {
    const d = Object.getOwnPropertyDescriptor(manifest, String(n));
    if (!d || !d.enumerable || !("value" in d)) throw Error("invalid capture manifest member");
    const entry = data(d.value, ["path", "mode"]);
    if (!safePath(entry.path) || !["whole", "fenced"].includes(entry.mode)) throw Error("invalid capture path/mode");
    if (seen.has(entry.path)) throw new StrictCaptureError("CAPTURE_DUPLICATE");
    seen.add(entry.path); entries.push(entry);
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const shapeHash = createHash("sha256"), captureHash = createHash("sha256"), files = [];
  atom(shapeHash, "skel-strict-shape-v1"); atom(captureHash, "skel-strict-capture-v1");
  atom(shapeHash, entries.length); atom(captureHash, entries.length);
  let totalBytes = 0, totalLines = 0;
  for (const entry of entries) {
    let read;
    try { read = readPinned(rootFd, entry.path, Math.min(cap.maxFileBytes, cap.maxTotalBytes - totalBytes)); }
    catch (error) { throw structured(error, entry.path); }
    const { bytes, unixMode } = read;
    totalBytes += bytes.length;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new StrictCaptureError("CAPTURE_TEXT", entry.path); }
    if (text.includes("\0")) throw new StrictCaptureError("CAPTURE_TEXT", entry.path);
    let content;
    try { content = shape(text, entry.path, entry.mode, Math.min(cap.maxFileLines, cap.maxTotalLines - totalLines)); }
    catch (error) { throw structured(error, entry.path); }
    totalLines += content.display.length;
    for (const hash of [shapeHash, captureHash]) { atom(hash, entry.path); atom(hash, entry.mode); atom(hash, unixMode); }
    atom(shapeHash, content.exterior.length);
    for (const line of content.exterior) atom(shapeHash, line);
    atom(shapeHash, content.fences.length);
    for (const fence of content.fences) { atom(shapeHash, fence.id); atom(shapeHash, fence.title); }
    atom(captureHash, bytes);
    files.push(freeze({ path: entry.path, mode: entry.mode, unixMode, text, byteLength: bytes.length,
      rawSha256: sha(bytes), exterior: content.exterior, fences: content.fences, display: content.display }));
  }
  return freeze({ format: 1, shapeVersion: shapeHash.digest("hex"), captureVersion: captureHash.digest("hex"), totalBytes, files: freeze(files) });
}

function structured(error, relativePath) {
  try { if (error instanceof StrictCaptureError) return error; } catch { return new StrictCaptureError("CAPTURE_VALIDATION"); }
  let message = "", reason;
  try { message = String(error?.message ?? ""); reason = error?.code; } catch {}
  const code = reason === "ENOENT" ? "CAPTURE_MISSING" : ["ELOOP", "ENOTDIR"].includes(reason) ? "CAPTURE_LINK"
    : reason === "CAPTURE_BOM" ? "CAPTURE_BOM" : reason === "CAPTURE_SEPARATOR" ? "CAPTURE_SEPARATOR"
    : /BOM/.test(message) ? "CAPTURE_BOM" : /separator/.test(message) ? "CAPTURE_SEPARATOR"
    : /marker|SKEL|fences/.test(message) ? "CAPTURE_MARKERS"
    : /hardlink|regular file/.test(message) ? "CAPTURE_LINK"
    : /changed during/.test(message) ? "CAPTURE_CHANGED"
    : /limit|count/.test(message) ? "CAPTURE_LIMIT"
    : /UTF|NUL|encoded/.test(message) ? "CAPTURE_TEXT"
    : /root|descriptor|Linux|O_DIRECTORY/.test(message) ? "CAPTURE_ROOT"
    : reason ? "CAPTURE_IO" : "CAPTURE_VALIDATION";
  return new StrictCaptureError(code, relativePath, undefined, reason);
}
export function captureStrictManifest(rootFd, manifest, options = {}) {
  try { return capture(rootFd, manifest, options); }
  catch (error) { throw structured(error); }
}
