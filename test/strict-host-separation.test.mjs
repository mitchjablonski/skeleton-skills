// #270: the host-side descriptor and desktop checks behind the worker's own
// controlTerminalAbsent / desktopEndpointsAbsent reports. Non-live: plain
// child processes, no sandbox, display or socket connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./live/strict-lifecycle-fault-probe.py", import.meta.url));

test("#270: the host sees a member holding a host terminal or desktop access", { skip: process.platform !== "linux" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skel-host-sep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawnSync("/usr/bin/python3", ["-I", "-c", `
import json, os, runpy, subprocess, sys
g = runpy.run_path(sys.argv[1], run_name="probe_under_test")
held, reachable = g["host_terminal_held"], g["desktop_reachable"]
devpts = os.stat("/dev/pts").st_dev
def child(env=None, pass_fds=()):
    return subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(30)"], env=env or {},
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=pass_fds)
out = {}
plain = child()
master, slave = os.openpty()
tty = child(pass_fds=(slave,))
os.close(slave)
null = os.open("/dev/null", os.O_RDONLY)
devnull = child(pass_fds=(null,))
try:
    out["plain"] = held(plain.pid, devpts)
    out["hostPty"] = held(tty.pid, devpts)
    out["devNull"] = held(devnull.pid, devpts)
    g["DESKTOP_PATHS"] = (sys.argv[2] + "/absent",)
    reachable.__globals__["DESKTOP_PATHS"] = g["DESKTOP_PATHS"]
    out["cleanEnv"] = reachable(plain.pid)
    display = child({"DISPLAY": ":0"})
    bus = child({"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    try:
        out["displayEnv"] = reachable(display.pid)
        out["busEnv"] = reachable(bus.pid)
    finally:
        for p in (display, bus): p.kill(); p.wait()
    os.mkdir(sys.argv[2] + "/present")
    reachable.__globals__["DESKTOP_PATHS"] = (sys.argv[2] + "/present",)
    out["desktopPath"] = reachable(plain.pid)
finally:
    for p in (plain, tty, devnull): p.kill(); p.wait()
    os.close(master); os.close(null)
print(json.dumps(out))
`, PROBE, dir], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    plain: false, hostPty: true, devNull: false,
    cleanEnv: false, displayEnv: true, busEnv: true, desktopPath: true,
  });
});
