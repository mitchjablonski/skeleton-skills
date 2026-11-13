// #77 control-window console logic (H3 proposal), against a scripted mock authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createControlConsole, normalizeCode, acceptInput, CONTROL_BANNER, CONSOLE_COPY as C } from "../lib/strict-control-console.mjs";
import { CONTROL_BANNER as PAGE_BANNER, DECISION_CODE_RE } from "../lib/strict-decision-codes.mjs";

const A = "a".repeat(64), B = "b".repeat(64), AT = "2026-11-13T04:00:00Z";
// Script entries are functions of the request (so they can echo requestId) or plain replies.
function mock(script = {}) {
  const calls = [];
  const next = (name, arg) => { calls.push({ name, arg }); const q = script[name] ?? []; const r = q.length > 1 ? q.shift() : q[0]; return typeof r === "function" ? r(arg) : r; };
  return { calls, authority: {
    verifyAndCommit: async (a) => next("verify", a), recapture: async (a) => next("recapture", a),
    endSession: async (a) => next("end", a), state: async () => next("state"),
  } };
}
const echo = (body) => (arg) => ({ requestId: arg.requestId, ...body });
const committed = (action = "approve", o = {}) => echo({ kind: "committed", action, revision: 8, reviewVersion: A, captureVersion: B, at: AT, ...o });
const mismatch = echo({ kind: "mismatch", revision: 9, reviewVersion: A, captureVersion: B, attemptsLeft: 1 });
const unavailable = echo({ kind: "unavailable" });
let ids = 0;
const make = (script) => { const m = mock(script); return { m, c: createControlConsole({ authority: m.authority, newRequestId: () => `req-${++ids}` }) }; };
const keepThenRetry = async (c) => { await c.handle("approve K7M2-QX9D"); await c.handle("retry"); return c.handle("yes"); };

test("code normalisation and input policy", () => {
  assert.equal(normalizeCode("k7m2 qx9d"), "K7M2-QX9D");
  assert.equal(normalizeCode("IOLL-0000"), "1011-0000");
  for (const bad of ["K7M2-QX9", "K7M2-QX9DD", "K7U2-QX9D", "K7M2_QX9D", "", null]) assert.equal(normalizeCode(bad), null, String(bad));
  for (const bad of ["approve\nyes", "approve\r", "\x1b]52;c;Zm9v\x07", "approve \x9b2J", "approve\tK7M2", "a b", "a​b", "a\x7fb", "x".repeat(201)])
    assert.equal(acceptInput(bad), null, JSON.stringify(bad));
  assert.equal(acceptInput("  approve K7M2-QX9D "), "approve K7M2-QX9D");
});

test("banner and code format match the decision page", () => {
  assert.equal(CONTROL_BANNER, PAGE_BANNER);
  for (const typed of ["k7m2 qx9d", "iolz-0000"]) assert.match(normalizeCode(typed), DECISION_CODE_RE);
});

test("approve echoes the committed reply (with time) after commit", async () => {
  const { m, c } = make({ verify: [committed()] });
  const out = await c.handle("approve k7m2 qx9d");
  assert.equal(m.calls[0].arg.code, "K7M2-QX9D");
  assert.deepEqual(out, [`Recorded: approve · shape ${A.slice(0, 12)}… · capture ${B.slice(0, 12)}… · revision 8 · ${AT}.`]);
  assert.equal(c.kept(), null);
});

test("one request in flight: concurrent commands are refused, so replies can't race", async () => {
  let release;
  const { m, c } = make({ verify: [() => new Promise((r) => { release = r; })], state: [{ phase: "skeleton", revision: 1, reviewVersion: A, captureVersion: B }] });
  const first = c.handle("approve K7M2-QX9D");
  assert.deepEqual(await c.handle("reshape M3P8-4TWZ"), [C.busy]);
  assert.deepEqual(await c.handle("recapture"), [C.busy]);
  assert.match((await c.handle("status")).join(" "), /being sent/);
  assert.equal(m.calls.filter((x) => x.name === "verify").length, 1);
  release({ kind: "unavailable", requestId: m.calls[0].arg.requestId });
  assert.deepEqual(await first, [C.unknownOutcome]);
  assert.ok(c.kept());
});

