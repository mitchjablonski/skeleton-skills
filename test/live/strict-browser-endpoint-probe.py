#!/usr/bin/python3
"""Opt-in Linux N5 fixture (#167): the agent can't reach a browser debugging
endpoint or a browser profile; the launcher can.

The fixture launches its own disposable headless Chrome with a fresh scratch
profile (holding a marker file) and a loopback remote-debugging endpoint. It
never uses a display (no DISPLAY/WAYLAND_DISPLAY; WSLg is never touched) and
never connects to anything it didn't create. Endpoint identity is pinned:
the listening socket's inode must be held by the browser's own session. Each
gate has a positive control that opens only that gate. Every browser process
must be proven gone before a pass. Never human proof, never a support claim.

Exit 0: passed. Exit 1: a check, positive control or cleanup failed.
Exit 2: unsupported (no Chrome/Chromium, no Bubblewrap, or the browser can't start).
"""
import ctypes
import http.client
import json
import os
import pathlib
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time

MAX = 32768
CANDIDATES = ("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser")
MARKER = "strict-n5-marker"

WORKER = r'''
import errno, json, os, socket, sys
plan = json.loads(sys.argv[1])
def name(e): return errno.errorcode.get(e.errno, "E?") if isinstance(e, OSError) and e.errno else type(e).__name__
out = {}
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(1)
try: s.connect(("127.0.0.1", plan["port"])); out["endpoint"] = "connected"
except OSError as e: out["endpoint"] = name(e)
finally: s.close()
try:
    with open(os.path.join(plan["profile"], plan["marker"]), "rb") as f: out["profile"] = "marker" if f.read(64) == plan["value"].encode() else "mismatch"
except OSError as e: out["profile"] = name(e)
print(json.dumps(out, sort_keys=True))
'''


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


def run_worker(root, label, prefix, plan):
    argv = prefix + ["--", "/usr/bin/python3", "-I", "-c", WORKER, json.dumps(plan)]
    with (root / (label + ".out")).open("wb") as out, (root / (label + ".err")).open("wb") as err:
        process = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env={},
                                 preexec_fn=limits, timeout=30)
    assert process.returncode == 0, label + " worker failed"
    data = (root / (label + ".out")).read_bytes()
    assert len(data) <= MAX
    return json.loads(data)


def session_pids(sid):
    """Live (non-zombie) processes in a session."""
    pids = []
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                with open("/proc/%s/stat" % name) as f:
                    data = f.read(4096)
                fields = data[data.rindex(")") + 2:].split()
                if int(fields[3]) == sid and fields[0] != "Z":
                    pids.append(int(name))
            except (OSError, ValueError, IndexError):
                pass
    return pids


def root_users(root):
    """Corroborating scratch use only. A path match never authorizes a signal."""
    needle = str(root).encode()
    found = []
    for name in os.listdir("/proc"):
        if name.isdigit() and int(name) != os.getpid():
            try:
                with open("/proc/%s/cmdline" % name, "rb") as f:
                    if needle in f.read(1 << 16):
                        found.append(int(name))
            except OSError:
                pass
    return found


def enable_child_supervision():
    """Own and reap orphaned browser helpers, even if they left its session."""
    try:
        os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        pass
    else:
        raise RuntimeError("fixture needs a process with no existing children")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("pidfds unavailable")
    libc = ctypes.CDLL(None, use_errno=True)
    pr_set_child_subreaper = 36
    if libc.prctl(pr_set_child_subreaper, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "could not enable child supervision")


def signal_direct_children(signum):
    pid_path = "/proc/self/task/%d/children" % os.getpid()
    with open(pid_path, "rb") as source:
        entries = source.read(MAX + 1)
    if len(entries) > MAX:
        raise RuntimeError("child list too large")
    for entry in entries.split():
        pid = int(entry)
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            # Verify this is still our child after opening the stable handle.
            os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            signal.pidfd_send_signal(fd, signum)
        except (ChildProcessError, ProcessLookupError, PermissionError):
            # A child we cannot stop leaves the final reaping proof unproven.
            continue
        finally:
            os.close(fd)


