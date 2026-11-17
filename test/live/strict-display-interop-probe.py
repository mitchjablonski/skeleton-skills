#!/usr/bin/python3
"""Opt-in WSL2 N4 fixture (#159): interop, display, session, audio and vsock reach.

Measures the ACTUAL endpoints on this host from a Bubblewrap sandbox, each
gate with a positive control that removes only that gate. Never human proof,
never a support claim. Records no user names, home paths, socket names or
binary output: only labels, counts, exit statuses and errno names.

SAFETY: this fixture never connects to a live WSLg, X11, Wayland, Pulse or
session-bus socket. Connecting and closing those crashed weston (SIGPIPE)
on the measured host. Actual sockets are checked with stat() only: ENOENT
in the sandbox, a socket inode when bind-mounted. Connect checks use
synthetic listeners that this fixture owns.

Exit 0: every control behaved as recorded (findings may still be open).
Exit 1: a control failed, or cleanup failed. Exit 2: unsupported.
"""
import json
import os
import pathlib
import platform
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile

MAX = 32768
MZ = "/mnt/c/Windows/System32/whoami.exe"  # harmless; its output is never recorded
VSOCK_HOST_CID = 2
VSOCK_PORT = 50000  # observed WSL host service port; one connect-and-close, nothing sent
ENV_KEYS = ("DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "WSL_INTEROP", "PULSE_SERVER", "XDG_RUNTIME_DIR")
AF_VSOCK = 40
NR_SOCKET, NR_IO_URING_SETUP = 41, 425  # x86_64
EAFNOSUPPORT, ENOSYS = 97, 38

# Runs inside each sandbox. Reads its plan from argv; prints one JSON line.
WORKER = r'''
import ctypes, errno, json, os, socket, stat, subprocess, sys
plan = json.loads(sys.argv[1])
out = {"env": sorted(k for k in plan["envKeys"] if k in os.environ), "stat": [], "connect": [], "vsock": {}}
def name(e): return errno.errorcode.get(e.errno, "E?") if isinstance(e, OSError) and e.errno else type(e).__name__
for label, path in plan["stat"]:
    try:
        st = os.stat(path); r = "socket" if stat.S_ISSOCK(st.st_mode) else "not-socket"
    except OSError as e: r = name(e)
    out["stat"].append([label, r])
for kind, label, addr in plan["connect"]:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(1)
    try: s.connect(("\0" + addr[1:]) if kind == "abstract" else addr); r = "connected"
    except OSError as e: r = name(e)
    finally: s.close()
    out["connect"].append([kind, label, r])
try:
    socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM).close(); out["vsock"]["create"] = "ok"
except OSError as e: out["vsock"]["create"] = name(e)
if plan["vsock"]:
    try:
        v = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); v.settimeout(1)
        try: v.connect((2, plan["vsockPort"])); r = "connected"
        finally: v.close()
    except OSError as e: r = name(e)
    out["vsock"]["connect"] = r
libc = ctypes.CDLL(None, use_errno=True)
rc = libc.syscall(425, 1, ctypes.c_void_p(0))
out["ioUringSetup"] = "ok" if rc >= 0 else errno.errorcode.get(ctypes.get_errno(), "E?")
if rc >= 0: os.close(rc)
if plan["mz"]:
    try:
        p = subprocess.run(["/win/probe.exe"], stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        out["mz"] = {"exit": p.returncode, "stdout": len(p.stdout) > 0}
    except OSError as e: out["mz"] = {"exec": name(e), "stdout": False}
    except subprocess.TimeoutExpired: out["mz"] = {"exec": "timeout", "stdout": False}
print(json.dumps(out, sort_keys=True))
'''


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))


