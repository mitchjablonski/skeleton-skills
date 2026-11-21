// Directory manager (bootstrap step 2): durable history reopen/first-enrollment
// and fresh scratch, with refusals. Linux only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareDurableHistory, createScratch, FILESYSTEM_TYPES } from "../lib/strict-directories.mjs";

const linux = (name, fn) => test(name, { skip: process.platform !== "linux" }, fn);
const refusal = (code) => (e) => e?.name === "DirectoryRefusal" && e.code === code;

function base(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strict-dirs-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

linux("first enrollment creates a private layout; reopen finds it and creates nothing", (t) => {
  const root = path.join(base(t), "history");
  const made = prepareDurableHistory(root, { firstEnrollment: true });
  assert.equal(made.root, root);
  for (const p of [made.root, made.authority, made.captures]) {
    const st = fs.lstatSync(p);
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.equal(st.mode & 0o777, 0o700);
  }
  const before = fs.readdirSync(root).sort();
  const reopened = prepareDurableHistory(root);
  assert.deepEqual(reopened, made);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

linux("first enrollment refuses an existing root, including a dangling symlink", (t) => {
  const dir = base(t);
  const root = path.join(dir, "history");
  fs.mkdirSync(root, { mode: 0o700 });
  assert.throws(() => prepareDurableHistory(root, { firstEnrollment: true }), refusal("durable-history-exists"));
  const link = path.join(dir, "link");
  fs.symlinkSync(path.join(dir, "nowhere"), link);
  assert.throws(() => prepareDurableHistory(link, { firstEnrollment: true }), refusal("durable-history-exists"));
});

linux("reopen refuses missing, incomplete, symlinked, foreign-mode or non-private history and never creates it", (t) => {
  const dir = base(t);
  const missing = path.join(dir, "missing");
  assert.throws(() => prepareDurableHistory(missing), refusal("missing-directory"));
  assert.equal(fs.existsSync(missing), false, "reopen never creates");

  const incomplete = path.join(dir, "incomplete");
  fs.mkdirSync(incomplete, { mode: 0o700 });
  fs.mkdirSync(path.join(incomplete, "authority"), { mode: 0o700 });
  assert.throws(() => prepareDurableHistory(incomplete), refusal("durable-history-incomplete"));
  assert.equal(fs.existsSync(path.join(incomplete, "captures")), false);

  const real = path.join(dir, "real");
  prepareDurableHistory(real, { firstEnrollment: true });
  const linked = path.join(dir, "linked");
  fs.symlinkSync(real, linked);
  assert.throws(() => prepareDurableHistory(linked), refusal("not-a-directory"));

  fs.chmodSync(real, 0o750);
  assert.throws(() => prepareDurableHistory(real), refusal("not-private"));
  fs.chmodSync(real, 0o700);
  fs.chmodSync(path.join(real, "captures"), 0o770);
  assert.throws(() => prepareDurableHistory(real), refusal("not-private"));
});

linux("an unsafe ancestor refuses", (t) => {
  const dir = base(t);
  const open = path.join(dir, "open");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777); // world-writable, not sticky
  assert.throws(() => prepareDurableHistory(path.join(open, "history"), { firstEnrollment: true }), refusal("unsafe-ancestor"));
  assert.throws(() => createScratch(path.join(open, "scratch")), refusal("unsafe-ancestor"));
  const viaLink = path.join(dir, "via");
  fs.symlinkSync(dir, viaLink);
  assert.throws(() => prepareDurableHistory(path.join(viaLink, "history"), { firstEnrollment: true }), refusal("unsafe-ancestor"));
});

linux("filesystem allowlist: durable refuses tmpfs and 9p; scratch accepts tmpfs but refuses 9p", (t) => {
  const dir = base(t);
  const as = (type) => ({ statfs: () => ({ type }) });
  assert.throws(() => prepareDurableHistory(path.join(dir, "h1"), { firstEnrollment: true, ...as(FILESYSTEM_TYPES.tmpfs) }),
    refusal("filesystem-not-allowed"));
  assert.throws(() => prepareDurableHistory(path.join(dir, "h2"), { firstEnrollment: true, ...as(0x01021997) }),
    refusal("filesystem-not-allowed"));
  assert.equal(fs.existsSync(path.join(dir, "h1")), false);
  const tmp = createScratch(path.join(dir, "s1"), as(FILESYSTEM_TYPES.tmpfs));
  assert.deepEqual(tmp.remove({ writersStopped: true }), { removed: true });
  assert.throws(() => createScratch(path.join(dir, "s2"), as(0x01021997)), refusal("filesystem-not-allowed"));
  assert.throws(() => prepareDurableHistory(path.join(dir, "h3"), { statfs: () => { throw new Error("nope"); } }),
    refusal("filesystem-unknown"));
});

linux("scratch is created fresh, refuses an existing path or dangling symlink, and must not overlap durable history", (t) => {
  const dir = base(t);
  const durable = prepareDurableHistory(path.join(dir, "history"), { firstEnrollment: true });
  const s = createScratch(path.join(dir, "scratch"), { durable });
  assert.equal(fs.lstatSync(s.path).mode & 0o777, 0o700);
  assert.throws(() => createScratch(path.join(dir, "scratch")), refusal("scratch-exists"));
  const dangling = path.join(dir, "dangling");
  fs.symlinkSync(path.join(dir, "gone"), dangling);
  assert.throws(() => createScratch(dangling), refusal("scratch-exists"));
  assert.throws(() => createScratch(path.join(durable.root, "scratch"), { durable }), refusal("scratch-overlaps-durable"));
  assert.throws(() => createScratch(dir, { durable }), refusal("scratch-overlaps-durable"));
});

linux("scratch removal removes only that scratch and never durable history; a swapped path is retained", (t) => {
  const dir = base(t);
  const durable = prepareDurableHistory(path.join(dir, "history"), { firstEnrollment: true });
  fs.writeFileSync(path.join(durable.captures, "blob"), "keep");
  const s = createScratch(path.join(dir, "scratch"), { durable });
  fs.mkdirSync(path.join(s.path, "nested"));
  fs.writeFileSync(path.join(s.path, "nested", "f"), "x");
  assert.deepEqual(s.remove({ writersStopped: true }), { removed: true });
  assert.equal(fs.existsSync(s.path), false);
  assert.equal(fs.readFileSync(path.join(durable.captures, "blob"), "utf8"), "keep");
  assert.deepEqual(s.remove({ writersStopped: true }), { removed: true }, "idempotent once removed");

  // Swap the scratch for a symlink to durable history: removal must refuse and retain.
  const s2 = createScratch(path.join(dir, "scratch2"), { durable });
  fs.rmdirSync(s2.path);
  fs.symlinkSync(durable.root, s2.path);
  const swapped = s2.remove({ writersStopped: true });
  assert.equal(swapped.removed, false);
  assert.equal(swapped.reason, "scratch-replaced");
  assert.equal(fs.readFileSync(path.join(durable.captures, "blob"), "utf8"), "keep");

  s2.retain();

  // Replace with a different directory at the same path: also refused (the
  // held handle pins the original inode, so its number can't be reused).
  const s3 = createScratch(path.join(dir, "scratch3"));
  fs.rmdirSync(s3.path);
  fs.mkdirSync(s3.path, { mode: 0o700 });
  assert.equal(s3.remove({ writersStopped: true }).reason, "scratch-replaced");
  s3.retain();
});

linux("invalid paths and options refuse before touching the filesystem", (t) => {
  const dir = base(t);
  for (const bad of ["", "relative/path", "/a\0b", 42, null]) {
    assert.throws(() => prepareDurableHistory(bad), refusal("invalid-path"));
    assert.throws(() => createScratch(bad), refusal("invalid-path"));
  }
  assert.throws(() => prepareDurableHistory(dir + "/a/../b"), refusal("non-canonical-path"));
  assert.throws(() => prepareDurableHistory(dir + "//b"), refusal("non-canonical-path"));
  assert.throws(() => prepareDurableHistory(path.join(dir, "h"), { firstEnrollment: "yes" }), refusal("invalid-options"));
  assert.throws(() => createScratch(path.join(dir, "s"), { durable: {} }), refusal("invalid-options"));
  assert.equal(fs.existsSync(path.join(dir, "h")), false);
});

test("unsupported platform refuses", { skip: process.platform === "linux" }, () => {
  assert.throws(() => prepareDurableHistory("/x"), refusal("unsupported-platform"));
});

linux("removal requires stopped writers, refuses after retain, and never follows a link inside scratch", (t) => {
  const dir = base(t);
  const durable = prepareDurableHistory(path.join(dir, "history"), { firstEnrollment: true });
  fs.writeFileSync(path.join(durable.captures, "blob"), "keep");
  const s = createScratch(path.join(dir, "scratch"), { durable });
  assert.deepEqual(s.remove(), { removed: false, retained: s.path, reason: "writers-not-stopped" });
  fs.symlinkSync(durable.root, path.join(s.path, "link-to-history"));
  fs.mkdirSync(path.join(s.path, "sub"));
  fs.symlinkSync(durable.captures, path.join(s.path, "sub", "deep-link"));
  assert.deepEqual(s.remove({ writersStopped: true }), { removed: true });
  assert.equal(fs.readFileSync(path.join(durable.captures, "blob"), "utf8"), "keep", "links were unlinked, not followed");
  const kept = createScratch(path.join(dir, "kept"));
  assert.equal(kept.retain().reason, "retained");
  assert.deepEqual(kept.remove({ writersStopped: true }), { removed: false, retained: kept.path, reason: "released" });
  assert.equal(fs.existsSync(kept.path), true);
});

linux("reopen requires exactly the layout, no symlinked or extra entries, all on one filesystem", (t) => {
  const dir = base(t);
  const root = path.join(dir, "history");
  prepareDurableHistory(root, { firstEnrollment: true });
  fs.symlinkSync("/etc", path.join(root, "extra"));
  assert.throws(() => prepareDurableHistory(root), refusal("durable-history-unexpected-entry"));
  fs.unlinkSync(path.join(root, "extra"));
  fs.writeFileSync(path.join(root, "junk"), "x");
  assert.throws(() => prepareDurableHistory(root), refusal("durable-history-unexpected-entry"));
  fs.unlinkSync(path.join(root, "junk"));
  const other = path.join(dir, "other-captures");
  fs.mkdirSync(other, { mode: 0o700 });
  fs.rmdirSync(path.join(root, "captures"));
  fs.symlinkSync(other, path.join(root, "captures"));
  assert.throws(() => prepareDurableHistory(root), refusal("not-a-directory"));
  fs.unlinkSync(path.join(root, "captures"));
  fs.mkdirSync(path.join(root, "captures"), { mode: 0o700 });
  // A subdirectory on a different filesystem type (as a bind or network mount would be).
  const mixed = (p) => ({ type: p.endsWith("captures") ? 0x6969 : FILESYSTEM_TYPES.ext });
  assert.throws(() => prepareDurableHistory(root, { statfs: mixed }), refusal("filesystem-not-allowed"));
  assert.equal(prepareDurableHistory(root).root, root);
});

linux("a rename failure after the temporary layout exists cleans the temporary directory up", (t) => {
  const dir = base(t);
  const failRename = { firstEnrollment: true, renameSync: () => { throw new Error("injected"); } };
  assert.throws(() => prepareDurableHistory(path.join(dir, "history"), failRename), refusal("io-error"));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("enrolling") || n === "history"), [],
    "neither the root nor the .history.enrolling-* temporary remains");
});

