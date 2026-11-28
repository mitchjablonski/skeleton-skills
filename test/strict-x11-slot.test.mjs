// The display-slot proof's /proc/net/unix parser (JS helper and Python dispose), on fixed text.
// Pure: no X server is started and no socket is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseUnixSocketTable, x11SocketState, x11SocketStateFromBytes } from "./live/strict-private-display.mjs";
import { bindSeatMetadata } from "./live/strict-seat-metadata.mjs";
import { bindPinnedChromeInstallation, checkPinnedChromeInstallation } from "./live/strict-real-seat-preflight.mjs";
import { bindControlTerminal, bindOperatorSeat, confirmAtTerminal, rehearseRealSeat } from "./live/strict-real-seat-rehearsal.mjs";
import { matchesWindowClaim, parseDecisionWindows } from "./live/strict-wslg-window.mjs";

test("real WSLg observations keep all decision-window candidates and check the exact claim", () => {
  const tree = `
     0x380001 "Mail": ("mail" "Mail")
        0x400005 "Skeleton decision (prototype) - Google Chrome": ("google-chrome" "Google-chrome")
        0x420005 "Skeleton decision (prototype)": ("google-chrome" "Google-chrome")
  `;
  assert.deepEqual(parseDecisionWindows(tree), ["0x400005", "0x420005"]);
  const claim = '_NET_WM_PID(CARDINAL) = 123\nWM_CLIENT_MACHINE(STRING) = "seat"\n';
  const geometry = "  Map State: IsViewable\n";
  assert.equal(matchesWindowClaim(claim, geometry, 123, "seat"), true);
  assert.equal(matchesWindowClaim(claim, geometry, 12, "seat"), false);
  assert.equal(matchesWindowClaim(claim + claim, geometry, 123, "seat"), false);
  assert.equal(matchesWindowClaim(claim, geometry, 123, "other"), false);
  assert.equal(matchesWindowClaim(claim, "  Map State: IsUnmapped\n", 123, "seat"), false);
});

test("the operator WSLg entry refuses redirected input and output", { skip: process.platform !== "linux" }, () => {
  const entry = fileURLToPath(new URL("./live/strict-real-seat-launcher.py", import.meta.url));
  const child = spawnSync("/usr/bin/python3", ["-I", entry, "--real-seat-launcher"], {
    input: "yes\n", encoding: "utf8", timeout: 5000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 2, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    ok: false, strictState: "unverified", code: "real-desktop-invocation-invalid",
    scope: "synthetic-window-checkpoint", windowAttribution: "attribution-unavailable",
  });
  const contained = spawnSync("/usr/bin/python3", ["-I", entry, "--real-seat-contained", "/dev/null", "0".repeat(64)], {
    input: "yes\n", encoding: "utf8", timeout: 5000,
  });
  assert.ifError(contained.error);
  assert.equal(contained.status, 2, contained.stderr);
  assert.deepEqual(JSON.parse(contained.stdout), {
    ok: false, strictState: "unverified", code: "real-desktop-invocation-invalid",
    scope: "synthetic-contained-restart", windowAttribution: "attribution-unavailable",
  });
  const interactive = spawnSync("/usr/bin/python3", ["-I", entry, "--real-seat-interactive",
    "/dev/null", "0".repeat(64), "/usr/bin/false", "0".repeat(64)], {
    input: "yes\n", encoding: "utf8", timeout: 5000,
  });
  assert.ifError(interactive.error);
  assert.equal(interactive.status, 2, interactive.stderr);
  assert.equal(JSON.parse(interactive.stdout).code, "real-desktop-invocation-invalid");
  assert.equal(JSON.parse(interactive.stdout).scope, "interactive-cli-local-fixture");
});

test("the rehearsal requires one unchanged control terminal", () => {
  const left = { isTTY: true, fd: 0 };
  const right = { isTTY: true, fd: 1 };
  const terminals = [5n, 5n];
  const stat = (fd) => ({ dev: 1n, ino: terminals[fd], rdev: 3n, isCharacterDevice: () => true });
  const available = bindControlTerminal(left, right, stat);
  assert.equal(available(), true);
  terminals[1] = 6n;
  assert.equal(available(), false);
  terminals[0] = 6n;
  assert.equal(available(), false);
  right.isTTY = false;
  assert.equal(bindControlTerminal(left, right, stat)(), false);
});

