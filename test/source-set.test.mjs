// The reviewable source set (#37): what approve baselines, and what done and
// finalize report against it. status and the Stop hook stay out of it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrateProject, planMigration } from "../lib/migrate.mjs";
import { feedNormalized, finishNormalized, readFullSnapshot as readSnapshot, readRendered, readSnapshot as readHead, recordSkeleton, snapshotPath } from "../lib/snapshot.mjs";
import { buildReviewData } from "../lib/review.mjs";
import { SOURCE_POLICY, captureSourceSet, compareCoverage, describeCoverage, discoverSource, excludedBecause, verifyCompletion } from "../lib/source-set.mjs";
import { projectKey, readState } from "../lib/state.mjs";
import { validSnapshot } from "../lib/records.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "skel.mjs");
const STOP = path.join(HERE, "..", "bin", "skel-stop.mjs");

const TEMPS = [];
after(() => {
  for (const d of TEMPS) {
    try { fs.chmodSync(d, 0o700); fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch (err) { console.warn(`left ${d}: ${err.code ?? err.message}`); }
  }
});
const mkTemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TEMPS.push(d); return d; };
process.env.XDG_CONFIG_HOME = mkTemp("skel-config-");
process.env.XDG_STATE_HOME = mkTemp("skel-state-");
process.env.LOCALAPPDATA = mkTemp("skel-localappdata-");

const tmp = (prefix = "skel-src-") => fs.realpathSync(mkTemp(prefix));
const canSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skel-ln-"));
  try { fs.symlinkSync(path.join(d, "x"), path.join(d, "y")); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const POSIX = process.platform !== "win32";
const noLinks = canSymlink ? false : "this user can't create symlinks";
const noPerms = POSIX ? false : "POSIX permissions";

const FENCED = 'export function f() {\n  // SKEL[1] step one\n  throw new Error("SKEL_TODO");\n  // /SKEL[1]\n}\n';
const FILLED = FENCED.replace('throw new Error("SKEL_TODO");', "return 1;");
const PLAIN = "export const plain = 1;\n";

function gitIn(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}

/** A project with a fenced file and an unfenced source file; `git` commits them. */
function project({ git = true, files = {}, ignore = ".skeleton/\ndist/\n*.log\nsecrets/\n" } = {}) {
  const dir = tmp();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  write("src/a.ts", FENCED);
  write("src/plain.ts", PLAIN);
  if (git) write(".gitignore", ignore);
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  if (git) {
    gitIn(dir, "init", "-q");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "base");
  }
  const run = (args, { cwd = dir, env = {} } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf-8", timeout: 60_000, env: { ...process.env, ...env } });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ok = (args, opts) => {
    const r = run(args, opts);
    assert.equal(r.status, 0, `skel ${args.join(" ")}: ${r.out}`);
    return r.out;
  };
  const refused = (args, opts) => {
    const r = run(args, opts);
    assert.notEqual(r.status, 0, `skel ${args.join(" ")} should refuse: ${r.out}`);
    return r.out;
  };
  const stop = (extra = []) => {
    const r = spawnSync(process.execPath, [...extra, STOP], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: "s" }), encoding: "utf-8", timeout: 60_000 });
    return r.stdout;
  };
  ok(["init", "t"]);
  return { dir, write, run, ok, refused, stop, abs: (rel) => path.join(dir, rel) };
}

/** Approved and with step 1 active. */
function filling(opts) {
  const p = project(opts);
  p.ok(["approve"]);
  p.ok(["start", "1"]);
  return p;
}

/** Both completion commands refuse, naming `re`; the step is left active. */
function assertCompletionRefused(p, re) {
  p.write("src/a.ts", FILLED);
  assert.match(p.refused(["done"]), re);
  assert.match(p.refused(["finalize"]), re);
  assert.equal(readState(p.dir).phase, "fill");
  assert.equal(readState(p.dir).activeStep, "1");
}

// ---- the clean path ----

test("a fill inside the fence passes done and finalize, and only the fenced file omits a fence body", () => {
  const p = filling({ files: { "src/empty.ts": "" } });
  const snap = readSnapshot(p.dir);
  assert.equal(snap.format, 3);
  assert.equal(snap.coverage.policy, SOURCE_POLICY);
  assert.deepEqual(snap.coverage.members["src/a.ts"], { fenced: true });
  assert.match(snap.coverage.members["src/plain.ts"].sha256, /^[0-9a-f]{64}$/);
  assert.ok(snap.coverage.members["src/empty.ts"].sha256, "an empty source file is a member");
  assert.ok(snap.coverage.members[".gitignore"], "the ignore rules are a member");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  assert.doesNotMatch(p.ok(["status"]), /!/);
  assert.match(p.ok(["finalize"]), /finalized/);
});

