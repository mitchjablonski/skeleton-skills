// #151: bounded streaming control-terminal input parser (prototype).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createControlInput, CONTROL_INPUT_MAX_LINE, REJECT_REASONS } from "../lib/strict-control-input.mjs";

const PS = "\x1b[200~", PE = "\x1b[201~";
const bytes = (s) => Buffer.from(s, "latin1");
const L = (text) => ({ type: "line", text });
const R = (reason) => ({ type: "rejected", reason });
const INT = { type: "interrupt" };

// Feed `input` whole, byte by byte, and split at every offset; all must give `expected`.
function check(input, expected, { end = false } = {}) {
  const b = bytes(input);
  const run = (chunks) => {
    const p = createControlInput();
    const out = [];
    for (const c of chunks) out.push(...p.push(c));
    if (end) out.push(...p.end());
    return out;
  };
  assert.deepEqual(run([b]), expected, `whole: ${JSON.stringify(input)}`);
  assert.deepEqual(run([...b].map((x) => Uint8Array.of(x))), expected, `bytewise: ${JSON.stringify(input)}`);
  for (let i = 1; i < b.length; i++) assert.deepEqual(run([b.subarray(0, i), b.subarray(i)]), expected, `split@${i}: ${JSON.stringify(input)}`);
}

test("a typed line is accepted only at Enter; CR, LF and CRLF each submit once", () => {
  check("approve K7M2-QX9D\r", [L("approve K7M2-QX9D")]);
  check("status\n", [L("status")]);
  check("status\r\n", [L("status")]);
  check("a\r\nb\r\n\r\n", [L("a"), L("b"), L("")]);
  check("partial", []);
  check("partial", [R("incomplete")], { end: true });
});

test("printable pastes are part of the line and never submit on their own", () => {
  check(`approve ${PS}K7M2-QX9D${PE}`, []);
  check(`approve ${PS}K7M2-QX9D${PE}\r`, [L("approve K7M2-QX9D")]);
  check(`${PS}approve K7M2-QX9D${PE}\r`, [L("approve K7M2-QX9D")]);
});

test("a multi-line or control-bearing paste rejects the whole line, once, and never becomes several commands", () => {
  check(`${PS}approve K7M2-QX9D\nyes\n${PE}\r`, [R("paste-content")]);
  check(`${PS}approve K7M2-QX9D\r\nyes${PE}\r`, [R("paste-content")]);
  for (const bad of ["\t", "\x1b", "\x7f", "\x00", "\x85", "\x9b", "\xe9"])
    check(`${PS}ab${bad}cd${PE}\r`, [R("paste-content")]);
});

test("an invalid byte anywhere rejects the line: no prefix is ever emitted first", () => {
  check("app\x01rove K7M2-QX9D\r", [R("unsupported-byte")]);
  check("approve K7M2\xe9\r", [R("unsupported-byte")]);
  check("approve \x1b[A K7\r", [R("escape")]); // an arrow key
  check("ok\rbad\x02\rok2\r", [L("ok"), R("unsupported-byte"), L("ok2")]);
});

test("malformed paste framing rejects the line", () => {
  check(`${PS}a${PS}b${PE}\r`, [R("malformed-paste")]);
  check(`a${PE}b\r`, [R("malformed-paste")]);
});

test("an unclosed paste discards input, including Enters, until its end marker or end()", () => {
  check(`${PS}approve X\ryes\r`, []);
  check(`${PS}approve X\ryes\r`, [R("incomplete")], { end: true });
  check(`${PS}junk\r${PE}\rnext\r`, [R("paste-content"), L("next")]);
});

test("over-long lines are rejected with overflow, typed or pasted, and the buffer stays bounded", () => {
  const max = CONTROL_INPUT_MAX_LINE;
  check(`${"x".repeat(max)}\r`, [L("x".repeat(max))]);
  check(`${"x".repeat(max + 1)}\r`, [R("overflow")]);
  check(`${PS}${"y".repeat(max + 50)}${PE}\r`, [R("overflow")]);
  const p = createControlInput({ maxLine: 5 });
  assert.deepEqual([...p.push(bytes("123456\r"))], [R("overflow")]);
  assert.throws(() => createControlInput({ maxLine: max + 1 }), RangeError);
  assert.throws(() => createControlInput({ maxLine: 0 }), RangeError);
});

test("editing keys: Backspace and DEL delete, Ctrl-U clears, Ctrl-C interrupts", () => {
  check("aprx\x7f\x08prove\r", [L("approve")]);
  check("garbage\x15status\r", [L("status")]);
  check("half\x03status\r", [INT, L("status")]);
  check("bad\x02\x15ok\r", [L("ok")], {}); // Ctrl-U clears a poisoned line too
});

test("a huge unclosed paste or many chunks never grows state beyond the bounds", () => {
  const p = createControlInput();
  p.push(bytes(PS));
  for (let i = 0; i < 2000; i++) assert.deepEqual([...p.push(bytes("z".repeat(1000) + "\r"))], []);
  assert.deepEqual([...p.push(bytes(`${PE}\rok\r`))], [R("overflow"), L("ok")]);
});

test("reset drops all state silently; end reports an unfinished escape", () => {
  const p = createControlInput();
  p.push(bytes(`half ${PS}pa`));
  p.reset();
  assert.deepEqual([...p.push(bytes("status\r"))], [L("status")]);
  assert.deepEqual([...p.push(bytes("\x1b[20"))], []);
  assert.deepEqual([...p.end()], [R("incomplete")]);
  assert.deepEqual([...p.end()], []);
});

test("events are frozen and exact, reasons are generic and never echo input", () => {
  const p = createControlInput();
  const out = p.push(bytes("hello\rbad\x01secret\r"));
  assert.ok(Object.isFrozen(out) && out.every(Object.isFrozen));
  assert.deepEqual(Object.keys(out[0]), ["type", "text"]);
  assert.deepEqual(Object.keys(out[1]), ["type", "reason"]);
  assert.ok(REJECT_REASONS.includes(out[1].reason));
  assert.ok(!JSON.stringify(out[1]).includes("secret"));
});

test("only real Uint8Arrays are accepted: no strings, coercion, proxies or getters", () => {
  const p = createControlInput();
  for (const bad of ["status\r", [115, 13], { length: 1, 0: 13 }, null, 42, new Proxy(new Uint8Array([13]), {})])
    assert.throws(() => p.push(bad), TypeError);
  let touched = false;
  const sneaky = new Uint8Array([111, 107, 13]);
  Object.defineProperty(sneaky, "length", { get() { touched = true; return 0; } });
  assert.deepEqual([...p.push(sneaky)], [L("ok")]);
  assert.equal(touched, false, "the length getter is never consulted");
});

test("prototype: imports nothing, and nothing in lib/bin loads it", () => {
  const src = readFileSync(new URL("../lib/strict-control-input.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), /^import /m);
  for (const dir of ["lib", "bin"]) for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)))
    if (f !== "strict-control-input.mjs") assert.doesNotMatch(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8"), /strict-control-input/, f);
});