def seccomp_program():
    """x86_64 BPF: refuse socket(AF_VSOCK) and io_uring_setup; kill other ABIs."""
    def ins(code, jt, jf, k):
        return struct.pack("HBBI", code, jt, jf, k)
    LD_ABS, JEQ, JGE, RET = 0x20, 0x15, 0x35, 0x06
    KILL, ALLOW, ERRNO = 0x80000000, 0x7FFF0000, 0x00050000
    prog = [
        ins(LD_ABS, 0, 0, 4),                 # 0 arch
        ins(JEQ, 1, 0, 0xC000003E),           # 1 x86_64 -> 3
        ins(RET, 0, 0, KILL),                 # 2
        ins(LD_ABS, 0, 0, 0),                 # 3 nr
        ins(JGE, 0, 1, 0x40000000),           # 4 x32 ABI -> kill
        ins(RET, 0, 0, KILL),                 # 5
        ins(JEQ, 0, 1, NR_IO_URING_SETUP),    # 6
        ins(RET, 0, 0, ERRNO | ENOSYS),       # 7
        ins(JEQ, 0, 3, NR_SOCKET),            # 8 not socket -> 12
        ins(LD_ABS, 0, 0, 16),                # 9 args[0] low word (domain is an int)
        ins(JEQ, 0, 1, AF_VSOCK),             # 10
        ins(RET, 0, 0, ERRNO | EAFNOSUPPORT), # 11
        ins(RET, 0, 0, ALLOW),                # 12
    ]
    return b"".join(prog)


def host_env():
    return {k: os.environ[k] for k in ENV_KEYS if k in os.environ}


def actual_sockets(env):
    """Candidate actual endpoints as (label, path); stat only, never connected."""
    found = [("x11", "/tmp/.X11-unix/X0")]
    runtime = env.get("XDG_RUNTIME_DIR")
    if runtime and env.get("WAYLAND_DISPLAY"):
        found.append(("wayland", str(pathlib.Path(runtime) / env["WAYLAND_DISPLAY"])))
    bus = env.get("DBUS_SESSION_BUS_ADDRESS", "")
    if bus.startswith("unix:path="):
        found.append(("session-bus", bus[len("unix:path="):].split(",")[0]))
    found += [("pulse", "/mnt/wslg/PulseServer"), ("rdp-sink", "/mnt/wslg/PulseAudioRDPSink"),
              ("rdp-source", "/mnt/wslg/PulseAudioRDPSource")]
    present, missing = [], []
    for label, path in found:
        try:
            ok = stat.S_ISSOCK(os.stat(path).st_mode)
        except OSError:
            ok = False
        if ok:
            present.append((label, os.path.realpath(path)))
        else:
            missing.append(label)
    return present, missing


def actual_abstract_listeners():
    """Count listening abstract sockets in /proc/net/unix without connecting to any."""
    with open("/proc/net/unix") as source:
        rows = source.read(1 << 20).splitlines()[1:]
    names = {f[7] for f in (r.split() for r in rows) if len(f) >= 8 and f[3] == "00010000" and f[7].startswith("@")}
    return len(names)


def sandbox_argv(net=True, clearenv=True, extra=()):
    argv = ["/usr/bin/bwrap", "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts",
            "--unshare-cgroup-try", "--die-with-parent", "--new-session"]
    if net:
        argv.append("--unshare-net")
    if clearenv:
        argv.append("--clearenv")
    argv += ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if pathlib.Path("/lib64").exists():
        argv += ["--ro-bind", "/lib64", "/lib64"]
    argv += ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--ro-bind", MZ, "/win/probe.exe"]
    return argv + list(extra)


def run_sandbox(root, label, argv, plan, env, pass_fds=()):
    full = argv + ["--", "/usr/bin/python3", "-I", "-c", WORKER, json.dumps(plan)]
    with (root / (label + ".out")).open("wb") as out, (root / (label + ".err")).open("wb") as err:
        process = subprocess.run(full, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env=env,
                                 pass_fds=pass_fds, preexec_fn=limits, timeout=60)
    assert process.returncode == 0, label + " worker failed"
    data = (root / (label + ".out")).read_bytes()
    assert len(data) <= MAX
    return json.loads(data)