test("approve shows counts, policy, exclusions, and says a baseline isn't proof every file was shown", () => {
  const p = project({ files: { "package-lock.json": "{}", LICENSE: "MIT", "dist/out.js": "ignored", "a.min.js": "x" } });
  p.write("build/out.js", "untracked output"); // a committed one would be source
  const out = p.ok(["approve"]);
  assert.match(out, new RegExp(`source baseline [0-9a-f]{12} \\(policy ${SOURCE_POLICY}, discovered with git\\)`));
  assert.match(out, /1 fenced \(only these leave out their fence bodies\)/);
  assert.match(out, /ignored by git \d+ \(.*dist\//);
  assert.match(out, /build 1 \(build\/out\.js\)/);
  assert.match(out, /lockfile 1 \(package-lock\.json\)/);
  assert.match(out, /generated 1 \(a\.min\.js\)/);
  assert.match(out, /unknown-extension \d+ \(.*LICENSE/);
  assert.match(out, /`skel track` adds any of them/);
  assert.match(out, /isn't proof that every file was shown: the skeleton, which is what the review page shows, holds 1 file\(s\)/);
});

// ---- unfenced edit, add, delete, rename ----

test("an unfenced edit to a source file nobody fenced stops done and finalize; status leaves it to them and says so", () => {
  const p = filling();
  p.write("src/plain.ts", `${PLAIN}export const sneaked = 2;\n`);
  assertCompletionRefused(p, /src\/plain\.ts: changed since approval \(it is part of the approved source baseline\)/);
  // Undoing it clears the report below; status doesn't run this check, and says so.
  const text = p.ok(["status"]);
  assert.doesNotMatch(text, /src\/plain\.ts/);
  assert.match(text, /this checked only the skeleton.s own files: new, deleted or changed files elsewhere are checked against source baseline [0-9a-f]{12} at skel done and skel finalize/);
  const json = JSON.parse(p.ok(["status", "--json"]));
  assert.equal(json.drift.ok, true);
  assert.equal(json.coverage.policy, SOURCE_POLICY);
  assert.equal(json.coverage.fullCheck, "done and finalize");
  // It's a comparison, not a latch.
  p.write("src/plain.ts", PLAIN);
  assert.match(p.ok(["done"]), /STEP 1 done/);
});

test("line endings alone aren't a change, as for exteriors; the hash holds across chunk boundaries", () => {
  const p = filling();
  p.write("src/plain.ts", PLAIN.replace(/\n/g, "\r\n"));
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  const digest = (chunks) => {
    const h = crypto.createHash("sha256");
    const st = { cr: false };
    for (const c of chunks) feedNormalized(h, Buffer.from(c), st);
    finishNormalized(h, st);
    return h.digest("hex");
  };
  assert.equal(digest(["a\r", "\nb"]), digest(["a\nb"]));
  assert.equal(digest(["a\r\n\r\nb"]), digest(["a\n\nb"]));
  assert.notEqual(digest(["a\r", "b"]), digest(["ab"]), "a lone CR is content");
  assert.equal(digest(["a\r", "b"]), digest(["a\rb"]));
  assert.equal(digest(["a\r"]), digest(["a\r"]));
  assert.notEqual(digest(["a\r"]), digest(["a"]));
});

test("a new source file, tracked or untracked by git, stops completion by name", () => {
  const p = filling();
  p.write("src/new.ts", "export const n = 1;\n");
  assertCompletionRefused(p, /src\/new\.ts: new since approval/);
});

test("a new empty source file is new too", () => {
  const p = filling();
  p.write("src/new-empty.ts", "");
  assertCompletionRefused(p, /src\/new-empty\.ts: new since approval/);
});

test("a deleted source file stops completion, even once it's removed from git", () => {
  const p = filling();
  gitIn(p.dir, "rm", "-q", "src/plain.ts");
  assertCompletionRefused(p, /src\/plain\.ts: deleted \(it is part of the approved source baseline\)/);
});

test("a rename reports both names", () => {
  const p = filling();
  fs.renameSync(p.abs("src/plain.ts"), p.abs("src/moved.ts"));
  p.write("src/a.ts", FILLED);
  const out = p.refused(["done"]);
  assert.match(out, /src\/plain\.ts: deleted/);
  assert.match(out, /src\/moved\.ts: new since approval/);
});

// ---- empty, large, ignored-tracked, unknown extension ----

test("editing an empty source file is seen", () => {
  const p = filling({ files: { "src/empty.py": "" } });
  p.write("src/empty.py", "print(1)\n");
  assertCompletionRefused(p, /src\/empty\.py: changed since approval/);
});

test("oversized source is hashed, not omitted: a change at its very end is seen", () => {
  const big = `${"x".repeat(80)}\n`.repeat(40_000); // 3.2 MB: past the search's 1 MB cap and several read chunks
  const p = filling({ files: { "src/big.json": big } });
  assert.ok(readSnapshot(p.dir).coverage.members["src/big.json"].sha256);
  assert.equal(readSnapshot(p.dir).files["src/big.json"], undefined, "not held in the record");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  p.write("src/big.json", `${big}y`);
  assert.match(p.refused(["done"]), /src\/big\.json: changed since approval/);
});

test("a git-tracked file that .gitignore now matches is a member, and so is what skel track names", () => {
  const p = project({ files: { "dist/kept.js": "kept\n", "secrets/plan.ts": "one\n" } });
  gitIn(p.dir, "add", "-f", "dist/kept.js");
  p.write("dist/untracked.js", "output\n");
  p.ok(["track", "secrets/plan.ts"]);
  p.ok(["approve"]);
  const members = readSnapshot(p.dir).coverage.members;
  assert.ok(members["dist/kept.js"], "committed to git: a folder name doesn't take it out");
  assert.equal(members["secrets/plan.ts"].tracked, true);
  assert.equal(members["dist/untracked.js"], undefined);
  p.ok(["start", "1"]);
  p.write("secrets/plan.ts", "two\n");
  assertCompletionRefused(p, /secrets\/plan\.ts/);
});

test("a tracked-in-git file an ignore rule matches is discovered, under a non-excluded folder", () => {
  const p = project({ files: { "notes/kept.ts": "kept\n" }, ignore: ".skeleton/\nnotes/\n" });
  gitIn(p.dir, "add", "-f", "notes/kept.ts");
  p.ok(["approve"]);
  assert.ok(readSnapshot(p.dir).coverage.members["notes/kept.ts"]);
  p.ok(["start", "1"]);
  p.write("notes/kept.ts", "changed\n");
  assertCompletionRefused(p, /notes\/kept\.ts: changed since approval/);
});

test("explicit tracks override every discovery exclusion: ignored, excluded dir, lockfile, unknown extension, empty, large, binary bytes", () => {
  const big = "y".repeat(1_500_000);
  const files = { "dist/x.js": "a\n", "package-lock.json": "{}\n", "tool/run": "#!/bin/sh\n", "out/empty.ts": "", "dist/big.txt": big, "assets/blob.dat": Buffer.from([0xff, 0xfe, 0x00, 0x41]) };
  const p = project({ files });
  p.ok(["track", ...Object.keys(files).map((f) => p.abs(f))], { cwd: p.dir });
  p.ok(["approve"]);
  const m = readSnapshot(p.dir).coverage.members;
  for (const f of Object.keys(files)) assert.equal(m[f]?.tracked, true, f);
  p.ok(["start", "1"]);
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  for (const [f, change] of Object.entries({ "dist/x.js": "b\n", "package-lock.json": "{ }\n", "tool/run": "#!/bin/bash\n", "out/empty.ts": "x", "dist/big.txt": `${big}z` })) {
    const before = fs.readFileSync(p.abs(f));
    p.write(f, change);
    assert.match(p.refused(["done"]), new RegExp(f.replace(/[./]/g, "\\$&")));
    fs.writeFileSync(p.abs(f), before);
  }
  // Two byte patterns that decode to the same text: only the whole-file hash tells them apart.
  p.write("assets/blob.dat", Buffer.from([0xfe, 0xff, 0x00, 0x41]));
  assert.match(p.refused(["done"]), /assets\/blob\.dat: changed since approval/);
});

test("an unknown extension isn't discovered, is counted, and skel track brings it in", () => {
  const p = filling({ files: { "src/data.xyz": "1\n", "src/kept.xyz": "1\n" } });
  assert.match(fs.readFileSync(snapshotPath(p.dir), "utf-8"), /unknown-extension/);
  p.write("src/data.xyz", "2\n");
  p.write("src/fresh.xyz", "new\n");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
});

// ---- exclusions ----

test("ignored output and policy exclusions aren't flagged, new or changed", () => {
  const p = project({ files: { "package-lock.json": "{}\n" } });
  p.write("build/old.js", "1\n");
  p.write("node_modules/x/i.js", "1\n");
  p.ok(["approve"]);
  p.ok(["start", "1"]);
  p.write("dist/out.js", "new output\n");
  p.write("debug.log", "log\n");
  p.write("secrets/ignored-source.ts", "a source name under an ignore rule\n");
  p.write("build/old.js", "2\n");
  p.write("build/new.js", "3\n");
  p.write("__pycache__/m.py", "x\n");
  p.write("package-lock.json", '{"changed":true}\n');
  p.write("node_modules/x/i.js", "2\n");
  p.write("src/app.min.js", "x\n");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
});

test("the policy's rules are explicit", () => {
  const table = {
    "src/a.ts": null, "lib/x.py": null, "Makefile": null, "Dockerfile.dev": null, "package.json": null, ".gitignore": null, "docs/a.md": null, "a.yaml": null, "CMakeLists.txt": null,
    "node_modules/a.js": "dependency", "pkg/vendor/a.go": "dependency", ".venv/a.py": "dependency",
    "dist/a.js": "build", "x/build/a.js": "build", "target/a.rs": "build", "foo.egg-info/x.py": "build",
    "__pycache__/a.py": "cache", ".cache/a.js": "cache",
    "__generated__/a.ts": "generated", "src/a.min.js": "generated", "a.js.map": "generated", "x.pb.go": "generated", "x_pb2.py": "generated", "a.generated.ts": "generated",
    "package-lock.json": "lockfile", "sub/yarn.lock": "lockfile", "Cargo.lock": "lockfile", "go.sum": "lockfile",
    ".git/config": "tool", ".skeleton/a.ts": "tool", ".claude/a.md": "tool",
    "LICENSE": "unknown-extension", "a.png": "unknown-extension", "bin/tool": "unknown-extension", ".env": "unknown-extension",
  };
  for (const [rel, reason] of Object.entries(table)) assert.equal(excludedBecause(rel), reason, rel);
});

// ---- changed ignores ----

test("a later ignore rule doesn't take a member out: edits, deletes and the rule itself are reported", () => {
  const p = filling();
  fs.appendFileSync(p.abs(".gitignore"), "src/plain.ts\n");
  p.write("src/plain.ts", "hidden\n");
  p.write("src/a.ts", FILLED);
  const out = p.refused(["done"]);
  assert.match(out, /src\/plain\.ts: changed since approval/);
  assert.match(out, /\.gitignore: changed since approval/);
});

test("a record written on one line, with no newline to stop at, is read whole", () => {
  const p = filling();
  const snap = readSnapshot(p.dir);
  fs.writeFileSync(snapshotPath(p.dir), JSON.stringify(snap));
  assert.ok(readHead(p.dir).coverage.members["src/plain.ts"]);
});

test("an ignore rule outside the tree (.git/info/exclude) doesn't take a member out either", () => {
  const p = filling();
  fs.appendFileSync(p.abs(".git/info/exclude"), "src/plain.ts\nsrc/hidden.ts\n");
  gitIn(p.dir, "rm", "-q", "--cached", "src/plain.ts");
  fs.rmSync(p.abs("src/plain.ts"));
  assertCompletionRefused(p, /src\/plain\.ts: deleted/);
});

test("an ignore file that ignores itself can't hide new source; one there at approval is a member", () => {
  const p = filling({ files: { "logs/.gitignore": "*\n" } });
  assert.ok(readSnapshot(p.dir).coverage.members["logs/.gitignore"], "a self-ignoring ignore file at approval is baselined");
  p.write("logs/today.log", "noise\n");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/, "what it ignores stays out");
  p.ok(["start", "1", "--force"]);
  p.write("src/.gitignore", "new.ts\n.gitignore\n");
  p.write("src/new.ts", "hidden\n");
  assertCompletionRefused(p, /src\/\.gitignore: new since approval/);
  fs.rmSync(p.abs("src/.gitignore"));
  p.write("logs/.gitignore", "*\n!keep.ts\n");
  assertCompletionRefused(p, /logs\/\.gitignore: changed since approval/);
});

test("the walk's .gitignore reader agrees with git, file by file", () => {
  const all = ["src/a/mytest.ts", "src/mytest.ts", "src/b/c/deep.ts", "t/m/ax/k.ts", "t/ax/k.ts", "x/y.ts", "xay.ts", "tab.ts", "sp.ts", "sp2.ts ", "lead/x.ts",
    "a/b.ts", "a/x/b.ts", "a/x/y/b.ts", "doc/a.ts", "doc/x/a.ts", "keep/one.ts", "keep/two.ts", "q1.ts", "q12.ts", "logs/x.ts", "logs/sub/y.ts", "hash#.ts", "#lit.ts", "!bang.ts", "br[1].ts", "n/outx/z.ts", "outx/z.ts"];
  // Windows can't keep a trailing space in a file name.
  const files = all.filter((f) => POSIX || !f.endsWith(" "));
  const ignore = ["src/**test.ts", "t/**x/*.ts", "x[/]y.ts", "tab.ts\t", "sp.ts   ", "sp2.ts\\ ", "a/**/b.ts", "/doc/*.ts", "keep/*", "!keep/one.ts", "q?.ts", "logs/**", "\\#lit.ts", "\\!bang.ts", "br\\[1].ts", "/outx/", "**/deep.ts"].join("\n");
  const dir = tmp();
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x\n");
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), `${ignore}\n`);
  const walk = discoverSource(dir, { mode: "walk" });
  const ours = new Set([...walk.eligible, ...walk.unknown]);
  gitIn(dir, "init", "-q");
  const theirs = new Set(gitIn(dir, "ls-files", "-z", "-o", "--exclude-standard").split("\0").filter(Boolean));
  const diff = files.filter((f) => ours.has(f) !== theirs.has(f)).map((f) => `${f}: git ${theirs.has(f) ? "keeps" : "ignores"} it, the walk ${ours.has(f) ? "keeps" : "ignores"} it`);
  assert.deepEqual(diff, []);
  // The cases from review, named.
  for (const f of ["src/a/mytest.ts", "t/m/ax/k.ts", "x/y.ts", "tab.ts"]) assert.ok(ours.has(f), f);
});

test("setting core.excludesFile is reported as the setting moving", () => {
  const p = filling();
  const global = path.join(tmp("skel-gi-"), "ignore");
  fs.writeFileSync(global, "*.bak\n");
  gitIn(p.dir, "config", "core.excludesFile", global);
  p.write("src/a.ts", FILLED);
  const out = p.refused(["done"]);
  assert.match(out, new RegExp(`global ignore file: is now ${global.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}, not .*git.ignore`));
  assert.doesNotMatch(out, /global ignore file .*: changed since approval/);
});

test("ignore rules outside the tree are baselined: .git/info/exclude and core.excludesFile", () => {
  const global = path.join(tmp("skel-gi-"), "ignore");
  fs.writeFileSync(global, "*.bak\n");
  const p = project();
  gitIn(p.dir, "config", "core.excludesFile", global);
  p.ok(["approve"]);
  p.ok(["start", "1"]);
  assert.ok(readSnapshot(p.dir).coverage.discovery.ignoreFiles.some((f) => f.file.includes(global) && f.sha256));
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  fs.appendFileSync(p.abs(".git/info/exclude"), "src/sneaky.ts\n");
  p.write("src/sneaky.ts", "hidden\n");
  assertCompletionRefused(p, /\.git\/info\/exclude: changed since approval: it decides which files discovery sees/);
  fs.writeFileSync(p.abs(".git/info/exclude"), fs.readFileSync(p.abs(".git/info/exclude"), "utf-8").replace("src/sneaky.ts\n", ""));
  fs.rmSync(p.abs("src/sneaky.ts"));
  fs.appendFileSync(global, "src/other.ts\n");
  assertCompletionRefused(p, /global ignore file .*ignore: changed since approval/);
});

test("without git, skel applies .gitignore files itself: build output stays out, and new source is still seen", () => {
  const p = project({ git: false, files: { ".gitignore": "out-js/\n*.tmp.ts\n/rooted.ts\n!keep.tmp.ts\n", "sub/.gitignore": "local.ts\n" } });
  p.write("rooted.ts", "ignored at the root only\n");
  p.write("lib/rooted.ts", "not ignored here\n");
  p.write("sub/local.ts", "ignored by the nested file\n");
  p.write("keep.tmp.ts", "re-included\n");
  const out = p.ok(["approve"]);
  assert.match(out, /ignored by git|ignored/);
  const m = readSnapshot(p.dir).coverage.members;
  assert.equal(m["rooted.ts"], undefined);
  assert.ok(m["lib/rooted.ts"]);
  assert.equal(m["sub/local.ts"], undefined);
  assert.ok(m["keep.tmp.ts"], "a negation re-includes");
  assert.ok(m["sub/.gitignore"]);
  p.ok(["start", "1"]);
  p.write("out-js/a.js", "built\n");
  p.write("src/x.tmp.ts", "scratch\n");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  p.write("src/real.ts", "new source\n");
  assert.match(p.refused(["done"]), /src\/real\.ts: new since approval/);
  // A self-ignoring ignore file is still a member here too.
  fs.rmSync(p.abs("src/real.ts"));
  p.write("src/.gitignore", "new.ts\n.gitignore\n");
  p.write("src/new.ts", "hidden\n");
  assert.match(p.refused(["done"]), /src\/\.gitignore: new since approval/);
});

test("folder-name exclusions don't take out what git tracks; untracked output under those names stays out", () => {
  const p = project({ files: { "src/generated/types.ts": "t\n", "lib/vendor/v.go": "package v\n", "tools/build/run.ts": "r\n", "src/out/o.ts": "o\n", "db/schema.prisma": "model A {}\n", "views/page.ejs": "<p>\n" } });
  p.ok(["approve"]);
  const m = readSnapshot(p.dir).coverage.members;
  for (const f of ["src/generated/types.ts", "lib/vendor/v.go", "tools/build/run.ts", "src/out/o.ts", "db/schema.prisma", "views/page.ejs"]) assert.ok(m[f], f);
  p.ok(["start", "1"]);
  p.write("src/generated/new.ts", "codegen output\n");
  p.write("tools/build/new.js", "build output\n");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  p.write("lib/vendor/v.go", "package changed\n");
  assertCompletionRefused(p, /lib\/vendor\/v\.go: changed since approval/);
});

test("a path named like an Object.prototype key is a member like any other", () => {
  const p = project({ git: false });
  // Written one by one: an object literal's `__proto__` key would set its prototype instead.
  p.write("__proto__", "first\n");
  p.write("toString", "x\n");
  p.ok(["track", "__proto__", "toString"]);
  p.ok(["approve"]);
  const text = fs.readFileSync(snapshotPath(p.dir), "utf-8");
  const members = JSON.parse(text).coverage.members;
  assert.ok(Object.hasOwn(members, "__proto__") && members.__proto__.tracked, "an own member, in the record");
  assert.ok(Object.hasOwn(JSON.parse(text).files, "__proto__"), "and in the skeleton record");
  p.ok(["start", "1"]);
  p.write("__proto__", "second\n");
  assertCompletionRefused(p, /__proto__/);
});

test("links named __proto__, toString and constructor: enrolled, and new ones flagged", { skip: noLinks }, () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "a.ts"), "a\n");
  fs.writeFileSync(path.join(outside, "b.ts"), "b\n");
  const p = project();
  fs.symlinkSync(path.join(outside, "a.ts"), p.abs("__proto__"));
  p.ok(["approve"]);
  assert.ok(Object.hasOwn(readSnapshot(p.dir).coverage.members, "__proto__"));
  p.ok(["start", "1"]);
  fs.rmSync(p.abs("__proto__"));
  fs.symlinkSync(path.join(outside, "b.ts"), p.abs("__proto__"));
  assertCompletionRefused(p, /__proto__: now points to/);
  fs.rmSync(p.abs("__proto__"));
  fs.symlinkSync(path.join(outside, "a.ts"), p.abs("__proto__"));
  fs.symlinkSync(path.join(outside, "a.ts"), p.abs("toString"));
  fs.symlinkSync(path.join(outside, "a.ts"), p.abs("constructor"));
  p.write("src/a.ts", FILLED);
  const out = p.refused(["done"]);
  assert.match(out, /toString: new since approval/);
  assert.match(out, /constructor: new since approval/);
});

