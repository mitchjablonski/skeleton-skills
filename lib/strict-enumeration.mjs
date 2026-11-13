// Trusted-host Linux prototype, not atomic enumeration, root-membership proof,
// mount proof, containment, or approval. Genuine immutable procfs and descriptor
// ownership are host prerequisites. A freeze/staged tree must span this walk AND
// the later capture pass. Neither matching metadata nor two reads proves that.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { captureStrictManifest, StrictCaptureError } from "./strict-capture.mjs";

export const STRICT_ENUMERATION_POLICY = "all-regular-text-v1";
const EXCLUDED = Object.freeze([".git", "node_modules", ".skeleton"]);
export const STRICT_ENUMERATION_LIMITS = Object.freeze({ maxVisits: 4096, maxFiles: 256, maxDirectories: 256,
  maxDepth: 32, maxOpenHandles: 67, maxNameBytes: 255, maxPathBytes: 4096, maxTotalNameBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxOperations: 32768, maxElapsedMs: 5000 });
export class StrictEnumerationError extends Error {
  constructor(code) { super(code); this.name = "StrictEnumerationError"; this.code = code; }
}
const fail = code => { throw new StrictEnumerationError(code); };
const frozen = Object.freeze;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const same = (a,b) => ["dev","ino","mode","size","mtimeNs","ctimeNs","nlink"].every(key => a[key] === b[key]);
// Equivalent to the former multiline candidate regex, including whitespace
// across line boundaries, without restarting a whitespace scan at every LF.
function markerCandidate(text) {
  const whitespace = /\s/u, newline = /[\r\n\u2028\u2029]/u;
  const comments = ["//", "#", "--", ";", "/*", "<!--", "{/*"];
  let start = 0;
  while (start < text.length) {
    let at = start;
    while (at < text.length && whitespace.test(text[at])) at++;
    if (at === text.length) return false;
    const comment = comments.find(prefix => text.startsWith(prefix, at));
    if (comment) {
      let marker = at + comment.length;
      while (marker < text.length && whitespace.test(text[marker])) marker++;
      if (text[marker] === "/") marker++;
      if (text.startsWith("SKEL[", marker)) return true;
    }
    // Skipped leading whitespace contains no possible comment. Resume at the
    // next line boundary after its first non-whitespace character. Whitespace
    // after a comment is visited at most once here and once by the lookahead.
    while (at < text.length && !newline.test(text[at])) at++;
    start = at + 1;
  }
  return false;
}
function limits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail("ENUM_LIMITS");
  const out = { ...STRICT_ENUMERATION_LIMITS };
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value,key);
    if (!Object.hasOwn(out,key) || !d || !d.enumerable || !("value" in d) || !Number.isSafeInteger(d.value) || d.value < 1 || d.value > out[key]) fail("ENUM_LIMITS");
    out[key] = d.value;
  }
  return out;
}
/** Fixed host policy; no project ignore rules, suffix heuristics or candidates.
 * Returns no partial result on error. Exclusions represent only the named
 * directory root, never inspected or verified contents beneath it.
 */
