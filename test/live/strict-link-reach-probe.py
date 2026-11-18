#!/usr/bin/python3
"""Opt-in Linux N9 fixture: the agent can't reach the authority or listener
links, or the durable history or scratch directories; the launcher can.

Everything is synthetic and owned by the fixture: two directories, an
authority-link socketpair, a loopback TCP listener standing in for the
decision-page listener, and a pathname and an abstract socket standing in
for named endpoints. Never connects to anything it didn't create. Each gate has a
positive control that removes only that gate. Never human proof.

Exit 0: passed. Exit 1: a check or positive control failed. Exit 2: unsupported.
"""
import json
import os
import pathlib
import platform
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time

MAX = 32768

# Runs in the sandbox, and also on the host as the launcher-side control.
WORKER = r'''
import errno, json, os, socket, sys
plan = json.loads(sys.argv[1])
def name(e): return errno.errorcode.get(e.errno, "E?") if isinstance(e, OSError) and e.errno else type(e).__name__
out = {"dirs": {}, "tcp": None, "unix": None, "abstract": None, "fds": [], "authority": None}
for label, path in plan["dirs"]:
    try:
        os.listdir(path); out["dirs"][label] = "listed"
    except OSError as e: out["dirs"][label] = name(e)
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(1)
try: s.connect(("127.0.0.1", plan["port"])); out["tcp"] = "connected"
except OSError as e: out["tcp"] = name(e)
finally: s.close()
for key, addr in (("unix", plan["unix"]), ("abstract", "\0" + plan["abstract"][1:])):
    u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); u.settimeout(1)
    try: u.connect(addr); out[key] = "connected"
    except OSError as e: out[key] = name(e)
    finally: u.close()
# Every descriptor except stdio and the listing one, by type and identity
# (as in the N3 fixture). Only the sampled transient slot (CPython's listdir dup) may vanish.
import stat
listing = os.open("/proc/self/fd", os.O_RDONLY | os.O_DIRECTORY)
transient = os.dup(listing)  # the lowest free slot, where listdir's own dup will land
os.close(transient)
for n in sorted(os.listdir(listing), key=int):
    fd = int(n)
    if fd == listing or fd <= 2 or fd == plan.get("authorityFd"): continue
    try:
        target = os.readlink("/proc/self/fd/%d" % fd); st = os.fstat(fd)
    except OSError as e:
        if not (fd == transient and e.errno in (errno.ENOENT, errno.EBADF)):
            out["fds"].append([fd, "uninspectable", 0, 0])
        continue
    kind = ("socket" if target.startswith("socket:") else "pipe" if target.startswith("pipe:")
            else "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other")
    out["fds"].append([fd, kind, st.st_ino, st.st_dev])
os.close(listing)
if plan.get("authorityFd") is not None:
    import select
    fd = plan["authorityFd"]
    try:
        os.write(fd, b"state\n"); reply = b""
        while not reply.endswith(b"\n"):
            if not select.select([fd], [], [], 5)[0]: raise TimeoutError("authority reply timeout")
            chunk = os.read(fd, 64)
            if not chunk or len(reply) + len(chunk) > 64: raise ValueError("authority reply malformed")
            reply += chunk
        out["authority"] = reply.decode().strip()
    except (OSError, ValueError) as e: out["authority"] = name(e)
print(json.dumps(out, sort_keys=True))
'''


class _Fd:
    def __init__(self, fd):
        self.fd = fd

    def close(self):
        os.close(self.fd)


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))


def bwrap_argv(net=True, extra=()):
    argv = ["/usr/bin/bwrap", "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts",
            "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--clearenv"]
    if net:
        argv.append("--unshare-net")
    argv += ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if pathlib.Path("/lib64").exists():
        argv += ["--ro-bind", "/lib64", "/lib64"]
    return argv + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"] + list(extra)


