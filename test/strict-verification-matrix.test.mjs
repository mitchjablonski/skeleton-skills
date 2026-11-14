// #79: keep docs/strict-verification-matrix.md honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const doc = read("docs/strict-verification-matrix.md");
const EXPECTED = [...Array.from({ length: 20 }, (_, i) => `C${i + 1}`), ...Array.from({ length: 18 }, (_, i) => `X${i + 1}`)];
const KINDS = new Set(["unit", "live-fixture", "design", "—"]);
const CLAIMS = /\b(profile|verified|contained|containment (?:is )?(?:proven|established)|attested|production[- ]ready|active)\b/i;

const rowLines = doc.split("\n").filter((l) => /^\|\s*[CX]\d/.test(l));
const rows = rowLines.map((line) => {
  const m = /^\| ([CX]\d+) \|(.*)\|$/.exec(line);
  assert.ok(m, `row line doesn't parse: ${line.slice(0, 60)}`);
  const cols = m[2].split("|").map((c) => c.trim());
  assert.equal(cols.length, 4, `${m[1]} has requirement, evidence, kind and status`);
  return { id: m[1], requirement: cols[0], evidence: cols[1], kind: cols[2], status: cols[3], line };
});

test("the row ids are exactly the pinned set, each once", () => {
  assert.deepEqual(rows.map((r) => r.id), EXPECTED);
});

test("Claude rows sit under the Claude heading, Codex rows under the Codex heading", () => {
  const claude = doc.indexOf("## Claude-owned rows"), codex = doc.indexOf("## Codex-owned rows");
  assert.ok(claude > 0 && codex > claude);
  for (const r of rows) {
    const at = doc.indexOf(r.line);
    assert.ok(r.id.startsWith("C") ? at > claude && at < codex : at > codex, r.id);
  }
});

test("every cited file exists", () => {
  const cited = [...doc.matchAll(/`((?:test|lib|docs|skills|scripts)\/[A-Za-z0-9._/-]+)`/g)].map((m) => m[1]);
  assert.ok(cited.length > 30);
  for (const p of new Set(cited)) assert.ok(fs.existsSync(new URL(`../${p}`, import.meta.url)), `${p} is cited but missing`);
});

test("kinds are known, no Kind or Status cell claims more than fixture evidence, and evidence-free rows say so", () => {
  for (const r of rows) {
    for (const k of r.kind.split(",").map((s) => s.trim())) assert.ok(KINDS.has(k), `${r.id}: unknown kind "${k}"`);
    assert.doesNotMatch(r.kind, CLAIMS, `${r.id} kind`);
    assert.doesNotMatch(r.status.replace(/\bunverified\b/gi, ""), CLAIMS, `${r.id} status`);
    if (r.kind === "—") assert.match(r.evidence, /^none$/, `${r.id}: no kind means no evidence`);
    if (r.evidence === "none") assert.equal(r.kind, "—", `${r.id}: no evidence means kind —`);
  }
});

test("browser row ids cited in the matrix exist in the probe", () => {
  const probe = read("test/live/strict-browser-matrix.mjs");
  const defined = new Set([...probe.matchAll(/row\("(B\d+)"/g)].map((m) => m[1]));
  const cited = new Set();
  for (const m of doc.matchAll(/\bB(\d+)(?:–B(\d+))?\b/g)) {
    const lo = Number(m[1]), hi = Number(m[2] ?? m[1]);
    for (let n = lo; n <= hi; n++) cited.add(`B${n}`);
  }
  assert.ok(cited.has("B12") && cited.has("B1") && cited.has("B18"), "ids after a range are read too");
  for (const id of cited) assert.ok(defined.has(id), `${id} is cited but not a probe row`);
});

test("unit-kind rows cite test files that npm test runs", () => {
  const script = JSON.parse(read("package.json")).scripts.test;
  for (const r of rows.filter((x) => x.kind.split(",").map((s) => s.trim()).includes("unit")))
    for (const m of r.evidence.matchAll(/`(test\/[a-z0-9-]+\.test\.mjs)`/g)) assert.ok(script.includes(m[1]), `${r.id}: ${m[1]} not in npm test`);
});
