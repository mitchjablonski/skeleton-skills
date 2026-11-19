#!/usr/bin/python3
"""Opt-in Linux fixture (#172): the agent can't attach to, read, or take
descriptors from a launcher-side process.

A host-side stand-in (for the console or authority) holds a random secret in
memory and a private descriptor. From a Bubblewrap sandbox (same uid), the
agent tries ptrace(PTRACE_ATTACH), process_vm_readv, /proc/<pid>/mem and
pidfd_open + pidfd_getfd against the stand-in's host pid. Two layers are
measured separately: with a pid namespace the pid isn't even visible; without
one (a positive control for visibility) it is visible but every access must
still be refused. The launcher, as the stand-in's parent, can read the secret
and take the descriptor (positive control for the access paths). Output has
errno names only, never the secret. Never human proof.

Exit 0: passed. Exit 1: a check or positive control failed. Exit 2: unsupported.
"""
import ctypes
import errno
import json
import os
import pathlib
import platform
import select
import shutil
import subprocess
import sys
import tempfile
import time

MAX = 32768
NR_PIDFD_GETFD = 438  # x86_64
PTRACE_ATTACH, PTRACE_DETACH = 16, 17

STANDIN = r'''
import ctypes, json, os, sys, time
secret = bytes.fromhex(sys.argv[1])
buf = ctypes.create_string_buffer(secret, len(secret))
r, w = os.pipe()
os.write(w, b"private")
print(json.dumps({"addr": ctypes.addressof(buf), "length": len(secret), "fd": r}), flush=True)
while True: time.sleep(1)
'''

# Runs in the sandbox (and, for the controls, outside it).
WORKER = r'''
import ctypes, errno, json, os, sys
plan = json.loads(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
pid, addr, length, fd, secret = plan["pid"], plan["addr"], plan["length"], plan["fd"], bytes.fromhex(plan["secret"])
def err(): return errno.errorcode.get(ctypes.get_errno(), "E?")
out = {"visible": os.path.exists("/proc/%d" % pid)}
class iovec(ctypes.Structure): _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
dst = ctypes.create_string_buffer(length)
local, remote = iovec(ctypes.addressof(dst), length), iovec(addr, length)
libc.process_vm_readv.restype = ctypes.c_ssize_t
n = libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
out["processVmReadv"] = ("read-secret" if dst.raw == secret else "read-other") if n == length else err()
libc.ptrace.restype = ctypes.c_long
rc = libc.ptrace(16, pid, None, None)
if rc == 0:
    out["ptraceAttach"] = "attached"
    try: os.waitpid(pid, 0)  # a tracer may wait for its tracee to stop
    except OSError: pass
    libc.ptrace(17, pid, None, None)
else:
    out["ptraceAttach"] = err()
try:
    with open("/proc/%d/mem" % pid, "rb", buffering=0) as m:
        m.seek(addr); out["procMem"] = "read-secret" if m.read(length) == secret else "read-other"
except OSError as e:
    out["procMem"] = errno.errorcode.get(e.errno, "E?")
try:
    pidfd = os.pidfd_open(pid); out["pidfdOpen"] = "ok"
    got = libc.syscall(438, pidfd, fd, 0)
    if got >= 0:
        out["pidfdGetfd"] = "took-descriptor" if os.read(got, 16) == b"private" else "took-other"; os.close(got)
    else:
        out["pidfdGetfd"] = err()
    os.close(pidfd)
except OSError as e:
    out["pidfdOpen"] = errno.errorcode.get(e.errno, "E?"); out["pidfdGetfd"] = "not-attempted"
print(json.dumps(out, sort_keys=True))
'''


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))


def bwrap_argv(pidns=True):
    argv = ["/usr/bin/bwrap", "--unshare-user", "--unshare-ipc", "--unshare-net", "--unshare-uts",
            "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--clearenv"]
    if pidns:
        argv.append("--unshare-pid")
    argv += ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if pathlib.Path("/lib64").exists():
        argv += ["--ro-bind", "/lib64", "/lib64"]
    return argv + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"]


def run(root, label, prefix, plan):
    argv = prefix + ["/usr/bin/python3", "-I", "-c", WORKER, json.dumps(plan)]
    with (root / (label + ".out")).open("wb") as out, (root / (label + ".err")).open("wb") as err:
        process = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env={},
                                 preexec_fn=limits, timeout=30)
    assert process.returncode == 0, label + " worker failed"
    data = (root / (label + ".out")).read_bytes()
    assert len(data) <= MAX
    return json.loads(data)