test("terminal confirmation accepts one exact line, bounds input and resumes for a later prompt", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const answer = async (parts) => {
    const pending = confirmAtTerminal(input, output, "Test question", 1000);
    for (const part of parts) input.write(part);
    return pending;
  };
  assert.equal(await answer(["y", "es\r\n"]), true);
  assert.equal(await answer(["yes\n"]), true);
  assert.equal(await answer(["yes\nno\n"]), false);
  assert.equal(await answer(["private fixture value\n"]), false);
  assert.equal(await answer([Buffer.from([0xf9, 101, 115, 10])]), false);
  assert.doesNotMatch(output.read().toString(), /private fixture value/);
  assert.equal(await confirmAtTerminal(input, output, "Timeout question", 5), false);
  const cancelled = new AbortController();
  const interrupted = confirmAtTerminal(input, output, "Window lost", 1000, cancelled.signal);
  cancelled.abort();
  assert.equal(await interrupted, false);
  assert.equal(await answer(["yes\n"]), true);
  const eof = confirmAtTerminal(input, output, "End question", 1000);
  input.end();
  assert.equal(await eof, false);
});

test("rehearsal checks the same seat before ready and after the restart prompt", async () => {
  for (const restart of ["seat-metadata-matched", "seat-changed", "browser-executable-changed"]) {
    const samples = ["seat-metadata-matched", restart];
    let binds = 0;
    let prompts = 0;
    const result = await rehearseRealSeat({
      interactive: () => true,
      confirm: async () => {
        if (++prompts === 8) assert.deepEqual(samples, [restart]);
        return true;
      },
      bind: () => {
        binds++;
        return { code: "real-seat-preflight-passed", recheck: () => samples.shift() };
      },
    });
    assert.equal(result, restart === "seat-metadata-matched" ? "real-seat-rehearsal-passed" : restart);
    assert.equal(binds, 1);
    assert.equal(prompts, 8);
  }
});

test("rehearsal refusal stops at invocation or the first missing attestation", async () => {
  let prompts = 0;
  const confirm = async () => ++prompts === 1;
  const bind = () => assert.fail("refusal must happen before seat access");
  assert.equal(await rehearseRealSeat({ interactive: () => false, confirm, bind }), "real-desktop-invocation-invalid");
  assert.equal(prompts, 0);
  assert.equal(await rehearseRealSeat({ interactive: () => true, confirm, bind }), "unsandboxed-agent-not-excluded");
  assert.equal(prompts, 2);
});

test("the operator handoff refuses a terminal change during a seat check and keeps that refusal", async () => {
  let terminal = true;
  let samples = 0;
  const binding = await bindOperatorSeat({
    interactive: () => terminal,
    confirm: async () => true,
    bind: () => ({
      code: "real-seat-preflight-passed",
      recheck() {
        if (++samples === 2) terminal = false;
        return "seat-metadata-matched";
      },
    }),
  });
  assert.equal(binding.code, "real-seat-preflight-passed");
  assert.equal(binding.recheck(), "seat-metadata-matched");
  assert.equal(binding.recheck(), "real-desktop-invocation-invalid");
  terminal = true;
  assert.equal(binding.recheck(), "real-desktop-invocation-invalid");
  assert.equal(samples, 2, "a new check cannot revive the refused handoff");
});

test("an unavailable seat refuses a restart before asking the operator", async () => {
  let prompts = 0;
  const binding = await bindOperatorSeat({
    interactive: () => true,
    confirm: async () => { prompts++; return true; },
    bind: () => ({ code: "real-seat-preflight-passed", recheck: () => "browser-executable-changed" }),
  });
  const setupPrompts = prompts;
  assert.equal(await binding.confirmRestart(), "browser-executable-changed");
  assert.equal(prompts, setupPrompts);
});

test("a declined restart confirmation closes the retained binding", async () => {
  let answer = true;
  let samples = 0;
  const binding = await bindOperatorSeat({
    interactive: () => true,
    confirm: async () => answer,
    bind: () => ({
      code: "real-seat-preflight-passed",
      recheck() { samples++; return "seat-metadata-matched"; },
    }),
  });
  answer = false;
  assert.equal(await binding.confirmRestart(), "operator-restart-not-attested");
  answer = true;
  assert.equal(await binding.confirmRestart(), "operator-restart-not-attested");
  assert.equal(binding.recheck(), "operator-restart-not-attested");
  assert.equal(samples, 1);
});