// ---- links, read failures, non-regular files ----

test("a discovered link out of the project is shown and pinned, never read; retargeting it is named", { skip: noLinks }, () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "secret.ts"), "SECRET-CONTENT\n");
  fs.writeFileSync(path.join(outside, "other.ts"), "other\n");
  const p = project();
  fs.symlinkSync(path.join(outside, "secret.ts"), p.abs("src/out.ts"));
  const out = p.ok(["approve"]);
  assert.match(out, /warning: src\/out\.ts is a link out of the project\. Only where it points is recorded/);
  const m = readSnapshot(p.dir).coverage.members["src/out.ts"];
  assert.equal(m.link, path.join(outside, "secret.ts"));
  assert.equal(m.sha256, undefined);
  assert.doesNotMatch(fs.readFileSync(snapshotPath(p.dir), "utf-8"), /SECRET-CONTENT/);
  p.ok(["start", "1"]);
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  fs.rmSync(p.abs("src/out.ts"));
  fs.symlinkSync(path.join(outside, "other.ts"), p.abs("src/out.ts"));
  assert.match(p.refused(["done"]), /src\/out\.ts: now points to .*other\.ts, not .*secret\.ts/);
});

test("a folder link out of the project with source behind it can't pass unseen", () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "x.ts"), "x\n");
  const p = project();
  fs.symlinkSync(outside, p.abs("shared"), "junction");
  if (POSIX) {
    // git reports a link, whatever its name says: recorded by target, and warned about.
    assert.match(p.ok(["approve"]), /warning: shared is a link out of the project/);
    assert.equal(readSnapshot(p.dir).coverage.members.shared.state, "outside");
  } else {
    // Git for Windows lists the files behind a junction: approval refuses by name.
    assert.match(p.refused(["approve"]), /shared\/x\.ts: source, but it resolves outside the project/);
    assert.equal(readSnapshot(p.dir), null);
  }
});