def tally(rows, value):
    return {"attempted": len(rows), "matched": sum(1 for r in rows if r[-1] == value),
            "results": sorted({r[-1] for r in rows})}


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    listeners = []
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux") and platform.machine() == "x86_64"
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file() and pathlib.Path(MZ).is_file()
        binfmt = pathlib.Path("/proc/sys/fs/binfmt_misc/WSLInterop")
        assert binfmt.is_file() and pathlib.Path("/run/WSL").is_dir()
        interop = binfmt.read_text()[:4096].splitlines()
        assert interop and interop[0] == "enabled"
        flags = next((row.split(":", 1)[1].strip() for row in interop if row.startswith("flags:")), "")
        env = host_env()
        present, missing = actual_sockets(env)
        labels = [label for label, _ in present]
        # Without the display sockets there is nothing real to measure: unsupported, not a pass.
        required = ["x11"] + (["wayland"] if env.get("WAYLAND_DISPLAY") else [])
        assert all(label in labels for label in required), "WSLg display sockets unavailable"
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-display-interop-")).resolve()
        os.chmod(root, 0o700)

        # Host positive controls.
        host_mz = subprocess.run([MZ], stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        assert host_mz.returncode == 0 and host_mz.stdout, "host interop positive control failed"
        host_vsock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        host_vsock.settimeout(1)
        try:
            host_vsock.connect((VSOCK_HOST_CID, VSOCK_PORT))
        finally:
            host_vsock.close()
        actual_abstract = actual_abstract_listeners()  # counted before our own listener exists
        # Synthetic listeners owned by the fixture: the only unix sockets ever connected to.
        path_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listeners.append(path_listener)
        synthetic_path = str(root / "synthetic.sock")
        path_listener.bind(synthetic_path)
        path_listener.listen(16)
        abstract_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listeners.append(abstract_listener)
        synthetic_abstract = "@strict-display-interop-" + os.urandom(8).hex()
        abstract_listener.bind("\0" + synthetic_abstract[1:])
        abstract_listener.listen(16)
        exit_code = 1
        result["code"] = "fixture-failed"

        stat_plan = [[label, path] for label, path in present]
        connect_plan = [["path", "synthetic-path", synthetic_path], ["abstract", "synthetic-abstract", synthetic_abstract]]
        plan = {"envKeys": list(ENV_KEYS), "stat": stat_plan, "connect": connect_plan,
                "vsock": True, "vsockPort": VSOCK_PORT, "mz": True}
        quiet = dict(plan, mz=False, vsock=False)

        strict = run_sandbox(root, "strict", sandbox_argv(), plan, env)
        positive_env = run_sandbox(root, "env-positive", sandbox_argv(clearenv=False), quiet, env)
        interop_run_wsl = run_sandbox(root, "interop-run-wsl", sandbox_argv(extra=[
            "--ro-bind", "/run/WSL", "/run/WSL"]), dict(quiet, mz=True), env)
        interop_env_only = run_sandbox(root, "interop-env-only", sandbox_argv(extra=[
            "--setenv", "WSL_INTEROP", env.get("WSL_INTEROP", "/run/WSL/1_interop")]), dict(quiet, mz=True), env)
        binds = []
        for _label, path in present:
            binds += ["--bind", path, path]
        binds += ["--bind", synthetic_path, synthetic_path]
        positive_path = run_sandbox(root, "path-positive", sandbox_argv(extra=binds), quiet, env)
        positive_net = run_sandbox(root, "net-positive", sandbox_argv(net=False), quiet, env)
        prog_r, prog_w = os.pipe()
        try:
            os.write(prog_w, seccomp_program())
            os.close(prog_w)
            prog_w = None
            mitigated = run_sandbox(root, "seccomp", sandbox_argv(extra=["--seccomp", str(prog_r)]),
                                    dict(quiet, vsock=True), env, pass_fds=(prog_r,))
        finally:
            os.close(prog_r)
            if prog_w is not None:
                os.close(prog_w)

        def connect_result(run, label):
            return next(r[2] for r in run["connect"] if r[1] == label)

        # Environment: none in strict; every host key without --clearenv.
        assert strict["env"] == [] and positive_env["env"] == sorted(env), "environment gate or its positive control failed"
        # Interop is gated by /run/WSL, not by the environment variable.
        assert strict["mz"]["stdout"] is False and strict["mz"].get("exit", 1) != 0, "Windows binary ran in the strict sandbox"
        assert interop_env_only["mz"]["stdout"] is False and interop_env_only["mz"].get("exit", 1) != 0, \
            "WSL_INTEROP alone ran the Windows binary"
        assert interop_run_wsl["mz"] == {"exit": 0, "stdout": True}, "interop positive control (/run/WSL only) failed"
        # Actual sockets by stat: absent in strict, socket inodes when bound.
        assert all(r[1] == "ENOENT" for r in strict["stat"]), "an actual socket is visible in the strict sandbox"
        assert all(r[1] == "socket" for r in positive_path["stat"]), "bound actual sockets not visible"
        # Synthetic listeners: the mount gate and the network-namespace gate.
        assert connect_result(strict, "synthetic-path") == "ENOENT" and connect_result(positive_path, "synthetic-path") == "connected"
        assert connect_result(strict, "synthetic-abstract") == "ECONNREFUSED" and connect_result(positive_net, "synthetic-abstract") == "connected"
        # vsock: the host reached the port above (positive control); seccomp refuses the family.
        assert mitigated["vsock"] == {"create": "EAFNOSUPPORT", "connect": "EAFNOSUPPORT"} and mitigated["ioUringSetup"] == "ENOSYS", \
            "seccomp mitigation did not refuse vsock and io_uring"
        assert all(r[1] == "ENOENT" for r in mitigated["stat"]) and connect_result(mitigated, "synthetic-abstract") == "ECONNREFUSED"

        result.update(
            ok=True, code="display-interop-fixture-passed",
            interop={"binfmtFlags": flags[:16], "hostExit": 0, "strict": strict["mz"],
                     "envOnlyNoRunWsl": interop_env_only["mz"], "runWslOnly": interop_run_wsl["mz"]},
            environment={"strictKeys": strict["env"], "positiveKeys": len(positive_env["env"]), "hostKeys": len(env)},
            actualSockets={"checkedByStatOnly": labels, "absentOnHost": missing,
                           "strict": tally(strict["stat"], "ENOENT"), "bound": tally(positive_path["stat"], "socket")},
            synthetic={"pathStrict": connect_result(strict, "synthetic-path"),
                       "pathBound": connect_result(positive_path, "synthetic-path"),
                       "abstractStrict": connect_result(strict, "synthetic-abstract"),
                       "abstractSharedNet": connect_result(positive_net, "synthetic-abstract"),
                       "actualAbstractListenersOnHost": actual_abstract},
            vsock={"hostConnect": "connected", "strict": strict["vsock"], "strictIoUringSetup": strict["ioUringSetup"],
                   "seccomp": mitigated["vsock"], "seccompIoUringSetup": mitigated["ioUringSetup"]},
            findings={"vsockFamilyAvailableInNetnsSandbox": strict["vsock"]["create"] == "ok",
                      "vsockHostPortReachedFromNetnsSandbox": strict["vsock"].get("connect") == "connected"},
            platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                      "pythonVersion": platform.python_version()},
            limitations=["actual WSLg/Pulse/bus sockets are checked by stat only and never connected to",
                         "connect checks use synthetic listeners owned by the fixture",
                         "one vsock port, one connect-and-close; other host vsock services were not enumerated",
                         "the seccomp filter is a fixture mitigation, not an adopted profile",
                         "measured host only; no support claim"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, RuntimeError, StopIteration,
            subprocess.SubprocessError):
        pass
    finally:
        for listener in listeners:
            listener.close()
        if root is not None and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith("strict-display-interop-") and not root.is_symlink()
                shutil.rmtree(root)
            except (OSError, AssertionError):
                cleanup = False
        if not cleanup:
            result.update(ok=False, code="cleanup-failed", cleanupFailed=True)
            exit_code = 1
        if exit_code == 1 and root is not None and root.exists():
            result["ok"] = False
            result["retainedScratch"] = str(root)
        print(json.dumps(result, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
