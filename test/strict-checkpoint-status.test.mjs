// #78/#99 checkpoint status and recovery copy against fixture reports (proposal schema).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  checkpointStatus, parseCheckpointReport, CHECKPOINT_PHASES, CHECKPOINT_REFUSALS, DRIFT_KINDS, CHECKPOINT_ACTIONS,
} from "../lib/strict-checkpoint-status.mjs";

const report = (o = {}) => ({ version: 1, phase: "running", stage: "fill", round: "round-1", refusal: null, detail: null, ...o });
const refused = (refusal, detail = null, stage = "fill") => report({ phase: "refused", refusal, detail, stage });
const ALL = () => {
  const out = [];
  for (const stage of ["scaffold", "fill"]) for (const phase of CHECKPOINT_PHASES.filter((p) => p !== "refused")) out.push(report({ phase, stage }));
  for (const stage of ["scaffold", "fill"]) for (const r of CHECKPOINT_REFUSALS) {
    const detail = r === "drift" ? { kind: "exterior", path: "src/a.js", line: 3 } : r === "capture-refused" ? { kind: "CAPTURE_LINK", path: "src/a.js", line: null } : null;
    out.push(refused(r, detail, stage));
  }
  return out;
};
const text = (s) => [s.headline, s.detail, s.next, s.note, s.agentNotice ?? ""].join(" ");

test("every phase and refusal renders complete copy with only fixed actions", () => {
  for (const r of ALL()) {
    const s = checkpointStatus(r);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.actions));
    for (const k of ["headline", "detail", "next", "note"]) assert.ok(typeof s[k] === "string" && s[k].length > 10, `${r.phase}/${r.refusal} ${k}`);
    for (const a of s.actions) assert.ok(CHECKPOINT_ACTIONS.includes(a), a);
    assert.equal(s.phase, r.phase);
  }
});

test("copy never claims containment, safety, a human decision or a delivered result", () => {
  const banned = [/\bcontained\b/i, /\bsafe\b/i, /\bsecure/i, /guarantee/i, /\bverified\b(?! until)(?!:)/i, /you approved/i, /human approved/i,
    /\bactive\b/i, /\bdelivered\b/i, /(was|were|has been) (written|applied) to your (checkout|project)(?!)/i];
  for (const r of [...ALL(), { junk: 1 }]) {
    const t = text(checkpointStatus(r));
    for (const b of banned) assert.doesNotMatch(t, b, `${r.phase}/${r.refusal}: ${b}`);
  }
  // The one sanctioned use of "unverified" is the standing note.
  assert.match(checkpointStatus(report()).note, /remains unverified/);
});

test("refusals keep the session stopped: no retry, fallback or resume, and no reopen of a review", () => {
  for (const r of ALL().filter((x) => x.phase === "refused")) {
    const s = checkpointStatus(r);
    assert.equal(s.tone, "refused");
    assert.match(s.detail, /session stays stopped/);
    assert.ok(!s.actions.includes("reopen-decision-page"), r.refusal);
    assert.ok(s.actions.includes("end-session"));
    assert.doesNotMatch(text(s), /retry(ing)? automatically|default mode|resume|continue the session/i);
  }
});

test("restart-from-approved is offered only for fill refusals that a clean restart can address", () => {
  const allowed = new Set(["capture-refused", "drift", "check-unavailable"]);
  for (const r of ALL().filter((x) => x.phase === "refused")) {
    const s = checkpointStatus(r);
    assert.equal(s.actions.includes("restart-from-approved"), r.stage === "fill" && allowed.has(r.refusal), `${r.stage}/${r.refusal}`);
  }
});

test("the agent notice only says to wait; it never instructs recovery", () => {
  for (const r of [...ALL(), null]) {
    const n = checkpointStatus(r).agentNotice;
    if (n === null) continue;
    assert.match(n, /Wait for the human/);
    assert.doesNotMatch(n.replace(/do not try to restart, recapture, approve or work around it\./, ""), /restart|recapture|approve|launcher window|control window|decision page|token|secret|\bskel\b/i);
  }
  // While the human must act or the host is mid-checkpoint, the agent is told to wait.
  for (const phase of ["stopping", "verifying-stop", "capturing", "awaiting-review", "checking", "ready-to-deliver"])
    assert.ok(checkpointStatus(report({ phase })).agentNotice);
});

test("review is reached only from the trusted window, from a stored snapshot", () => {
  const s = checkpointStatus(report({ phase: "awaiting-review", stage: "scaffold" }));
  assert.deepEqual([...s.actions], ["reopen-decision-page", "end-session"]);
  assert.match(s.detail, /stored snapshot itself, not the live project/);
  assert.match(s.next, /from this window/);
});

test("ready-to-deliver says delivery is undecided and nothing was written to the checkout", () => {
  const s = checkpointStatus(report({ phase: "ready-to-deliver" }));
  assert.match(s.detail, /open product decision/);
  assert.match(s.next, /nothing has been written to your checkout/);
});

test("drift and capture details name kind, path and line; paths escape invisible/reordering characters", () => {
  for (const kind of DRIFT_KINDS) {
    const s = checkpointStatus(refused("drift", { kind, path: "src/a.js", line: 7 }));
    assert.match(s.headline, /in src\/a\.js at line 7\.$/, kind);
  }
  const bidi = checkpointStatus(refused("drift", { kind: "exterior", path: "src/‮sj.txt", line: null }));
  assert.match(bidi.headline, /src\/\\u\{202E\}sj\.txt/);
  assert.doesNotMatch(bidi.headline, /‮/);
  const cap = checkpointStatus(refused("capture-refused", { kind: "CAPTURE_BOM", path: "a.js", line: 1 }, "scaffold"));
  assert.match(cap.detail, /CAPTURE_BOM/);
  assert.match(cap.next, /new session/);
});

test("malformed or inconsistent reports render as unknown and stopped", () => {
  const bad = [
    null, "running", [], { ...report(), extra: 1 }, report({ version: 2 }), report({ phase: "approved" }), report({ stage: "done" }),
    report({ round: "../x" }), report({ refusal: "drift" }), refused("nope"), refused("drift"), // drift without detail
    refused("teardown-unproven", { kind: "exterior", path: null, line: null }), // detail not allowed here
    refused("drift", { kind: "CAPTURE_LINK", path: null, line: null }), refused("capture-refused", { kind: "exterior", path: null, line: null }),
    refused("drift", { kind: "exterior", path: "", line: null }), refused("drift", { kind: "exterior", path: "a", line: 0 }),
    refused("drift", { kind: "exterior", path: "a", line: null, msg: "x" }),
    Object.defineProperty(report(), "phase", { get: () => "running", enumerable: true }),
    new Proxy(report(), { ownKeys: () => { throw new Error("boom"); } }),
  ];
  for (const [i, b] of bad.entries()) {
    assert.equal(parseCheckpointReport(b), null, `case ${i}`);
    const s = checkpointStatus(b);
    assert.equal(s.phase, "unknown");
    assert.deepEqual([...s.actions], ["end-session"]);
    assert.match(s.detail, /nothing as approved/);
  }
});

test("prototype: nothing in lib/bin/skills loads the checkpoint status module", () => {
  for (const dir of ["lib", "bin"]) for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)))
    if (f !== "strict-checkpoint-status.mjs") assert.doesNotMatch(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8"), /strict-checkpoint-status/, f);
});
