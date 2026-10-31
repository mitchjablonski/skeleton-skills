import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDiagrams } from "../lib/review.mjs";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skel-diagrams-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, ".skeleton"), { recursive: true });
  const external = path.join(base, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "private.mmd"), "EXTERNAL_PRIVATE_MARKER");
  return { root, external, dir: path.join(root, ".skeleton", "diagrams") };
}

test("diagram review reads regular project diagrams, sorted, and skips non-files", (t) => {
  const { root, dir } = fixture(t);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "b.mmd"), "flowchart LR\n B-->C");
  fs.writeFileSync(path.join(dir, "a.mmd"), "flowchart LR\n A-->B");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a diagram");
  fs.mkdirSync(path.join(dir, "directory.mmd"));
  assert.deepEqual(readDiagrams(root).map(d => d.name), ["a", "b"]);
  assert.match(readDiagrams(root)[0].source, /A-->B/);
});

test("a diagram directory junction cannot expose files outside the project", (t) => {
  const { root, dir, external } = fixture(t);
  fs.symlinkSync(external, dir, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(readDiagrams(root), []);
});

test("an individual diagram symlink cannot expose an external file", (t) => {
  const { root, dir, external } = fixture(t);
  fs.mkdirSync(dir);
  try {
    fs.symlinkSync(path.join(external, "private.mmd"), path.join(dir, "secret.mmd"));
  } catch (err) {
    if (process.platform === "win32" && err.code === "EPERM") {
      t.skip("file symlinks require Windows Developer Mode or elevation");
      return;
    }
    throw err;
  }
  assert.deepEqual(readDiagrams(root), []);
});

test("an in-project diagram directory alias stays usable", (t) => {
  const { root, dir } = fixture(t);
  const assets = path.join(root, "diagram-assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "architecture.mmd"), "flowchart LR\n A-->B");
  fs.symlinkSync(assets, dir, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(readDiagrams(root), [{ name: "architecture", source: "flowchart LR\n A-->B" }]);
});
