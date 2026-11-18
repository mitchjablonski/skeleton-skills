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
    """Processes whose command line names anything under our scratch root.

    Catches a helper that left the browser session (Chrome's crash handler
    setsids and names only a database path under HOME, which is the root).
    """
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
            "--disable-extensions", "--disable-background-networking", "--disable-crash-reporter",
            "--disable-breakpad", "--user-data-dir=" + str(profile),
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
            lines = path.read_text()[:512].splitlines()
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
    sessions = []  # every browser session ever launched, checked in cleanup
    cleanup = True
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file()
        chrome = next((c for c in CANDIDATES if pathlib.Path(c).exists()), None)
        assert chrome, "no Chrome/Chromium"
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
            sessions.append(browser.pid)
            try:
                port, ws_path = wait_port(profile, browser, time.monotonic() + 20)
                sandbox = attempt
                break
            except RuntimeError as error:
                fallback_reason = str(error)[:80]
                try:
                    os.killpg(browser.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # the whole group already exited
                browser.wait(timeout=10)
                browser = None
                (profile / "DevToolsActivePort").unlink(missing_ok=True)
        assert browser is not None and port, "browser cannot start"
        exit_code = 1
        result["code"] = "fixture-failed"

        # Endpoint identity: the listener's inode is held by the browser's own session.
        inode = listening_inode(port)
        assert inode, "no loopback listener on the reported port"
        assert holders(inode, session_pids(browser.pid)), "listener not held by the browser session"
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
        after = version(port)
        assert after.get("Browser") == before["Browser"] and listening_inode(port) == inode, "endpoint changed during the run"
        assert holders(inode, session_pids(browser.pid)), "listener no longer held by the browser session"

        result.update(ok=True, code="browser-endpoint-fixture-passed",
                      browser={"product": before["Browser"][:64], "chromeSandbox": sandbox,
                               "sandboxFallbackReason": None if sandbox else fallback_reason,
                               "crashReporter": "disabled"},
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
        if sessions:
            for sid in sessions:
                try:
                    os.killpg(sid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if browser is not None:
                    browser.poll()  # reap the lead so it stops counting
                if not any(session_pids(sid) for sid in sessions) and not root_users(root):
                    break
                time.sleep(0.1)
            for sid in sessions:
                try:
                    os.killpg(sid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if browser is not None:
                try:
                    browser.wait(timeout=5)
                except subprocess.SubprocessError:
                    cleanup = False
            for pid in root_users(root):  # a helper outside the session: kill, then fail
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                cleanup = False
            if any(session_pids(sid) for sid in sessions):
                cleanup = False  # a browser process outlived cleanup
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