test("skel's own stores inside the project aren't source", () => {
  const p = project({ ignore: ".skeleton/\n" });
  const env = { env: { XDG_STATE_HOME: p.abs("state"), XDG_CONFIG_HOME: p.abs("config") } };
  p.ok(["approve"], env);
  p.ok(["start", "1"], env);
  assert.ok(fs.readdirSync(p.abs("state/skel")).some((f) => f.endsWith(".snapshot.json")));
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"], env), /STEP 1 done/);
});

test("a member swapped for a link out is named, and the target isn't read", { skip: noLinks }, () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "plain.ts"), PLAIN);
  const p = filling();
  fs.rmSync(p.abs("src/plain.ts"));
  fs.symlinkSync(path.join(outside, "plain.ts"), p.abs("src/plain.ts"));
  assertCompletionRefused(p, /src\/plain\.ts: now resolves outside the project/);
});

test("a member under a folder swapped for a link out is named, on every platform", () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "m.ts"), "m\n");
  const p = filling({ files: { "lib/deep/m.ts": "m\n" } });
  fs.rmSync(p.abs("lib/deep"), { recursive: true });
  fs.symlinkSync(outside, p.abs("lib/deep"), "junction");
  assertCompletionRefused(p, /lib\/deep\/m\.ts: now resolves outside the project/);
});

