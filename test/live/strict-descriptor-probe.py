#!/usr/bin/python3
"""Opt-in Linux N3 fixture (#162): inherited descriptors vs an allowlist.

A worker inside a Bubblewrap sandbox enumerates /proc/self/fd (excluding its
own listing descriptor) and classifies each descriptor by type only, never by
path. The strict launch must match the allowlist exactly. Positive controls
that deliberately leak a descriptor must be detected. Never human proof,
never a support claim. Touches only pipes and sockets the fixture creates.

Exit 0: passed. Exit 1: a check or a positive control failed. Exit 2: unsupported.
"""
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

MAX = 32768
# 0 is /dev/null; 1 and 2 are the launcher's output files. Nothing else.
ALLOWLIST = {"0": "char", "1": "file", "2": "file"}

WORKER = r'''
import json, os, stat
listing = os.open("/proc/self/fd", os.O_RDONLY | os.O_DIRECTORY)
out = {}
for name in sorted(os.listdir(listing), key=int):
    fd = int(name)
    if fd == listing:
        continue
    try:
        target = os.readlink("/proc/self/fd/%d" % fd)
        mode = os.fstat(fd).st_mode
    except OSError:
        continue  # closed between listing and inspection
    if target.startswith("pipe:"): kind = "pipe"
    elif target.startswith("socket:"): kind = "socket"
    elif target.startswith("anon_inode:"): kind = "anon_inode"
    elif stat.S_ISCHR(mode): kind = "tty" if os.isatty(fd) else "char"
    elif stat.S_ISDIR(mode): kind = "directory"
    elif stat.S_ISREG(mode): kind = "file"
    else: kind = "other"
    out[str(fd)] = kind
os.close(listing)
print(json.dumps(out, sort_keys=True))
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


def run(root, label, extra=(), pass_fds=(), close_fds=True):
    argv = bwrap_argv(extra) + ["--", "/usr/bin/python3", "-I", "-c", WORKER]
    with (root / (label + ".out")).open("wb") as out, (root / (label + ".err")).open("wb") as err:
        process = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env={},
                                 pass_fds=pass_fds, close_fds=close_fds, preexec_fn=limits, timeout=30)
    assert process.returncode == 0, label + " worker failed"
    data = (root / (label + ".out")).read_bytes()
    assert len(data) <= MAX
    return json.loads(data)


def extras(seen):
    """Descriptors outside the allowlist, or allowlisted numbers with the wrong type."""
    return {fd: kind for fd, kind in seen.items() if ALLOWLIST.get(fd) != kind}


def allow_all_seccomp():
    """A trivial x86_64-agnostic BPF program: return ALLOW."""
    return struct.pack("HBBI", 0x06, 0, 0, 0x7FFF0000)


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    owned = []
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file()
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-descriptor-")).resolve()
        os.chmod(root, 0o700)
        prerequisite = run(root, "prerequisite")
        exit_code = 1
        result["code"] = "fixture-failed"

        # Strict launch: exactly the allowlist.
        strict = prerequisite
        assert strict == ALLOWLIST, "strict launch does not match the allowlist"

        # Positive control 1: a deliberately passed pipe is detected.
        pipe_r, pipe_w = os.pipe()
        owned += [pipe_r, pipe_w]
        leaked_pipe = run(root, "leak-pipe", pass_fds=(pipe_r,))
        assert extras(leaked_pipe) == {str(pipe_r): "pipe"}, "a passed pipe was not detected"

        # Positive control 2: a deliberately passed socketpair end is detected.
        left, right = socket.socketpair()
        owned += [left.detach(), right.detach()]
        leaked_socket = run(root, "leak-socket", pass_fds=(owned[-1],))
        assert extras(leaked_socket) == {str(owned[-1]): "socket"}, "a passed socket was not detected"

        # Positive control 3: an inheritable descriptor survives a launcher that
        # doesn't close descriptors, and is detected; closing them removes it.
        stray = os.open(str(root), os.O_RDONLY | os.O_DIRECTORY)
        owned.append(stray)
        os.set_inheritable(stray, True)
        careless = run(root, "careless-launcher", close_fds=False)
        careful = run(root, "careful-launcher", close_fds=True)
        assert str(stray) in extras(careless), "an inheritable descriptor was not detected"
        assert careful == ALLOWLIST, "closing descriptors did not remove the stray"

        # Launcher-owned: the descriptor carrying a seccomp program into
        # Bubblewrap is consumed and does not reach the sandbox.
        prog_r, prog_w = os.pipe()
        owned += [prog_r, prog_w]
        os.write(prog_w, allow_all_seccomp())
        os.close(prog_w)
        owned.remove(prog_w)
        with_seccomp = run(root, "seccomp-fd", extra=["--seccomp", str(prog_r)], pass_fds=(prog_r,))
        assert with_seccomp == ALLOWLIST, "the seccomp program descriptor reached the sandbox"

        result.update(ok=True, code="descriptor-fixture-passed", allowlist=ALLOWLIST, strict=strict,
                      positiveControls={"passedPipe": extras(leaked_pipe), "passedSocket": extras(leaked_socket),
                                        "carelessLauncher": extras(careless), "carefulLauncher": extras(careful)},
                      seccompDescriptor=extras(with_seccomp),
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version()},
                      limitations=["synthetic launcher, not the real one", "types only, no paths",
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