def read_line(fd, deadline):
    data = b""
    while not data.endswith(b"\n"):
        remaining = deadline - time.monotonic()
        assert remaining > 0 and select.select([fd], [], [], remaining)[0], "stand-in record timeout"
        chunk = os.read(fd, 1024)
        assert chunk and len(data) + len(chunk) <= 4096, "stand-in record malformed"
        data += chunk
    return json.loads(data)


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    standin = None
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux") and platform.machine() == "x86_64"
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file()
        try:
            yama = pathlib.Path("/proc/sys/kernel/yama/ptrace_scope").read_text().strip()[:4]
        except OSError:
            yama = "absent"
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-process-reach-")).resolve()
        os.chmod(root, 0o700)
        capability = subprocess.run(bwrap_argv() + ["--", "/usr/bin/true"], stdin=subprocess.DEVNULL,
                                    capture_output=True, env={}, timeout=30, preexec_fn=limits)
        assert capability.returncode == 0, "bubblewrap cannot start a sandbox"

        secret = os.urandom(32).hex()
        standin = subprocess.Popen(["/usr/bin/python3", "-I", "-c", STANDIN, secret], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={}, preexec_fn=limits)
        record = read_line(standin.stdout.fileno(), time.monotonic() + 10)
        exit_code = 1
        result["code"] = "fixture-failed"
        plan = {"pid": standin.pid, "addr": record["addr"], "length": record["length"], "fd": record["fd"], "secret": secret}

        # Positive control for the access paths: the launcher (the stand-in's parent).
        launcher = run(root, "launcher", [], plan)
        # Note: the launcher-side worker is a child of the probe, a sibling of the
        # stand-in, so Yama scope 1 may refuse it; the probe itself is the parent.
        libc = ctypes.CDLL(None, use_errno=True)

        class iovec(ctypes.Structure):
            _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
        dst = ctypes.create_string_buffer(record["length"])
        libc.process_vm_readv.restype = ctypes.c_ssize_t
        n = libc.process_vm_readv(standin.pid, ctypes.byref(iovec(ctypes.addressof(dst), record["length"])), 1,
                                  ctypes.byref(iovec(record["addr"], record["length"])), 1, 0)
        assert n == record["length"] and dst.raw == bytes.fromhex(secret), "parent could not read the stand-in (positive control)"
        pidfd = os.pidfd_open(standin.pid)
        try:
            got = libc.syscall(NR_PIDFD_GETFD, pidfd, record["fd"], 0)
            assert got >= 0, "parent could not take the stand-in's descriptor (positive control)"
            try:
                assert os.read(got, 16) == b"private"
            finally:
                os.close(got)
        finally:
            os.close(pidfd)

        # The agent, with a pid namespace: the stand-in isn't even visible.
        agent = run(root, "agent", bwrap_argv() + ["--"], plan)
        assert agent == {"visible": False, "processVmReadv": "ESRCH", "ptraceAttach": "ESRCH", "procMem": "ENOENT",
                         "pidfdOpen": "ESRCH", "pidfdGetfd": "not-attempted"}, "the agent reached the stand-in"
        # Visibility control: without a pid namespace the pid is visible, and
        # every access must still be refused (credentials and Yama, not hiding).
        visible = run(root, "no-pidns", bwrap_argv(pidns=False) + ["--"], plan)
        assert visible["visible"] is True, "visibility control: the stand-in should be visible without a pid namespace"
        leaked = [k for k, v in visible.items() if v in ("read-secret", "read-other", "attached", "took-descriptor", "took-other")]
        assert not leaked, "a visible stand-in was accessed from the sandbox"

        result.update(ok=True, code="process-reach-fixture-passed", yamaPtraceScope=yama,
                      parentPositiveControl={"processVmReadv": "read-secret", "pidfdGetfd": "took-descriptor"},
                      launcherSiblingWorker=launcher, agent=agent, noPidNamespace=visible,
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version()},
                      limitations=["a stand-in process, not the real console or authority",
                                   "the sibling result depends on the Yama scope, which is recorded",
                                   "hardened kernels and LSMs beyond the measured host are not covered",
                                   "measured host only"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError):
        pass
    finally:
        if standin is not None:
            try:
                standin.kill()
                standin.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                cleanup = False
        if root is not None and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith("strict-process-reach-") and not root.is_symlink()
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
