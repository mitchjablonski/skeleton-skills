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
import hashlib
import json
import os
import pathlib
import platform
import re
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
secret = bytes.fromhex(sys.stdin.readline().strip())  # never on the command line
buf = ctypes.create_string_buffer(secret, len(secret))
r, w = os.pipe()
os.write(w, b"private")
print(json.dumps({"addr": ctypes.addressof(buf), "length": len(secret), "fd": r}), flush=True)
while True: time.sleep(1)
'''

# Runs in the sandbox (and, for the controls, outside it).
WORKER = r'''
import ctypes, errno, json, os, sys
import hashlib, select
plan = json.loads(sys.argv[1])
def bounded_read(fd):  # never block on a descriptor that turns out empty
    return os.read(fd, 16) if select.select([fd], [], [], 1)[0] else b""
libc = ctypes.CDLL(None, use_errno=True)
pid, addr, length, fd, digest = plan["pid"], plan["addr"], plan["length"], plan["fd"], plan["digest"]
def err(): return errno.errorcode.get(ctypes.get_errno(), "EUNKNOWN")
def judge(data):  # the worker only knows the secret's hash
    return "read-secret" if hashlib.sha256(data).hexdigest() == digest else "read-other"
out = {"visible": os.path.exists("/proc/%d" % pid)}
if plan.get("visibilityOnly"):
    # In a private pid namespace the host number may alias a different, local
    # process: only report visibility, and never address whatever it names.
    print(json.dumps(out, sort_keys=True))
    raise SystemExit(0)
# Before any process-specific operation, confirm the number still names the
# owned process: its cmdline must carry the fixture's (non-secret) token.
try:
    with open("/proc/%d/cmdline" % pid, "rb") as f:
        if plan["token"].encode() not in f.read(1 << 16):
            print(json.dumps({"visible": out["visible"], "identity": "mismatch"}, sort_keys=True)); raise SystemExit(0)
except OSError:
    print(json.dumps({"visible": out["visible"], "identity": "unverified"}, sort_keys=True)); raise SystemExit(0)
out["identity"] = "verified"
text_only = plan.get("textOnly", False)  # a control that owns only its own /proc text
class iovec(ctypes.Structure): _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
dst = ctypes.create_string_buffer(length)
local, remote = iovec(ctypes.addressof(dst), length), iovec(addr, length)
libc.process_vm_readv.restype = ctypes.c_ssize_t
libc.process_vm_readv.argtypes = [ctypes.c_int, ctypes.POINTER(iovec), ctypes.c_ulong, ctypes.POINTER(iovec), ctypes.c_ulong, ctypes.c_ulong]
ctypes.set_errno(0)
n = -1 if text_only else libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
if not text_only:
    out["processVmReadv"] = judge(dst.raw) if n == length else ("read-partial" if n > 0 else err())
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
libc.syscall.restype = ctypes.c_long
rc = None if text_only else libc.ptrace(16, pid, None, None)
if rc is None:
    pass
elif rc == 0:
    out["ptraceAttach"] = "attached"
    try: os.waitpid(pid, 0)  # a tracer may wait for its tracee to stop
    except OSError: pass
    libc.ptrace(17, pid, None, None)
else:
    out["ptraceAttach"] = err()
try:
    if text_only: raise StopIteration
    with open("/proc/%d/mem" % pid, "rb", buffering=0) as m:
        m.seek(addr); data = m.read(length); out["procMem"] = judge(data) if data else "read-empty"
except StopIteration:
    pass
except OSError as e:
    out["procMem"] = errno.errorcode.get(e.errno, "EUNKNOWN")
try:
    if text_only: raise StopIteration
    pidfd = os.pidfd_open(pid); out["pidfdOpen"] = "ok"
    got = libc.syscall(ctypes.c_long(438), ctypes.c_long(pidfd), ctypes.c_long(fd), ctypes.c_long(0))
    if got >= 0:
        out["pidfdGetfd"] = "took-descriptor" if bounded_read(got) == b"private" else "took-other"; os.close(got)
    else:
        out["pidfdGetfd"] = err()
    os.close(pidfd)
except StopIteration:
    pass
except OSError as e:
    out["pidfdOpen"] = errno.errorcode.get(e.errno, "EUNKNOWN"); out["pidfdGetfd"] = "not-attempted"