test("unknown outcomes keep the request; retyping is refused; retry resends the same id and code after yes", async () => {
  const unknowns = [unavailable, echo({ kind: "rejected", code: "unavailable" }), () => { throw new Error("socket"); },
    committed("reshape"), committed("approve", { at: "yesterday" }), committed("approve", { reviewVersion: `${A}\x1b]0;X\x07` }),
    committed("approve", { revision: -1 }), (a) => ({ kind: "committed", action: "approve", revision: 1, reviewVersion: A, captureVersion: B, at: AT, requestId: `${a.requestId}x` }),
    () => ({ get kind() { throw new Error("boom"); } }), () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } }),
    echo({ junk: 1 }), null];
  for (const [i, unknown] of unknowns.entries()) {
    const { m, c } = make({ verify: [unknown, committed()] });
    const out = await c.handle("approve K7M2-QX9D");
    assert.ok([C.unknownOutcome, C.malformedReply].includes(out[0]), `case ${i}: ${out}`);
    assert.ok(c.kept(), `case ${i}`);
    assert.deepEqual(await c.handle("approve M3P8-4TWZ"), [C.keptBlocksNew], `case ${i}`);
    await c.handle("retry");
    const done = await c.handle("yes");
    assert.equal(m.calls[1].arg.requestId, m.calls[0].arg.requestId, `case ${i}`);
    assert.equal(m.calls[1].arg.code, "K7M2-QX9D");
    assert.match(done[0], /^Recorded: approve/, `case ${i}`);
  }
});

test("answers to a resend that can't settle the original keep the request", async () => {
  const cant = [echo({ kind: "rejected", code: "unauthorized-channel" }), echo({ kind: "rejected", code: "session-ended" }),
    echo({ kind: "rejected", code: "request-reused" }), mismatch, echo({ kind: "locked", unlock: "recapture" }), echo({ kind: "journal-full" })];
  for (const [i, reply] of cant.entries()) {
    const { c } = make({ verify: [unavailable, reply] });
    assert.deepEqual(await keepThenRetry(c), [C.stillUnknown], `case ${i}`);
    assert.ok(c.kept(), `case ${i}`);
    assert.deepEqual(await c.handle("approve M3P8-4TWZ"), [C.keptBlocksNew], `case ${i}`);
  }
  // stale-review/revision-conflict/invalid-transition come after the journal lookup: never recorded, even on a resend.
  for (const code of ["stale-review", "revision-conflict", "invalid-transition"]) {
    const { c } = make({ verify: [unavailable, echo({ kind: "rejected", code })] });
    assert.deepEqual(await keepThenRetry(c), [C.rejectedDecision[code]]);
    assert.equal(c.kept(), null, code);
  }
});

test("first-send refusals say this request made no change and clear nothing-kept", async () => {
  for (const code of ["stale-review", "revision-conflict", "invalid-transition", "unauthorized-channel", "session-ended", "request-reused"]) {
    const { c } = make({ verify: [echo({ kind: "rejected", code })] });
    const out = await c.handle("approve K7M2-QX9D");
    assert.equal(out[0], C.rejectedDecision[code]);
    assert.doesNotMatch(out[0], /earlier send/);
    assert.equal(c.kept(), null, code);
  }
  const { c } = make({ verify: [echo({ kind: "journal-full" })] });
  assert.deepEqual(await c.handle("approve K7M2-QX9D"), [C.journalFull]);
  assert.equal(c.kept(), null);
});

test("record-unreadable keeps the request and says a retry won't help", async () => {
  const { c } = make({ verify: [echo({ kind: "record-unreadable" })] });
  assert.deepEqual(await c.handle("approve K7M2-QX9D"), [C.recordUnreadable]);
  assert.ok(c.kept());
});

