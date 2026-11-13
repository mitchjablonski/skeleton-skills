// #78/#99 checkpoint status and recovery copy against fixture reports (proposal schema).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  checkpointStatus, parseCheckpointReport, CHECKPOINT_PHASES, CHECKPOINT_REFUSALS, DRIFT_KINDS, CHECKPOINT_ACTIONS,
  CONTENT_CODES, BOUNDARY_CODES, LINK_CODES, HOST_CODES, NO_CLAIM, AGENT_WAIT,
} from "../lib/strict-checkpoint-status.mjs";

const report = (o = {}) => ({ version: 1, phase: "running", stage: "fill", round: "round-1", refusal: null, detail: null, ...o });
const refused = (refusal, detail = null, stage = "fill") => report({ phase: "refused", refusal, detail, stage });
const FILL_ONLY_PHASES = ["restarting", "checking", "checked"];
const FILL_ONLY_REFUSALS = ["restart-unproven", "drift", "check-unavailable"];
const detailFor = (r) => r === "drift" ? { kind: "exterior", path: "src/a.js", line: 3 } : r === "capture-refused" ? { kind: "CAPTURE_MARKERS", path: "src/a.js", line: 2 } : null;
const ALL = () => {
  const out = [];
  for (const stage of ["scaffold", "fill"]) for (const phase of CHECKPOINT_PHASES)
    if (phase !== "refused" && !(stage === "scaffold" && FILL_ONLY_PHASES.includes(phase))) out.push(report({ phase, stage }));
  for (const stage of ["scaffold", "fill"]) for (const r of CHECKPOINT_REFUSALS)
    if (!(stage === "scaffold" && FILL_ONLY_REFUSALS.includes(r))) out.push(refused(r, detailFor(r), stage));
  for (const kind of Object.keys({ ...CONTENT_CODES, ...BOUNDARY_CODES, ...LINK_CODES, ...HOST_CODES }))
    for (const stage of ["scaffold", "fill"]) out.push(refused("capture-refused", { kind, path: null, line: null }, stage));
  return out;
};
const label = (r) => `${r.stage}/${r.phase}/${r.refusal ?? ""}/${r.detail?.kind ?? ""}`;
const text = (s) => [s.headline, s.detail, s.next, s.pageNext, s.note, s.agentNotice ?? ""].join(" ");

test("every valid report renders complete copy with only fixed actions and the standing note", () => {
  for (const r of ALL()) {
    const s = checkpointStatus(r);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.actions), label(r));
    assert.equal(s.phase, r.phase, label(r));
    for (const k of ["headline", "detail", "next", "pageNext"]) assert.ok(typeof s[k] === "string" && s[k].length > 10, `${label(r)} ${k}`);
    assert.equal(s.note, NO_CLAIM, label(r));
    for (const a of s.actions) assert.ok(CHECKPOINT_ACTIONS.includes(a), a);
  }
  assert.equal(checkpointStatus(null).note, NO_CLAIM);
});

test("exact actions per phase", () => {
  const expected = { running: ["stop-for-review", "end-session"], stopping: [], "verifying-stop": [], capturing: [],
    "awaiting-review": ["reopen-decision-page", "end-session"], restarting: [], checking: [], checked: ["end-session"], ended: [] };
  for (const [phase, actions] of Object.entries(expected)) {
    const stage = FILL_ONLY_PHASES.includes(phase) ? "fill" : "scaffold";
    assert.deepEqual([...checkpointStatus(report({ phase, stage })).actions], actions, phase);
  }
});

test("copy never claims containment, safety, a human decision or a delivered result", () => {
  const banned = [/\bcontained\b/i, /\bsafe(ly)?\b/i, /\bsecure/i, /guarantee/i, /you approved/i, /human approved/i,
    /\bactive\b/i, /\bdelivered\b/i, /(?<![Nn]othing )(was|were|has been) (written|applied) to your (checkout|project)/i, /session stays stopped/i,
    /no (session )?process is running/i, /nothing from this attempt is used.*may still be running/i];
  for (const r of [...ALL(), { junk: 1 }]) {
    const t = text(checkpointStatus(r));
    for (const b of banned) assert.doesNotMatch(t, b, `${label(r)}: ${b}`);
  }
  assert.doesNotMatch("The result has been written to your checkout", /x^/); // sanity for the matcher style
  assert.match("The result has been written to your checkout", banned[8]);
});

