// #77 H3-proposal decision codes on the page: binding checks only (prototype).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDecisionCodes, commandFor, bindingLine, CONTROL_BANNER, DECISION_CODE_RE } from "../lib/strict-decision-codes.mjs";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64);
const scaffold = (o = {}) => ({ binding: { protocolVersion: 2, projectId: "p", sessionId: "s", reviewRoundId: "r", phase: "scaffold",
  reviewVersion: A, captureVersion: B, approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false, ...o } });
// In fill the rendered (selected) pair is the approved pair.
const fill = (o = {}) => scaffold({ phase: "fill", reviewVersion: C, captureVersion: D, approvedVersion: C, approvedCaptureVersion: D, ...o });
const entry = (o = {}) => ({ code: "K7M2-QX9D", revision: 4, reviewVersion: A, captureVersion: B, ...o });

test("approve binds the selected pair; reshape binds the approved pair", () => {
  assert.deepEqual(parseDecisionCodes({ approve: entry() }, scaffold()), { approve: entry() });
  assert.deepEqual(parseDecisionCodes({ reshape: entry({ reviewVersion: C, captureVersion: D }) }, fill()), { reshape: entry({ reviewVersion: C, captureVersion: D }) });
  assert.equal(parseDecisionCodes({ reshape: entry() }, fill()), null, "reshape on another pair");
  // The page renders the selected pair; a reshape code is never shown when that differs from the approved pair.
  assert.equal(parseDecisionCodes({ reshape: entry({ reviewVersion: C, captureVersion: D }) }, fill({ reviewVersion: A, captureVersion: B })), null);
  assert.equal(parseDecisionCodes({ reshape: entry({ reviewVersion: C, captureVersion: D }) }, fill({ captureVersion: B })), null);
  assert.equal(parseDecisionCodes({ approve: entry({ captureVersion: D }) }, scaffold()), null, "approve for another capture");
  assert.deepEqual(parseDecisionCodes({}, scaffold()), {});
});

test("only phase-allowed actions; finalize never; approve never while notes are pending", () => {
  assert.equal(parseDecisionCodes({ reshape: entry() }, scaffold()), null);
  assert.equal(parseDecisionCodes({ approve: entry() }, fill()), null);
  assert.equal(parseDecisionCodes({ finalize: entry() }, scaffold({ phase: "done" })), null);
  assert.deepEqual(parseDecisionCodes({}, scaffold({ phase: "done" })), {});
  assert.equal(parseDecisionCodes({ approve: entry() }, scaffold({ pendingNotes: true })), null);
});

test("malformed codes and entries refuse", () => {
  for (const code of ["k7m2-qx9d", "K7M2QX9D", "K7M2-QX9", "K7M2-QX9DD", "K7I2-QX9D", "K7L2-QX9D", "K7O2-QX9D", "K7U2-QX9D", " K7M2-QX9D"])
    assert.equal(parseDecisionCodes({ approve: entry({ code }) }, scaffold()), null, code);
  for (const bad of [null, [], "x", { approve: null }, { approve: { ...entry(), x: 1 } }, { approve: entry({ revision: 1.5 }) },
    Object.defineProperty({}, "approve", { get: () => entry(), enumerable: true }), new Proxy({}, { ownKeys: () => { throw new Error("boom"); } })])
    assert.equal(parseDecisionCodes(bad, scaffold()), null);
  assert.equal(parseDecisionCodes({ approve: entry() }, null), null);
});

test("display helpers and banner", () => {
  assert.equal(commandFor("approve", entry()), "approve K7M2-QX9D");
  assert.equal(bindingLine(entry()), `shape ${A.slice(0, 12)}… · capture ${B.slice(0, 12)}… · revision 4`);
  assert.equal(bindingLine(entry(), "reshape"), `approved shape ${A.slice(0, 12)}… · approved capture ${B.slice(0, 12)}… · revision 4`);
  assert.equal(CONTROL_BANNER, "SKELETON STRICT CONTROL");
  assert.ok(DECISION_CODE_RE.test("0123-4567"));
});

test("the codes module is browser-safe and never sends, derives or stores codes", () => {
  const src = readFileSync(new URL("../lib/strict-decision-codes.mjs", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of [/^import /m, /fetch\(/, /XMLHttpRequest/, /sendBeacon/, /localStorage|sessionStorage|document\.cookie/, /crypto|hmac/i, /\bBuffer\b|\bprocess\./])
    assert.doesNotMatch(src, bad);
});
