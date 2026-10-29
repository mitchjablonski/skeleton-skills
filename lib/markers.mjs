// Fence markers: the skeleton's unit of work.
//
//   // SKEL[2] drop near-duplicate points (< 0.5px apart)
//   throw new Error("SKEL_TODO");
//   // /SKEL[2]
//
// Markers sit on their own line behind any line-comment or block-comment
// prefix, so the same syntax works in TS, Python, SQL, HTML, etc. A step id may
// fence several regions (e.g. the implementation and its test). A fence whose
// body still contains SKEL_TODO is pending; otherwise it is filled. Progress is
// read from the code itself — there is no status file to drift.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TODO_TOKEN = "SKEL_TODO";

const COMMENT = String.raw`(?:\/\/|#|--|;|\/\*|<!--|\{\/\*)`;
const ID = String.raw`([A-Za-z0-9][\w.-]*)`;
const OPEN_RE = new RegExp(String.raw`^\s*${COMMENT}\s*SKEL\[${ID}\]\s*(.*?)\s*(?:\*\/\}?|-->)?\s*$`);
const CLOSE_RE = new RegExp(String.raw`^\s*${COMMENT}\s*\/SKEL\[${ID}\]\s*(?:\*\/\}?|-->)?\s*$`);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".skeleton", ".deeppairing", "dist", "build", "out",
  ".next", ".turbo", "coverage", "__pycache__", ".venv", "venv", "target",
]);
const MAX_BYTES = 1_000_000;

/** Parse one file's text into fences. Throws on malformed nesting. */
export function scanText(text, file = "<text>") {
  const lines = text.split("\n");
  const fences = [];
  let open = null;
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const close = CLOSE_RE.exec(line);
    if (close) {
      if (!open) throw new Error(`${file}:${lineNo}: /SKEL[${close[1]}] closes nothing`);
      if (open.id !== close[1]) {
        throw new Error(`${file}:${lineNo}: /SKEL[${close[1]}] closes SKEL[${open.id}] (opened line ${open.openLine})`);
      }
      const body = lines.slice(open.openLine, lineNo - 1).join("\n");
      fences.push({
        id: open.id,
        title: open.title,
        file,
        openLine: open.openLine,
        closeLine: lineNo,
        body,
        status: body.includes(TODO_TOKEN) ? "todo" : "filled",
      });
      open = null;
      return;
    }
    const m = OPEN_RE.exec(line);
    if (m) {
      if (open) throw new Error(`${file}:${lineNo}: SKEL[${m[1]}] opened inside SKEL[${open.id}] — fences don't nest`);
      open = { id: m[1], title: m[2], openLine: lineNo };
    }
  });
  if (open) throw new Error(`${file}:${open.openLine}: SKEL[${open.id}] is never closed`);
  return fences;
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|flac|mov|avi|mkv|webm|sqlite|db|lock)$/i;
const NEEDLE = Buffer.from("SKEL[");

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
    } else if (e.isFile() && !BINARY_EXT.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

/**
 * Files that might hold fences. In a git repo, `git grep` does the search: it
 * honours .gitignore, skips binaries and reads in parallel, which matters on
 * slow mounts (WSL's /mnt/c costs ~5ms per file call). Elsewhere, a walk that
 * searches raw bytes and decodes only the files that match.
 */
function candidates(root) {
  try {
    const out = execFileSync("git", ["-C", root, "grep", "-l", "-z", "-I", "-F", "--untracked", "-e", "SKEL[", "--", ".",
      ...[...SKIP_DIRS].map((d) => `:(exclude,glob)**/${d}/**`)], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    });
    const found = out.split("\0").filter(Boolean).map((rel) => path.join(root, rel));
    if (found.length) return found;
  } catch {
    // exit 1 = no match; anything else = not a repo. Either way, walk: the
    // project may sit in a directory its parent repo ignores, or contain a
    // nested repo git grep won't enter.
  }
  const out = [];
  for (const abs of walk(root)) {
    try {
      const buf = fs.readFileSync(abs);
      if (buf.length <= MAX_BYTES && buf.includes(NEEDLE)) out.push(abs);
    } catch { /* unreadable */ }
  }
  return out;
}

/**
 * Scan a project for fences. Returns { fences, errors, files }.
 * `cache` (a Map) keeps each file's parse keyed by mtime and size, so a
 * long-running caller (`skel serve`) only re-reads files that changed.
 */
export function scanRepo(root, cache) {
  return scanFiles(root, candidates(root), cache);
}

/** Parse a known set of files (absolute paths). Same result shape as scanRepo. */
export function scanFiles(root, absPaths, cache) {
  const fences = [];
  const errors = [];
  const files = [];
  const errored = []; // files with malformed markers: callers keep watching them
  for (const abs of absPaths) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    let entry = cache?.get(abs);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      let text;
      try { text = fs.readFileSync(abs, "utf-8"); } catch { continue; }
      entry = { mtimeMs: st.mtimeMs, size: st.size, text, fences: null, error: null };
      try { entry.fences = text.includes("SKEL[") ? scanText(text, rel) : []; } catch (err) { entry.error = err.message; }
      cache?.set(abs, entry);
    }
    if (entry.error) { errors.push(entry.error); errored.push(rel); }
    else if (entry.fences.length) { files.push(rel); fences.push(...entry.fences); }
  }
  return { fences, errors, files, errored };
}

const collator = new Intl.Collator(undefined, { numeric: true });

/** Group fences into steps, ordered by id (natural sort: 2 < 10, 2.1 < 2.2). */
export function toSteps(fences) {
  const byId = new Map();
  for (const f of fences) {
    if (!byId.has(f.id)) byId.set(f.id, { id: f.id, title: f.title, fences: [] });
    const step = byId.get(f.id);
    if (!step.title && f.title) step.title = f.title;
    step.fences.push(f);
  }
  const steps = [...byId.values()].sort((a, b) => collator.compare(a.id, b.id));
  for (const s of steps) s.status = s.fences.some((f) => f.status === "todo") ? "todo" : "filled";
  return steps;
}

/** Remove marker lines from text (finalize). Leaves bodies untouched. */
export function stripMarkers(text) {
  return text
    .split("\n")
    .filter((line) => !OPEN_RE.test(line) && !CLOSE_RE.test(line))
    .join("\n");
}