def run(root, label, prefix, plan, pass_fds=()):
    argv = prefix + ["/usr/bin/python3", "-I", "-c", WORKER, json.dumps(plan)]
    with (root / (label + ".out")).open("wb") as out, (root / (label + ".err")).open("wb") as err:
        process = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env={},
                                 pass_fds=pass_fds, preexec_fn=limits, timeout=30)
    assert process.returncode == 0, label + " worker failed"
    data = (root / (label + ".out")).read_bytes()
    assert len(data) <= MAX
    return json.loads(data)


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    closers = []
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file()
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-link-reach-")).resolve()
        os.chmod(root, 0o700)
        capability = subprocess.run(bwrap_argv() + ["--", "/usr/bin/true"], stdin=subprocess.DEVNULL,
                                    capture_output=True, env={}, timeout=30, preexec_fn=limits)
        assert capability.returncode == 0, "bubblewrap cannot start a sandbox"
        exit_code = 1
        result["code"] = "fixture-failed"

        durable = root / "durable"
        scratch = root / "scratch"
        for d in (durable, scratch):
            d.mkdir(mode=0o700)
            (d / "marker").write_text("synthetic\n")
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        closers.append(listener)
        listener.bind(("127.0.0.1", 0))
        listener.listen(16)
        port = listener.getsockname()[1]
        named = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        closers.append(named)
        named_path = str(scratch / "named.sock")
        named.bind(named_path)
        named.listen(16)
        abstract = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        closers.append(abstract)
        abstract_name = "@strict-link-reach-" + os.urandom(8).hex()
        abstract.bind("\0" + abstract_name[1:])
        abstract.listen(16)
        # Authority link stand-in: the launcher keeps one end and never passes it to the agent.
        launcher_end, authority_end = socket.socketpair()
        closers += [launcher_end, authority_end]

        plan = {"dirs": [["durable", str(durable)], ["scratch", str(scratch)]], "port": port, "unix": named_path,
                "abstract": abstract_name}
        # A leaked descriptor of any type to either directory would bypass the mount gate.

        # The agent: a sandbox given none of it.
        agent = run(root, "agent", bwrap_argv() + ["--"], plan)
        assert agent["dirs"] == {"durable": "ENOENT", "scratch": "ENOENT"}, "a directory is visible to the agent"
        assert agent["tcp"] == "ECONNREFUSED", "the listener is reachable from the agent"
        assert agent["unix"] == "ENOENT", "a named endpoint is reachable from the agent"
        assert agent["abstract"] == "ECONNREFUSED", "an abstract endpoint is reachable from the agent"
        assert agent["fds"] == [], "a descriptor beyond stdio reached the agent"
        closed = {"dirs": {"durable": "ENOENT", "scratch": "ENOENT"}, "tcp": "ECONNREFUSED", "unix": "ENOENT",
                  "abstract": "ECONNREFUSED", "fds": []}

        def others_hold(run_result, opened):
            """Every gate except the opened ones still holds."""
            for key, value in closed.items():
                if key not in opened:
                    assert run_result[key] == value, f"{key} changed when only {opened} was opened"

        # Positive controls, each removing one gate.
        # The launcher's own (unsandboxed) process reaches everything, including the authority link.
        def serve_authority(deadline):
            request = b""
            while not request.endswith(b"\n"):
                remaining = deadline - time.monotonic()
                assert remaining > 0 and select.select([authority_end], [], [], remaining)[0], "authority request timeout"
                chunk = authority_end.recv(64)
                assert chunk and len(request) + len(chunk) <= 64, "authority request malformed"
                request += chunk
            assert request == b"state\n"
            authority_end.sendall(b"ok\n")
        launcher_fd = launcher_end.fileno()
        process = subprocess.Popen(["/usr/bin/python3", "-I", "-c", WORKER, json.dumps(dict(plan, authorityFd=launcher_fd))],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env={}, pass_fds=(launcher_fd,), preexec_fn=limits)
        try:
            serve_authority(time.monotonic() + 10)
            out, _ = process.communicate(timeout=30)
        finally:
            if process.poll() is None:
                process.kill()  # never leave the launcher-side worker behind
                process.wait(timeout=5)
        assert process.returncode == 0 and len(out) <= MAX
        host = json.loads(out)
        assert host["dirs"] == {"durable": "listed", "scratch": "listed"} and host["tcp"] == "connected"
        assert host["unix"] == "connected" and host["abstract"] == "connected" and host["authority"] == "ok", \
            "launcher-side positive control failed"
        # Mount gate: binding the directories makes them visible and the named endpoint reachable.
        bound = run(root, "bound", bwrap_argv(extra=["--bind", str(durable), str(durable),
                                                    "--bind", str(scratch), str(scratch)]) + ["--"], plan)
        assert bound["dirs"] == {"durable": "listed", "scratch": "listed"} and bound["unix"] == "connected", "mount positive control failed"
        others_hold(bound, {"dirs", "unix"})
        # Network gate: sharing the network namespace makes the loopback listener reachable.
        shared = run(root, "shared-net", bwrap_argv(net=False) + ["--"], plan)
        assert shared["tcp"] == "connected" and shared["abstract"] == "connected", "network positive control failed"
        others_hold(shared, {"tcp", "abstract"})
        # Descriptor gate: passing the authority end makes it visible as a socket.
        passed = run(root, "passed-fd", bwrap_argv() + ["--"], plan, pass_fds=(authority_end.fileno(),))
        link = os.fstat(authority_end.fileno())
        assert passed["fds"] == [[authority_end.fileno(), "socket", link.st_ino, link.st_dev]], \
            "descriptor positive control failed"
        others_hold(passed, {"fds"})
        # A leaked directory descriptor is reported too, as that directory.
        dir_fd = os.open(str(durable), os.O_RDONLY | os.O_DIRECTORY)
        closers.append(_Fd(dir_fd))
        leaked_dir = run(root, "passed-dirfd", bwrap_argv() + ["--"], plan, pass_fds=(dir_fd,))
        expected_dir = os.fstat(dir_fd)
        assert leaked_dir["fds"] == [[dir_fd, "directory", expected_dir.st_ino, expected_dir.st_dev]], \
            "a leaked directory descriptor was not detected"
        others_hold(leaked_dir, {"fds"})

        result.update(ok=True, code="link-reach-fixture-passed",
                      agent={"dirs": agent["dirs"], "listener": agent["tcp"], "namedEndpoint": agent["unix"],
                             "abstractEndpoint": agent["abstract"], "extraDescriptors": len(agent["fds"])},
                      positiveControls={"launcher": {"dirs": host["dirs"], "listener": host["tcp"],
                                                     "namedEndpoint": host["unix"], "authorityLink": host["authority"]},
                                        "boundDirs": bound["dirs"], "boundNamedEndpoint": bound["unix"],
                                        "sharedNetListener": shared["tcp"], "sharedNetAbstract": shared["abstract"],
                                        "passedAuthorityFd": "same inode", "passedDirectoryFd": "detected"},
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version()},
                      limitations=["synthetic directories, listener and links, not the real launcher",
                                   "loopback TCP only; other listener addresses (0.0.0.0, [::ffff:127.0.0.1], the WSL host address) are X14 and open",
                                   "the vsock path (#160) is a separate open finding",
                                   "measured host only"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError):
        pass
    finally:
        for closer in closers:
            try:
                closer.close()
            except OSError:
                pass
        if root is not None and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith("strict-link-reach-") and not root.is_symlink()
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
