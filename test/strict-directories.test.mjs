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
  assert.deepEqual(tmp.remove(), { removed: true });
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
  assert.deepEqual(s.remove(), { removed: true });
  assert.equal(fs.existsSync(s.path), false);
  assert.equal(fs.readFileSync(path.join(durable.captures, "blob"), "utf8"), "keep");
  assert.deepEqual(s.remove(), { removed: true }, "idempotent once removed");

  // Swap the scratch for a symlink to durable history: removal must refuse and retain.
  const s2 = createScratch(path.join(dir, "scratch2"), { durable });
  fs.rmdirSync(s2.path);
  fs.symlinkSync(durable.root, s2.path);
  const swapped = s2.remove();
  assert.equal(swapped.removed, false);
  assert.equal(swapped.reason, "scratch-replaced");
  assert.equal(fs.readFileSync(path.join(durable.captures, "blob"), "utf8"), "keep");

  s2.retain();

  // Replace with a different directory at the same path: also refused. The
  // held handle pins the original inode, so even inode-number reuse can't fool it.
  for (let i = 0; i < 20; i++) {
    const s3 = createScratch(path.join(dir, "scratch3-" + i));
    fs.rmdirSync(s3.path);
    fs.mkdirSync(s3.path, { mode: 0o700 });
    assert.equal(s3.remove().reason, "scratch-replaced");
    s3.retain();
  }
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