test("an unreadable member refuses approval by name, and is drift after it", { skip: noPerms }, () => {
  const p = project();
  fs.chmodSync(p.abs("src/plain.ts"), 0o000);
  try {
    const out = p.refused(["approve"]);
    assert.match(out, /can't approve: these can't be part of the source baseline/);
    assert.match(out, /src\/plain\.ts: it can't be read \(EACCES\)/);
    assert.equal(readState(p.dir).phase, "scaffold");
    assert.equal(readSnapshot(p.dir), null);
    fs.chmodSync(p.abs("src/plain.ts"), 0o600);
    p.ok(["approve"]);
    p.ok(["start", "1"]);
    fs.chmodSync(p.abs("src/plain.ts"), 0o000);
    assertCompletionRefused(p, /src\/plain\.ts: can't be read \(EACCES\)/);
  } finally {
    fs.chmodSync(p.abs("src/plain.ts"), 0o600);
  }
});

test("a read failure can't shrink the baseline or pass the check, on any platform", async () => {
  const p = project();
  const eacces = (real, ...rest) => {
    if (real.endsWith("plain.ts")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.promises.open(real, ...rest);
  };
  const state = readState(p.dir);
  await assert.rejects(captureSourceSet(p.dir, state, ["src/a.ts"], { open: eacces }), (err) => err.code === "SKEL_SOURCE" && /src\/plain\.ts: it can't be read \(EACCES\)/.test(err.message));
  p.ok(["approve"]);
  const items = await compareCoverage(p.dir, readSnapshot(p.dir), { open: eacces });
  assert.deepEqual(items.map((i) => i.file), ["src/plain.ts"]);
  assert.match(items[0].note, /can't be read \(EACCES\)/);
  const result = await verifyCompletion(p.dir, readState(p.dir), ["src/a.ts"], { open: eacces });
  assert.equal(result.drift.ok, false);
});

test("a member replaced by a folder isn't passed over", () => {
  const p = filling({ git: false });
  fs.rmSync(p.abs("src/plain.ts"));
  fs.mkdirSync(p.abs("src/plain.ts"));
  assertCompletionRefused(p, /src\/plain\.ts: is no longer a regular file/);
});

test("a FIFO with a source name refuses approval in a walk, and a read never blocks on it", { skip: noPerms }, () => {
  const p = project({ git: false });
  execFileSync("mkfifo", [p.abs("src/pipe.ts")]);
  assert.match(p.refused(["approve"]), /src\/pipe\.ts: source, but it isn't a regular file/);
});

// ---- tracks that aren't there ----

test("a track that doesn't exist or leaves the project refuses approval: it isn't dropped", () => {
  const p = project({ files: { "src/types.ts": "t\n" } });
  p.ok(["track", "src/types.ts"]);
  fs.rmSync(p.abs("src/types.ts"));
  assert.match(p.refused(["approve"]), /src\/types\.ts: tracked, but it doesn't exist/);
  const state = JSON.parse(fs.readFileSync(p.abs(".skeleton/state.json"), "utf-8"));
  fs.writeFileSync(p.abs(".skeleton/state.json"), JSON.stringify({ ...state, files: ["../elsewhere.ts"] }));
  assert.match(p.refused(["approve"]), /\.\.\/elsewhere\.ts: tracked, but it leaves the project/);
  fs.writeFileSync(p.abs(".skeleton/state.json"), JSON.stringify({ ...state, files: ["src"] }));
  assert.match(p.refused(["approve"]), /src: tracked, but it isn't a regular file/);
  fs.writeFileSync(p.abs(".skeleton/state.json"), JSON.stringify({ ...state, files: [] }));
  p.ok(["approve"]);
});

test("a track that's a link out of the project refuses approval", { skip: noLinks }, () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "x.ts"), "x\n");
  const p = project();
  fs.symlinkSync(path.join(outside, "x.ts"), p.abs("src/x.ts"));
  const state = JSON.parse(fs.readFileSync(p.abs(".skeleton/state.json"), "utf-8"));
  fs.writeFileSync(p.abs(".skeleton/state.json"), JSON.stringify({ ...state, files: ["src/x.ts"] }));
  assert.match(p.refused(["approve"]), /src\/x\.ts: tracked, but it's a link out of the project/);
});

test("a track too large to hold whole refuses by name, and tells the human how out", async () => {
  const p = project({ files: { "dist/huge.txt": "z".repeat(4096) } });
  p.ok(["track", "dist/huge.txt"]);
  await assert.rejects(captureSourceSet(p.dir, readState(p.dir), ["src/a.ts"], { maxWholeText: 1024 }), /dist\/huge\.txt: it's 4096 bytes, too large to record whole as a tracked file\. .*state\.json/);
});

// ---- physical aliases ----

test("run through a linked project path, the baseline keeps the project's names and isn't read as outside", () => {
  const p = project();
  const link = path.join(tmp("skel-via-"), "via");
  fs.symlinkSync(p.dir, link, "junction");
  const cwd = { cwd: link };
  p.ok(["approve"], cwd);
  const snap = readSnapshot(p.dir);
  assert.ok(snap.coverage.members["src/plain.ts"].sha256);
  assert.equal(snap.coverage.links.length, 0);
  p.ok(["start", "1"], cwd);
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"], cwd), /STEP 1 done/);
  assert.equal(p.stop(), "");
  p.ok(["start", "1", "--force"], cwd);
  p.write("src/plain.ts", "edited\n");
  assert.match(p.refused(["done"], cwd), /src\/plain\.ts: changed since approval/);
  assert.doesNotMatch(p.run(["status"], cwd).out, /outside the project/);
});

test("a discovered link to the fenced file doesn't freeze its fence body, and retargeting it is named", { skip: noLinks }, () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "x.ts"), "x\n");
  const p = project();
  fs.symlinkSync("a.ts", p.abs("src/alias.ts"));
  p.ok(["approve"]);
  assert.equal(readSnapshot(p.dir).coverage.members["src/alias.ts"].alias, "src/a.ts");
  p.ok(["start", "1"]);
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  fs.rmSync(p.abs("src/alias.ts"));
  fs.symlinkSync(path.join(outside, "x.ts"), p.abs("src/alias.ts"));
  assert.match(p.refused(["done"]), /src\/alias\.ts: now resolves outside the project/);
  fs.rmSync(p.abs("src/alias.ts"));
  fs.symlinkSync("plain.ts", p.abs("src/alias.ts"));
  assert.match(p.refused(["done"]), /src\/alias\.ts: now points to src\/plain\.ts, not src\/a\.ts/);
});

test("an in-root alias with an explicit track: the fill passes, the page's version matches, and an outside retarget is named by done and Stop", { skip: noLinks }, () => {
  const outside = tmp("skel-out-");
  fs.writeFileSync(path.join(outside, "x.ts"), "x\n");
  const p = project();
  fs.symlinkSync("a.ts", p.abs("src/alias.ts"));
  p.ok(["track", "src/alias.ts"]);
  const page = buildReviewData(p.dir, readState(p.dir));
  const out = p.ok(["approve", "--reviewed", page.skeletonVersion]);
  assert.match(out, /skeleton approved/);
  const snap = readSnapshot(p.dir);
  assert.equal(snap.version, page.skeletonVersion);
  assert.equal(snap.files["src/alias.ts"], undefined, "held under the fenced name, not whole under this one");
  assert.deepEqual(snap.coverage.members["src/alias.ts"].alias, "src/a.ts");
  p.ok(["start", "1"]);
  p.write("src/a.ts", FILLED);
  assert.equal(p.stop(), "", "Stop: a filled body isn't drift through the alias");
  assert.doesNotMatch(p.ok(["status"]), /has fences|drift/);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  fs.rmSync(p.abs("src/alias.ts"));
  fs.symlinkSync(path.join(outside, "x.ts"), p.abs("src/alias.ts"));
  assert.match(p.refused(["done"]), /src\/alias\.ts: now resolves outside the project/);
  assert.match(JSON.parse(p.stop()).systemMessage, /src\/alias\.ts: now resolves outside the project/);
});

test("a hard link to the fenced file, tracked: the fill passes in place, and a changed copy is named", () => {
  const p = project({ files: { "secrets/copy.ts": "placeholder" } });
  fs.rmSync(p.abs("secrets/copy.ts"));
  fs.linkSync(p.abs("src/a.ts"), p.abs("secrets/copy.ts"));
  p.ok(["track", "secrets/copy.ts"]);
  p.ok(["approve"]);
  assert.equal(readSnapshot(p.dir).coverage.members["secrets/copy.ts"].alias, "src/a.ts");
  p.ok(["start", "1"]);
  p.write("src/a.ts", FILLED); // in place: the second name sees the fill too
  assert.equal(fs.readFileSync(p.abs("secrets/copy.ts"), "utf-8"), FILLED);
  assert.equal(p.stop(), "");
  assert.match(p.ok(["done"]), /STEP 1 done/);
  // An atomic save breaks the link. The second name is then its own file, held to its approved text.
  p.ok(["start", "1", "--force"]);
  fs.rmSync(p.abs("secrets/copy.ts"));
  fs.writeFileSync(p.abs("secrets/copy.ts"), FENCED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  fs.writeFileSync(p.abs("secrets/copy.ts"), "something else\n");
  assert.match(p.refused(["done"]), /secrets\/copy\.ts: changed since approval/);
});

test("a link to a file discovery leaves out still holds the approved content", { skip: noLinks }, () => {
  const p = project({ files: { "dist/gen.js": "generated\n" } });
  fs.symlinkSync("../dist/gen.js", p.abs("src/gen.js"));
  p.ok(["approve"]);
  assert.equal(readSnapshot(p.dir).coverage.members["src/gen.js"].alias, "dist/gen.js");
  p.ok(["start", "1"]);
  p.write("dist/gen.js", "regenerated\n");
  assertCompletionRefused(p, /src\/gen\.js: changed since approval/);
});

// ---- failed discovery ----

test("a broken .git refuses approval: it doesn't become a walk or an empty baseline", () => {
  const p = project();
  fs.rmSync(p.abs(".git"), { recursive: true, force: true });
  fs.writeFileSync(p.abs(".git"), "gitdir: /nowhere/at/all\n");
  const out = p.refused(["approve"]);
  assert.match(out, /can't approve: git can't list this project's source/);
  assert.equal(readState(p.dir).phase, "scaffold");
  assert.equal(readSnapshot(p.dir), null);
});

test("a nested repo whose listing fails refuses approval by name, and doesn't shrink the baseline", () => {
  const p = project({ ignore: ".skeleton/\n" });
  const nested = p.abs("sub");
  fs.mkdirSync(nested);
  gitIn(nested, "init", "-q");
  fs.writeFileSync(path.join(nested, "n.ts"), "n\n");
  gitIn(nested, "add", "-A");
  gitIn(nested, "commit", "-qm", "n");
  fs.writeFileSync(path.join(nested, ".git", "index"), "garbage");
  assert.match(p.refused(["approve"]), /can't approve: git couldn't list the source in sub/);
  assert.equal(readSnapshot(p.dir), null);
  assert.equal(readState(p.dir).phase, "scaffold");
});

test("a nested repo's files are members; a worktree of this repo isn't, and an unchecked-out submodule is noted", () => {
  const p = project({ ignore: ".skeleton/\n" });
  const nested = p.abs("sub");
  fs.mkdirSync(nested);
  gitIn(nested, "init", "-q");
  fs.writeFileSync(path.join(nested, "n.ts"), "n\n");
  gitIn(nested, "add", "-A");
  gitIn(nested, "commit", "-qm", "n");
  gitIn(p.dir, "worktree", "add", "-q", p.abs("wt"));
  fs.writeFileSync(p.abs("wt/only-here.ts"), "w\n");
  p.ok(["approve"]);
  const snap = readSnapshot(p.dir);
  assert.ok(snap.coverage.members["sub/n.ts"], "nested repo member");
  assert.deepEqual(snap.coverage.discovery.nested, ["sub"]);
  assert.equal(snap.coverage.members["wt/only-here.ts"], undefined);
  assert.equal(snap.coverage.members["wt/src/plain.ts"], undefined);
  p.ok(["start", "1"]);
  fs.writeFileSync(path.join(nested, "n.ts"), "changed\n");
  assertCompletionRefused(p, /sub\/n\.ts: changed since approval/);
  fs.writeFileSync(path.join(nested, "n.ts"), "n\n");
  fs.writeFileSync(path.join(nested, ".git", "index"), "garbage");
  // A completion check that can't rediscover can't pass.
  assertCompletionRefused(p, /couldn't rediscover the source set.*git couldn't list the source in sub/s);
});

test("a discovery that fails at completion refuses", () => {
  const p = filling();
  fs.writeFileSync(p.abs(".git/index"), "garbage");
  assertCompletionRefused(p, /couldn't rediscover the source set, so new or deleted source can't be ruled out/);
});

test("status does no discovery and hashes no member; only done and finalize do", () => {
  const p = filling();
  const listing = (s) => s.read().split("\n").filter((l) => l.startsWith("spawn") && l.includes("core.fsmonitor=false"));
  const s = spy(tmp("skel-spy-"));
  const r = spawnSync(process.execPath, [...s.args, BIN, "status"], { cwd: p.dir, encoding: "utf-8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listing(s), []);
  assert.doesNotMatch(s.read(), /plain\.ts/);
  p.write("src/a.ts", FILLED);
  const d = spy(tmp("skel-spy-"));
  const done = spawnSync(process.execPath, [...d.args, BIN, "done"], { cwd: p.dir, encoding: "utf-8", timeout: 60_000 });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(listing(d).length > 0, "done rediscovers");
});

test("a doc or ignore-rule change is refused in words a human can act on", () => {
  const p = filling({ files: { "docs/guide.md": "# guide\n" } });
  p.write("docs/guide.md", "# guide, edited\n");
  fs.appendFileSync(p.abs(".gitignore"), "more/\n");
  p.write("src/a.ts", FILLED);
  const out = p.refused(["done"]);
  assert.match(out, /docs\/guide\.md: changed since approval/);
  assert.match(out, /\.gitignore: changed since approval/);
  assert.match(out, /\.gitignore, docs\/guide\.md: docs and ignore rules are reviewable source, so they are held to the baseline like code\. To edit one during a fill, the human runs `skel reshape` and approves again; otherwise revert it\./);
  assert.match(p.refused(["finalize"]), /docs and ignore rules are reviewable source/);
  // Code alone doesn't get that paragraph.
  p.write("docs/guide.md", "# guide\n");
  fs.writeFileSync(p.abs(".gitignore"), ".skeleton/\ndist/\n*.log\nsecrets/\n");
  p.write("src/plain.ts", "edited\n");
  assert.doesNotMatch(p.refused(["done"]), /docs and ignore rules/);
});

test("every validator parses the record whole: a damaged member list fails migrate too", () => {
  const p = filling();
  const key = projectKey(p.dir);
  const from = tmp("skel-from-");
  const text = fs.readFileSync(snapshotPath(p.dir), "utf-8");
  assert.deepEqual(Object.keys(JSON.parse(text).coverage.members).sort(), Object.keys(readSnapshot(p.dir).coverage.members).sort());
  fs.writeFileSync(path.join(from, `${key}.snapshot.json`), text.slice(0, -10));
  const plan = planMigration({ key, from, to: path.join(tmp("skel-to-"), "skel"), keyOf: projectKey });
  assert.equal(plan.problems[0].kind, "corrupt");
});

test("git going away after a git-based approval is a failure, not a walk", () => {
  const p = filling();
  p.write("src/a.ts", FILLED);
  const noGit = { env: { PATH: tmp("skel-nogit-"), Path: tmp("skel-nogit-") } };
  assert.match(p.refused(["done"], noGit), /this approval discovered source with git, and git can't answer now/);
});

test("git absent at approval falls back to the walk, says so, and applies the same exclusions", () => {
  const p = project({ files: { "dist/o.js": "1\n", "node_modules/x/i.js": "1\n" } });
  const empty = tmp("skel-nogit-");
  const noGit = { env: { PATH: empty, Path: empty } };
  const out = p.ok(["approve"], noGit);
  assert.match(out, /discovered with walk: git isn't available, so skel applies the \.gitignore files itself/);
  const m = readSnapshot(p.dir).coverage.members;
  assert.ok(m["src/plain.ts"]);
  assert.equal(m["dist/o.js"], undefined);
  assert.equal(m["node_modules/x/i.js"], undefined);
  assert.equal(readSnapshot(p.dir).coverage.discovery.mode, "walk");
});

test("git exiting 0 with a folder it couldn't open is a failed discovery", { skip: noPerms }, () => {
  const p = project({ files: { "src/locked/x.ts": "x\n" }, ignore: ".skeleton/\n" });
  fs.writeFileSync(p.abs("src/untracked.ts"), "u\n");
  fs.mkdirSync(p.abs("hidden"));
  fs.writeFileSync(p.abs("hidden/new.ts"), "n\n");
  fs.chmodSync(p.abs("hidden"), 0o000);
  try {
    assert.match(p.refused(["approve"]), /can't approve: git couldn't list the source in the project/);
    assert.equal(readSnapshot(p.dir), null);
  } finally {
    fs.chmodSync(p.abs("hidden"), 0o700);
  }
});

test("a walk that can't read a folder refuses too", { skip: noPerms }, () => {
  const p = project({ git: false, files: { "hidden/x.ts": "x\n" } });
  fs.chmodSync(p.abs("hidden"), 0o000);
  try {
    assert.match(p.refused(["approve"]), /can't approve: couldn't list hidden \(EACCES\)/);
    assert.equal(readSnapshot(p.dir), null);
  } finally {
    fs.chmodSync(p.abs("hidden"), 0o700);
  }
});

test("a path that isn't UTF-8 refuses rather than reading back as missing", { skip: process.platform === "linux" ? false : "only Linux keeps raw bytes in names" }, () => {
  const p = project({ git: false });
  fs.writeFileSync(Buffer.concat([Buffer.from(`${p.abs("src")}/bad-`), Buffer.from([0xff, 0xfe]), Buffer.from(".ts")]), "x\n");
  assert.match(p.refused(["approve"]), /isn't valid UTF-8/);
});

test("a project in a subfolder of a repo baselines its own files, under the repo's ignore rules", () => {
  const dir = tmp();
  gitIn(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".skeleton/\n*.tmp.ts\n");
  fs.writeFileSync(path.join(dir, "above.ts"), "not this project\n");
  const sub = path.join(dir, "pkg");
  fs.mkdirSync(path.join(sub, "src"), { recursive: true });
  fs.writeFileSync(path.join(sub, "src", "a.ts"), FENCED);
  fs.writeFileSync(path.join(sub, "src", "b.ts"), PLAIN);
  fs.writeFileSync(path.join(sub, "src", "c.tmp.ts"), "ignored\n");
  const run = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: sub, encoding: "utf-8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
  };
  run("init", "t");
  run("approve");
  assert.deepEqual(Object.keys(readSnapshot(sub).coverage.members), ["src/a.ts", "src/b.ts"]);
});

// ---- the walk ----

test("without git: edit, add and delete are seen, and the walk prunes what the policy excludes", () => {
  const p = filling({ git: false, files: { "node_modules/x/i.js": "1\n", "dist/o.js": "1\n" } });
  assert.equal(readSnapshot(p.dir).coverage.discovery.mode, "walk");
  assert.equal(readSnapshot(p.dir).coverage.members["dist/o.js"], undefined);
  p.write("dist/new.js", "2\n");
  p.write("node_modules/x/i.js", "2\n");
  p.write("src/a.ts", FILLED);
  assert.match(p.ok(["done"]), /STEP 1 done/);
  p.ok(["start", "1", "--force"]);
  p.write("src/plain.ts", "edited\n");
  p.write("src/new.ts", "n\n");
  fs.writeFileSync(p.abs("src/plain2.ts"), "x");
  const out = p.refused(["done"]);
  assert.match(out, /src\/plain\.ts: changed since approval/);
  assert.match(out, /src\/new\.ts: new since approval/);
  fs.rmSync(p.abs("src/plain.ts"));
  assert.match(p.refused(["finalize"]), /src\/plain\.ts: deleted/);
});

// ---- Stop ----

/** A preload recording what the Stop hook does: processes it starts, folders it lists, files it opens. */
function spy(logDir) {
  const file = path.join(logDir, "spy.mjs");
  const log = path.join(logDir, "calls.log");
  fs.writeFileSync(file, `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.appendFileSync;
const note = (kind, what) => write(${JSON.stringify(log)}, kind + " " + String(what) + "\\n");
for (const name of ["execFileSync", "execSync", "spawnSync", "execFile", "exec", "spawn", "fork"]) {
  const real = cp[name];
  cp[name] = function (cmd, args) { note("spawn", cmd + " " + (Array.isArray(args) ? args.join(" ") : "")); return real.apply(this, arguments); };
}
for (const name of ["readdirSync", "opendirSync"]) {
  const real = fs[name];
  fs[name] = function (dir) { note("list", dir); return real.apply(this, arguments); };
}
for (const name of ["readFileSync", "openSync"]) {
  const real = fs[name];
  fs[name] = function (target) { if (typeof target === "string") note("read", target); return real.apply(this, arguments); };
}
const open = fs.promises.open;
fs.promises.open = function (target) { note("read", target); return open.apply(this, arguments); };
syncBuiltinESMExports();
`);
  return { args: ["--import", pathToFileURL(file).href], read: () => { try { return fs.readFileSync(log, "utf-8"); } catch { return ""; } }, log };
}

test("Stop does no discovery: no process, no listing in the project, no read of a plain member", () => {
  const p = filling({ files: { "src/tracked.ts": "t\n" } });
  // Re-approve with a track, so the approved set holds one of each kind.
  p.ok(["reshape"]);
  p.ok(["track", "src/tracked.ts"]);
  p.ok(["approve"]);
  p.ok(["start", "1"]);
  const s = spy(tmp("skel-spy-"));
  assert.equal(p.stop(s.args), "", "clean");
  const calls = s.read();
  assert.ok(calls.includes("src"), "the spy saw the hook's reads");
  assert.doesNotMatch(calls, /^spawn /m, `no process: ${calls}`);
  const lists = calls.split("\n").filter((l) => l.startsWith("list ")).map((l) => l.slice(5));
  for (const dir of lists) assert.ok(!path.resolve(dir).startsWith(p.dir), `listed ${dir}`);
  assert.match(calls, /a\.ts/);
  assert.match(calls, /tracked\.ts/);
  assert.doesNotMatch(calls, /plain\.ts/);
  // The hook's module graph has no way to the discovery code.
  for (const f of ["stop.mjs", "snapshot.mjs", "hook.mjs", "records.mjs", "state.mjs"]) assert.doesNotMatch(fs.readFileSync(path.join(HERE, "..", "lib", f), "utf-8"), /source-set\.mjs"/, f);
  // What it isn't checking waits for done, which reports it.
  p.write("src/plain.ts", "edited\n");
  p.write("src/new.ts", "n\n");
  fs.rmSync(p.abs("src/tracked.ts"));
  assert.match(JSON.parse(p.stop()).systemMessage, /src\/tracked\.ts: deleted/);
  p.write("src/tracked.ts", "t\n");
  assert.equal(p.stop(), "", "Stop stays on the skeleton's own files");
  assertCompletionRefused(p, /src\/plain\.ts: changed since approval/);
});

test("the hot readers stop before the member list, and a damaged list fails closed where it's used", () => {
  const p = filling();
  const text = fs.readFileSync(snapshotPath(p.dir), "utf-8");
  assert.ok(JSON.parse(text).coverage.members["src/plain.ts"], "one JSON document, member list included");
  assert.equal(text.split("\n").length, 2);
  const head = readHead(p.dir);
  assert.deepEqual(head.coverage.members, {});
  assert.equal(head.version, readSnapshot(p.dir).version);
  assert.ok(readSnapshot(p.dir).coverage.members["src/plain.ts"]);
  assert.ok(text.indexOf("\n") < text.indexOf("src/plain.ts"), "the list sits past the newline");
  // Cut the list: Stop's part still reads, and completion refuses.
  fs.writeFileSync(snapshotPath(p.dir), text.slice(0, text.indexOf("\n") + 20));
  assert.ok(readHead(p.dir));
  assert.equal(p.stop(), "");
  assertCompletionRefused(p, /record can't be read whole/);
});

// ---- page version vs coverage ----

test("the page's version and coverage are separate: unseen source doesn't change what was reviewed", () => {
  const p = project();
  const before = buildReviewData(p.dir, readState(p.dir));
  assert.equal(before.record.coverage, undefined);
  p.write("src/plain.ts", "changed before approval\n");
  p.write("src/also.ts", "new before approval\n");
  const seen = buildReviewData(p.dir, readState(p.dir));
  assert.equal(seen.skeletonVersion, before.skeletonVersion, "a plain file isn't on the page, so it isn't in the version");
  p.ok(["approve", "--reviewed", before.skeletonVersion]);
  const snap = readSnapshot(p.dir);
  assert.equal(snap.version, before.skeletonVersion);
  assert.match(snap.coverage.id, /^[0-9a-f]{12}$/);
  assert.notEqual(snap.coverage.id, snap.version);
  assert.ok(snap.coverage.members["src/also.ts"], "the baseline is taken at approval");
  assert.equal(Object.keys(snap.files).length, 1, "the plain files aren't added to the reviewed skeleton");
  assert.deepEqual(Object.keys(snap.files), ["src/a.ts"]);
  // The stale check stays on the version: it isn't tripped by coverage, and still trips on the skeleton.
  assert.deepEqual(readRendered(p.dir), []);
  p.ok(["reshape"]);
  p.write("src/a.ts", FENCED.replace("export function f", "export function g"));
  assert.match(p.refused(["approve", "--reviewed", before.skeletonVersion]), /the skeleton has changed since/);
});

test("approve discovers once, and the record and baseline hold the same read", async () => {
  const p = project({ files: { "src/types.ts": "one\n" } });
  p.ok(["track", "src/types.ts"]);
  const s = spy(tmp("skel-spy-"));
  const r = spawnSync(process.execPath, [...s.args, BIN, "approve"], { cwd: p.dir, encoding: "utf-8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const listings = s.read().split("\n").filter((l) => l.startsWith("spawn") && l.includes("core.fsmonitor=false") && l.includes("--exclude-standard") && !l.includes("--directory"));
  assert.equal(listings.length, 1, s.read());

  const q = project({ files: { "src/types.ts": "one\n" } });
  q.ok(["track", "src/types.ts"]);
  const state = readState(q.dir);
  const source = await captureSourceSet(q.dir, state, ["src/a.ts"]);
  q.write("src/types.ts", "two, after the capture\n");
  const record = recordSkeleton(q.dir, state, ["src/a.ts"], source.read, { strict: true });
  assert.deepEqual(record.files["src/types.ts"].lines, ["one", ""], "the bytes that were hashed");
});

test("describeCoverage names the fallback and the kinds of member", async () => {
  const p = project({ git: false, files: { "src/types.ts": "t\n" } });
  p.ok(["track", "src/types.ts"]);
  const { coverage } = await captureSourceSet(p.dir, readState(p.dir), ["src/a.ts"]);
  const text = describeCoverage(coverage, 2).join("\n");
  assert.match(text, /discovered with walk: not a git repository, so skel applies the \.gitignore files itself/);
  assert.match(text, /1 fenced .*1 explicitly added with `skel track`, 1 other source files, checked in full/);
  assert.match(text, /review page shows 2 file\(s\).*not necessarily reviewed/);
  assert.match(text, /holds 2 file/);
});

test("discovery never reads a file, and lists nothing the policy excludes as a member", () => {
  const p = project({ files: { "dist/o.js": "1\n" } });
  p.write("build/b.js", "untracked output\n");
  const found = discoverSource(p.dir, { withIgnored: true });
  assert.equal(found.mode, "git");
  assert.ok(found.eligible.has("src/plain.ts"));
  assert.ok(!found.eligible.has("build/b.js"));
  assert.equal(found.excluded.build.count, 1);
  assert.ok(found.ignored.sample.some((s) => s.startsWith("dist")));
});

// ---- legacy records ----

/** Rewrite the approved record as an older skel wrote it. */
function downgrade(p, format) {
  const snap = readSnapshot(p.dir);
  const { coverage, format: _f, ...rest } = snap;
  const out = format ? { ...rest, format } : rest;
  fs.writeFileSync(snapshotPath(p.dir), JSON.stringify(out));
  return out;
}

for (const format of [undefined, 2]) {
  test(`a format-${format ?? 1} record stays readable for diagnosis, but done and finalize require re-approval, without a backfill`, () => {
    const p = filling();
    const old = downgrade(p, format);
    assert.ok(readSnapshot(p.dir), "readable");
    p.write("src/a.ts", FILLED);
    assert.doesNotMatch(p.ok(["status"]), /drift/, "no false drift");
    assert.match(p.ok(["status"]), /from before source baselines.*skel reshape/);
    assert.doesNotMatch(p.ok(["status"]), /full check/);
    assert.equal(p.stop(), "", "Stop diagnoses without complaint");
    const refusal = p.refused(["done"]);
    assert.match(refusal, /can't finish step 1: .*from before source baselines/);
    assert.match(refusal, /won't build a baseline from today's files/);
    assert.match(p.refused(["finalize"]), /can't finalize: .*from before source baselines/);
    assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath(p.dir), "utf-8")), old, "never backfilled");
    // Real drift is still named, under the old comparison.
    fs.appendFileSync(p.abs("src/a.ts"), "export const out = 1;\n");
    assert.match(p.refused(["done"]), /src\/a\.ts:\d+[\s\S]*export const out = 1;[\s\S]*from before source baselines/);
    assert.match(JSON.parse(p.stop()).systemMessage, /export const out = 1;/);
    p.write("src/a.ts", FILLED);
    // And the way out works.
    p.ok(["reshape"]);
    p.ok(["approve"]);
    assert.equal(readSnapshot(p.dir).format, 3);
    p.ok(["start", "1", "--force"]);
    assert.match(p.ok(["done"]), /STEP 1 done/);
  });
}

test("format 2 keeps its comparison: a tracked whole file's example fence body is still held whole, by status and by Stop", () => {
  const doc = "// SKEL[9] an example, not a step\nexample body\n// /SKEL[9]\n";
  const p = project({ files: { "secrets/doc.ts": doc } });
  p.ok(["track", "secrets/doc.ts"]);
  p.ok(["approve"]);
  p.ok(["start", "1"]);
  const snap = readSnapshot(p.dir);
  assert.deepEqual(snap.fenced, ["src/a.ts"]);
  assert.deepEqual(snap.files["secrets/doc.ts"].lines, [...doc.split("\n")]);
  downgrade(p, 2);
  assert.equal(p.stop(), "");
  p.write("secrets/doc.ts", doc.replace("example body", "edited body"));
  assert.match(JSON.parse(p.stop()).systemMessage, /secrets\/doc\.ts:2[\s\S]*edited body/, "Stop");
  assert.match(p.ok(["status"]), /secrets\/doc\.ts:2[\s\S]*edited body/, "status");
  // A format-less record is still the other way: it dropped every file's bodies.
  p.write("secrets/doc.ts", doc);
  const full = JSON.parse(fs.readFileSync(snapshotPath(p.dir), "utf-8"));
  const { format: _gone, ...formatless } = full;
  formatless.files["secrets/doc.ts"].lines = ["// SKEL[9] an example, not a step", "// /SKEL[9]", ""];
  formatless.files["secrets/doc.ts"].sha256 = crypto.createHash("sha256").update(formatless.files["secrets/doc.ts"].lines.join("\n")).digest("hex");
  fs.writeFileSync(snapshotPath(p.dir), JSON.stringify(formatless));
  p.write("secrets/doc.ts", doc.replace("example body", "edited body"));
  assert.doesNotMatch(p.ok(["status"]), /secrets\/doc\.ts:2/, "the format-less record compares without bodies");
});

test("the shape of format 3 is checked: no baseline, a baseline on an old format, a bad member, a later policy", async () => {
  const p = filling();
  const snap = readSnapshot(p.dir);
  assert.ok(validSnapshot(snap));
  const { coverage, ...bare } = snap;
  assert.equal(validSnapshot(bare), false, "format 3 without a baseline");
  assert.equal(validSnapshot({ ...snap, format: 2 }), false, "a baseline can't sit on an old format");
  assert.equal(validSnapshot({ ...bare, format: 4 }), false, "unknown format");
  const bad = (member) => validSnapshot({ ...snap, coverage: { ...coverage, members: { ...coverage.members, ...member } } });
  assert.equal(bad({ "../x": { sha256: "0".repeat(64) } }), false, "a key out of the project");
  assert.equal(bad({ x: { sha256: "short" } }), false);
  assert.equal(bad({ x: {} }), false);
  assert.equal(bad({ x: { alias: "../y", sha256: "0".repeat(64) } }), false);
  assert.equal(validSnapshot({ ...snap, coverage: { ...coverage, discovery: { mode: "guess" } } }), false);
  // A record made under other rules can't be compared under these.
  fs.writeFileSync(snapshotPath(p.dir), JSON.stringify({ ...snap, coverage: { ...coverage, policy: SOURCE_POLICY + 1 } }));
  p.write("src/a.ts", FILLED);
  assert.match(p.refused(["done"]), new RegExp(`discovery policy ${SOURCE_POLICY + 1}, and this skel uses ${SOURCE_POLICY}.*skel reshape`, "s"));
});

// ---- migration ----

test("skel migrate's validators accept format 3, and refuse a format-3 record with a broken baseline", () => {
  const p = filling();
  const key = projectKey(p.dir);
  const from = tmp("skel-from-");
  const to = path.join(tmp("skel-to-"), "skel");
  const bytes = fs.readFileSync(snapshotPath(p.dir));
  fs.writeFileSync(path.join(from, `${key}.snapshot.json`), bytes);
  const plan = planMigration({ key, from, to, keyOf: projectKey });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.outcomes.map((o) => o.outcome), ["move"]);
  assert.equal(migrateProject({ key, from, to, keyOf: projectKey }), 1);
  assert.deepEqual(fs.readFileSync(path.join(to, `${key}.snapshot.json`)), bytes, "byte for byte");

  const from2 = tmp("skel-from-");
  const { coverage, ...rest } = JSON.parse(bytes.toString("utf-8"));
  fs.writeFileSync(path.join(from2, `${key}.snapshot.json`), JSON.stringify(rest));
  const refused = planMigration({ key, from: from2, to: path.join(tmp("skel-to-"), "skel"), keyOf: projectKey });
  assert.equal(refused.problems[0].kind, "corrupt");
});

test("rendered versions from before the bump still load, for approve's diff", () => {
  const p = project();
  const data = buildReviewData(p.dir, readState(p.dir));
  const rendered = { root: p.dir, versions: [{ version: data.skeletonVersion, at: 1, format: 2, files: data.record.files, fences: data.record.fences, fenced: data.record.fenced }] };
  const file = snapshotPath(p.dir).replace(".snapshot.json", ".rendered.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rendered));
  assert.equal(readRendered(p.dir).length, 1);
});
