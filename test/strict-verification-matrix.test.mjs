// #79: keep docs/strict-verification-matrix.md honest: every cited file exists,
// every row has an owner section, and no row claims the "profile" kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const doc = fs.readFileSync(new URL("../docs/strict-verification-matrix.md", import.meta.url), "utf8");

test("every file the matrix cites exists", () => {
  const cited = [...doc.matchAll(/`((?:test|lib|docs|skills|scripts)\/[A-Za-z0-9._/-]+)`/g)].map((m) => m[1]);
  assert.ok(cited.length > 20, "the matrix cites its evidence");
  for (const p of new Set(cited)) assert.ok(fs.existsSync(new URL(`../${p}`, import.meta.url)), `${p} is cited but missing`);
});

test("rows are uniquely numbered and none claims a profile result yet", () => {
  const rows = [...doc.matchAll(/^\| ([CX]\d+) \|(.*)\|$/gm)];
  const ids = rows.map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "unique row ids");
  assert.ok(ids.some((i) => i.startsWith("C")) && ids.some((i) => i.startsWith("X")));
  for (const [, id, rest] of rows) {
    const cols = rest.split("|").map((c) => c.trim());
    assert.equal(cols.length, 4, `${id} has requirement, evidence, kind, status`);
    assert.doesNotMatch(cols[2], /\bprofile\b/, `${id} must not claim the profile kind until it truly passes`);
  }
});
