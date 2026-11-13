// #77 control-window console logic (H3 proposal), against a scripted mock authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createControlConsole, normalizeCode, acceptInput, CONTROL_BANNER, CONSOLE_COPY } from "../lib/strict-control-console.mjs";
import { CONTROL_BANNER as PAGE_BANNER, DECISION_CODE_RE } from "../lib/strict-decision-codes.mjs";

const A = "a".repeat(64), B = "b".repeat(64);
function mock(script = {}) {
  const calls = [];
  const next = (name, arg) => { calls.push({ name, arg }); const q = script[name] ?? []; const r = q.length > 1 ? q.shift() : q[0]; return typeof r === "function" ? r(arg) : r; };
  return {
    calls,
    authority: {
      verifyAndCommit: async (a) => next("verify", a),
      recapture: async (a) => next("recapture", a),
      state: async () => next("state"),
    },
  };
}
const committed = (action = "approve", revision = 8) => ({ kind: "committed", action, revision, reviewVersion: A, captureVersion: B });
let ids = 0;
const make = (script) => { const m = mock(script); return { m, c: createControlConsole({ authority: m.authority, newRequestId: () => `req-${++ids}` }) }; };

test("code normalisation and input policy", () => {
  assert.equal(normalizeCode("k7m2-qx9d"), "K7M2-QX9D");
  assert.equal(normalizeCode("K7M2 QX9D"), "K7M2-QX9D");
  assert.equal(normalizeCode("k7m2qx9d"), "K7M2-QX9D");
  assert.equal(normalizeCode("IOLL-0000"), "1011-0000");
  for (const bad of ["K7M2-QX9", "K7M2-QX9DD", "K7U2-QX9D", "K7M2_QX9D", "", null]) assert.equal(normalizeCode(bad), null, String(bad));
  assert.equal(acceptInput("approve K7M2-QX9D"), "approve K7M2-QX9D");
  for (const bad of ["approve\nyes", "approve\r", "\x1b]52;c;Zm9v\x07", "approve \x9b2J", "approve K7M2 ", "é", "x".repeat(201)])
    assert.equal(acceptInput(bad), null, JSON.stringify(bad));
  assert.equal(acceptInput("approve\tK7M2", { paste: true }), null);
});

test("banner and code format match the decision page", () => {
  assert.equal(CONTROL_BANNER, PAGE_BANNER);
  for (const typed of ["k7m2 qx9d", "K7M2-QX9D", "iolz-0000"]) assert.match(normalizeCode(typed), DECISION_CODE_RE);
});

test("approve sends the normalised code with a fresh request id and echoes the committed reply", async () => {
  const { m, c } = make({ verify: [committed()] });
  const out = await c.handle("approve k7m2 qx9d");
  assert.equal(m.calls[0].arg.code, "K7M2-QX9D");
  assert.match(m.calls[0].arg.requestId, /^req-\d+$/);
  assert.deepEqual(out, [`Recorded: approve · shape ${A.slice(0, 12)}… · capture ${B.slice(0, 12)}… · revision 8.`]);
  assert.equal(c.kept(), null);
});

test("unknown outcomes keep the request; retyping is refused; retry resends the same id after yes", async () => {
  for (const unknown of [{ kind: "unavailable" }, { kind: "rejected", code: "unavailable" }, () => { throw new Error("socket"); }, { kind: "committed", action: "reshape", revision: 1, reviewVersion: A, captureVersion: B }, { junk: 1 }, null]) {
    const { m, c } = make({ verify: [unknown, committed()] });
    await c.handle("approve K7M2-QX9D");
    const first = m.calls[0].arg.requestId;
    assert.ok(c.kept(), JSON.stringify(unknown));
    assert.deepEqual(await c.handle("approve M3P8-4TWZ"), [CONSOLE_COPY.keptBlocksNew]);
    assert.equal(m.calls.length, 1, "nothing sent while a request is kept");
    const prompt = await c.handle("retry");
    assert.match(prompt[0], /Resend the earlier approve request with the same request id/);
    assert.equal(m.calls.length, 1, "retry waits for yes");
    const out = await c.handle("yes");
    assert.equal(m.calls[1].arg.requestId, first, "same request id");
    assert.equal(m.calls[1].arg.code, "K7M2-QX9D");
    assert.match(out[0], /^Recorded: approve/);
    assert.equal(c.kept(), null);
  }
});