export function enumerateStrictManifest(rootFd, hostPolicy = STRICT_ENUMERATION_POLICY, lowerableLimits = {}) {
  if (process.platform !== "linux") fail("ENUM_UNSUPPORTED");
  try {
    if (hostPolicy !== STRICT_ENUMERATION_POLICY) fail("ENUM_POLICY");
    const cap = limits(lowerableLimits), started = performance.now();
    let operations = 0, visits = 0, directories = 0, totalNameBytes = 0, inspectedBytes = 0, handles = 1, peakHandles = 1;
    const tick = () => { if (++operations > cap.maxOperations || performance.now() - started > cap.maxElapsedMs) fail("ENUM_BUDGET"); };
    const op = fn => { tick(); return fn(); };
    const acquire = () => { if (++handles > cap.maxOpenHandles) { handles--; fail("ENUM_HANDLES"); } peakHandles = Math.max(handles,peakHandles); };
    if (!Number.isInteger(rootFd) || rootFd < 0) fail("ENUM_ROOT");
    const root = op(() => fs.fstatSync(rootFd,{bigint:true}));
    if (!root.isDirectory()) fail("ENUM_ROOT");
    // fdinfo briefly opens one additional descriptor before traversal begins.
    if (cap.maxOpenHandles < 2) fail("ENUM_HANDLES");
    const flags = /^flags:\s+([0-7]+)$/m.exec(op(() => fs.readFileSync(`/proc/self/fdinfo/${rootFd}`,"utf8")));
    if (!flags || !(parseInt(flags[1],8) & fs.constants.O_DIRECTORY)) fail("ENUM_ROOT");
    const manifest = [], exclusions = [];
    function walk(fd, prefix, depth) {
      if (depth > cap.maxDepth || ++directories > cap.maxDirectories) fail("ENUM_LIMIT");
      const before = op(() => fs.fstatSync(fd,{bigint:true}));
      if (!before.isDirectory() || before.dev !== root.dev) fail("ENUM_DEVICE");
      acquire(); let dir;
      try {
        // Public Node exposes no fdopendir or fs.Dir descriptor identity. The
        // opened stream relies on this genuine procfs reference to our held fd.
        dir = op(() => fs.opendirSync(`/proc/self/fd/${fd}`,{encoding:"buffer",bufferSize:1}));
        const seen = new Set();
        for (;;) {
          const ent = op(() => dir.readSync());
          if (!ent) break;
          if (++visits > cap.maxVisits) fail("ENUM_LIMIT");
          if (!Buffer.isBuffer(ent.name)) fail("ENUM_UNSUPPORTED_NAMES");
          const raw = ent.name;
          totalNameBytes += raw.length;
          if (!raw.length || raw.length > cap.maxNameBytes || totalNameBytes > cap.maxTotalNameBytes) fail("ENUM_NAME_LIMIT");
          let name;
          try { name = decoder.decode(raw); } catch { fail("ENUM_NAME"); }
          if (name === "." || name === ".." || /[\/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || !Buffer.from(name).equals(raw) || seen.has(name)) fail("ENUM_NAME");
          seen.add(name);
          const rel = prefix ? `${prefix}/${name}` : name;
          if (Buffer.byteLength(rel) > cap.maxPathBytes) fail("ENUM_PATH_LIMIT");
          const child = `/proc/self/fd/${fd}/${name}`;
          const named = op(() => fs.lstatSync(child,{bigint:true}));
          if (named.dev !== root.dev) fail("ENUM_DEVICE");
          if (named.isSymbolicLink()) fail("ENUM_TYPE");
          if (named.isDirectory()) {
            if (EXCLUDED.includes(name)) { exclusions.push(frozen({path:rel,reason:"fixed-directory"})); continue; }
            if (depth + 1 > cap.maxDepth) fail("ENUM_LIMIT");
            acquire(); let childFd;
            try {
              childFd = op(() => fs.openSync(child,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW));
              if (!same(named,op(() => fs.fstatSync(childFd,{bigint:true})))) fail("ENUM_CHANGED");
              walk(childFd,rel,depth+1);
              if (!same(named,op(() => fs.lstatSync(child,{bigint:true})))) fail("ENUM_CHANGED");
            } finally { if (childFd !== undefined) fs.closeSync(childFd); handles--; }
          } else {
            if (!named.isFile() || named.nlink !== 1n) fail("ENUM_TYPE");
            if (manifest.length >= cap.maxFiles || named.size > BigInt(cap.maxFileBytes)) fail("ENUM_LIMIT");
            const inspect = mode => {
              if (inspectedBytes + Number(named.size) > cap.maxTotalBytes) fail("ENUM_BYTE_LIMIT");
              acquire();
              try {
                tick();
                let captured;
                try {
                  captured = captureStrictManifest(fd,[{path:name,mode}],{maxFileBytes:cap.maxFileBytes,maxTotalBytes:Math.max(1,cap.maxTotalBytes-inspectedBytes)}).files[0];
                } catch (error) {
                  // Only the parser's typed marker refusal has a proven content
                  // cause. Unknown I/O, missing/changed files and runtime faults
                  // still lose their cause at the conservative outer boundary.
                  if (error instanceof StrictCaptureError && error.code === "CAPTURE_MARKERS") {
                    // A malformed second read must not hide observed drift
                    // since the initial whole-file observation. This is still
                    // a metadata check, not an atomicity or same-tick proof.
                    if (!same(named,op(() => fs.lstatSync(child,{bigint:true})))) fail("ENUM_CHANGED");
                    tick();
                    fail("ENUM_MARKERS");
                  }
                  throw error;
                }
                inspectedBytes += captured.byteLength;
                if (inspectedBytes > cap.maxTotalBytes) fail("ENUM_BYTE_LIMIT");
                return captured;
              } finally { handles--; }
            };
            const whole = inspect("whole");
            let mode = "whole";
            if (markerCandidate(whole.text)) {
              mode = "fenced";
              if (inspect(mode).rawSha256 !== whole.rawSha256) fail("ENUM_CHANGED");
            }
            if (!same(named,op(() => fs.lstatSync(child,{bigint:true})))) fail("ENUM_CHANGED");
            manifest.push(frozen({path:rel,mode}));
          }
        }
        if (!same(before,op(() => fs.fstatSync(fd,{bigint:true})))) fail("ENUM_CHANGED");
      } finally { try { if (dir) dir.closeSync(); } finally { handles--; } }
    }
    walk(rootFd,"",0); tick();
    manifest.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);exclusions.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const policyIdentity = createHash("sha256").update(JSON.stringify({policy:STRICT_ENUMERATION_POLICY,excludedDirectories:EXCLUDED})).digest("hex");
    return frozen({format:1,policy:STRICT_ENUMERATION_POLICY,policyIdentity,manifest:frozen(manifest),exclusions:frozen(exclusions),
      coverage:frozen({visits,files:manifest.length,directories,totalNameBytes,inspectedBytes,operations,peakHandles})});
  } catch (error) { if (error instanceof StrictEnumerationError) throw error; fail("ENUM_UNAVAILABLE"); }
}