# Other per-process files a same-uid process might read: the secret must not be in them.
for key, name in (("procCmdline", "cmdline"), ("procEnviron", "environ")):
    try:
        with open("/proc/%d/%s" % (pid, name), "rb") as f: data = f.read(1 << 16)
        needles = (plan["secretHex"].encode(), digest.encode())
        out[key] = "contains-secret" if any(x in data for x in needles) else "no-secret"
    except OSError as e:
        out[key] = errno.errorcode.get(e.errno, "EUNKNOWN")
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
        token = "strict-standin-" + os.urandom(8).hex()  # identity, not a secret
        standin = subprocess.Popen(["/usr/bin/python3", "-I", "-c", STANDIN, token], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={}, preexec_fn=limits)
        standin.stdin.write((secret + "\n").encode())  # the secret travels over stdin only
        standin.stdin.close()
        record = read_line(standin.stdout.fileno(), time.monotonic() + 10)
        exit_code = 1
        result["code"] = "fixture-failed"
        # Workers get only the secret's hash, plus the hex to search /proc text
        # for. The hex is in a worker's own argv, never in the stand-in's.
        plan = {"pid": standin.pid, "addr": record["addr"], "length": record["length"], "fd": record["fd"],
                "digest": hashlib.sha256(bytes.fromhex(secret)).hexdigest(), "secretHex": secret, "token": token}

        # A sibling worker outside any sandbox: recorded only (Yama scope decides).
        launcher = run(root, "launcher", [], plan)
        # Positive control for the access paths: the probe itself, the stand-in's parent.
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
                assert select.select([got], [], [], 5)[0] and os.read(got, 16) == b"private", \
                    "parent took a descriptor without the stand-in's marker"
            finally:
                os.close(got)
        finally:
            os.close(pidfd)

        # The agent, with a pid namespace: the stand-in isn't even visible.
        # Visibility only: the agent's namespace must not show the number at all.
        # If it does, that may be a different local process, so refuse rather than probe it.
        agent = run(root, "agent", bwrap_argv() + ["--"], dict(plan, visibilityOnly=True))
        assert agent == {"visible": False}, "the stand-in's host pid number is visible in the agent's namespace (uncertain identity)"
        # Visibility control: without a pid namespace the pid is visible, and
        # every access must still be refused (credentials and Yama, not hiding).
        visible = run(root, "no-pidns", bwrap_argv(pidns=False) + ["--"], plan)
        assert visible["visible"] is True and visible.get("identity") == "verified", \
            "visibility control: the stand-in should be visible, and verified by its token, without a pid namespace"
        assert visible["pidfdOpen"] == "ok", "visibility control: pidfd_open should succeed, so pidfd_getfd is really attempted"
        # Allowlist: every access attempt must be a real errno; cmdline/environ may
        # be readable but must not contain the secret.
        # Observed permission refusals, specifically (not a generic error).
        for key in ("processVmReadv", "ptraceAttach", "procMem", "pidfdGetfd"):
            assert visible[key] in ("EPERM", "EACCES"), f"visible stand-in: {key} was not a permission refusal"
        for key in ("procCmdline", "procEnviron"):
            assert visible[key] in ("no-secret", "EPERM", "EACCES"), f"visible stand-in: {key} exposed the secret"

        # Positive control for the /proc text check: a stand-in that does carry the
        # secret on its command line must be caught.
        leaky_token = "strict-leaky-" + os.urandom(8).hex()
        leaky = subprocess.Popen(["/usr/bin/python3", "-I", "-c", "import time\nwhile True: time.sleep(1)", secret, leaky_token],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 env={"S": secret}, preexec_fn=limits)
        try:
            time.sleep(0.2)
            # Its own plan: only the pid and the text to search for, nothing from the first stand-in.
            caught = run(root, "cmdline-control", bwrap_argv(pidns=False) + ["--"],
                         {"pid": leaky.pid, "addr": 0, "length": 1, "fd": -1, "digest": plan["digest"],
                          "secretHex": secret, "textOnly": True, "token": leaky_token})
        finally:
            leaky.kill()
            leaky.wait(timeout=5)
        assert caught.get("identity") == "verified" and caught["procCmdline"] == "contains-secret", "cmdline check positive control failed"
        # environ is refused under Yama here; if it is readable, the search must find the secret.
        assert caught["procEnviron"] in ("contains-secret", "EPERM", "EACCES"), \
            "environ check positive control failed"

        result.update(ok=True, code="process-reach-fixture-passed", yamaPtraceScope=yama,
                      parentPositiveControl={"processVmReadv": "read-secret", "pidfdGetfd": "took-descriptor"},
                      cmdlineCheckControl=caught["procCmdline"], environCheckControl=caught["procEnviron"],
                      launcherSiblingWorker=launcher, agent=agent, noPidNamespace=visible,
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version()},
                      limitations=["a stand-in process, not the real console or authority",
                                   "results describe this measured configuration only; the Yama scope is recorded, not inferred as the cause",
                                   "inside a pid namespace the host pid number names no process; ESRCH there is not a refusal by the stand-in",
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
