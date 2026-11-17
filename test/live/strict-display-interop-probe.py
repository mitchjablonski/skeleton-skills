#!/usr/bin/python3
"""Opt-in WSL2 N4 fixture (#159): interop, display, session, audio and vsock reach.

Measures the ACTUAL endpoints on this host from a Bubblewrap sandbox, each
gate with a positive control that removes only that gate. Never human proof,
never a support claim. Records no user names, home paths, socket names or
binary output: only labels, counts, exit statuses and errno names.

Exit 0: every control behaved as recorded (findings may still be open).
Exit 1: a control failed, or cleanup failed. Exit 2: unsupported.
"""
import errno
import json
import os
import pathlib
import platform
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

MAX = 32768
MZ = "/mnt/c/Windows/System32/whoami.exe"  # harmless; its output is never recorded
VSOCK_HOST_CID = 2
VSOCK_PORTS = (50000,)  # observed WSL host service port; connect and close only
ENV_KEYS = ("DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "WSL_INTEROP", "PULSE_SERVER", "XDG_RUNTIME_DIR")
MAX_ABSTRACT = 32
AF_VSOCK = 40
NR_SOCKET, NR_IO_URING_SETUP = 41, 425  # x86_64
EAFNOSUPPORT, ENOSYS = 97, 38

# Runs inside each sandbox. Reads its plan from argv; prints one JSON line.
WORKER = r'''
import ctypes, errno, json, os, socket, subprocess, sys
plan = json.loads(sys.argv[1])
out = {"env": sorted(k for k in plan["envKeys"] if k in os.environ), "unix": [], "vsock": {}}
def name(e): return errno.errorcode.get(e.errno, "E?") if isinstance(e, OSError) and e.errno else type(e).__name__
import time
def attempt(kind, addr):
    # WSLg servers sometimes refuse or lag a burst of connects, so a busy
    # listener gets a few short retries; a missing path or a blocked
    # namespace fails the same way every time.
    for tries in range(6):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(1)
        try:
            s.connect(("\0" + addr[1:]) if kind == "abstract" else addr); return "connected"
        except OSError as e: r = name(e)
        finally: s.close()
        if r not in ("ECONNREFUSED", "EAGAIN"): return r
        time.sleep(0.2)
    return r
for kind, label, addr in plan["unix"]:
    out["unix"].append([kind, label, attempt(kind, addr)])
try:
    socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM).close(); out["vsock"]["create"] = "ok"
except OSError as e: out["vsock"]["create"] = name(e)
for port in plan["vsockPorts"]:
    try:
        v = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); v.settimeout(1)
        try: v.connect((2, port)); r = "connected"
        finally: v.close()
    except OSError as e: r = name(e)
    out["vsock"][str(port)] = r
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
        ins(LD_ABS, 0, 0, 16),                # 9 args[0] low word
        ins(JEQ, 0, 1, AF_VSOCK),             # 10
        ins(RET, 0, 0, ERRNO | EAFNOSUPPORT), # 11
        ins(RET, 0, 0, ALLOW),                # 12
    ]
    return b"".join(prog)


def host_env():
    return {k: os.environ[k] for k in ENV_KEYS if k in os.environ}


def unix_targets(env):
    """Actual pathname and abstract listening sockets on this host, with labels."""
    paths = []
    x11 = pathlib.Path("/tmp/.X11-unix/X0")
    if x11.exists():
        paths.append(("x11", str(x11)))
    runtime = env.get("XDG_RUNTIME_DIR")
    if runtime and env.get("WAYLAND_DISPLAY"):
        paths.append(("wayland", str(pathlib.Path(runtime) / env["WAYLAND_DISPLAY"])))
    bus = env.get("DBUS_SESSION_BUS_ADDRESS", "")
    if bus.startswith("unix:path="):
        paths.append(("session-bus", bus[len("unix:path="):].split(",")[0]))
    for label, candidate in (("pulse", "/mnt/wslg/PulseServer"), ("rdp-sink", "/mnt/wslg/PulseAudioRDPSink"),
                             ("rdp-source", "/mnt/wslg/PulseAudioRDPSource")):
        if pathlib.Path(candidate).exists():
            paths.append((label, candidate))
    abstract = []
    with open("/proc/net/unix") as source:
        rows = source.read(1 << 20).splitlines()[1:]
    for row in rows:
        fields = row.split()
        # Num RefCount Protocol Flags Type St Inode Path; Flags 00010000 = listening
        if len(fields) >= 8 and fields[3] == "00010000" and fields[7].startswith("@"):
            if fields[7] not in abstract:
                abstract.append(fields[7])
    targets = [["path", label, addr] for label, addr in paths]
    targets += [["abstract", "abstract-%d" % i, addr] for i, addr in enumerate(abstract[:MAX_ABSTRACT])]
    return targets


def host_reach(targets):
    reached = []
    for kind, label, addr in targets:
        for tries in range(6):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(1)
            try:
                s.connect(("\0" + addr[1:]) if kind == "abstract" else addr)
                reached.append([kind, label, addr])
                break
            except OSError as error:
                if error.errno not in (errno.ECONNREFUSED, errno.EAGAIN):
                    break
                time.sleep(0.2)
            finally:
                s.close()
    return reached


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


def reach_of(result, kind):
    rows = [r for r in result["unix"] if r[0] == kind]
    return {"attempted": len(rows), "connected": sum(1 for r in rows if r[2] == "connected"),
            "errnos": sorted({r[2] for r in rows if r[2] != "connected"})}


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    listener = None
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
        sockets = sorted(p for p in os.listdir("/run/WSL") if p.endswith("_interop"))
        assert sockets
        env = host_env()
        interop_env = env.get("WSL_INTEROP") or "/run/WSL/" + sockets[0]
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-display-interop-")).resolve()
        os.chmod(root, 0o700)

        # Host positive controls.
        host_mz = subprocess.run([MZ], stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        assert host_mz.returncode == 0 and host_mz.stdout, "host interop positive control failed"
        actual = host_reach(unix_targets(env))
        assert any(t[0] == "path" for t in actual), "no host-reachable pathname endpoint"
        actual_abstract = sum(1 for t in actual if t[0] == "abstract")
        # This host may have no actual abstract listener (WSLg X11 uses a
        # pathname socket). A throwaway abstract listener, labelled synthetic,
        # keeps a positive control for the network-namespace gate itself.
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        synthetic = "@strict-display-interop-" + os.urandom(8).hex()
        listener.bind("\0" + synthetic[1:])
        listener.listen(16)
        targets = actual + host_reach([["abstract", "synthetic-abstract", synthetic]])
        assert targets[-1][1] == "synthetic-abstract", "synthetic abstract listener unreachable on host"
        exit_code = 1
        result["code"] = "fixture-failed"
        plan = {"envKeys": list(ENV_KEYS), "unix": targets, "vsockPorts": list(VSOCK_PORTS), "mz": True}
        quiet = dict(plan, mz=False)

        strict = run_sandbox(root, "strict", sandbox_argv(), plan, env)
        positive_env = run_sandbox(root, "env-positive", sandbox_argv(clearenv=False), quiet, env)
        positive_interop = run_sandbox(root, "interop-positive", sandbox_argv(extra=[
            "--ro-bind", "/run/WSL", "/run/WSL", "--setenv", "WSL_INTEROP", interop_env]), plan, env)
        binds = []
        for kind, _label, addr in targets:
            if kind == "path":
                binds += ["--bind", addr, addr]
        positive_path = run_sandbox(root, "path-positive", sandbox_argv(extra=binds), quiet, env)
        positive_net = run_sandbox(root, "net-positive", sandbox_argv(net=False), quiet, env)
        prog_r, prog_w = os.pipe()
        try:
            os.write(prog_w, seccomp_program())
            os.close(prog_w)
            prog_w = None
            mitigated = run_sandbox(root, "seccomp", sandbox_argv(extra=["--seccomp", str(prog_r)]), quiet, env,
                                    pass_fds=(prog_r,))
        finally:
            os.close(prog_r)
            if prog_w is not None:
                os.close(prog_w)

        # Gates and their positive controls.
        assert strict["env"] == [] and positive_env["env"], "environment gate or its positive control failed"
        assert strict["mz"]["stdout"] is False and strict["mz"].get("exit", 1) != 0, "Windows binary ran in the strict sandbox"
        assert positive_interop["mz"] == {"exit": 0, "stdout": True}, "interop positive control failed"
        for kind, positive in (("path", positive_path), ("abstract", positive_net)):
            strict_reach, positive_reach = reach_of(strict, kind), reach_of(positive, kind)
            assert strict_reach["connected"] == 0, kind + " endpoint reachable from the strict sandbox"
            assert positive_reach["connected"] == positive_reach["attempted"], kind + " positive control failed"
        assert mitigated["vsock"]["create"] == "EAFNOSUPPORT" and mitigated["ioUringSetup"] == "ENOSYS", \
            "seccomp mitigation did not refuse vsock and io_uring"
        assert all(v == "EAFNOSUPPORT" for k, v in mitigated["vsock"].items()), "vsock reachable under seccomp"
        assert reach_of(mitigated, "path")["connected"] == 0 and reach_of(mitigated, "abstract")["connected"] == 0

        vsock_open = any(v == "connected" for k, v in strict["vsock"].items() if k != "create")
        result.update(
            ok=True, code="display-interop-fixture-passed",
            interop={"binfmtFlags": flags[:16], "hostExit": 0, "strict": strict["mz"],
                     "positiveWithRunWsl": positive_interop["mz"]},
            environment={"strictKeys": strict["env"], "positiveKeys": len(positive_env["env"])},
            pathname={"labels": sorted({t[1] for t in targets if t[0] == "path"}),
                      "strict": reach_of(strict, "path"), "positiveBound": reach_of(positive_path, "path")},
            abstract={"actualListeners": actual_abstract, "synthetic": 1,
                      "strict": reach_of(strict, "abstract"), "positiveSharedNet": reach_of(positive_net, "abstract")},
            vsock={"strict": strict["vsock"], "strictIoUringSetup": strict["ioUringSetup"],
                   "seccomp": mitigated["vsock"], "seccompIoUringSetup": mitigated["ioUringSetup"]},
            findings={"vsockReachesHostFromNetnsSandbox": vsock_open,
                      "n4SatisfiedByNamespacesAlone": not vsock_open},
            platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                      "pythonVersion": platform.python_version()},
            limitations=["connect-and-close only: no protocol, clipboard or automation semantics",
                         "one observed vsock port; other host vsock services were not enumerated",
                         "abstract sockets: actual listeners only if present, plus one synthetic listener",
                         "the seccomp filter is a fixture mitigation, not an adopted profile",
                         "measured host only; no support claim"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, RuntimeError, StopIteration,
            subprocess.SubprocessError):
        pass
    finally:
        if listener is not None:
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
