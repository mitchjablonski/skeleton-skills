// The display-slot proof's /proc/net/unix parser (JS helper and Python dispose), on fixed text.
// Pure: no X server is started and no socket is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseUnixSocketTable, x11SocketState, x11SocketStateFromBytes } from "./live/strict-private-display.mjs";

const HEADER = "Num       RefCount Protocol Flags    Type St Inode Path";
const row = (inode, path = "") => `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode}${path ? " " + path : ""}`;
const table = (...rows) => [HEADER, ...rows, ""].join("\n");

const CASES = [
  { name: "abstract present", number: 4321, text: table(row(11, "@/tmp/.X11-unix/X4321"), row(12)),
    want: { abstract: true, filesystem: false, proven: true } },
  { name: "filesystem present", number: 4321, text: table(row(13, "/tmp/.X11-unix/X4321")),
    want: { abstract: false, filesystem: true, proven: true } },
  { name: "absent (other displays and unnamed sockets only)", number: 4321,
    text: table(row(14, "@/tmp/.X11-unix/X43210"), row(15, "/tmp/.X11-unix/X432"), row(16), row(17, "/run/user/1000/bus")),
    want: { abstract: false, filesystem: false, proven: true } },
  { name: "malformed row: not proven", number: 4321, text: table(row(18), "garbage line @/tmp/.X11-unix/X4321"),
    want: { abstract: false, filesystem: false, proven: false } },
  { name: "missing header: not proven", number: 4321, text: row(19, "@/tmp/.X11-unix/X4321"),
    want: { abstract: false, filesystem: false, proven: false } },
  { name: "unreadable table: not proven", number: 4321, text: null,
    want: { abstract: null, filesystem: null, proven: false } },
];

for (const c of CASES) test(`JS: ${c.name}`, () => assert.deepEqual(x11SocketState(c.text, c.number), c.want));

// Raw-byte cases: what the bounded readers actually parse (shared with the Python dispose).
const bytes = (text) => Buffer.from(text, "latin1");
const NON_UTF8 = Buffer.concat([bytes(HEADER + "\n" + row(21, "@")), Buffer.from([0xff, 0xfe, 0x80]), bytes("\n" + row(22, "@/tmp/.X11-unix/X4321") + "\n")]);
const BYTE_CASES = [
  ...CASES.map((c) => ({ name: c.name, number: c.number, raw: c.text === null ? null : bytes(c.text), want: c.want })),
  { name: "non-UTF-8 socket name: still parsed", number: 4321, raw: NON_UTF8, want: { abstract: true, filesystem: false, proven: true } },
  { name: "non-UTF-8 name, display absent", number: 1234, raw: NON_UTF8, want: { abstract: false, filesystem: false, proven: true } },
  { name: "over-cap table: not proven", number: 4321, cap: 64, raw: bytes(table(row(23, "@/tmp/.X11-unix/X4321"), row(24))),
    want: { abstract: null, filesystem: null, proven: false } },
  { name: "exactly at cap: parsed", number: 4321, raw: bytes(table(row(25, "@/tmp/.X11-unix/X4321"))),
    want: { abstract: true, filesystem: false, proven: true } },
];
BYTE_CASES.at(-1).cap = BYTE_CASES.at(-1).raw.length;

for (const c of BYTE_CASES) test(`JS bytes: ${c.name}`, () => assert.deepEqual(x11SocketStateFromBytes(c.raw, c.number, c.cap), c.want));

test("JS: parser counts rows and malformed lines", () => {
  const parsed = parseUnixSocketTable(table(row(1, "@a"), row(2), "x"));
  assert.equal(parsed.rows, 2);
  assert.equal(parsed.malformed, 1);
  assert.ok(parsed.paths.has("@a"));
});

test("Python dispose parser agrees on every raw-byte case", () => {
  const script = fileURLToPath(new URL("./live/strict-x11-slot.py", import.meta.url));
  const input = BYTE_CASES.map(({ raw, number, cap }) => ({ b64: raw === null ? null : raw.toString("base64"), number, ...(cap ? { cap } : {}) }));
  const r = spawnSync("/usr/bin/python3", ["-I", script], { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), BYTE_CASES.map((c) => c.want));
});