test("two overlapping restart requests cannot share one operator answer", async () => {
  let prompt = () => true;
  const binding = await bindOperatorSeat({
    interactive: () => true,
    confirm: () => prompt(),
    bind: () => ({ code: "real-seat-preflight-passed", recheck: () => "seat-metadata-matched" }),
  });
  let answer;
  prompt = () => new Promise((resolve) => { answer = resolve; });
  const first = binding.confirmRestart();
  const acceptFirst = answer;
  assert.equal(await binding.confirmRestart(), "operator-restart-not-attested");
  assert.equal(answer, acceptFirst);
  acceptFirst(true);
  assert.equal(await first, "operator-restart-not-attested");
});

test("an operator compares one selected window and keeps its phrase through restart", async () => {
  const prompts = [];
  let current = true;
  let replaceOnAnswer = false;
  const seat = await bindOperatorSeat({
    interactive: () => true,
    confirm: async (prompt) => {
      prompts.push(prompt);
      if (replaceOnAnswer) current = false;
      return true;
    },
    bind: () => ({ code: "real-seat-preflight-passed", recheck: () => "seat-metadata-matched" }),
  });
  const binding = { captureVersion: "a".repeat(64) };
  let minted = 0;
  let used = false;
  let pagePhrase;
  const listener = { mintWindowNavigation(value, { windowPhrase }) {
    assert.equal(value, binding);
    minted++;
    pagePhrase = windowPhrase;
    return {
      url: "fixture",
      takeView() {
        if (used) return false;
        used = true;
        return true;
      },
      isCurrent: () => current,
    };
  } };
  const presentation = seat.prepareWindow(listener, binding);
  assert.equal(presentation.comparison(), null);
  assert.equal(presentation.navigation.takeView(), true);
  assert.equal(presentation.navigation.takeView(), false);
  assert.equal(await presentation.confirmMatch(), "seat-metadata-matched");
  assert.ok(prompts.at(-1).includes(pagePhrase));
  assert.ok(prompts.at(-1).includes(binding.captureVersion));
  const before = presentation.comparison();
  assert.equal(await presentation.confirmRestart(), "seat-metadata-matched");
  assert.ok(prompts.at(-1).includes(pagePhrase));
  assert.ok(prompts.at(-1).includes("attestations still hold"));
  assert.equal(presentation.comparison(), before);
  assert.equal(minted, 1);
  replaceOnAnswer = true;
  assert.equal(await presentation.confirmRestart(), "discriminating-phrase-mismatch");
  assert.equal(presentation.comparison(), null);
});

function installationFixture() {
  const bytes = Buffer.from("fixture executable bytes");
  const pin = createHash("sha256").update(bytes).digest("hex");
  const directory = { uid: 0n, mode: 0o755n, dev: 42n, ino: 1n, ctimeNs: 1n, size: 0n,
    isDirectory: () => true };
  const file = { ...directory, ino: 2n, size: BigInt(bytes.length), isFile: () => true };
  const state = { opened: 0, closed: 0, descriptor: file, chunk: 3 };
  const entries = new Map([["/", directory], ["/opt", directory], ["/opt/google", directory],
    ["/opt/google/chrome", directory], ["/opt/google/chrome/chrome", file]]);
  const io = {
    lstatSync: (path) => entries.get(path),
    accessSync() {},
    openSync() { state.opened++; return 42; },
    fstatSync() { return state.descriptor; },
    readSync(fd, chunk, start, length, position) {
      return bytes.copy(chunk, start, position, Math.min(bytes.length, position + state.chunk));
    },
    closeSync() { state.closed++; },
  };
  return { io, entries, state, pin };
}

test("the fixed install verifies a digest from the same opened executable", () => {
  const { io, state, pin } = installationFixture();
  assert.equal(checkPinnedChromeInstallation(io, pin), "browser-pin-matched");
  assert.equal(checkPinnedChromeInstallation(io, "0".repeat(64)), "browser-pin-mismatch");
  assert.equal(state.opened, 2);
  assert.equal(state.closed, 2);
});

