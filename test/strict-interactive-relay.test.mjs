// #270: non-live tests for the interactive relay's frame parser, pane input
// gate and client pin. No client, sandbox, display or network is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = fileURLToPath(new URL("./live/strict-interactive-claude-relay.py", import.meta.url));
const linux = { skip: process.platform !== "linux" };

function python(body, ...args) {
  const script = `
import json, os, runpy, socket, sys
m = runpy.run_path(sys.argv[1])
Relay, Refused = m["AgentRelay"], m["RelayRefused"]
class Filter:
    def __init__(self): self.pushes = []
    def push(self, data):
        self.pushes.append(bytes(data))
        return bytes(data)
def fresh():
    r = object.__new__(Relay)
    r.text_filter = Filter()
    r.pending, r.output, r.input, r.send = bytearray(), bytearray(), bytearray(), bytearray()
    r.ready = r.prompted = r.turn = False
    return r
def frame(kind, payload): return kind + len(payload).to_bytes(2, "big") + payload
def outcome(fn):
    try:
        fn()
        return "ok"
    except Refused as e:
        return "refused:%d" % e.status
    except RuntimeError as e:
        return str(e)
${body}
`;
  const child = spawnSync("/usr/bin/python3", ["-I", "-c", script, RELAY, ...args], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("#270: relay frames are bounded, typed and reassembled across reads", linux, () => {
  const got = python(`
out = {}
r = fresh()
data = frame(b"O", b"hello\\n")
r.receive(data[:2]); a = bytes(r.output)
r.receive(data[2:5]); b = bytes(r.output)
r.receive(data[5:]); c = bytes(r.output)
out["split"] = [a.decode(), b.decode(), c.decode()]
r = fresh(); r.receive(b"".join(frame(b"O", b"x") for _ in range(50)))
out["batched"] = [len(r.text_filter.pushes), bytes(r.output).decode()]
for label, block in [("empty", b""), ("oversize-read", b"O" * 8193),
                     ("unknown-kind", frame(b"X", b"a")), ("zero-length", b"O\\x00\\x00"),
                     ("long-status", b"S" + (513).to_bytes(2, "big")),
                     ("bad-status", frame(b"S", b'{"event":"other"}'))]:
    r = fresh(); out[label] = outcome(lambda: r.receive(block))
r = fresh(); out["long-output"] = outcome(lambda: r.receive(b"O" + (8193).to_bytes(2, "big")))
ready, turn = frame(b"S", b'{"event":"ready"}'), frame(b"S", b'{"event":"turn"}')
r = fresh(); r.receive(ready); out["ready"] = r.ready
out["second-ready"] = outcome(lambda: r.receive(ready))
r = fresh(); r.receive(ready); out["turn-unprompted"] = outcome(lambda: r.receive(turn))
r = fresh(); r.receive(ready); r.prompted = True; r.receive(turn); out["turn"] = r.turn
out["second-turn"] = outcome(lambda: r.receive(turn))
r = fresh(); r.output.extend(b"y" * (128 * 1024 - 2))
out["output-limit"] = outcome(lambda: r.receive(frame(b"O", b"abc")))
print(json.dumps(out))
`);
  assert.deepEqual(got, {
    split: ["", "", "hello\n"],
    batched: [1, "x".repeat(50)],
    empty: "interactive-agent-exited",
    "oversize-read": "interactive-agent-frame-refused",
    "unknown-kind": "interactive-agent-frame-refused",
    "zero-length": "interactive-agent-frame-refused",
    "long-status": "interactive-agent-frame-refused",
    "bad-status": "interactive-agent-status-refused",
    "long-output": "interactive-agent-frame-refused",
    ready: true, "second-ready": "interactive-agent-status-refused",
    "turn-unprompted": "interactive-agent-status-refused",
    turn: true, "second-turn": "interactive-agent-status-refused",
    "output-limit": "interactive-agent-output-limit",
  });
});

test("#270: the pane may only type witness, once, after the client is ready", linux, () => {
  const got = python(`
def gate(chunks, ready):
    r = fresh(); r.ready = ready
    r.listener, lp = socket.socketpair(); r.channel, cp = socket.socketpair(); r.pane, pane = socket.socketpair()
    try:
        for chunk in chunks:
            pane.sendall(chunk)
            r.poll(0.2)
        return ["ok", r.prompted, bytes(r.send).decode()]
    except Refused as e:
        return ["refused:%d" % e.status, r.prompted, bytes(r.send).decode()]
    finally:
        for s in (r.listener, lp, r.channel, cp, r.pane, pane): s.close()
P = m["PROMPT"].decode()
print(json.dumps({
    "exact": gate([b"witness\\n"], True),
    "typed": gate([b"wit", b"ness", b"\\n"], True),
    "wrong": gate([b"witnesx"], True),
    "not-ready": gate([b"witness\\n"], False),
    "again": gate([b"witness\\n", b"w"], True),
    "PROMPT": P,
}))
`);
  const P = got.PROMPT;
  assert.deepEqual(got.exact, ["ok", true, P]);
  assert.deepEqual(got.typed, ["ok", true, P]);
  assert.deepEqual(got.wrong, ["refused:41", false, ""]);
  assert.deepEqual(got["not-ready"], ["refused:42", false, ""]);
  assert.equal(got.again[0], "refused:41");
});

test("#270: pin_client copies exactly the pinned ELF bytes and refuses anything else", linux, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skel-pin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("pinned client bytes")]);
  const pin = createHash("sha256").update(elf).digest("hex");
  const write = (name, bytes, mode) => fs.writeFileSync(path.join(dir, name), bytes, { mode });
  write("good", elf, 0o755);
  write("plain", elf, 0o644);
  write("script", Buffer.from("#!/bin/sh\n"), 0o755);
  write("tiny", Buffer.from([0x7f, 0x45]), 0o755);
  fs.symlinkSync(path.join(dir, "good"), path.join(dir, "link"));
  const got = python(`
from pathlib import Path
src, pin = sys.argv[2], sys.argv[3]
out = {}
for label, name, digest in [("good", "good", pin), ("wrong-pin", "good", "0" * 64), ("not-executable", "plain", pin),
                            ("not-elf", "script", pin), ("too-small", "tiny", pin), ("symlink", "link", pin)]:
    root = Path(src) / ("root-" + label); root.mkdir()
    try:
        target = m["pin_client"](os.path.join(src, name), digest, root)
        st = os.stat(target)
        out[label] = ["ok", oct(st.st_mode & 0o777), open(target, "rb").read() == open(os.path.join(src, "good"), "rb").read()]
    except RuntimeError as e:
        out[label] = [str(e)]
    except OSError as e:
        out[label] = ["oserror"]
root = Path(src) / "root-good"
try:
    m["pin_client"](os.path.join(src, "good"), pin, root)
    out["existing-target"] = ["ok"]
except OSError:
    out["existing-target"] = ["oserror"]
print(json.dumps(out))
`, dir, pin);
  const refused = ["interactive-client-pin-refused"];
  assert.deepEqual(got, {
    good: ["ok", "0o500", true],
    "wrong-pin": refused, "not-executable": refused, "not-elf": refused, "too-small": refused,
    symlink: ["oserror"], "existing-target": ["oserror"],
  });
});
