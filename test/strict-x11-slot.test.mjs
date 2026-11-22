// The display-slot proof's /proc/net/unix parser (JS helper and Python dispose), on fixed text.
// Pure: no X server is started and no socket is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseUnixSocketTable, x11SocketState } from "./live/strict-private-display.mjs";

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

test("JS: parser counts rows and malformed lines", () => {
  const parsed = parseUnixSocketTable(table(row(1, "@a"), row(2), "x"));
  assert.equal(parsed.rows, 2);
  assert.equal(parsed.malformed, 1);
  assert.ok(parsed.paths.has("@a"));
});

test("Python dispose parser agrees on every case", () => {
  const script = fileURLToPath(new URL("./live/strict-x11-slot.py", import.meta.url));
  const r = spawnSync("/usr/bin/python3", ["-I", script], {
    input: JSON.stringify(CASES.map(({ text, number }) => ({ text, number }))), encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), CASES.map((c) => c.want));
});
