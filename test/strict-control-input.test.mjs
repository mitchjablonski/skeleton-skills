// #151: bounded streaming control-terminal input parser (prototype).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createControlInput, CONTROL_INPUT_MAX_LINE, CONTROL_INPUT_MAX_CHUNK, CONTROL_INPUT_MAX_PASTE_DEPTH, REJECT_REASONS } from "../lib/strict-control-input.mjs";

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
  check(`${PS}a${PS}b${PE}\r`, []); // still inside the outer paste
  check(`${PS}a${PS}b${PE}${PE}\r`, [R("malformed-paste")]);
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
  for (const bad of ["status\r", [115, 13], { length: 1, 0: 13 }, null, 42, new Proxy(new Uint8Array([13]), {})]) {
    assert.throws(() => p.push(bad), TypeError);
    p.reset();
  }
  let touched = false;
  const sneaky = new Uint8Array([111, 107, 13]);
  Object.defineProperty(sneaky, "length", { get() { touched = true; return 0; } });
  assert.deepEqual([...p.push(sneaky)], [L("ok")]);
  assert.equal(touched, false, "the length getter is never consulted");
});

test("a lone Esc never swallows the next marker, Enter or Ctrl-C", () => {
  check(`\x1b${PS}junk\rapprove K7M2-QX9D\r${PE}\r`, [R("escape")]);
  check(`\x1b[${PS}x\rstatus\r${PE}\r`, [R("escape")]);
  check(`\x1b${PS}ok${PE}\r`, [R("escape")]);
  check("ok\x1b\rmore\r", [R("escape"), L("more")]);
  check("x\x1b\x03ok\r", [INT, L("ok")]);
  check(`${PS}ab\x1b${PE}\rnext\r`, [R("paste-content"), L("next")]);
});

test("inside a paste, Ctrl-C and Enter are content: they poison and never interrupt or submit", () => {
  check(`${PS}a\x03b\rc${PE}\r`, [R("paste-content")]);
});

test("end() and reset() fully clear paste, CR and poison state", () => {
  const p = createControlInput();
  p.push(bytes(`${PS}half`));
  const e = p.end();
  assert.ok(Object.isFrozen(e));
  assert.deepEqual([...e], [R("incomplete")]);
  assert.deepEqual([...p.push(bytes("a\r"))], [L("a")]);
  p.push(bytes("\x01"));
  assert.deepEqual([...p.end()], [R("incomplete")]);
  p.push(bytes("x\r"));
  p.reset();
  assert.deepEqual([...p.push(bytes("\n"))], [L("")]);
  p.push(bytes(`${PS}x`)); p.reset();
  assert.deepEqual([...p.push(bytes("b\r"))], [L("b")]);
  p.push(bytes("\x1b[20")); p.reset();
  assert.deepEqual([...p.push(bytes("0~ok\r"))], [L("0~ok")], "a pending escape prefix never survives reset()");
  check(`\r${PS}${PE}\n`, [L(""), L("")]);
});

test("other typed arrays and Uint8Array subclass overrides can't inject bytes", () => {
  const p = createControlInput();
  for (const bad of [new Float64Array([111.9, 107.2, 13]), new Uint16Array([0x6f, 0x6b, 13]), new BigInt64Array([1n]), new Uint8ClampedArray([13]), new DataView(new ArrayBuffer(1))]) {
    assert.throws(() => p.push(bad), TypeError);
    p.reset();
  }
  class Evil extends Uint8Array { *[Symbol.iterator]() { yield 0x6f; yield 13; yield 0x67; yield 0x6f; yield 13; } }
  assert.deepEqual([...p.push(new Evil([0x7a, 13]))], [L("z")]);
  let touched = false;
  const u = new Uint8Array([0x6f, 0x6b, 13]);
  Object.defineProperty(u, "constructor", { get() { touched = true; return Uint8Array; } });
  assert.deepEqual([...p.push(u)], [L("ok")]);
  assert.equal(touched, false);
  assert.deepEqual([...p.push(Buffer.from("hi\r"))], [L("hi")]);
  const big = new Uint8Array([0x78, 0x61, 0x62, 13, 0x79]);
  assert.deepEqual([...p.push(big.subarray(1, 4))], [L("ab")]);
});

test("nested pastes never let the outer remainder become commands", () => {
  check(`${PS}a${PS}b${PE}\rapprove K7M2-QX9D\r${PE}\r`, [R("malformed-paste")]);
  check(`\x1b${PS}junk\rapprove K7M2-QX9D\r${PE}\r`, [R("escape")]);
  check(`${PS}${PS}${PS}x${PE}\r${PE}\x03go\r${PE}\rok\r`, [R("malformed-paste"), L("ok")]);
  check(`${PS}\x1b[20${PS}x${PE}\rgo\r${PE}\r`, [R("paste-content")]);
});

test("nesting beyond the bound latches until end() or reset()", () => {
  const p = createControlInput();
  const deep = PS.repeat(CONTROL_INPUT_MAX_PASTE_DEPTH + 1) + PE.repeat(CONTROL_INPUT_MAX_PASTE_DEPTH + 5) + "\rgo\r\x03";
  assert.deepEqual([...p.push(bytes(deep))], []);
  assert.deepEqual([...p.end()], [R("incomplete")]);
  assert.deepEqual([...p.push(bytes("ok\r"))], [L("ok")]);
  p.push(bytes(PS.repeat(CONTROL_INPUT_MAX_PASTE_DEPTH + 1)));
  p.reset();
  assert.deepEqual([...p.push(bytes("ok\r"))], [L("ok")]);
});

test("API errors latch and discard a pending prefix; oversized chunks are refused before copying", () => {
  const p = createControlInput();
  p.push(bytes("approve K7M2"));
  assert.throws(() => p.push("x"), TypeError);
  assert.throws(() => p.push(bytes("-QX9D\r")), /reset/);
  p.reset();
  assert.deepEqual([...p.push(bytes("-QX9D\r"))], [L("-QX9D")]);
  assert.deepEqual([...p.push(new Uint8Array(CONTROL_INPUT_MAX_CHUNK))], []);
  p.push(bytes("\r"));
  assert.throws(() => p.push(new Uint8Array(CONTROL_INPUT_MAX_CHUNK + 1)), RangeError);
  assert.deepEqual([...p.end()], []);
  const ab = new ArrayBuffer(4), u = new Uint8Array(ab);
  structuredClone(ab, { transfer: [ab] });
  assert.throws(() => p.push(u), TypeError);
});

test("options are exact: no getters, extra keys or coercion", () => {
  let touched = false;
  const g = {}; Object.defineProperty(g, "maxLine", { enumerable: true, get() { touched = true; return 5; } });
  for (const bad of [g, { maxLine: 5, x: 1 }, Object.create({ maxLine: 5 }), null, 5, { maxLine: "5" }, { maxLine: 2.5 }])
    assert.throws(() => createControlInput(bad), bad === g ? TypeError : Error);
  assert.equal(touched, false);
  createControlInput({}); createControlInput({ maxLine: 10 }); createControlInput();
});

test("prototype: imports nothing, and nothing in lib/bin loads it", () => {
  const src = readFileSync(new URL("../lib/strict-control-input.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), /^import /m);
  for (const dir of ["lib", "bin"]) for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url)))
    if (f !== "strict-control-input.mjs") assert.doesNotMatch(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8"), /strict-control-input/, f);
});
