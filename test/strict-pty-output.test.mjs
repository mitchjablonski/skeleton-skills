import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrictPtyOutput, PTY_OUTPUT_MAX_CHUNK } from "../lib/strict-pty-output.mjs";

const raw = (text) => Buffer.from(text, "latin1");
const ESC = "\x1b", BEL = "\x07", ST = "\x9c";
const escapeST = ESC + "\\";

function assertAcrossReads(input, expected) {
  const bytes = typeof input === "string" ? raw(input) : input;
  for (let split = 0; split <= bytes.length; split++) {
    const filter = createStrictPtyOutput();
    assert.equal(filter.push(bytes.subarray(0, split)) + filter.push(bytes.subarray(split)) + filter.end(),
      expected, `split at byte ${split} of ${bytes.toString("hex")}`);
  }
  const filter = createStrictPtyOutput();
  let result = "";
  for (const byte of bytes) result += filter.push(Uint8Array.of(byte));
  assert.equal(result + filter.end(), expected, "one byte per read");
}

test("retains plain transcripts and omits all other standalone byte values", () => {
  assertAcrossReads("build started\r\nstep\t1\r\nbuild complete\n", "build started\nstep1\nbuild complete\n");
  for (let byte = 0; byte <= 0xff; byte++) {
    const allowed = byte === 0x0a || (byte >= 0x20 && byte <= 0x7e);
    assertAcrossReads(Uint8Array.of(byte), allowed ? String.fromCharCode(byte) : "");
  }
});

test("drops every control string in both introducer forms", () => {
  for (const [introducer, c1] of [["]", "\x9d"], ["P", "\x90"], ["_", "\x9f"], ["^", "\x9e"], ["X", "\x98"]]) {
    for (const start of [ESC + introducer, c1]) {
      for (const end of introducer === "]" ? [BEL, ST, escapeST] : [ST, escapeST]) {
        const internalBel = introducer === "]" ? "" : BEL + "still hidden";
        assertAcrossReads("before" + start + "hidden\n\x18\x1a" + internalBel + end + "after\n", "beforeafter\n");
      }
    }
  }
});

test("DCS quoted ESC and wrapped C1 ST stay inside the payload", () => {
  for (const dcs of [ESC + "P", "\x90"]) {
    const payload = ESC + ESC + "quoted ESC" + ESC + ESC + "\\" + ST + "still hidden";
    assertAcrossReads("before" + dcs + "tmux;" + payload + escapeST + "after", "beforeafter");
    assertAcrossReads("before" + dcs + "tmux;" + payload, "before");
    assertAcrossReads(dcs + ESC + ESC + "\\still hidden" + ST + "after", "after");
  }
});

test("drops CSI, ordinary ESC sequences and incomplete controls", () => {
  assertAcrossReads(ESC + "[31mtext" + "\x9b0m" + ESC + "(B" + ESC + "7\n", "text\n");
  assertAcrossReads("before" + ESC + "[12\n;9", "before");
  assertAcrossReads("before" + ESC + "(\t", "before");
  assertAcrossReads("before" + ESC + "\n" + ESC + "]hidden" + BEL + "after", "beforeafter");
  assertAcrossReads("before" + ESC + "[1" + ESC + "]hidden" + BEL + "after", "beforeafter");
  assertAcrossReads("before" + ESC + "]hidden", "before");
});

test("UTF-8 continuation bytes do not open or close control strings", () => {
  assertAcrossReads(Buffer.from("before✅🌟\u009d☘after\n"), "beforeafter\n");
  assertAcrossReads(Buffer.from("before\u009dvisible\x07after\n"), "beforevisibleafter\n");
  const bytes = Buffer.concat([raw("before" + ESC + "]"), Buffer.from("✅\u009c"), raw("hidden" + ST + "after")]);
  assertAcrossReads(bytes, "beforeafter");
  assertAcrossReads(raw("before\xe0\x9dhidden" + BEL + "after"), "beforeafter");
});

test("accepts bounded chunks and returns text independent of the input storage", () => {
  const filter = createStrictPtyOutput();
  const storage = Buffer.alloc(PTY_OUTPUT_MAX_CHUNK + 2, "A");
  const bytes = storage.subarray(1, -1);
  const first = filter.push(bytes);
  storage.fill("B");
  assert.equal(first, "A".repeat(PTY_OUTPUT_MAX_CHUNK));
  assert.equal(filter.push(bytes), "B".repeat(PTY_OUTPUT_MAX_CHUNK));
  assert.equal(filter.push(new Uint8Array()), "");
  assert.equal(filter.end(), "");
  assert.throws(() => filter.push(raw("text")), /closed/);
});

test("invalid batches permanently close the stream without exposing pending payload", () => {
  const detached = Uint8Array.of(1);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const invalid of ["text", [1], new Uint16Array(1), detached, new Uint8Array(PTY_OUTPUT_MAX_CHUNK + 1)]) {
    const filter = createStrictPtyOutput();
    assert.equal(filter.push(raw("before" + ESC + "Phidden")), "before");
    assert.throws(() => filter.push(invalid), invalid instanceof Uint8Array && invalid !== detached ? RangeError : TypeError);
    assert.throws(() => filter.push(raw("still hidden" + escapeST)), /closed/);
    assert.equal(filter.end(), "");
    assert.throws(() => filter.push(raw("still hidden")), /closed/);
  }
});
