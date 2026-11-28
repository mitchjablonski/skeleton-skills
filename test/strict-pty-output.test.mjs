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
    assertAcrossReads(dcs + "tmu" + ST + "after", "after");
  }
  assertAcrossReads(ESC + "]hidden" + ESC + escapeST + "after", "after");
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
  assertAcrossReads(raw("before" + ESC + "]\xe2A" + ST + "after"), "beforeafter");
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

test("withheld() reports an unterminated control string to the launcher, outside the text", () => {
  for (const [start, kind] of [[ESC + "]", "osc"], ["\x90", "dcs"], [ESC + "_", "apc"], ["\x9e", "pm"], [ESC + "X", "sos"]]) {
    const filter = createStrictPtyOutput();
    assert.equal(filter.withheld(), null);
    assert.equal(filter.push(raw("visible\n" + start)), "visible\n");
    assert.deepEqual(filter.withheld(), { kind, bytes: start.length - 1 });
    assert.equal(filter.push(raw("tail the human never sees\n")), "");
    const pending = filter.withheld();
    assert.deepEqual(pending, { kind, bytes: start.length - 1 + 26 });
    assert.ok(Object.isFrozen(pending));
    assert.equal(filter.end(), "");
    assert.deepEqual(filter.withheld(), { kind, bytes: start.length - 1 + 26 }, "still readable after end()");
  }
  // A terminated string clears it, and later text is visible again.
  const filter = createStrictPtyOutput();
  filter.push(raw(ESC + "]0;title"));
  assert.equal(filter.withheld().kind, "osc");
  assert.equal(filter.push(raw(BEL + "after\n")), "after\n");
  assert.equal(filter.withheld(), null);
  // A pending CSI or escape hides digits, punctuation, spaces, LF and controls until a
  // final byte, so numeric output (progress, counters) can vanish: it is reported too.
  const csi = createStrictPtyOutput();
  assert.equal(csi.push(raw("ok\n" + ESC + "[" + "100% 42/42 3.14\n".repeat(1000))), "ok\n");
  assert.deepEqual(csi.withheld(), { kind: "csi", bytes: 16001 });
  csi.end();
  assert.deepEqual(csi.withheld(), { kind: "csi", bytes: 16001 });
  const rawCsi = createStrictPtyOutput();
  rawCsi.push(raw("\x9b12;"));
  assert.deepEqual(rawCsi.withheld(), { kind: "csi", bytes: 3 });
  assert.equal(rawCsi.push(raw("mnext\n")), "next\n");
  assert.equal(rawCsi.withheld(), null);
  const esc = createStrictPtyOutput();
  assert.equal(esc.push(raw("ok\n" + ESC + " " + "  \n".repeat(100))), "ok\n");
  assert.deepEqual(esc.withheld(), { kind: "escape", bytes: 301 });
  // Text-state drops (non-ASCII here) hide nothing and don't inflate a transient CSI.
  const utf = createStrictPtyOutput();
  utf.push(Buffer.from("ok\n" + "\u00e9".repeat(5000) + ESC + "[", "utf-8"));
  assert.deepEqual(utf.withheld(), { kind: "csi", bytes: 1 });
  // Re-arming an unfinished CSI doesn't reset the count: only emitted text does.
  const rearm = createStrictPtyOutput();
  assert.equal(rearm.push(raw("ok\n" + (ESC + "[100% 42/42\n").repeat(1000))), "ok\n");
  assert.deepEqual(rearm.withheld(), { kind: "csi", bytes: 12999 });
  // A UTF-8-encoded U+009D is a character, not an OSC introducer.
  const utf8 = createStrictPtyOutput();
  utf8.push(Buffer.from("\u009d", "utf-8"));
  assert.equal(utf8.withheld(), null);
});

test("withheld() is independent of how the stream is split", () => {
  const bytes = raw("a" + ESC + "Pq#0;2;0;0;0" + "z".repeat(40));
  for (let split = 0; split <= bytes.length; split++) {
    const filter = createStrictPtyOutput();
    filter.push(bytes.subarray(0, split));
    filter.push(bytes.subarray(split));
    assert.deepEqual(filter.withheld(), { kind: "dcs", bytes: bytes.length - 2 }, `split at ${split}`);
  }
});

// Golden edge vectors (#270/#276). The relay runs this filter on every agent
// byte before the pane socket, so each rule below is pinned to an exact
// output. Every vector here fails if its rule is changed.
test("golden edge vectors pin each parser rule", () => {
  const cases = [
    // tmux-wrapped DCS: a bare 8-bit ST doesn't end it; ESC \ does.
    ["\x90tmux;\x9cA" + escapeST + "B\n", "B\n"],
    // Near-miss prefixes don't wrap, so the ST ends the string.
    ["\x90tmuxX\x9cA\n", "A\n"],
    ["\x90tmux\x9cA\n", "A\n"],
    // An 8-bit ST that is a UTF-8 continuation doesn't end an OSC.
    ["\x9d\xe2\x82\x9cA" + BEL + "B\n", "B\n"],
    // CSI final bytes start at '@'.
    [ESC + "[@A\n", "A\n"],
    // DEL isn't an escape final; the next byte is.
    [ESC + "\x7fA\n", "\n"],
    // '/' is an intermediate; no 7-bit C1 mapping after an intermediate.
    [ESC + "/]hidden" + BEL + "shown\n", "hiddenshown\n"],
    [ESC + "(]x" + BEL + "y\n", "xy\n"],
    // ED's continuation range stops at 0x9F: ED A0 isn't UTF-8, so 9D opens an OSC.
    ["X\n\xed\xa0\x9dA\n", "X\n"],
    // A doubled ESC inside DCS is quoted and can't begin ST.
    [ESC + "Pq" + ESC + ESC + "\\visible" + escapeST + "after\n", "after\n"],
  ];
  for (const [input, want] of cases) {
    const whole = createStrictPtyOutput();
    assert.equal(whole.push(raw(input)), want, JSON.stringify(input));
    // The same result byte by byte.
    const bytes = createStrictPtyOutput();
    assert.equal([...raw(input)].map((b) => bytes.push(Uint8Array.of(b))).join(""), want, `bytewise ${JSON.stringify(input)}`);
  }
});