test("the pinned installation keeps its original path identity and latches loss", () => {
  for (const code of ["browser-executable-changed", "browser-evidence-unavailable"]) {
    const { io, entries, state, pin } = installationFixture();
    const file = "/opt/google/chrome/chrome";
    const original = entries.get(file);
    const binding = bindPinnedChromeInstallation(io, pin);
    assert.equal(binding.code, "browser-pin-matched");
    assert.equal(binding.recheck(), "browser-pin-matched");

    if (code === "browser-executable-changed") entries.set(file, { ...original, ino: 3n });
    else entries.delete(file);
    assert.equal(binding.recheck(), code);
    entries.set(file, original);
    assert.equal(binding.recheck(), code);
    assert.equal(state.opened, 1);
    assert.equal(state.closed, 1);
  }
});

test("the fixed install refuses untrusted path components, changed identity, and I/O errors", () => {
  const { io, entries, state, pin } = installationFixture();
  const parent = entries.get("/opt/google");
  for (const changed of [{ uid: 1n }, { mode: 0o775n }, { isDirectory: () => false }]) {
    entries.set("/opt/google", { ...parent, ...changed });
    assert.equal(checkPinnedChromeInstallation(io, pin), "browser-executable-untrusted");
  }
  assert.equal(state.opened, 0);
  entries.set("/opt/google", parent);
  const original = state.descriptor;
  state.descriptor = { ...original, ino: 3n };
  assert.equal(checkPinnedChromeInstallation(io, pin), "browser-executable-changed");

  state.descriptor = original;
  const read = io.readSync;
  io.readSync = (...args) => {
    entries.set("/opt/google", { ...parent, ctimeNs: 2n });
    return read(...args);
  };
  assert.equal(checkPinnedChromeInstallation(io, pin), "browser-executable-changed");
  io.readSync = () => { throw new Error("private read detail"); };
  assert.equal(checkPinnedChromeInstallation(io, pin), "browser-evidence-unavailable");
  assert.equal(state.opened, state.closed);
});

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
  state.mounts = [wslg.replace("0:38", "0:39"), local.replace("0:38", "0:39")];
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

