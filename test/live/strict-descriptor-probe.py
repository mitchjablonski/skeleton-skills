#!/usr/bin/python3
"""Opt-in Linux N3 fixture (#162): inherited descriptors vs an allowlist.

A worker inside a Bubblewrap sandbox enumerates /proc/self/fd and reports
each descriptor's type and identity (pipe/socket inode, device numbers),
never a path. The strict launch must match the allowlist exactly, by type AND
identity: 0 is /dev/null (char 1:3), 1 and 2 are the launcher's own pipes.
Positive controls that leak a descriptor must be detected. Never human proof,
never a support claim. Touches only pipes, sockets and files it creates.

Exit 0: passed. Exit 1: a check or a positive control failed. Exit 2: unsupported.
"""
import json
import os
import pathlib
import platform
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

MAX = 32768
NULL_RDEV = (1, 3)  # /dev/null
NR_UNAME = 63       # x86_64

WORKER = r'''
import json, os, stat, sys
listing = os.open("/proc/self/fd", os.O_RDONLY | os.O_DIRECTORY)
names = sorted(os.listdir(listing), key=int)
out = {}
for name in names:
    fd = int(name)
    if fd == listing:
        continue
    try:
        target = os.readlink("/proc/self/fd/%d" % fd)
        st = os.fstat(fd)
    except OSError:
        # CPython's os.listdir(fd) works on a dup of `listing` and closes it
        # before returning, so exactly listing + 1 vanishes. Anything else is
        # a descriptor we could not inspect, which counts as a violation.
        out[name] = {"kind": "vanished" if fd == listing + 1 else "uninspectable"}
        continue
    mode = st.st_mode
    entry = {}
    if target.startswith("pipe:"): entry = {"kind": "pipe", "ino": st.st_ino}
    elif target.startswith("socket:"): entry = {"kind": "socket", "ino": st.st_ino}
    elif target.startswith("anon_inode:"): entry = {"kind": "anon_inode"}
    elif stat.S_ISCHR(mode): entry = {"kind": "char", "rdev": [os.major(st.st_rdev), os.minor(st.st_rdev)]}
    elif stat.S_ISDIR(mode): entry = {"kind": "directory"}
    elif stat.S_ISREG(mode): entry = {"kind": "file"}
    else: entry = {"kind": "other"}
    out[name] = entry
uname = "ok"
if len(sys.argv) > 1 and sys.argv[1] == "uname":
    try: os.uname()
    except OSError as e: uname = "denied-%d" % e.errno
print(json.dumps({"fds": out, "uname": uname}, sort_keys=True))
'''


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))


def bwrap_argv(extra=()):
    argv = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
            "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if pathlib.Path("/lib64").exists():
        argv += ["--ro-bind", "/lib64", "/lib64"]
    return argv + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"] + list(extra)


def read_both(fds, deadline):
    """Drain both pipes together until EOF, bounded in size and time."""
    data = {fd: b"" for fd in fds}
    open_fds = list(fds)
    while open_fds:
        remaining = deadline - time.monotonic()
        assert remaining > 0, "worker output timeout"
        for fd in select.select(open_fds, [], [], remaining)[0]:
            chunk = os.read(fd, 65536)
            if not chunk:
                open_fds.remove(fd)
                continue
            data[fd] += chunk
            assert len(data[fd]) <= MAX, "worker output too large"
    return data


def run(root, label, extra=(), pass_fds=(), close_fds=True, stdout_file=False, worker_args=()):
    """Run the worker; stdout and stderr are launcher-owned pipes unless stdout_file."""
    argv = bwrap_argv(extra) + ["--", "/usr/bin/python3", "-I", "-c", WORKER, *worker_args]
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    pipes = {"1": os.fstat(out_r).st_ino, "2": os.fstat(err_r).st_ino}
    out_file = None
    process = None
    try:
        if stdout_file:
            out_file = (root / (label + ".out")).open("wb+")
            stdout = out_file
        else:
            stdout = out_w
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=err_w, env={},
                                   pass_fds=pass_fds, close_fds=close_fds, preexec_fn=limits)
        os.close(out_w)
        os.close(err_w)
        out_w = err_w = None
        deadline = time.monotonic() + 30
        drained = read_both([err_r] if stdout_file else [out_r, err_r], deadline)
        output = b"" if stdout_file else drained[out_r]
        assert process.wait(timeout=max(0.1, deadline - time.monotonic())) == 0, label + " worker failed"
        if stdout_file:
            out_file.seek(0)
            output = out_file.read(MAX + 1)
            assert len(output) <= MAX
        result = json.loads(output)
        return result["fds"], result["uname"], pipes
    finally:
        if process is not None and process.poll() is None:
            process.kill()  # never leave a worker behind on an error path
            process.wait(timeout=5)
        for fd in (out_r, err_r, out_w, err_w):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if out_file is not None:
            out_file.close()


