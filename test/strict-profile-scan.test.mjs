// The browser fixture's profile scan (#270): a temporary directory that
// vanishes mid-scan repeats the scan; anything that can't complete refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findNamed } from "./live/strict-browser-fixture.mjs";

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
  assert.throws(() => findNamed(root, "DevToolsActivePort", new Set(), { read: always.read }), /profile scan never completed/);
  assert.equal(always.calls.count, 3);
  assert.throws(() => findNamed(path.join(root, "absent"), "DevToolsActivePort"), { code: "ENOENT" });
  const denied = vanishing(path.join(root, "Default", "Cache"), 1, "EACCES");
  assert.throws(() => findNamed(root, "DevToolsActivePort", new Set(), { read: denied.read }), { code: "EACCES" });
  const rootGone = vanishing(root, 1);
  assert.throws(() => findNamed(root, "DevToolsActivePort", new Set(), { read: rootGone.read }), { code: "ENOENT" });
});
