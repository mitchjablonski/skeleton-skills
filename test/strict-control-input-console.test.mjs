// #124/#99 composition fixture. Bytes here are fixed synthetic input with no
// terminal attached. The fixture provides no claim about terminal trust or human origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlInput } from "../lib/strict-control-input.mjs";
import { createControlConsole, CONSOLE_COPY as C } from "../lib/strict-control-console.mjs";

const PS = "\x1b[200~", PE = "\x1b[201~";
const CODE = "M3P8-4TWZ";
const HIDDEN = "fixture-hidden-value";
const A = "a".repeat(64), B = "b".repeat(64), AT = "2026-11-13T04:00:00Z";

function fixture({ loseFirstReply = false, bytewise = false } = {}) {
  const input = createControlInput();
  const calls = [];
  let ids = 0;
  const authority = {
    async verifyAndCommit(request) {
      calls.push({ method: "verifyAndCommit", request });
      if (loseFirstReply && calls.length === 1) throw new Error(HIDDEN);
      return {
        kind: "committed", action: request.action, requestId: request.requestId,
        revision: 8, reviewVersion: A, captureVersion: B, at: AT,
      };
    },
    async recapture(request) { calls.push({ method: "recapture", request }); },
    async endSession(request) { calls.push({ method: "endSession", request }); },
    async state() { calls.push({ method: "state" }); },
  };
  const console = createControlConsole({ authority, newRequestId: () => `req-${++ids}` });

  async function feed(text) {
    const bytes = Buffer.from(text, "latin1");
    const chunks = bytewise ? [...bytes].map((byte) => Uint8Array.of(byte)) : [bytes];
    const lines = [];
    for (const chunk of chunks) {
      for (const event of input.push(chunk)) {
        if (event.type === "line") {
          lines.push(...await console.handle(event.text));
        } else {
          assert.ok(event.type === "rejected" || event.type === "interrupt");
          // Exercise the console's input refusal with a fixed invalid value.
          // This dispatch is only for the fixture.
          lines.push(...await console.handle(null));
        }
      }
    }
    for (const line of lines) {
      assert.ok(!line.includes(CODE) && !line.includes(HIDDEN), "console copy exposed a fixture value");
    }
    return lines;
  }

  return { feed, calls, kept: console.kept };
}

const decisionCall = {
  method: "verifyAndCommit",
  request: { action: "approve", code: CODE, requestId: "req-1" },
};
const recorded = [`Recorded: approve · shape ${A.slice(0, 12)}… · capture ${B.slice(0, 12)}… · revision 8 · ${AT}.`];

test("plain and printable-pasted bytes need Enter before a decision is sent", async () => {
  for (const bytewise of [false, true]) {
    for (const command of [`approve ${CODE}`, `approve ${PS}${CODE}${PE}`]) {
      const { feed, calls } = fixture({ bytewise });
      assert.deepEqual(await feed(command), []);
      assert.deepEqual(calls, []);
      assert.deepEqual(await feed("\r\n"), recorded);
      assert.deepEqual(calls, [decisionCall]);
    }
  }
});

test("bad paste bytes and interrupts cancel a pending console confirmation", async () => {
  for (const bytewise of [false, true]) {
    for (const bad of [`\n${HIDDEN}`, `\r\n${HIDDEN}`, `\t${HIDDEN}`, `\x03${HIDDEN}`]) {
      const { feed, calls } = fixture({ bytewise });
      assert.equal((await feed("recapture\r")).at(-1), C.confirmPrompt);
      assert.deepEqual(await feed(`${PS}yes${bad}`), []);
      assert.deepEqual(await feed(PE), []);
      assert.deepEqual(calls, []);
      assert.deepEqual(await feed("\ryes\r"), [C.refusedInput, C.unknownCommand]);
      assert.deepEqual(calls, []);
    }

    const { feed, calls } = fixture({ bytewise });
    assert.equal((await feed("recapture\r")).at(-1), C.confirmPrompt);
    assert.deepEqual(await feed("ye\x03yes\r"), [C.refusedInput, C.unknownCommand]);
    assert.deepEqual(calls, []);
  }
});

test("a lost reply is retried with the original request after a submitted yes", async () => {
  for (const bytewise of [false, true]) {
    const { feed, calls, kept } = fixture({ bytewise, loseFirstReply: true });
    assert.deepEqual(await feed(`approve ${CODE}\r`), [C.unknownOutcome]);
    assert.deepEqual(calls, [decisionCall]);
    assert.equal(kept()?.requestId, decisionCall.request.requestId);
    assert.equal((await feed("retry\r")).at(-1), C.confirmPrompt);
    assert.deepEqual(await feed(`${PS}yes${PE}`), []);
    assert.deepEqual(calls, [decisionCall]);
    assert.deepEqual(await feed("\r"), recorded);
    assert.deepEqual(calls, [decisionCall, decisionCall]);
    assert.equal(kept(), null);
  }
});
