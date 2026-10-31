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

// `.claude/` holds the installed skills, whose examples contain SKEL fences:
// scanning it would turn documentation into pending steps. All lowercase.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".skeleton", ".claude", ".deeppairing", "dist", "build", "out",
  ".next", ".turbo", "coverage", "__pycache__", ".venv", "venv", "target",
]);
/** Is a project-relative path under one of the directories the scan skips? */
export const inSkippedDir = (rel) => rel.split("/").slice(0, -1).some((seg) => SKIP_DIRS.has(seg));

/**
 * `rel` with each folder that spells a skipped dir in any case (`.Claude`,
 * `build`, `BUILD`) replaced by its spelling on disk. The scan matches on-disk names
 * exactly, so the gate must too: on a filesystem that folds case (macOS,
 * Windows, WSL's /mnt/c, where realpath keeps the caller's spelling) an edit
 * to `.Claude/x` lands in `.claude/`, and one to `build/x` lands in a real
 * `Build/`, which is code. A real `Build/` folder keeps its name,
 * and so does one that doesn't exist yet. Only those segments cost a
 * directory read: ordinary paths don't touch the disk.
 */
export function onDiskRel(root, rel) {
  const segs = rel.split("/");
  let dir = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (SKIP_DIRS.has(segs[i].toLowerCase())) segs[i] = diskName(dir, segs[i]);
    dir = path.join(dir, segs[i]);
  }
  return segs.join("/");
}

/** The entry `seg` reaches in `dir`: itself, or the one case variant the filesystem folds it to. */
function diskName(dir, seg) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return seg; }
  if (entries.includes(seg)) return seg;
  const variants = entries.filter((e) => e.toLowerCase() === seg.toLowerCase());
  if (variants.length !== 1) return seg;
  // Confirm the fold: on a case-sensitive filesystem the typed name doesn't exist.
  try {
    const a = fs.statSync(path.join(dir, seg));
    const b = fs.statSync(path.join(dir, variants[0]));
    return a.dev === b.dev && a.ino === b.ino ? variants[0] : seg;
  } catch {
    return seg;
  }
}

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

/** Is `dir` inside a git work tree that doesn't ignore it? */
function gitTracks(dir) {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore", timeout: 10_000 });
  } catch {
    return false;
  }
  try {
    // exit 0 = ignored by an enclosing repo's .gitignore
    execFileSync("git", ["-C", dir, "check-ignore", "-q", "."], { stdio: "ignore", timeout: 10_000 });
    return false;
  } catch {
    return true;
  }
}

const git = (dir, args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });

/** The repo's shared git directory (the same for all its worktrees). */
function commonDir(dir) {
  try {
    return fs.realpathSync(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  } catch {
    return null;
  }
}

/** git grep over the work tree, recursing into nested repos and submodules (which it won't enter). */
function gitCandidates(root, depth = 0) {
  const exclude = [...SKIP_DIRS].map((d) => `:(exclude,glob)**/${d}/**`);
  let found = [];
  try {
    found = git(root, ["grep", "-l", "-z", "-I", "-F", "--untracked", "-e", "SKEL[", "--", ".", ...exclude])
      .split("\0").filter(Boolean).map((rel) => path.join(root, rel));
  } catch {
    // exit 1 = no match
  }
  if (depth < 3) {
    let nested = [];
    try {
      const untracked = git(root, ["ls-files", "-z", "-o", "--exclude-standard"]).split("\0");
      const submodules = git(root, ["ls-files", "-z", "-s"]).split("\0").filter((l) => l.startsWith("160000 ")).map((l) => l.split("\t")[1]);
      // Submodules, and independent repos nested in the tree — but never a
      // worktree of this same repo (it shares our git dir): its copy of the
      // skeleton isn't ours, and counting its fences would wedge `skel done`.
      const ours = commonDir(root);
      const nestedRepos = untracked.filter((d) => d.endsWith("/"))
        .map((d) => path.join(root, d))
        .filter((d) => !SKIP_DIRS.has(path.basename(d)) && fs.existsSync(path.join(d, ".git")) && commonDir(d) !== ours);
      nested = [...submodules.map((d) => path.join(root, d)), ...nestedRepos];
    } catch { /* ignore */ }
    for (const d of nested) found.push(...gitCandidates(d, depth + 1));
  }
  return found;
}

/**
 * Files that might hold fences. In a git repo, `git grep` does the search: it
 * honours .gitignore, skips binaries and reads in parallel, which matters on
 * slow mounts (WSL's /mnt/c costs ~5ms per file call). Outside one (or when the
 * project sits in a directory its parent repo ignores), a walk that checks the
 * size first, searches raw bytes, and decodes only the files that match.
 */
function candidates(root) {
  if (gitTracks(root)) return gitCandidates(root);
  const out = [];
  for (const abs of walk(root)) {
    try {
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      if (fs.readFileSync(abs).includes(NEEDLE)) out.push(abs);
    } catch { /* unreadable */ }
  }
  return out;
}

/**
 * Which of `rels` (project-relative files) the full search would look in: not
 * under a skipped dir, not a binary, and (in a git repo) not gitignored. Lets
 * `skel serve` poll tracked files for new fences between searches without the
 * page seeing a file the CLI's search never does. A path git can't answer for
 * (inside a nested repo, say) is left to the search.
 */
export function searchable(root, rels) {
  const plain = rels.filter((rel) => !inSkippedDir(rel) && !BINARY_EXT.test(rel));
  if (!plain.length || !gitTracks(root)) return plain;
  const ignored = (list) => {
    try {
      return new Set(execFileSync("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
        input: list.join("\0"), encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"], timeout: 10_000,
      }).split("\0").filter(Boolean));
    } catch (err) {
      if (err.status === 1) return new Set(); // none ignored
      return null;
    }
  };
  const all = ignored(plain);
  if (all) return plain.filter((rel) => !all.has(rel));
  // One unanswerable path fails the batch: ask per file.
  return plain.filter((rel) => ignored([rel])?.size === 0);
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
export function scanFiles(root, absPaths, cache, { maxBytes = MAX_BYTES } = {}) {
  const fences = [];
  const errors = [];
  const files = [];
  const errored = []; // files with malformed markers: callers keep watching them
  for (const abs of absPaths) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > maxBytes) continue;
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