def violations(fds, pipes):
    """Every descriptor that is not exactly the allowlist, by type and identity."""
    bad = {}
    for fd, entry in fds.items():
        if entry["kind"] == "vanished":
            continue  # the listing dup, accounted for by the worker
        if fd == "0" and entry == {"kind": "char", "rdev": list(NULL_RDEV)}:
            continue
        if fd in ("1", "2") and entry == {"kind": "pipe", "ino": pipes[fd]}:
            continue
        bad[fd] = entry["kind"]
    for fd in ("0", "1", "2"):
        if fd not in fds:
            bad[fd] = "missing"
    vanished = [fd for fd, e in fds.items() if e["kind"] == "vanished"]
    if len(vanished) > 1:
        bad["vanished"] = len(vanished)
    return bad


def bpf(*instructions):
    return b"".join(struct.pack("HBBI", *i) for i in instructions)


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    owned = []
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux") and platform.machine() == "x86_64"
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file()
        version = subprocess.run(["/usr/bin/bwrap", "--version"], capture_output=True, timeout=10, env={})
        bwrap_version = version.stdout.decode("ascii", "replace").strip()[:64]
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-descriptor-")).resolve()
        os.chmod(root, 0o700)
        strict, _, pipes = run(root, "strict")
        exit_code = 1
        result["code"] = "fixture-failed"

        # Strict launch: exactly the allowlist, by type and identity.
        assert violations(strict, pipes) == {}, "strict launch does not match the allowlist"

        # Positive control 1: a deliberately passed pipe is detected, alone.
        pipe_r, pipe_w = os.pipe()
        owned += [pipe_r, pipe_w]
        fds, _, pipes = run(root, "leak-pipe", pass_fds=(pipe_r,))
        leak_pipe = violations(fds, pipes)
        assert leak_pipe == {str(pipe_r): "pipe"}, "a passed pipe was not detected"

        # Positive control 2: a deliberately passed socketpair end is detected, alone.
        left, right = socket.socketpair()
        owned += [left.detach(), right.detach()]
        fds, _, pipes = run(root, "leak-socket", pass_fds=(owned[-1],))
        leak_socket = violations(fds, pipes)
        assert leak_socket == {str(owned[-1]): "socket"}, "a passed socket was not detected"

        # Positive control 3: a regular file handed over as stdout is not the
        # launcher's pipe, so it is flagged even though fd 1 is "allowed".
        fds, _, pipes = run(root, "stdout-file", stdout_file=True)
        stdout_file = violations(fds, pipes)
        assert stdout_file == {"1": "file"}, "a regular file on fd 1 was not detected"

        # Positive control 4: an inheritable descriptor survives a careless
        # launcher (close_fds=False) and is detected, alone; closing removes it.
        stray = os.open(str(root), os.O_RDONLY | os.O_DIRECTORY)
        owned.append(stray)
        os.set_inheritable(stray, True)
        fds, _, pipes = run(root, "careless-launcher", close_fds=False)
        careless = violations(fds, pipes)
        fds, _, pipes = run(root, "careful-launcher", close_fds=True)
        careful = violations(fds, pipes)
        assert careless == {str(stray): "directory"}, "an inheritable descriptor was not detected exactly"
        assert careful == {}, "closing descriptors did not remove the stray"

        # Option-named descriptors are consumed: a --seccomp program that
        # denies uname() is loaded (the denial is seen) and its descriptor
        # never reaches the sandbox.
        LD, JEQ, RET = 0x20, 0x15, 0x06
        program = bpf((LD, 0, 0, 4), (JEQ, 1, 0, 0xC000003E), (RET, 0, 0, 0x7FFF0000),
                      (LD, 0, 0, 0), (JEQ, 0, 1, NR_UNAME), (RET, 0, 0, 0x00050000 | 1), (RET, 0, 0, 0x7FFF0000))
        prog_r, prog_w = os.pipe()
        owned += [prog_r, prog_w]
        os.write(prog_w, program)
        os.close(prog_w)
        owned.remove(prog_w)
        fds, uname, pipes = run(root, "seccomp-fd", extra=["--seccomp", str(prog_r)], pass_fds=(prog_r,),
                                worker_args=["uname"])
        seccomp = violations(fds, pipes)
        assert uname == "denied-1", "the seccomp program was not loaded"
        assert seccomp == {}, "the seccomp program descriptor reached the sandbox"

        result.update(ok=True, code="descriptor-fixture-passed",
                      allowlist={"0": "char 1:3 (/dev/null)", "1": "launcher stdout pipe", "2": "launcher stderr pipe"},
                      strictViolations={},
                      positiveControls={"passedPipe": leak_pipe, "passedSocket": leak_socket,
                                        "regularFileOnStdout": stdout_file, "carelessLauncher": careless,
                                        "carefulLauncher": careful},
                      seccomp={"programLoaded": True, "descriptorViolations": seccomp},
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version(), "bwrap": bwrap_version},
                      limitations=["synthetic launcher, not the real one", "types and identities only, no paths",
                                   "authority and listener socketpairs are N9", "measured host only"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError):
        pass
    finally:
        for fd in owned:
            try:
                os.close(fd)
            except OSError:
                pass
        if root is not None and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith("strict-descriptor-") and not root.is_symlink()
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