test("retry cancels on anything but yes; nothing to retry when nothing is kept", async () => {
  const { m, c } = make({ verify: [{ kind: "unavailable" }] });
  assert.deepEqual(await c.handle("retry"), [CONSOLE_COPY.nothingToRetry]);
  await c.handle("approve K7M2-QX9D");
  await c.handle("retry");
  assert.deepEqual(await c.handle("y"), [CONSOLE_COPY.cancelled]);
  assert.equal(m.calls.length, 1);
  assert.ok(c.kept(), "cancelling keeps the request");
});

test("mismatch is generic, shows current state and attempts, never echoes the code", async () => {
  const { c } = make({ verify: [{ kind: "mismatch", revision: 9, reviewVersion: A, captureVersion: B, attemptsLeft: 1 }] });
  const out = await c.handle("approve K7M2-QX9D");
  assert.match(out[0], /doesn't match the snapshot under review now. Nothing was recorded/);
  assert.match(out[1], /revision 9/);
  assert.equal(out[2], "1 attempt left in this review round.");
  assert.ok(!out.join(" ").includes("K7M2"));
  assert.doesNotMatch(out.join(" "), /older|stale|mistyp|wrong action/i, "no history oracle");
  assert.equal(c.kept(), null);
});

test("locked rounds name the unlock for the phase", async () => {
  for (const unlock of ["recapture", "new-session"]) {
    const { c } = make({ verify: [{ kind: "locked", unlock }] });
    assert.deepEqual(await c.handle("reshape K7M2-QX9D"), [CONSOLE_COPY.locked[unlock]]);
  }
});

test("recapture needs yes; with a kept request it warns and abandons it", async () => {
  const { m, c } = make({ verify: [{ kind: "unavailable" }], recapture: [{ kind: "recaptured", changed: true, revision: 3, reviewVersion: A, captureVersion: B }] });
  await c.handle("approve K7M2-QX9D");
  const prompt = await c.handle("recapture");
  assert.equal(prompt[0], CONSOLE_COPY.recaptureAbandons);
  assert.equal(m.calls.filter((x) => x.name === "recapture").length, 0);
  const out = await c.handle("yes");
  assert.match(out[0], /new snapshot is under review/);
  assert.equal(c.kept(), null);
  const { c: c2 } = make({ recapture: [{ kind: "refused", reason: "fill-phase" }] });
  assert.deepEqual(await c2.handle("recapture"), ["Take a fresh snapshot of the stopped project for review?", CONSOLE_COPY.confirmPrompt]);
  assert.deepEqual(await c2.handle("yes"), [CONSOLE_COPY.recaptureRefused["fill-phase"]]);
});

test("definitive rejections drop the request; unavailable keeps it", async () => {
  for (const code of ["stale-review", "revision-conflict", "invalid-transition", "unauthorized-channel", "session-ended", "request-reused"]) {
    const { c } = make({ verify: [{ kind: "rejected", code }] });
    const out = await c.handle("approve K7M2-QX9D");
    assert.equal(out[0], CONSOLE_COPY.rejected[code]);
    assert.equal(c.kept(), null, code);
  }
});

test("output never echoes raw input or authority-supplied text, and holds no control characters", async () => {
  const evil = "\x1b]0;APPROVED\x07";
  const { c } = make({
    verify: [{ kind: "committed", action: "approve", revision: 2, reviewVersion: `${A}${evil}`, captureVersion: B }, { kind: "rejected", code: `stale-review${evil}` }],
    state: [{ phase: "skeleton", revision: 1, reviewVersion: A, captureVersion: `${B} APPROVED` }],
  });
  const outs = [];
  for (const line of ["approve K7M2-QX9D", "retry", "yes", "hello-unique-input", "approve NOTACODE!", "status", `approve ${evil}`])
    outs.push(...await c.handle(line));
  const text = outs.join("\n");
  assert.doesNotMatch(text, /[\x00-\x09\x0B-\x1F\x7F-\x9F]/);
  assert.ok(!text.includes("hello-unique-input") && !text.includes("NOTACODE") && !text.includes("APPROVED"));
  assert.match(text, /malformed/);
});

test("status prints validated state and mentions a kept request", async () => {
  const { c } = make({ verify: [{ kind: "unavailable" }], state: [{ phase: "skeleton", revision: 4, reviewVersion: A, captureVersion: B }] });
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