def stop_owned_children(browser):
    """Return success only when the kernel has no direct children left."""
    started = time.monotonic()
    deadline = started + 10
    try:
        while time.monotonic() < deadline:
            while time.monotonic() < deadline:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    return True
                if pid == 0:
                    break
                if browser is not None and browser.pid == pid:
                    browser.returncode = os.waitstatus_to_exitcode(status)
            signum = signal.SIGTERM if time.monotonic() < started + 2 else signal.SIGKILL
            signal_direct_children(signum)
            time.sleep(0.05)
    except (OSError, ValueError, RuntimeError):
        return False
    return False


def crash_handlers(root):
    """Chrome crash handlers for this run: they setsid out of the browser session
    and name only a database under HOME (the scratch root)."""
    found = 0
    for pid in root_users(root):
        try:
            with open("/proc/%d/comm" % pid) as f:
                if f.read(64).startswith("chrome_crashpad"):
                    found += 1
        except OSError:
            pass
    return found


def listening_inode(port):
    """Inode of the 127.0.0.1:<port> TCP listener in our network namespace, or None."""
    want = "0100007F:%04X" % port
    with open("/proc/net/tcp") as f:
        for row in f.read(1 << 20).splitlines()[1:]:
            fields = row.split()
            if len(fields) > 9 and fields[1] == want and fields[3] == "0A":
                return int(fields[9])
    return None


def holders(inode, pids):
    target = "socket:[%d]" % inode
    found = []
    for pid in pids:
        try:
            for fd in os.listdir("/proc/%d/fd" % pid):
                try:
                    if os.readlink("/proc/%d/fd/%s" % (pid, fd)) == target:
                        found.append(pid)
                        break
                except OSError:
                    pass
        except OSError:
            pass
    return found


def version(port):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", "/json/version")
        response = conn.getresponse()
        body = response.read(MAX + 1)
        assert response.status == 200 and len(body) <= MAX
        return json.loads(body)
    finally:
        conn.close()


