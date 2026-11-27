#!/usr/bin/python3
"""Opt-in active process-access fixture for #172. All processes are owned.

A host-side stand-in holds a random secret in memory and in a private memfd.
A Bubblewrap worker with a private PID namespace tries ptrace attach,
process_vm_readv, /proc/<pid>/mem and pidfd_open + pidfd_getfd against the
stand-in's host PID; each must be refused. The launcher, as the stand-in's
parent, must succeed at the same reads (positive control), and a worker
without a PID namespace must see the PID (visibility control). Output is one
JSON object with errno names only; the secret is never printed.
"""
import ctypes
import errno
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys


PYTHON = "/usr/bin/python3"
BWRAP = "/usr/bin/bwrap"
PROC = Path("/proc")
YAMA = PROC / "sys/kernel/yama/ptrace_scope"
TIMEOUT = 5
SECRET_LEN = 32
SYS_PIDFD_GETFD = 438  # unified syscall number on every Linux architecture
PTRACE_ATTACH = 16
PTRACE_DETACH = 17
STAND_IN = r"""
import ctypes, os, sys
secret = bytes.fromhex(sys.stdin.readline().strip())
buf = ctypes.create_string_buffer(secret, len(secret))
fd = os.memfd_create("skel-access-fixture", 0)
os.write(fd, secret)
sys.stdout.write(f"{ctypes.addressof(buf)} {fd} {os.fstat(fd).st_ino}\n")
sys.stdout.flush()
for line in sys.stdin:
    if line != "ping\n":
        break
    sys.stdout.write("pong\n")
    sys.stdout.flush()
"""


class IOVec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]