// Note: the device checks (a subdirectory or tree entry on another device) need a
// real mount to exercise; the statfs mocks here cover only the filesystem-type check.
linux("a failed first enrollment leaves no root and no temporary directory behind", (t) => {
  const dir = base(t);
  const parent = path.join(dir, "parent");
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.chmodSync(parent, 0o500); // can't create inside
  assert.throws(() => prepareDurableHistory(path.join(parent, "history"), { firstEnrollment: true }), refusal("io-error"));
  fs.chmodSync(parent, 0o700);
  assert.deepEqual(fs.readdirSync(parent), []);
  const ok = prepareDurableHistory(path.join(parent, "history"), { firstEnrollment: true });
  assert.deepEqual(fs.readdirSync(parent), ["history"], "only the root remains; the temporary sibling was renamed");
  assert.equal(ok.root, path.join(parent, "history"));
});

linux("scratch filesystem is checked on the created directory too, and a refusal leaves nothing behind", (t) => {
  const dir = base(t);
  const parentOkChildBad = (p) => ({ type: p.endsWith("scratch") ? 0x01021997 : FILESYSTEM_TYPES.ext });
  assert.throws(() => createScratch(path.join(dir, "scratch"), { statfs: parentOkChildBad }), refusal("filesystem-not-allowed"));
  assert.equal(fs.existsSync(path.join(dir, "scratch")), false, "the refused scratch was removed");
});
