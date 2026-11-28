// The browser fixture's profile scan (#270): a temporary directory that
// vanishes mid-scan repeats the scan; anything that can't complete refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findNamed, labelOf } from "./live/strict-browser-fixture.mjs";

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-profile-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["Default", "Default/Cache", "tmp", "tmp/a", "other"]) fs.mkdirSync(path.join(root, dir));
  for (const file of ["DevToolsActivePort", "Default/DevToolsActivePort", "tmp/a/x", "other/DevToolsActivePort"]) {
    fs.writeFileSync(path.join(root, file), "");
  }
  return root;
}

// Reads normally, except that the first `times` reads of `target` find it gone.
function vanishing(target, times, code = "ENOENT") {
  const calls = { count: 0 };
  const read = (dir, options) => {
    if (dir === target && calls.count++ < times) throw Object.assign(new Error(code), { code });
    return fs.readdirSync(dir, options);
  };
  return { read, calls };
}

test("profile scan counts the named file outside excluded directories", (t) => {
  const root = tree(t);
  assert.equal(findNamed(root, "DevToolsActivePort"), 3);
  assert.equal(findNamed(root, "DevToolsActivePort", new Set([path.join(root, "other")])), 2);
});

test("a subdirectory that vanishes mid-scan repeats the whole scan", (t) => {
  const root = tree(t);
  const gone = vanishing(path.join(root, "tmp", "a"), 2);
  assert.equal(findNamed(root, "DevToolsActivePort", new Set(), { read: gone.read }), 3);
  assert.equal(gone.calls.count, 3);
  const replaced = vanishing(path.join(root, "tmp"), 1, "ENOTDIR");
  assert.equal(findNamed(root, "DevToolsActivePort", new Set(), { read: replaced.read }), 3);
});

test("a scan that never completes, a missing root or another error refuses", (t) => {
  const root = tree(t);
  const always = vanishing(path.join(root, "tmp", "a"), Infinity);
  // With nothing counted before the change, the scan refuses with its own label.
  const quiet = path.join(root, "quiet");
  fs.mkdirSync(path.join(quiet, "tmp"), { recursive: true });
  const stillGone = vanishing(path.join(quiet, "tmp"), Infinity);
  assert.throws(() => findNamed(quiet, "DevToolsActivePort", new Set(), { read: stillGone.read }),
    (error) => labelOf(error) === "profile-scan-incomplete");
  assert.equal(stillGone.calls.count, 3);
  const notDir = vanishing(path.join(quiet, "tmp"), Infinity, "ENOTDIR");
  assert.throws(() => findNamed(quiet, "DevToolsActivePort", new Set(), { read: notDir.read }),
    (error) => labelOf(error) === "profile-scan-incomplete");
  assert.throws(() => findNamed(root, "DevToolsActivePort", new Set(), { attempts: NaN }), TypeError);
  assert.throws(() => findNamed(root, "DevToolsActivePort", new Set(), { attempts: 0 }), TypeError);
  // A count from before the change stands even if the scan never completes.
  assert.ok(findNamed(root, "DevToolsActivePort", new Set(), { read: always.read }) >= 1);
  assert.equal(always.calls.count, 3);
  assert.throws(() => findNamed(path.join(root, "absent"), "DevToolsActivePort"), { code: "ENOENT" });
  const denied = vanishing(path.join(root, "Default", "Cache"), 1, "EACCES");
  assert.throws(() => findNamed(root, "DevToolsActivePort", new Set(), { read: denied.read }), { code: "EACCES" });
  const rootGone = vanishing(root, 1);
  assert.throws(() => findNamed(root, "DevToolsActivePort", new Set(), { read: rootGone.read }), { code: "ENOENT" });
});

test("a file counted before a mid-scan change is evidence, even if it is gone on a repeat", (t) => {
  const root = tree(t);
  const temp = path.join(root, "tmp");
  // Chromium removes its temp directory and the port file right after the first listing.
  const read = (dir, options) => {
    const entries = fs.readdirSync(dir, options);
    if (dir === root && fs.existsSync(temp)) {
      fs.rmSync(temp, { recursive: true });
      fs.rmSync(path.join(root, "DevToolsActivePort"));
      fs.rmSync(path.join(root, "Default", "DevToolsActivePort"));
      fs.rmSync(path.join(root, "other", "DevToolsActivePort"));
    }
    return entries;
  };
  // The first listing saw the root's port file; every later scan sees none.
  assert.equal(findNamed(root, "DevToolsActivePort", new Set(), { read }), 1);
});

test("the depth cap counts as evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-profile-deep-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ...Array(14).fill("d")), { recursive: true });
  assert.equal(findNamed(root, "DevToolsActivePort"), 1);
});
