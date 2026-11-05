// The reviewable source set (#37, design doc §9 Q2): what `skel approve`
// baselines beyond the skeleton's own files, and what `done` and `finalize` check
// it against. Only those three discover or hash members. `status`, the page and
// the Stop hook stay on the skeleton's own files, so plain-member drift surfaces
// at completion, not per turn. The hook never loads this file.
//
// Membership is the explicit tracks, the fenced files and the source discovery
// finds: `git ls-files` (cached plus untracked non-ignored) when git can answer,
// a pruned walk when it isn't available or this isn't a repo, and a refusal when
// it fails. Failed discovery must never read as a small or empty baseline.
//
// The baseline is coverage, not review. record.version is still what the page
// rendered; a member nobody saw adds nothing to it. describeCoverage says so.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dirResolver } from "./markers.mjs";
import { safeKey } from "./records.mjs";
import { RECORD_FORMAT, aliasDrift, feedNormalized, finishNormalized, readFullSnapshot, verifySnapshot } from "./snapshot.mjs";
import { leavesBase, realpath, skelStoreDirs } from "./state.mjs";

/** Bump when the rules below change: a record made under other rules needs re-approving. */
export const SOURCE_POLICY = 1;

const DIR_RULES = {
  dependency: ["node_modules", "bower_components", "jspm_packages", "vendor", "Pods", ".venv", "venv", "site-packages", ".yarn", ".pnpm-store"],
  build: ["dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".terraform", "DerivedData"],
  cache: ["__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".gradle", ".parcel-cache"],
  generated: ["__generated__", "generated"],
  tool: [".git", ".hg", ".svn", ".skeleton", ".claude", ".deeppairing", ".idea", ".vscode"],
};
const DIR_REASON = new Map(Object.entries(DIR_RULES).flatMap(([reason, names]) => names.map((n) => [n, reason])));

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock", "composer.lock", "gemfile.lock", "podfile.lock", "go.sum", "flake.lock", "mix.lock", "pubspec.lock", "packages.lock.json"]);
const GENERATED_FILE = /\.min\.(js|mjs|css)$|\.map$|\.(generated|gen)\.[^./]+$|\.g\.dart$|\.pb\.(go|h|cc)$|_pb2(_grpc)?\.pyi?$/i;

const SOURCE_EXT = new Set(("js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi ipynb rb php java kt kts scala groovy gradle go rs c h cc cpp cxx hpp hh m mm cs fs vb swift dart lua pl pm r jl ex exs erl hs ml clj nim cr coffee zig sol " +
  "sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto thrift tf hcl html htm css scss sass less xml xsl svg " +
  "json jsonc json5 yaml yml toml ini cfg conf properties md mdx rst").split(" "));
const SOURCE_NAMES = new Set(["makefile", "gnumakefile", "dockerfile", "containerfile", "rakefile", "gemfile", "podfile", "brewfile", "procfile", "justfile", "jenkinsfile", "vagrantfile", "caddyfile", "cmakelists.txt", "requirements.txt", "go.mod", "build", "build.bazel", "workspace", "workspace.bazel",
  ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig", ".npmrc", ".nvmrc", ".babelrc", ".eslintrc", ".prettierrc", ".env.example"]);

/** The discovery policy: why this path is left out, or null for a member. Explicit tracks skip this. */
export function excludedBecause(rel) {
  const segs = rel.split("/");
  const name = segs.pop();
  for (const seg of segs) {
    const reason = DIR_REASON.get(seg) ?? (seg.endsWith(".egg-info") ? "build" : null);
    if (reason) return reason;
  }
  const lower = name.toLowerCase();
  if (LOCKFILES.has(lower)) return "lockfile";
  if (GENERATED_FILE.test(name)) return "generated";
  if (SOURCE_NAMES.has(lower) || lower.startsWith("dockerfile.")) return null;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && SOURCE_EXT.has(lower.slice(dot + 1)) ? null : "unknown-extension";
}

/** Why a set couldn't be discovered or baselined. Callers refuse and print the message. */
const fail = (message) => Object.assign(new Error(message), { code: "SKEL_SOURCE" });
const firstLine = (s) => String(s ?? "").trim().split("\n")[0];

function git(dir, args, timeout = 120_000) {
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.error?.code ?? null };
}

const describeRun = (r) => r.code === "ETIMEDOUT" ? "it timed out" : r.code ? r.code : firstLine(r.stderr) || `exit ${r.status}`;

/** Is any folder from `dir` up a git checkout? Then "not a git repository" means a broken one. */
function underDotGit(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * How to discover under `root`: { mode: "git" } or { mode: "walk", why }. Git
 * being absent, or no repo, or a parent repo that ignores this folder (the same
 * test the fence search uses), selects the walk. Anything else git says (dubious
 * ownership, a broken .git, a timeout) throws: skel can't tell what's ignored.
 */
function gitProbe(root) {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"], 30_000);
  if (inside.code === "ENOENT") return { mode: "walk", why: "git isn't available, so .gitignore isn't applied" };
  if (inside.code || inside.status !== 0) {
    if (!inside.code && /not a git repository/i.test(inside.stderr) && !underDotGit(root)) return { mode: "walk", why: "not a git repository" };
    throw fail(`git can't list this project's source (${describeRun(inside)})`);
  }
  if (inside.stdout.trim() !== "true") return { mode: "walk", why: "not inside a git work tree" };
  const ignored = git(root, ["check-ignore", "-q", "."], 30_000);
  if (ignored.status === 0) return { mode: "walk", why: "the enclosing repository ignores this folder, so .gitignore isn't applied" };
  if (ignored.status !== 1) throw fail(`git can't list this project's source (${describeRun(ignored)})`);
  return { mode: "git" };
}

/** git exits 0 from `ls-files` even when it couldn't open a folder, so a partial answer shows only on stderr. */
const PARTIAL = /could not open directory|unable to access|permission denied/i;

function gitList(dir, args, where) {
  const r = git(dir, ["ls-files", "-z", ...args]);
  if (r.code || r.status !== 0 || PARTIAL.test(r.stderr)) throw fail(`git couldn't list the source in ${where} (${describeRun(r)})`);
  return r.stdout.split("\0").filter(Boolean);
}

function commonDir(dir, where) {
  const r = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 30_000);
  if (r.code || r.status !== 0) throw fail(`git couldn't read the repository in ${where} (${describeRun(r)})`);
  return realpath(r.stdout.trim());
}

const SAMPLES = 5;

/**
 * Find the set's members, without reading any file. `mode` holds a completion
 * check to the way the approval discovered, so losing git can't turn into a
 * walk that flags every ignored file, or a shorter list. `withIgnored` adds what
 * git ignores, for the approval summary (one more listing).
 */
export function discoverSource(root, { mode = null, withIgnored = false } = {}) {
  const probe = mode === "walk" ? { mode: "walk", why: null } : gitProbe(root);
  if (mode === "git" && probe.mode !== "git") throw fail(`this approval discovered source with git, and git can't answer now (${probe.why})`);
  const out = { mode: probe.mode, why: probe.why ?? null, eligible: new Set(), unknown: [], excluded: {}, nested: [], notes: [], ignored: null };
  const count = (reason, rel) => {
    const e = (out.excluded[reason] ??= { count: 0, sample: [] });
    e.count++;
    if (e.sample.length < SAMPLES) e.sample.push(rel);
  };
  // skel's own stores, if XDG_STATE_HOME puts them inside the project: approve writes there.
  const stores = skelStoreDirs().flatMap((d) => [root, realpath(root)].map((base) => path.relative(base, d).split(path.sep).join("/"))).filter((r) => r && !leavesBase(r));
  const add = (rel) => {
    if (stores.some((s) => rel.startsWith(`${s}/`))) { count("tool", rel); return; }
    // A name git or the OS gave us that UTF-8 can't hold would read back as "missing".
    if (rel.includes("�")) throw fail(`${rel}: this path isn't valid UTF-8, so skel can't check it. Rename it or add it to .gitignore, then approve again`);
    const reason = excludedBecause(rel);
    if (reason === "unknown-extension") out.unknown.push(rel);
    else if (reason) count(reason, rel);
    else out.eligible.add(rel);
  };
  if (probe.mode === "git") listGit(root, "", 0, add, count, out, withIgnored);
  else listWalk(root, add, count);
  return out;
}

/** Nested repos and submodules, as the fence search treats them (depth 3, never a worktree of this repo), but a failure throws. */
function listGit(dir, prefix, depth, add, count, out, withIgnored) {
  const where = prefix ? prefix.slice(0, -1) : "the project";
  const nested = [];
  for (const line of gitList(dir, ["-s"], where)) {
    const tab = line.indexOf("\t");
    const p = line.slice(tab + 1);
    if (line.startsWith("160000 ")) nested.push(p);
    else add(prefix + p);
  }
  for (const p of gitList(dir, ["-o", "--exclude-standard"], where)) {
    if (p.endsWith("/")) nested.push(p.slice(0, -1));
    else add(prefix + p);
  }
  if (withIgnored) {
    const ig = git(dir, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"]);
    if (!ig.code && ig.status === 0) {
      out.ignored ??= { count: 0, sample: [] };
      for (const p of ig.stdout.split("\0").filter(Boolean)) {
        out.ignored.count++;
        if (out.ignored.sample.length < SAMPLES) out.ignored.sample.push(prefix + p);
      }
    }
  }
  if (!nested.length) return;
  let ours = null;
  for (const p of nested) {
    const rel = prefix + p;
    const reason = excludedBecause(`${rel}/x.js`);
    if (reason) { count(reason, `${rel}/`); continue; }
    const abs = path.join(dir, p);
    if (!fs.existsSync(path.join(abs, ".git"))) { out.notes.push(`${rel}/: a submodule that isn't checked out, so nothing in it is baselined`); continue; }
    ours ??= commonDir(dir, where);
    if (commonDir(abs, rel) === ours) continue;
    if (depth >= 3) { count("nested-too-deep", `${rel}/`); continue; }
    out.nested.push(rel);
    listGit(abs, `${rel}/`, depth + 1, add, count, out, withIgnored);
  }
}

function listWalk(root, add, count) {
  const stack = [""];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir ? path.join(root, dir) : root, { withFileTypes: true });
    } catch (err) {
      if (dir && err.code === "ENOENT") continue;
      throw fail(`couldn't list ${dir || "the project"} (${err.code ?? err.message})`);
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (!e.isDirectory()) { add(rel); continue; }
      const reason = excludedBecause(`${rel}/x.js`);
      if (reason) count(reason, `${rel}/`);
      else stack.push(rel);
    }
  }
}

/** What's at a project-relative path, using one listing per folder instead of a call per file. */
function looker(root) {
  const dirs = dirResolver(root);
  return (rel) => {
    const abs = path.join(root, rel);
    const parent = dirs.realDir(path.dirname(abs));
    if (!parent) {
      try {
        fs.lstatSync(abs);
        return { kind: "outside" };
      } catch (err) {
        return err.code === "ENOENT" || err.code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable", code: err.code };
      }
    }
    const name = path.basename(abs);
    let ent = dirs.listing(parent)?.get(name);
    if (!ent) {
      try {
        ent = fs.lstatSync(path.join(parent, name));
      } catch (err) {
        return err.code === "ENOENT" || err.code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable", code: err.code };
      }
    }
    const real = path.join(parent, name);
    if (ent.isFile()) return { kind: "file", real };
    if (ent.isSymbolicLink()) return { kind: "link", real };
    return { kind: ent.isDirectory() ? "dir" : "other", real };
  };
}

// Never block on opening a FIFO swapped in after the listing (POSIX only).
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const CHUNK = 256 * 1024;

/**
 * Hash a file of any size without holding it: oversized source is hashed, never
 * skipped. `keep` also returns its bytes, for a file the record holds whole.
 * Line endings are hashed as LF, as the exteriors are compared.
 */
async function hashFile(real, { open, keep = false, maxKeep = Infinity }) {
  let fh;
  try {
    fh = await open(real, OPEN_FLAGS);
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) return { other: true };
    if (keep && st.size > BigInt(Math.min(maxKeep, Number.MAX_SAFE_INTEGER))) return { tooLarge: Number(st.size) };
    const hash = crypto.createHash("sha256");
    const state = { cr: false };
    const kept = [];
    const size = Number(st.size);
    let bytes = 0;
    for (;;) {
      // A small file takes a buffer one byte bigger than it is, so the first read also finds its end.
      const buf = Buffer.allocUnsafe(bytes === 0 ? Math.min(CHUNK, size + 1) : CHUNK);
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      feedNormalized(hash, chunk, state);
      if (keep) kept.push(chunk);
      bytes += bytesRead;
      if (bytesRead < buf.length && bytes >= size) break;
    }
    finishNormalized(hash, state);
    return { sha256: hash.digest("hex"), bytes, id: st.ino ? `${st.dev}:${st.ino}` : null, ...(keep ? { buffer: Buffer.concat(kept) } : {}) };
  } catch (err) {
    return err.code === "ENOENT" || err.code === "ENOTDIR" ? { missing: true } : { error: err.code ?? err.message };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Run fn over items, at most `limit` at a time, keeping their order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
const POOL = 32;

/** The physical file behind a link, if it's a regular one inside the project. */
function linkTarget(root, realRoot, rel) {
  const abs = path.join(root, rel);
  let text = null;
  try { text = fs.readlinkSync(abs); } catch { /* not a link any more: decided below */ }
  let real;
  try {
    real = realpath(abs);
  } catch {
    return { text, state: "dangling" };
  }
  const to = path.relative(realRoot, real);
  if (to !== "" && leavesBase(to)) return { text, state: "outside" };
  let st;
  try { st = fs.statSync(real); } catch { return { text, state: "dangling" }; }
  if (!st.isFile()) return { text, state: st.isDirectory() ? "folder" : "other" };
  return { text, state: "file", real, target: to.split(path.sep).join("/") };
}

const trackRemedy = "Fix or remove it, or take it out of `files` in .skeleton/state.json, then approve again.";
const sourceRemedy = "Fix or remove it, or add it to .gitignore if it isn't source, then approve again.";

/**
 * The baseline, from one discovery and one read of each member. `read` hands
 * recordSkeleton those same bytes, so the record's exteriors and the coverage
 * hashes describe one moment. Throws SKEL_SOURCE naming every member it can't
 * baseline; nothing is written.
 */
export async function captureSourceSet(root, state, fencedFiles, { open = fs.promises.open, maxWholeText = 256 * 1024 * 1024 } = {}) {
  const fenced = new Set(fencedFiles);
  const problems = [];
  const tracks = new Set();
  for (const t of (state.files ?? []).map(String)) {
    if (safeKey(t)) tracks.add(t);
    else problems.push(`${t}: tracked, but it leaves the project. ${trackRemedy}`);
  }
  const found = discoverSource(root, { withIgnored: true });
  const look = looker(root);
  const realRoot = realpath(root);
  const excluded = found.excluded;
  // A link is a member whatever its name says: it's how a swap out of the project would look.
  for (const rel of found.unknown) {
    if (look(rel).kind === "link") found.eligible.add(rel);
    else {
      const e = (excluded["unknown-extension"] ??= { count: 0, sample: [] });
      e.count++;
      if (e.sample.length < SAMPLES) e.sample.push(rel);
    }
  }
  const jobs = new Map(); // rel -> { real, target }
  const members = {};
  const links = [];
  let missing = 0;
  for (const rel of [...new Set([...found.eligible, ...tracks, ...fenced])].sort()) {
    const named = tracks.has(rel) || fenced.has(rel);
    const label = tracks.has(rel) ? "tracked" : fenced.has(rel) ? "fenced" : "source";
    const remedy = tracks.has(rel) ? trackRemedy : sourceRemedy;
    const e = look(rel);
    if (e.kind === "file") { jobs.set(rel, { real: e.real }); continue; }
    if (e.kind === "missing") {
      if (named) problems.push(`${rel}: ${label}, but it doesn't exist. ${remedy}`);
      else missing++; // in git's index, deleted from the work tree: not source now
      continue;
    }
    if (e.kind === "dir" && !named) continue; // a tracked path that's now a folder: its files are listed themselves
    if (e.kind !== "link") {
      problems.push(`${rel}: ${label}, but ${e.kind === "outside" ? "it resolves outside the project" : e.kind === "unreadable" ? `it can't be read (${e.code})` : "it isn't a regular file"}. ${remedy}`);
      continue;
    }
    const to = linkTarget(root, realRoot, rel);
    if (to.state === "file") { jobs.set(rel, { real: to.real, target: to.target }); continue; }
    if (named) {
      problems.push(`${rel}: ${label}, but it's a link ${to.state === "dangling" ? "to nothing" : to.state === "outside" ? "out of the project" : "to something that isn't a regular file"}. ${remedy}`);
      continue;
    }
    members[rel] = { link: to.text ?? "", state: to.state };
    links.push({ file: rel, to: to.text, state: to.state });
  }
  const keepReal = new Set([...jobs].filter(([rel]) => tracks.has(rel) || fenced.has(rel)).map(([, j]) => j.real));
  const reals = [...new Set([...jobs.values()].map((j) => j.real))];
  const hashed = new Map();
  await mapPool(reals, POOL, async (real) => {
    hashed.set(real, await hashFile(real, { open, keep: keepReal.has(real), maxKeep: maxWholeText }));
  });
  // A second name for a step-bearing file can't be held whole: its fence bodies are meant to change.
  const fencedIds = new Map();
  for (const rel of fencedFiles) {
    const j = jobs.get(rel);
    const id = j && hashed.get(j.real)?.id;
    if (id && !fencedIds.has(id)) fencedIds.set(id, rel);
  }
  const texts = new Map();
  let bytes = 0;
  const totals = { fenced: 0, tracked: 0, plain: 0, aliases: 0 };
  for (const [rel, job] of jobs) {
    const r = hashed.get(job.real);
    const named = tracks.has(rel) || fenced.has(rel);
    const remedy = tracks.has(rel) ? trackRemedy : sourceRemedy;
    if (r.missing) {
      if (named) problems.push(`${rel}: it disappeared while being read. ${remedy}`);
      continue;
    }
    if (r.other) { problems.push(`${rel}: it isn't a regular file. ${remedy}`); continue; }
    if (r.tooLarge) { problems.push(`${rel}: it's ${r.tooLarge} bytes, too large to record whole as a tracked file. ${remedy}`); continue; }
    if (r.error) { problems.push(`${rel}: it can't be read (${r.error}). ${remedy}`); continue; }
    if (r.buffer) texts.set(rel, r.buffer);
    bytes += r.bytes;
    const track = tracks.has(rel) ? { tracked: true } : {};
    if (fenced.has(rel)) {
      members[rel] = { fenced: true, ...track };
      totals.fenced++;
      continue;
    }
    const alias = (r.id && fencedIds.get(r.id)) ?? job.target;
    if (alias) {
      members[rel] = { alias, sha256: r.sha256, ...track };
      totals.aliases++;
    } else {
      members[rel] = { sha256: r.sha256, ...track };
      if (tracks.has(rel)) totals.tracked++;
      else totals.plain++;
    }
  }
  if (problems.length) throw fail(`these can't be part of the source baseline:\n  ${problems.join("\n  ")}`);
  const sorted = Object.fromEntries(Object.entries(members).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const coverage = {
    policy: SOURCE_POLICY,
    discovery: { mode: found.mode, why: found.why, nested: found.nested, notes: found.notes },
    id: coverageId(sorted),
    // Tracked names are skeleton files, so the Stop hook follows them too. It doesn't read the member list.
    trackedAliases: Object.fromEntries(Object.entries(sorted).filter(([, m]) => m.tracked && m.alias)),
    excluded,
    ignored: found.ignored,
    missing,
    links,
    totals: { ...totals, links: links.length, bytes },
    members: sorted, // last: writeSnapshot puts it where other readers stop short of it
  };
  return { coverage, read: (rel) => texts.get(rel)?.toString("utf-8") ?? null };
}

/** Names this baseline's membership and hashes. Not the reviewed skeleton version: nobody was shown most of it. */
function coverageId(members) {
  const hash = crypto.createHash("sha256");
  for (const [rel, m] of Object.entries(members)) hash.update(`${rel}\u0000${m.sha256 ?? ""}\u0000${m.alias ?? ""}\u0000${m.link ?? ""}\u0000${m.fenced ? 1 : 0}\n`);
  return hash.digest("hex").slice(0, 12);
}

const listed = ({ count, sample }) => `${count}${sample.length ? ` (${sample.join(", ")}${count > sample.length ? ", …" : ""})` : ""}`;

/** What `skel approve` prints: the counts, the policy and the exclusions, and what a baseline doesn't show. */
export function describeCoverage(cov, shownFiles) {
  const t = cov.totals;
  const parts = [`${t.fenced} fenced (only these leave out their fence bodies)`, `${t.tracked} tracked`, `${t.plain} other source, hashed whole`];
  if (t.aliases) parts.push(`${t.aliases} other name${t.aliases > 1 ? "s" : ""} for a file`);
  if (t.links) parts.push(`${t.links} link${t.links > 1 ? "s" : ""} recorded by target only`);
  const out = [`source baseline ${cov.id} (policy ${cov.policy}, discovered with ${cov.discovery.mode}${cov.discovery.why ? `: ${cov.discovery.why}` : ""}): ${Object.keys(cov.members).length} member(s): ${parts.join(", ")}.`];
  const reasons = Object.keys(cov.excluded).sort().map((r) => `${r} ${listed(cov.excluded[r])}`);
  if (cov.ignored) reasons.unshift(`ignored by git ${listed(cov.ignored)}`);
  if (reasons.length) out.push(`  left out: ${reasons.join("; ")}. \`skel track\` adds any of them.`);
  if (cov.missing) out.push(`  ${cov.missing} file(s) git knows about are deleted from the work tree: not in the baseline.`);
  for (const n of cov.discovery.notes) out.push(`  note: ${n}`);
  for (const l of cov.links) if (l.state === "outside" || l.state === "dangling") out.push(`  warning: ${l.file} is a link ${l.state === "outside" ? "out of the project" : "to nothing"}. Only where it points is recorded, not what's there.`);
  out.push(`  This baseline records what exists now, so \`done\` and \`finalize\` can report changes to it. It isn't proof that every file was shown: the review page showed ${shownFiles} file(s).`);
  return out;
}

const note = (file, text) => ({ file, note: `${text} (it is part of the approved source baseline)` });

/** Changes to the source set since approval: every approved member, and members discovery finds now. */
export async function compareCoverage(root, snap, { open = fs.promises.open } = {}) {
  const cov = snap.coverage;
  const found = discoverSource(root, { mode: cov.discovery.mode });
  const look = looker(root);
  const realRoot = realpath(root);
  const fenced = new Set(Object.entries(cov.members).filter(([, m]) => m.fenced).map(([rel]) => rel));
  const items = [];
  const reads = [];
  for (const [rel, m] of Object.entries(cov.members)) {
    if (m.fenced) continue; // the skeleton's own check, fence bodies left out
    if (m.alias) {
      const why = aliasDrift(root, rel, m, fenced);
      if (why) items.push(note(rel, why));
      continue;
    }
    const e = look(rel);
    if (m.link !== undefined) {
      if (e.kind === "missing") { items.push(note(rel, "deleted")); continue; }
      let text = null;
      try { text = fs.readlinkSync(path.join(root, rel)); } catch { /* not a link now */ }
      if (text !== m.link) items.push(note(rel, text === null ? `was a link to ${m.link}, and isn't now` : `now points to ${text}, not ${m.link}`));
      continue;
    }
    if (e.kind === "file") { reads.push({ rel, real: e.real, sha256: m.sha256 }); continue; }
    if (e.kind === "missing") { items.push(note(rel, "deleted")); continue; }
    if (e.kind === "link") {
      const to = linkTarget(root, realRoot, rel);
      items.push(note(rel, to.state === "outside" ? "now resolves outside the project" : to.state === "dangling" ? "is now a dangling link" : `is now a link to ${to.text}`));
      continue;
    }
    items.push(note(rel, e.kind === "outside" ? "now resolves outside the project" : e.kind === "unreadable" ? `can't be read (${e.code})` : "is no longer a regular file"));
  }
  await mapPool(reads, POOL, async ({ rel, real, sha256 }) => {
    const r = await hashFile(real, { open });
    if (r.missing) items.push(note(rel, "deleted"));
    else if (r.error) items.push(note(rel, `can't be read (${r.error})`));
    else if (r.other) items.push(note(rel, "is no longer a regular file"));
    else if (r.sha256 !== sha256) items.push(note(rel, "changed since approval"));
  });
  const fresh = [...found.eligible, ...found.unknown.filter((rel) => look(rel).kind === "link")];
  for (const rel of fresh) {
    if (cov.members[rel]) continue;
    const e = look(rel);
    if (e.kind === "missing" || e.kind === "dir") continue;
    items.push({ file: rel, note: "new since approval (it isn't in the approved source baseline)" });
  }
  return items.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

const REAPPROVE = "Ask the human to `skel reshape` and approve again; skel won't build a baseline from today's files, since those may already hold the changes it would have to report.";

/** Why this record can't claim source coverage, or null. Worded without "drift": this is about the record. */
export function coverageGap(snap) {
  if (!snap.coverage) return `this approval's record (format ${snap.format ?? 1}) is from before source baselines (current: ${RECORD_FORMAT}), so it covers only the skeleton's own files: it can't tell whether other source was edited, added or deleted. ${REAPPROVE}`;
  if (snap.coverage.policy !== SOURCE_POLICY) return `this approval's source baseline used discovery policy ${snap.coverage.policy}, and this skel uses ${SOURCE_POLICY}, so the two can't be compared. ${REAPPROVE}`;
  return null;
}

const DOC_OR_RULE = /(^|\/)\.(gitignore|gitattributes|dockerignore)$|\.(md|mdx|rst)$/i;

/**
 * For a refusal naming docs or ignore rules: those surprise people, so say that
 * they count and what the way on is. Empty when there are none.
 */
export function completionAdvice(items) {
  const files = [...new Set(items.filter((it) => it.note && DOC_OR_RULE.test(it.file)).map((it) => it.file))];
  if (!files.length) return "";
  return `\n${files.join(", ")}: docs and ignore rules are reviewable source, so they are held to the baseline like code. To edit one during a fill, the human runs \`skel reshape\` and approves again; otherwise revert it.`;
}

/**
 * The check behind `done` and `finalize`. { drift } is the skeleton
 * check, merged with source-set changes when the record has a usable baseline;
 * `gap` says the record can't claim coverage; `failure` says discovery failed,
 * so nothing can be said about new or deleted source.
 */
export async function verifyCompletion(root, state, fencedFiles, opts) {
  const drift = verifySnapshot(root, state, fencedFiles);
  if (drift.reason) return { drift };
  const snap = readFullSnapshot(root);
  // The list is damaged though the head reads: that's no record to compare with.
  if (!snap) return { drift: { ok: false, reason: "the approved skeleton's record can't be read whole", items: [] } };
  const gap = coverageGap(snap);
  if (gap) return { drift, gap };
  let items;
  try {
    items = await compareCoverage(root, snap, opts);
  } catch (err) {
    if (err.code !== "SKEL_SOURCE") throw err;
    return { drift, coverage: snap.coverage, failure: `couldn't rediscover the source set, so new or deleted source can't be ruled out: ${err.message}. Fix that and run this again.` };
  }
  // One report per file: the skeleton check's line diff says more than a hash mismatch.
  const seen = new Set(drift.items.map((it) => it.file));
  const merged = [...drift.items, ...items.filter((it) => !seen.has(it.file))];
  return { drift: { ...drift, ok: merged.length === 0 && drift.ok, items: merged }, coverage: snap.coverage };
}