test("mismatch on a first send is generic, shows state and attempts, never echoes the code", async () => {
  const { c } = make({ verify: [mismatch] });
  const out = await c.handle("approve K7M2-QX9D");
  assert.match(out[0], /doesn't match the snapshot under review now. Nothing was recorded/);
  assert.match(out[1], /revision 9/);
  assert.equal(out[2], "1 attempt left in this review round.");
  assert.ok(!out.join(" ").includes("K7M2"));
  assert.doesNotMatch(out.join(" "), /older|stale|mistyp|wrong action/i);
  assert.equal(c.kept(), null);
  const { c: c2 } = make({ verify: [echo({ kind: "mismatch", revision: 9, reviewVersion: A, captureVersion: B, attemptsLeft: -1 })] });
  assert.deepEqual(await c2.handle("approve K7M2-QX9D"), [C.malformedReply]);
  assert.ok(c2.kept());
});

test("locked rounds name the unlock and clear", async () => {
  for (const unlock of ["recapture", "new-session"]) {
    const { c } = make({ verify: [echo({ kind: "locked", unlock })] });
    assert.deepEqual(await c.handle("reshape K7M2-QX9D"), [C.locked[unlock]]);
    assert.equal(c.kept(), null);
  }
});

test("recapture: needs yes, warns and abandons a kept request, reports changed/unchanged/refused", async () => {
  const { m, c } = make({ verify: [unavailable], recapture: [echo({ kind: "recaptured", changed: true, revision: 3, reviewVersion: A, captureVersion: B }),
    echo({ kind: "recaptured", changed: false, revision: 3, reviewVersion: A, captureVersion: B }), echo({ kind: "refused", reason: "fill-phase" }),
    echo({ kind: "recaptured", changed: "yes", revision: 3, reviewVersion: A, captureVersion: B })] });
  await c.handle("approve K7M2-QX9D");
  assert.equal((await c.handle("recapture"))[0], C.recaptureAbandons);
  assert.equal(m.calls.filter((x) => x.name === "recapture").length, 0);
  assert.match((await c.handle("yes"))[0], /new snapshot is under review/);
  assert.equal(c.kept(), null);
  await c.handle("recapture"); assert.deepEqual(await c.handle("yes"), ["Recaptured: the snapshot is unchanged · revision 3."]);
  await c.handle("recapture"); assert.deepEqual(await c.handle("yes"), [C.recaptureRefused["fill-phase"]]); assert.equal(c.kept(), null);
  await c.handle("recapture"); assert.deepEqual(await c.handle("yes"), [C.malformedReply]); assert.ok(c.kept(), "malformed recapture keeps it");
  const { c: c3 } = make({ recapture: [echo({ kind: "rejected", code: "stale-review" })] });
  await c3.handle("recapture");
  assert.deepEqual(await c3.handle("yes"), [C.rejectedRecapture["stale-review"]]);
  assert.doesNotMatch(C.rejectedRecapture["stale-review"], /code/);
});

test("end: needs yes, warns about a kept request, then every command but status/help is refused", async () => {
  const { m, c } = make({ verify: [unavailable], end: [echo({ kind: "ended" })] });
  await c.handle("approve K7M2-QX9D");
  assert.equal((await c.handle("end"))[0], C.endAbandons);
  await c.handle("yes");
  assert.ok(c.ended());
  assert.equal(c.kept(), null);
  assert.deepEqual(await c.handle("approve M3P8-4TWZ"), [C.ended]);
  assert.deepEqual(await c.handle("retry"), [C.ended]);
  assert.equal(m.calls.filter((x) => x.name === "end").length, 1);
  const { c: c2 } = make({ end: [() => { throw new Error("x"); }] });
  await c2.handle("end"); assert.deepEqual(await c2.handle("yes"), [C.endUnknown]); assert.equal(c2.ended(), false);
});

test("prompts: anything but yes cancels; a refused input line cancels too; extra words are refused", async () => {
  const { m, c } = make({ verify: [unavailable], recapture: [echo({ kind: "recaptured", changed: false, revision: 1, reviewVersion: A, captureVersion: B })] });
  assert.deepEqual(await c.handle("retry"), [C.nothingToRetry]);
  await c.handle("recapture");
  assert.deepEqual(await c.handle("approve K7M2-QX9D\nyes"), [C.refusedInput]);
  assert.deepEqual(await c.handle("yes"), [C.unknownCommand], "the prompt was cancelled; a bare yes is just unknown");
  assert.equal(m.calls.filter((x) => x.name === "recapture").length, 0);
  await c.handle("approve K7M2-QX9D");
  await c.handle("retry");
  assert.deepEqual(await c.handle("y"), [C.cancelled]);
  assert.ok(c.kept());
  for (const cmd of ["retry foo", "recapture now", "end please"]) assert.deepEqual(await c.handle(cmd), [C.unknownCommand], cmd);
});

test("output never echoes raw input or authority-supplied text, and holds no control characters", async () => {
  const evil = "\x1b]0;APPROVED\x07";
  const { c } = make({
    verify: [committed("approve", { reviewVersion: `${A}${evil}` }), echo({ kind: "rejected", code: `stale-review${evil}` })],
    state: [{ phase: `skeleton${evil}`, revision: 1, reviewVersion: A, captureVersion: B }],
  });
  const outs = [];
  for (const line of ["approve K7M2-QX9D", "retry", "yes", "hello-unique-input", "approve NOTACODE!", "status", `approve ${evil}`]) outs.push(...await c.handle(line));
  const text = outs.join("\n");
  assert.doesNotMatch(text, /[\x00-\x09\x0B-\x1F\x7F-\x9F]/);
  assert.ok(!text.includes("hello-unique-input") && !text.includes("NOTACODE") && !text.includes("APPROVED"));
  assert.equal(outs[0], C.malformedReply);
  assert.equal(outs.filter((l) => l === C.malformedReply).length, 2);
  assert.ok(outs.some((l) => /state is unknown/.test(l)), "malformed state phase is not printed");
});

test("status prints validated state and mentions a kept request", async () => {
  const { c } = make({ verify: [unavailable], state: [{ phase: "skeleton", revision: 4, reviewVersion: A, captureVersion: B }] });
  await c.handle("approve K7M2-QX9D");
  const out = await c.handle("status");
  assert.match(out[0], /^Phase skeleton · shape a{12}… · capture b{12}… · revision 4\.$/);
  assert.match(out[1], /outcome is unknown/);
});

test("prototype: pure (no I/O imports), and nothing in lib/bin loads it", () => {
  const src = readFileSync(new URL("../lib/strict-control-console.mjs", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["./strict-protocol.mjs"]);
  for (const bad of [/node:/, /process\./, /fetch\(/, /crypto|hmac/i]) assert.doesNotMatch(src, bad);
  for (const dir of ["lib", "bin"]) for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)))
    if (f !== "strict-control-console.mjs") assert.doesNotMatch(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8"), /strict-control-console/, f);
});

test("a failing request-id factory sends nothing and never abandons a pending retry", async () => {
  let fail = false, n = 0;
  const m = mock({ verify: [unavailable], recapture: [echo({ kind: "recaptured", changed: false, revision: 1, reviewVersion: A, captureVersion: B })], end: [echo({ kind: "ended" })] });
  const c = createControlConsole({ authority: m.authority, newRequestId: () => { if (fail) throw new Error("rng"); return `id-${++n}`; } });
  await c.handle("approve K7M2-QX9D");
  const before = c.kept();
  fail = true;
  for (const cmd of ["recapture", "end"]) {
    await c.handle(cmd);
    assert.deepEqual(await c.handle("yes"), [C.noRequestId], cmd);
    assert.deepEqual(c.kept(), before, `${cmd} kept the pending retry`);
  }
  const fresh = createControlConsole({ authority: m.authority, newRequestId: () => "bad id with spaces" });
  assert.deepEqual(await fresh.handle("approve K7M2-QX9D"), [C.noRequestId]);
  assert.equal(m.calls.filter((x) => x.name !== "verify").length, 0, "nothing else was sent");
  assert.equal(m.calls.length, 1);
});
