// #270: the host-side descriptor, controlling-terminal and desktop checks
// behind the worker's own controlTerminalAbsent / desktopEndpointsAbsent
// reports. Non-live: plain child processes, no sandbox, display or socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./live/strict-lifecycle-fault-probe.py", import.meta.url));

test("#270: the host refuses any member terminal outside the sandbox allowlist, and desktop access", { skip: process.platform !== "linux" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skel-host-sep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawnSync("/usr/bin/python3", ["-I", "-c", `
import json, os, runpy, subprocess, sys
g = runpy.run_path(sys.argv[1], run_name="probe_under_test")
held, reachable, private = g["host_terminal_held"], g["desktop_reachable"], g["namespace_devpts"]
SLEEP = "import time; time.sleep(30)"
def child(env=None, pass_fds=(), code=SLEEP, args=(), session=False):
    return subprocess.Popen(["/usr/bin/python3", "-c", code, *args], env=env or {}, start_new_session=session,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=pass_fds)
procs, fds = [], []
def keep(p):
    # /proc/<pid>/cmdline and environ can read empty just after exec; wait for the child's argv.
    procs.append(p)
    import time
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with open(f"/proc/{p.pid}/cmdline", "rb") as f:
            if b"time.sleep" in f.read(): break
        time.sleep(0.02)
    return p
out = {}
try:
    plain = keep(child())
    out["hostRootHasNoPrivateDevpts"] = private(plain.pid) is None
    master, slave = os.openpty(); fds += [master, slave]
    ptmx = os.open("/dev/ptmx", os.O_RDWR | os.O_NOCTTY); fds.append(ptmx)
    null, zero = os.open("/dev/null", os.O_RDONLY), os.open("/dev/zero", os.O_RDONLY); fds += [null, zero]
    host_dev = os.stat("/dev/pts").st_dev
    with_slave, with_master, with_ptmx = keep(child(pass_fds=(slave,))), keep(child(pass_fds=(master,))), keep(child(pass_fds=(ptmx,)))
    sandbox_nodes = keep(child(pass_fds=(null, zero)))
    # A session leader that opens a tty acquires it as controlling terminal; it then closes the fd.
    ctty = keep(child(code="import os, sys, time; os.close(os.open(sys.argv[1], os.O_RDWR)); time.sleep(30)",
                      args=(os.ttyname(slave),), session=True))
    import time; time.sleep(0.5)
    out["plain"] = held(plain.pid, None)
    out["sandboxNodes"] = held(sandbox_nodes.pid, None)
    out["hostSlave"] = held(with_slave.pid, None)
    out["hostMaster"] = held(with_master.pid, None)
    out["hostPtmx"] = held(with_ptmx.pid, None)
    out["controllingTerminal"] = held(ctty.pid, None)
    # A pty on the namespace's own devpts is allowed; simulate by naming this devpts as private.
    out["privateSlaveAllowed"] = held(with_slave.pid, host_dev)
    out["masterStillRefused"] = held(with_master.pid, host_dev)
    reachable.__globals__["DESKTOP_PATHS"] = (sys.argv[2] + "/absent",)
    out["cleanEnv"] = reachable(plain.pid)
    out["displayEnv"] = reachable(keep(child({"DISPLAY": ":0"})).pid)
    out["busEnv"] = reachable(keep(child({"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})).pid)
    os.mkdir(sys.argv[2] + "/present")
    reachable.__globals__["DESKTOP_PATHS"] = (sys.argv[2] + "/present",)
    out["desktopPath"] = reachable(plain.pid)
finally:
    for p in procs: p.kill(); p.wait()
    for fd in fds: os.close(fd)
print(json.dumps(out))
`, PROBE, dir], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    hostRootHasNoPrivateDevpts: true,
    plain: false, sandboxNodes: false,
    hostSlave: true, hostMaster: true, hostPtmx: true, controllingTerminal: true,
    privateSlaveAllowed: false, masterStillRefused: true,
    cleanEnv: false, displayEnv: true, busEnv: true, desktopPath: true,
  });
});