test("seat mount devices account for high Linux major and minor fields", () => {
  const { bind, entries, state } = seatFixture();
  // Linux dev_t for major 0x1002 and minor 0x301.
  for (const entry of new Set(entries.values())) entry.dev = 0x100000300201n;
  state.mounts = state.mounts.map((line) => line.replace("0:38", "4098:769"));
  assert.equal(bind().recheck?.(), "seat-metadata-matched");
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

test("#270: the agent relay accepts only the pinned Node running the absolute pane script on its socket", { skip: process.platform !== "linux" }, (t) => {
  const relayPath = fileURLToPath(new URL("./live/strict-interactive-claude-relay.py", import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skel-pane-pin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pane = path.join(dir, "pane.mjs"), other = path.join(dir, "other.mjs");
  for (const file of [pane, other]) fs.writeFileSync(file, "setTimeout(() => {}, 20000);\n");
  const script = `
import json, os, runpy, subprocess, sys, time
relay = runpy.run_path(sys.argv[1])
node, pane, other, root = sys.argv[2:6]
sock = os.path.join(root, "agent.sock")
st = os.stat(node)
ident = (st.st_dev, st.st_ino)
match = relay["pane_process_matches"]
py = os.stat("/usr/bin/python3")
def check(argv, script=pane, socket_path=sock, identity=ident, env=None):
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             env=env if env is not None else {"PATH": "/usr/bin:/bin"})
    try:
        # Node can briefly show an empty cmdline while it sets up its args; a
        # real pane attaches long after that. Wait for the full argv first.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with open(f"/proc/{child.pid}/cmdline", "rb") as record:
                if record.read().count(b"\\0") == len(argv):
                    break
            time.sleep(0.02)
        return match(child.pid, identity, script, socket_path)
    finally:
        child.kill(); child.wait()
out = {
    "exact": check([node, pane, sock]),
    "other-script": check([node, other, sock]),
    "relative-script": check([node, os.path.relpath(pane), sock], script=pane),
    "extra-arg": check([node, pane, sock, "x"]),
    "other-socket": check([node, pane, os.path.join(root, "else.sock")]),
    "other-exe": check(["/usr/bin/python3", "-c", "import time; time.sleep(20)", pane, sock]),
    "wrong-identity": check([node, pane, sock], identity=(py.st_dev, py.st_ino)),
    "node-options": check([node, pane, sock], env={"PATH": "/usr/bin:/bin", "NODE_OPTIONS": "--no-warnings"}),
    "symlinked-socket": (os.symlink(root, os.path.join(root, "link")), check([node, pane, os.path.join(root, "link", "agent.sock")]))[1],
    "gone": match(2 ** 22 + 7, ident, pane, sock),
}
try:
    relay["AgentRelay"](__import__("pathlib").Path(root), None, node, "relative/pane.mjs")
    out["relative-refused"] = False
except RuntimeError as error:
    out["relative-refused"] = str(error) == "interactive-agent-pane-path-refused"
print(json.dumps(out))
`;
  const child = spawnSync("/usr/bin/python3", ["-I", "-c", script, relayPath, process.execPath, pane, other, dir], { encoding: "utf8", timeout: 30000, cwd: dir });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    exact: true, "other-script": false, "relative-script": false, "extra-arg": false,
    "other-socket": false, "other-exe": false, "wrong-identity": false, "node-options": false, "symlinked-socket": true, gone: false, "relative-refused": true,
  });
});

test("#270: the restart driver reports unproven cleanup whatever the exercise raised", { skip: process.platform !== "linux" }, () => {
  const entry = fileURLToPath(new URL("./live/strict-real-seat-restart.py", import.meta.url));
  // Load the driver without running main, stub the launcher and the runtime
  // check, and drive exercise() through each failure type.
  const script = `
import runpy, subprocess, sys, json
g = runpy.run_path(sys.argv[1], run_name="restart_under_test")
ex = g["exercise"]
G = ex.__globals__
adm = G["admission"]
out = {}
for label, error, cleanup_fails in [
    ("attr-ok", AttributeError, False),
    ("attr-fail", AttributeError, True),
    ("key-fail", KeyError, True),
    ("type-fail", TypeError, True),
    ("timeout-fail", lambda m: subprocess.TimeoutExpired("probe", 1), True),
    ("refused-fail", G["Refused"], True),
    ("kbint-fail", KeyboardInterrupt, True),
    ("refused-ok", G["Refused"], False),
    ("unproven-ok", "unproven", False),
]:
    class Launcher:
        def __init__(self, *a, **k): pass
        def cleanup(self):
            if cleanup_fails: raise OSError("namespace survived")
    def runtime_check(*a, **k):
        def verify():
            if error == "unproven": raise adm["RuntimeRefused"]("runtime-observation-cleanup-unproven")
            raise error("injected")
        return verify
    G["OperatorLauncher"] = Launcher
    adm["read_runtime_selection"] = lambda runtime: None
    adm["runtime_check"] = runtime_check
    out[label] = ex("/root", "/node", "/runtime", "0" * 64, "r", "c")
# Cleanup raising a BaseException (not just Exception) is unproven too.
class Interrupting:
    def __init__(self, *a, **k): pass
    def cleanup(self): raise KeyboardInterrupt()
G["OperatorLauncher"] = Interrupting
out["cleanup-baseexception"] = ex("/root", "/node", "/runtime", "0" * 64, "r", "c")
# With a relay: a failing relay.close() is unproven cleanup; a clean one isn't.
inter = G["interactive"]
for label, close_fails in [("relay-close-fail", True), ("relay-close-ok", False)]:
    class Launcher:
        def __init__(self, *a, **k): pass
        def cleanup(self): pass
    class Relay:
        def __init__(self, *a, **k): pass
        def close(self):
            if close_fails: raise OSError("relay socket")
    def no_enrollment(*a, **k): raise ValueError("stop after the relay exists")
    G["OperatorLauncher"] = Launcher
    G["Enrollment"] = no_enrollment
    adm["runtime_check"] = lambda *a, **k: (lambda: None)
    inter["pin_client"] = lambda *a, **k: "/pinned"
    inter["AgentRelay"] = Relay
    out[label] = ex("/root", "/node", "/runtime", "0" * 64, "r", "c", profile=("/client", "0" * 64, (1, 2, 3)))
# Not covered: reaching result = 0 and then failing cleanup needs the full
# launcher; the code path is the same "return result if proven else 125".
print(json.dumps(out))
`;
  const child = spawnSync("/usr/bin/python3", ["-I", "-c", script, entry], { encoding: "utf8", timeout: 20000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    "attr-ok": 1, "attr-fail": 125, "key-fail": 125, "type-fail": 125,
    "timeout-fail": 125, "refused-fail": 125, "kbint-fail": 125, "refused-ok": 1, "unproven-ok": 125,
    "cleanup-baseexception": 125, "relay-close-fail": 125, "relay-close-ok": 1,
  });
});
