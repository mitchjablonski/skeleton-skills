// The display-slot proof's /proc/net/unix parser (JS helper and Python dispose), on fixed text.
// Pure: no X server is started and no socket is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseUnixSocketTable, x11SocketState, x11SocketStateFromBytes } from "./live/strict-private-display.mjs";
import { bindSeatMetadata } from "./live/strict-seat-metadata.mjs";

function seatFixture() {
  function entry(ino, kind) {
    return {
      dev: 38n, ino, ctimeNs: 500n,
      isDirectory: () => kind === "directory",
      isSocket: () => kind === "socket",
    };
  }
  const directory = entry(2n, "directory");
  const socket = entry(9n, "socket");
  const entries = new Map([
    ["/mnt/wslg", entry(1n, "directory")],
    ["/mnt/wslg/.X11-unix", directory],
    ["/tmp/.X11-unix", directory],
    ["/mnt/wslg/.X11-unix/X0", socket],
    ["/tmp/.X11-unix/X0", socket],
  ]);
  const state = {
    display: ":0", pidNamespace: "pid:[30]",
    mounts: [
      "81 80 0:38 / /mnt/wslg rw,relatime shared:2 - tmpfs none rw",
      "128 80 0:38 /.X11-unix /tmp/.X11-unix ro,relatime shared:2 - tmpfs none rw",
    ],
  };
  const sources = {
    display: () => state.display,
    mountInfo: () => state.mounts.join("\n"),
    lstat(path) {
      if (!entries.has(path)) throw new Error("private I/O detail");
      return entries.get(path);
    },
    readlink: (path) => path.endsWith("/pid") ? state.pidNamespace : `${path.split("/").at(-1)}:[20]`,
  };
  return { bind: () => bindSeatMetadata(sources), entries, state };
}

test("seat metadata binds only the fixed display and matching directory/socket aliases", () => {
  const { bind, entries, state } = seatFixture();
  assert.deepEqual(Object.keys(bind()), ["code", "recheck"]);
  assert.equal(bind().recheck(), "seat-metadata-matched");

  state.display = "other-host:0";
  assert.deepEqual(bind(), { code: "seat-display-unsupported" });
  state.display = ":0";

  const [wslg, local] = state.mounts;
  state.mounts = [wslg, local.replace("ro,", "rw,")];
  assert.deepEqual(bind(), { code: "seat-anchor-mismatch" });
  state.mounts = [wslg, local.replace("0:38", "0:39")];
  assert.deepEqual(bind(), { code: "seat-anchor-mismatch" });
  state.mounts = [wslg, local, local.replace("128", "129")];
  assert.deepEqual(bind(), { code: "seat-anchor-mismatch" });
  state.mounts = [wslg, local];

  const alias = "/tmp/.X11-unix";
  const directory = entries.get(alias);
  entries.set(alias, { ...directory, isDirectory: () => false });
  assert.deepEqual(bind(), { code: "seat-anchor-mismatch" });
  entries.set(alias, { ...directory, dev: 52n });
  assert.deepEqual(bind(), { code: "seat-anchor-mismatch" });
  entries.set(alias, directory);

  const endpoint = `${alias}/X0`;
  const socket = entries.get(endpoint);
  entries.set(endpoint, { ...socket, ino: 42n });
  assert.deepEqual(bind(), { code: "seat-anchor-mismatch" });
  entries.set(endpoint, { ...socket, isSocket: () => false });
  assert.deepEqual(bind(), { code: "seat-anchor-mismatch" });
  entries.delete(endpoint);
  assert.deepEqual(bind(), { code: "seat-evidence-unavailable" });
});

test("seat recheck latches endpoint, mount, namespace, and observation loss", () => {
  for (const [mutate, code] of [
    [({ entries }) => { entries.get("/tmp/.X11-unix/X0").ino++; }, "seat-changed"],
    [({ entries }) => { entries.get("/tmp/.X11-unix/X0").ctimeNs++; }, "seat-changed"],
    [({ entries }) => { entries.get("/mnt/wslg").ino++; }, "seat-changed"],
    [({ state }) => { state.mounts[1] = state.mounts[1].replace("128", "129"); }, "seat-changed"],
    [({ state }) => { state.pidNamespace = "pid:[31]"; }, "seat-changed"],
    [({ state }) => { state.pidNamespace = "unreadable"; }, "seat-evidence-unavailable"],
    [({ state }) => { state.display = ":8"; }, "seat-display-unsupported"],
  ]) {
    const fixture = seatFixture();
    const binding = fixture.bind();
    assert.equal(binding.code, "seat-metadata-observed");
    assert.equal(binding.recheck(), "seat-metadata-matched");
    mutate(fixture);
    assert.equal(binding.recheck(), code);
  }
  const { bind, entries } = seatFixture();
  const binding = bind();
  const alias = "/tmp/.X11-unix/X0";
  const original = entries.get(alias);
  entries.delete(alias);
  assert.equal(binding.recheck(), "seat-evidence-unavailable");
  entries.set(alias, original);
  assert.equal(bind().recheck(), "seat-metadata-matched");
  assert.equal(binding.recheck(), "seat-evidence-unavailable");
});

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

test("Python dispose parser agrees on every raw-byte case", { skip: process.platform === "linux" ? false : "the Python dispose parser runs on Linux only" }, () => {
  const script = fileURLToPath(new URL("./live/strict-x11-slot.py", import.meta.url));
  const input = BYTE_CASES.map(({ raw, number, cap }) => ({ b64: raw === null ? null : raw.toString("base64"), number, ...(cap ? { cap } : {}) }));
  const r = spawnSync("/usr/bin/python3", ["-I", script], { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), BYTE_CASES.map((c) => c.want));
});