test("boundary doubt: the copy says a process may still be running and refuses capture, checks and restart", () => {
  const boundary = [refused("teardown-unproven"), refused("writer-survived"), refused("restart-unproven"),
    ...Object.keys(BOUNDARY_CODES).map((kind) => refused("capture-refused", { kind, path: null, line: null }))];
  for (const r of boundary) {
    const s = checkpointStatus(r);
    assert.equal(s.boundaryInDoubt, true, label(r));
    assert.match(s.detail, /may still be running/);
    assert.match(s.detail, /untrusted, from before and after the stop/);
    assert.match(s.next, /doesn't prove every process is gone/);
    assert.deepEqual([...s.actions], ["show-details", "end-session"], label(r));
  }
  const unknown = checkpointStatus({ nope: 1 });
  assert.match(unknown.detail, /possibly still running and nothing as approved/);
  assert.deepEqual([...unknown.actions], ["end-session"]);
});

test("other refusals: not used, no reopen of review, restart only for fill causes a clean session can fix", () => {
  for (const r of ALL().filter((x) => x.phase === "refused" && !checkpointStatus(x).boundaryInDoubt)) {
    const s = checkpointStatus(r);
    assert.equal(s.boundaryInDoubt, false);
    assert.ok(!s.actions.includes("reopen-decision-page"), label(r));
    assert.ok(s.actions.includes("end-session"));
    const restartable = r.stage === "fill" && (r.refusal === "check-unavailable" || (r.refusal === "drift" && r.detail.kind !== "link")
      || (r.refusal === "capture-refused" && Object.hasOwn(CONTENT_CODES, r.detail.kind)));
    assert.equal(s.actions.includes("restart-from-approved"), restartable, label(r));
    assert.equal(/Restart the fill/.test(s.next), restartable, `${label(r)} next matches actions`);
    assert.doesNotMatch(text(s), /retry(ing)? automatically|default mode|resume|continue the session/i);
  }
});

test("store outcome unknown keeps request identity and never says nothing was used", () => {
  const s = checkpointStatus(refused("store-outcome-unknown", null, "scaffold"));
  assert.match(s.detail, /may or may not have completed/);
  assert.match(s.detail, /keeps the request's identity/);
  assert.doesNotMatch(text(s), /Nothing from this attempt is used|rolled back|nothing was stored/i);
});

test("approved-unreadable follows the outside-recovery rule and offers no restart", () => {
  const s = checkpointStatus(refused("approved-unreadable"));
  assert.match(s.detail, /refuses until the launcher's storage is recovered outside/);
  assert.ok(!s.actions.includes("restart-from-approved"));
});

test("the agent notice only says to wait", () => {
  for (const r of [...ALL(), null]) {
    const n = checkpointStatus(r).agentNotice;
    if (n !== null) assert.equal(n, AGENT_WAIT, label(r ?? {}));
  }
  assert.doesNotMatch(AGENT_WAIT, /restart|recapture|approve|reshape|control window|decision page|token|secret|\bskel\b/i);
  for (const phase of ["stopping", "verifying-stop", "capturing", "awaiting-review", "checking", "checked"])
    assert.equal(checkpointStatus(report({ phase })).agentNotice, AGENT_WAIT, phase);
});

test("the decision page gets its own next step; it never points at actions it doesn't have", () => {
  for (const r of [...ALL(), null]) {
    const s = checkpointStatus(r);
    assert.doesNotMatch(s.pageNext, /Restart|from this window|End the session/, label(r ?? {}));
  }
  assert.equal(checkpointStatus(report({ phase: "awaiting-review" })).pageNext, "Review the stored snapshot on this page.");
});

test("checked is a future gate: not stored, not delivered, nothing in the checkout", () => {
  const s = checkpointStatus(report({ phase: "checked" }));
  assert.match(s.detail, /not durably stored and not handed to your project/);
  assert.match(s.detail, /open product decision/);
  assert.match(s.next, /Nothing has been written to your checkout/);
});

test("ended doesn't claim every process is gone", () => {
  const s = checkpointStatus(report({ phase: "ended" }));
  assert.match(s.headline, /reports the session ended/);
  assert.match(s.detail, /doesn't prove every process is gone/);
});

test("details name kind, path and line; hidden, combining and reordering characters are escaped", () => {
  for (const kind of DRIFT_KINDS) assert.match(checkpointStatus(refused("drift", { kind, path: "src/a.js", line: 7 })).headline, /in src\/a\.js at line 7\.$/, kind);
  for (const [ch, hex] of [["\u3164", "3164"], ["\u0336", "336"], ["\u034F", "34F"]]) {
    const s = checkpointStatus(refused("drift", { kind: "exterior", path: `src/x${ch}y.js`, line: null }));
    assert.match(s.headline, new RegExp(`\\\\u\\{${hex}\\}`), hex);
    assert.ok(!s.headline.includes(ch), hex);
  }
  const cap = checkpointStatus(refused("capture-refused", { kind: "CAPTURE_MARKERS", path: "a.js", line: null }, "scaffold"));
  assert.match(cap.headline, /CAPTURE_MARKERS/);
  assert.match(cap.next, /rewritten in a new session/);
});

test("malformed, impossible or inconsistent reports are refused and render as unknown", () => {
  const bad = [
    null, "running", [], { ...report(), extra: 1 }, report({ version: 2 }), report({ phase: "approved" }), report({ stage: "done" }),
    report({ round: "../x" }), report({ refusal: "teardown-unproven" }), report({ refusal: "drift" }), refused("nope"),
    refused("drift"), refused("capture-refused"), // these must say what
    refused("teardown-unproven", { kind: "exterior", path: null, line: null }),
    refused("drift", { kind: "CAPTURE_LINK", path: null, line: null }), refused("capture-refused", { kind: "exterior", path: null, line: null }),
    refused("capture-refused", { kind: "CAPTURE__", path: null, line: null }), refused("capture-refused", { kind: "toString", path: null, line: null }),
    refused("drift", { kind: "exterior", path: "", line: null }), refused("drift", { kind: "exterior", path: "a", line: 0 }),
    refused("drift", { kind: "exterior", path: null, line: 4 }), // line without a path
    refused("drift", { kind: "exterior", path: "/etc/shadow", line: null }), refused("drift", { kind: "exterior", path: "../../h/.ssh/id", line: null }),
    refused("drift", { kind: "exterior", path: "a\\b", line: null }), refused("drift", { kind: "exterior", path: "a/\0", line: null }),
    refused("drift", { kind: "exterior", path: "C:/x", line: null }), refused("drift", { kind: "exterior", path: "a\uD800b", line: null }),
    refused("drift", { kind: "exterior", path: "a", line: null, msg: "x" }),
    report({ phase: "checking", stage: "scaffold" }), report({ phase: "checked", stage: "scaffold" }), report({ phase: "restarting", stage: "scaffold" }),
    refused("drift", { kind: "exterior", path: null, line: null }, "scaffold"), refused("check-unavailable", null, "scaffold"),
    refused("restart-unproven", null, "scaffold"),
    Object.defineProperty(report(), "phase", { get: () => "running", enumerable: true }),
    new Proxy(report(), { ownKeys: () => { throw new Error("boom"); } }),
  ];
  for (const [i, b] of bad.entries()) {
    assert.equal(parseCheckpointReport(b), null, `case ${i}`);
    const s = checkpointStatus(b);
    assert.equal(s.phase, "unknown", `case ${i}`);
    assert.equal(s.detail, "The launcher's report was missing or malformed, so this window doesn't know what the session is doing. Treat the session as possibly still running and nothing as approved.");
  }
});

test("prototype: nothing in lib/bin loads the checkpoint status module", () => {
  for (const dir of ["lib", "bin"]) for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)))
    if (f !== "strict-checkpoint-status.mjs") assert.doesNotMatch(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8"), /strict-checkpoint-status/, f);
});

test("the standing note and agent notice have their exact reviewed wording", () => {
  assert.equal(NO_CLAIM, "Strict status remains unverified: this report is the launcher's account of its own steps, not proof that the boundary held.");
  assert.equal(AGENT_WAIT, "Stopped by the strict launcher. Wait for the human.");
});

test("every real CAPTURE_/ENUM_ code is mapped to exactly one group", () => {
  const src = (f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf8");
  const real = new Set([...`${src("strict-capture.mjs")}\n${src("strict-enumeration.mjs")}`.matchAll(/\b(?:CAPTURE|ENUM)_[A-Z_]+\b/g)].map((m) => m[0]));
  const groups = [CONTENT_CODES, BOUNDARY_CODES, LINK_CODES, HOST_CODES];
  for (const code of real) assert.equal(groups.filter((g) => Object.hasOwn(g, code)).length, 1, code);
  for (const g of groups) for (const code of Object.keys(g)) assert.ok(real.has(code), `${code} is not a real code`);
});

test("a vanished file or unlistable copy is a stop-in-doubt refusal, never session content", () => {
  for (const kind of ["CAPTURE_MISSING", "CAPTURE_CHANGED", "ENUM_CHANGED", "CAPTURE_LINK", "ENUM_UNAVAILABLE"]) {
    const s = checkpointStatus(refused("capture-refused", { kind, path: null, line: null }));
    assert.equal(s.boundaryInDoubt, true, kind);
    assert.doesNotMatch(s.detail, /something the session wrote/);
  }
});
test("only proven enumeration marker faults offer fill restart; unavailable remains uncertain", () => {
  const marker=checkpointStatus(refused("capture-refused", {kind:"ENUM_MARKERS",path:"plan.js",line:null}));
  assert.ok(Object.hasOwn(CONTENT_CODES,"ENUM_MARKERS"));
  assert.equal(marker.boundaryInDoubt,false);
  assert.ok(marker.actions.includes("restart-from-approved"));
  const uncertain=checkpointStatus(refused("capture-refused", {kind:"ENUM_UNAVAILABLE",path:null,line:null}));
  assert.equal(uncertain.boundaryInDoubt,true);
  assert.ok(!uncertain.actions.includes("restart-from-approved"));
});

test("host manifest/runtime faults never blame the session or offer restart", () => {
  for (const kind of ["CAPTURE_DUPLICATE", "ENUM_UNSUPPORTED_NAMES"]) {
    const s = checkpointStatus(refused("capture-refused", { kind, path: null, line: null }));
    assert.ok(Object.hasOwn(HOST_CODES, kind), kind);
    assert.ok(!s.actions.includes("restart-from-approved"), kind);
    assert.doesNotMatch(s.detail, /something the session wrote/);
  }
});

test("display paths follow safePath: byte limit and no format/separator characters", () => {
  for (const path of ["a/\u202Eb", "a\u2028b", "a\u2029b", "\u00e9".repeat(2049)])
    assert.equal(parseCheckpointReport(refused("drift", { kind: "exterior", path, line: null })), null, JSON.stringify(path.slice(0, 8)));
  assert.ok(parseCheckpointReport(refused("drift", { kind: "exterior", path: "\u00e9".repeat(2048), line: null })));
});

test("links never offer restart, and the copy says the session probably made them", () => {
  for (const r of [refused("drift", { kind: "link", path: "a", line: null }), refused("capture-refused", { kind: "ENUM_TYPE", path: null, line: null })]) {
    const s = checkpointStatus(r);
    assert.ok(!s.actions.includes("restart-from-approved"), label(r));
    assert.match(s.detail, /session probably created it/);
  }
});