def launch_browser(chrome, profile, sandbox):
    args = [chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-background-networking", "--user-data-dir=" + str(profile),
            "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]
    if not sandbox:
        args.append("--no-sandbox")
    env = {"HOME": str(profile.parent), "PATH": "/usr/bin:/bin"}  # no display variables at all
    return subprocess.Popen(args + ["about:blank"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env=env, start_new_session=True)


def wait_port(profile, process, deadline):
    """(port, browser websocket path) from DevToolsActivePort."""
    path = profile / "DevToolsActivePort"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("browser exited before opening its endpoint")
        try:
            with path.open("rb") as source:
                raw = source.read(513)
            if len(raw) > 512:
                raise RuntimeError("browser port file exceeds limit")
            lines = raw.decode("ascii").splitlines()
            port = int(lines[0])
            if 0 < port < 65536 and len(lines) > 1 and lines[1].startswith("/devtools/browser/"):
                return port, lines[1]
        except (OSError, ValueError, IndexError):
            pass
        time.sleep(0.05)
    raise RuntimeError("browser endpoint timeout")


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    browser = None
    supervise = False
    cleanup = True
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file()
        chrome = next((c for c in CANDIDATES if pathlib.Path(c).exists()), None)
        assert chrome, "no Chrome/Chromium"
        enable_child_supervision()
        supervise = True
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-browser-endpoint-")).resolve()
        os.chmod(root, 0o700)
        capability = subprocess.run(bwrap_argv() + ["--", "/usr/bin/true"], stdin=subprocess.DEVNULL,
                                    capture_output=True, env={}, timeout=30, preexec_fn=limits)
        assert capability.returncode == 0, "bubblewrap cannot start a sandbox"
        profile = root / "profile"
        profile.mkdir(mode=0o700)
        value = os.urandom(16).hex()
        (profile / MARKER).write_text(value)

        # Prefer the browser's own sandbox; fall back to --no-sandbox only if it can't start, and record which.
        sandbox = True
        port = None
        fallback_reason = None
        for attempt in (True, False):
            browser = launch_browser(chrome, profile, attempt)
            try:
                port, ws_path = wait_port(profile, browser, time.monotonic() + 20)
                sandbox = attempt
                break
            except RuntimeError as error:
                fallback_reason = str(error)[:80]
                if not stop_owned_children(browser) or root_users(root):
                    cleanup = False
                    raise RuntimeError("first browser attempt cleanup unproven") from error
                browser = None
                (profile / "DevToolsActivePort").unlink(missing_ok=True)
        assert browser is not None and port, "browser cannot start"
        exit_code = 1
        result["code"] = "fixture-failed"

        # Endpoint identity: the listener's inode is held by the browser's own session.
        inode = listening_inode(port)
        assert inode, "no loopback listener on the reported port"
        assert holders(inode, session_pids(browser.pid)), "listener not held by the browser session"
        handlers_seen = crash_handlers(root)  # observed, not assumed: cleanup must reap them
        before = version(port)
        assert isinstance(before.get("Browser"), str) and before.get("webSocketDebuggerUrl") == "ws://127.0.0.1:%d%s" % (port, ws_path), \
            "debugger URL does not match DevToolsActivePort"

        # Launcher side: reaches the endpoint and reads the profile marker.
        assert (profile / MARKER).read_text() == value

        plan = {"port": port, "profile": str(profile), "marker": MARKER, "value": value}
        agent = run_worker(root, "agent", bwrap_argv(), plan)
        assert agent == {"endpoint": "ECONNREFUSED", "profile": "ENOENT"}, "the agent reached the endpoint or the profile"
        shared = run_worker(root, "shared-net", bwrap_argv(net=False), plan)
        assert shared == {"endpoint": "connected", "profile": "ENOENT"}, "network control did not open exactly the endpoint"
        bound = run_worker(root, "bound-profile", bwrap_argv(extra=["--ro-bind", str(profile), str(profile)]), plan)
        assert bound == {"endpoint": "ECONNREFUSED", "profile": "marker"}, "profile control did not open exactly the profile"

        # Same endpoint, same browser, at the end of the observations.
        assert listening_inode(port) == inode and holders(inode, session_pids(browser.pid)), "listener ownership changed"
        after = version(port)
        assert after.get("Browser") == before["Browser"], "browser product changed during the run"
        assert after.get("webSocketDebuggerUrl") == before["webSocketDebuggerUrl"], "debugger URL changed during the run"
        assert listening_inode(port) == inode, "listener inode changed"
        assert holders(inode, session_pids(browser.pid)), "listener no longer held by the browser session"

        result.update(ok=True, code="browser-endpoint-fixture-passed",
                      browser={"product": before["Browser"][:64], "chromeSandbox": sandbox,
                               "sandboxFallbackReason": None if sandbox else fallback_reason,
                               "crashHandlersSeen": handlers_seen},
                      endpoint={"address": "127.0.0.1", "kind": "remote-debugging-port", "ownedByBrowserSession": True},
                      agent=agent, positiveControls={"launcher": {"endpoint": "connected", "profile": "marker"},
                                                     "sharedNet": shared, "boundProfile": bound},
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version()},
                      limitations=["one fixture-owned loopback CDP endpoint and profile, not the human's browser",
                                   "C20 (protected window and profile acceptance) stays open",
                                   "WebDriver, abstract automation sockets, model egress and other host bindings are not measured",
                                   "measured host only"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError,
            http.client.HTTPException):
        pass
    finally:
        if supervise:
            try:
                if not stop_owned_children(browser) or (root is not None and root_users(root)):
                    cleanup = False
            except OSError:
                cleanup = False
        if root is not None and cleanup and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith("strict-browser-endpoint-") and not root.is_symlink()
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