def libc():
    lib = ctypes.CDLL(None, use_errno=True)
    lib.process_vm_readv.argtypes = [
        ctypes.c_int, ctypes.POINTER(IOVec), ctypes.c_ulong,
        ctypes.POINTER(IOVec), ctypes.c_ulong, ctypes.c_ulong,
    ]
    lib.process_vm_readv.restype = ctypes.c_ssize_t
    lib.ptrace.argtypes = [ctypes.c_long, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
    lib.ptrace.restype = ctypes.c_long
    lib.syscall.restype = ctypes.c_long
    return lib


def name(code):
    return errno.errorcode.get(code, "E?")


def vm_read(lib, pid, addr, length):
    buf = ctypes.create_string_buffer(length)
    local = IOVec(ctypes.cast(buf, ctypes.c_void_p), length)
    remote = IOVec(addr, length)
    got = lib.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
    if got < 0:
        return name(ctypes.get_errno()), None
    return "succeeded", buf.raw[:got]


def mem_read(pid, addr, length):
    try:
        fd = os.open(f"/proc/{pid}/mem", os.O_RDONLY | os.O_CLOEXEC)
    except OSError as error:
        return name(error.errno), None
    try:
        return "succeeded", os.pread(fd, length, addr)
    except OSError as error:
        return name(error.errno), None
    finally:
        os.close(fd)


def take_fd(lib, pid, target_fd):
    """pidfd_open then pidfd_getfd. Returns (open status, getfd status, fd or None)."""
    try:
        pidfd = os.pidfd_open(pid)
    except OSError as error:
        return name(error.errno), "not-attempted", None
    try:
        got = lib.syscall(SYS_PIDFD_GETFD, ctypes.c_int(pidfd), ctypes.c_int(target_fd), ctypes.c_uint(0))
        if got < 0:
            return "succeeded", name(ctypes.get_errno()), None
        return "succeeded", "succeeded", got
    finally:
        os.close(pidfd)


def attach(lib, pid):
    # A successful attach is only possible in the shared control; the worker
    # then exits, which detaches, and the launcher resumes the stand-in.
    if lib.ptrace(PTRACE_ATTACH, pid, None, None) < 0:
        return name(ctypes.get_errno())
    return "succeeded"


def worker(pid, addr, target_fd, private):
    local_pid = str(os.getpid())
    with os.scandir(PROC) as listing:
        entries = {entry.name for entry in listing if entry.name in (str(pid), local_pid)}
    if os.readlink(PROC / "self") != local_pid or local_pid not in entries:
        return {"status": "proc-self-mismatch", "namespace": namespace()}
    visible = str(pid) in entries
    if private and visible:
        # The number names some process in this namespace; act on nothing.
        return {"status": "numeric-collision", "namespace": namespace()}
    lib = libc()
    vm, _ = vm_read(lib, pid, addr, SECRET_LEN)
    mem, _ = mem_read(pid, addr, SECRET_LEN)
    opened, getfd, fd = take_fd(lib, pid, target_fd)
    if fd is not None:
        os.close(fd)
    return {
        "status": "measured", "namespace": namespace(), "visible": visible,
        "process_vm_readv": vm, "proc_mem": mem, "pidfd_open": opened,
        "pidfd_getfd": getfd, "ptrace_attach": attach(lib, pid),
    }


def namespace():
    identity = os.stat(PROC / "self/ns/pid")
    return [identity.st_dev, identity.st_ino]


def sandbox(private):
    args = [
        BWRAP, "--unshare-user", "--unshare-ipc", "--unshare-net", "--unshare-uts",
        "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--clearenv",
    ]
    if private:
        args.append("--unshare-pid")
    args += ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if Path("/lib64").is_dir():
        args += ["--ro-bind", "/lib64", "/lib64"]
    return args + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"]


def run(args):
    return subprocess.run(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env={}, text=True, timeout=TIMEOUT,
    )


def ping(stand_in):
    os.kill(stand_in.pid, signal.SIGCONT)  # undo a stop left by a control attach
    stand_in.stdin.write(b"ping\n")
    stand_in.stdin.flush()
    return stand_in.stdout.readline() == b"pong\n"


DENIED_KEYS = ("process_vm_readv", "proc_mem", "pidfd_getfd", "ptrace_attach")


def observe(stand_in, target, private, host_namespace, secret):
    pid, addr, target_fd = target
    if not ping(stand_in):
        return {"status": "stand-in-unresponsive"}
    result = run(sandbox(private) + [
        "--ro-bind", str(Path(__file__).resolve()), "/fixture.py",
        "--", PYTHON, "-I", "/fixture.py", "--worker", str(pid), str(addr),
        str(target_fd), "private" if private else "shared",
    ])
    if not ping(stand_in):
        return {"status": "stand-in-unresponsive"}
    if result.returncode != 0 or len(result.stdout) > 1024 or secret.hex() in result.stdout:
        return {"status": "worker-failed"}
    record = json.loads(result.stdout)
    actual = record.get("namespace")
    if not isinstance(actual, list) or len(actual) != 2 or any(type(v) != int for v in actual):
        return {"status": "namespace-missing"}
    if (actual == host_namespace) == private:
        return {"status": "namespace-mismatch"}
    allowed = {"status", "visible", "pidfd_open", *DENIED_KEYS}
    out = {k: v for k, v in record.items() if k in allowed and isinstance(v, (str, bool))}
    if out.get("status") not in ("measured", "numeric-collision", "proc-self-mismatch"):
        return {"status": "worker-failed"}
    return out


def control(stand_in, target, secret, inode):
    """The launcher is the stand-in's parent, so Yama's relational scope allows these."""
    pid, addr, target_fd = target
    lib = libc()
    vm, vm_bytes = vm_read(lib, pid, addr, SECRET_LEN)
    mem, mem_bytes = mem_read(pid, addr, SECRET_LEN)
    opened, getfd, fd = take_fd(lib, pid, target_fd)
    fd_ok = False
    if fd is not None:
        try:
            fd_ok = os.fstat(fd).st_ino == inode and os.pread(fd, SECRET_LEN, 0) == secret
        finally:
            os.close(fd)
    attached = attach(lib, pid)
    if attached == "succeeded":
        # The stand-in stops with SIGSTOP; the launcher is its parent, so it can wait and detach.
        _, status = os.waitpid(pid, 0)
        stopped = os.WIFSTOPPED(status)
        detached = lib.ptrace(PTRACE_DETACH, pid, None, None) == 0
        attached = "attached-and-detached" if stopped and detached else "detach-failed"
    return {
        "ptrace_attach": attached,
        "process_vm_readv": "matched" if vm_bytes == secret else vm,
        "proc_mem": "matched" if mem_bytes == secret else mem,
        "pidfd_getfd": "matched" if fd_ok else (getfd if getfd != "succeeded" else "mismatch"),
        "pidfd_open": opened,
    }


def measure(report):
    host_namespace = namespace()
    secret = secrets.token_bytes(SECRET_LEN)
    stand_in = subprocess.Popen(
        [PYTHON, "-I", "-c", STAND_IN], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={},
    )
    try:
        stand_in.stdin.write(secret.hex().encode() + b"\n")
        stand_in.stdin.flush()
        fields = stand_in.stdout.readline().split()
        if len(fields) != 3 or not all(f.isdigit() for f in fields):
            report["error"] = "stand-in-handshake"
            return False
        addr, target_fd, inode = (int(f) for f in fields)
        target = (stand_in.pid, addr, target_fd)
        report["agent"] = observe(stand_in, target, True, host_namespace, secret)
        report["shared_control"] = observe(stand_in, target, False, host_namespace, secret)
        report["launcher_control"] = control(stand_in, target, secret, inode)
        alive = ping(stand_in)
    finally:
        try:
            stand_in.stdin.close()
            clean_exit = stand_in.wait(timeout=TIMEOUT) == 0
        except (OSError, subprocess.TimeoutExpired):
            stand_in.kill()
            stand_in.wait(timeout=TIMEOUT)
            clean_exit = False
        stand_in.stdout.close()
    report["stand_in_exit"] = "clean" if alive and clean_exit else "failed"
    agent = report["agent"]
    agent_denied = agent.get("status") == "measured" and agent.get("visible") is False and all(
        agent.get(k) not in (None, "succeeded") for k in DENIED_KEYS + ("pidfd_open",))
    shared_visible = report["shared_control"].get("visible") is True
    launcher = report["launcher_control"]
    launcher_ok = launcher["ptrace_attach"] == "attached-and-detached" and all(
        launcher[k] == "matched" for k in ("process_vm_readv", "proc_mem", "pidfd_getfd"))
    return alive and clean_exit and agent_denied and shared_visible and launcher_ok


def main():
    report = {"ok": False, "code": "unsupported", "strictState": "unverified"}
    exit_code = 2
    if sys.platform == "linux" and not sys.flags.optimize and not sys.argv[1:] and hasattr(os, "pidfd_open"):
        try:
            report["yama_ptrace_scope"] = YAMA.read_text().strip()
        except OSError:
            report["yama_ptrace_scope"] = "absent"
        try:
            supported = all(
                run(sandbox(private) + ["--", "/usr/bin/true"]).returncode == 0
                for private in (False, True)
            )
        except (OSError, subprocess.TimeoutExpired):
            supported = False
        if supported:
            report["code"] = "process-access-fixture-failed"
            exit_code = 1
            try:
                if measure(report):
                    report.update(ok=True, code="process-access-fixture-passed")
                    exit_code = 0
            except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
                report["error"] = "fixture-io-or-timeout"
    print(json.dumps(report, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    args = sys.argv[1:]
    if (len(args) == 5 and args[0] == "--worker" and all(a.isascii() and a.isdecimal() for a in args[1:4])
            and args[4] in ("private", "shared") and not sys.flags.optimize):
        print(json.dumps(worker(int(args[1]), int(args[2]), int(args[3]), private=args[4] == "private")))
    else:
        sys.exit(main())
