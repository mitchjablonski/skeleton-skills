#!/usr/bin/python3
"""Operator entry for the synthetic WSLg window and retained checkpoint."""

import json
import os
from pathlib import Path
import re
import runpy
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import time


SUCCESS = "real-seat-window-checkpoint-passed"
CONTAINED_SUCCESS = "real-seat-contained-restart-passed"
INTERACTIVE_SUCCESS = "real-seat-interactive-restart-passed"
REFUSED = "real-desktop-invocation-invalid"
UNPROVEN = "real-seat-cleanup-unproven"


def operation(argv):
    if argv == ["--real-seat-launcher"]:
        return "--supervised-wslg-window", SUCCESS, []
    if (len(argv) == 3 and argv[0] == "--real-seat-contained"
            and Path(argv[1]).is_absolute() and re.fullmatch(r"[0-9a-f]{64}", argv[2])):
        return "--supervised-wslg-contained", CONTAINED_SUCCESS, argv[1:]
    if (len(argv) == 5 and argv[0] == "--real-seat-interactive"
            and all(Path(value).is_absolute() for value in (argv[1], argv[3]))
            and all(re.fullmatch(r"[0-9a-f]{64}", value) for value in (argv[2], argv[4]))):
        return "--supervised-wslg-interactive", INTERACTIVE_SUCCESS, argv[1:]
    return None


def foreground_terminal():
    left, right = (os.fstat(fd) for fd in (0, 1))
    if (not stat.S_ISCHR(left.st_mode) or not stat.S_ISCHR(right.st_mode)
            or (left.st_dev, left.st_ino, left.st_rdev) != (right.st_dev, right.st_ino, right.st_rdev)
            or os.tcgetpgrp(0) != os.getpgrp()):
        return None
    return left.st_dev, left.st_ino, left.st_rdev


def run(argv):
    selected = operation(argv)
    if selected is None or not (sys.stdin.isatty() and sys.stdout.isatty()):
        return REFUSED
    flag, success, args = selected
    terminal = None
    terminal_settings = None
    if flag != "--supervised-wslg-window":
        try:
            terminal = foreground_terminal()
            if terminal is not None:
                terminal_settings = termios.tcgetattr(0)
        except OSError:
            return REFUSED
        if terminal is None:
            return REFUSED
    node = shutil.which("node")
    if not node or not os.path.isabs(node):
        return "real-seat-node-unavailable"
    directory = Path(__file__).resolve().parent
    helpers = runpy.run_path(str(directory / "strict-browser-endpoint-probe.py"))
    helpers["enable_child_supervision"]()

    interrupted_at = None

    def mark_interrupted(_sig, _frame):
        nonlocal interrupted_at
        if interrupted_at is None:
            interrupted_at = time.monotonic()

    for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(name, mark_interrupted)
    scratch = tempfile.mkdtemp(prefix="skel-wslg-", dir="/dev/shm")
    workspace = None
    child = None
    timed_out = False
    terminal_lost = False
    terminal_restore_unproven = False
    try:
        try:
            if flag != "--supervised-wslg-window":
                workspace = tempfile.mkdtemp(prefix="skel-wslg-state-", dir="/tmp")
                args = [workspace, *args]
            child = subprocess.Popen(
                [node, str(directory / "strict-real-seat-launcher.mjs"), flag, scratch, *args],
                env={"DISPLAY": os.environ.get("DISPLAY", ""), "PATH": "/usr/bin:/bin"},
                # This single-threaded wrapper keeps supervision as a fallback
                # while the Node child samples its own adopted Chrome helpers.
                preexec_fn=helpers["enable_child_supervision"],
                # Chrome and the X tools each replace stderr. Hand off no
                # additional descriptor for them to inherit.
                stderr=subprocess.PIPE,
            )
        except (OSError, subprocess.SubprocessError):
            pass

        minutes = {"--supervised-wslg-window": 19, "--supervised-wslg-contained": 24,
                   "--supervised-wslg-interactive": 29}[flag]
        watchdog = time.monotonic() + minutes * 60
        forwarded = False
        while child is not None and child.poll() is None:
            now = time.monotonic()
            if terminal is not None and interrupted_at is None:
                try:
                    terminal_lost = foreground_terminal() != terminal
                except OSError:
                    terminal_lost = True
                if terminal_lost:
                    mark_interrupted(None, None)
            if now >= watchdog and interrupted_at is None:
                timed_out = True
                mark_interrupted(None, None)
            if interrupted_at is not None:
                if now >= interrupted_at + 8:
                    break
                if not forwarded:
                    child.terminate()
                    forwarded = True
            time.sleep(0.05)
    finally:
        cleanup = helpers["stop_owned_children"](child)
        if terminal_settings is not None:
            try:
                if termios.tcgetattr(0) != terminal_settings:
                    if foreground_terminal() != terminal:
                        terminal_restore_unproven = True
                    else:
                        termios.tcsetattr(0, termios.TCSANOW, terminal_settings)
                        os.write(1, b"\x1b[?2004l")
            except (OSError, termios.error):
                terminal_restore_unproven = True
    packet = b""
    if child is not None:
        with child.stderr as report:
            if cleanup:
                os.set_blocking(report.fileno(), False)
                try:
                    packet = os.read(report.fileno(), 192)
                except BlockingIOError:
                    pass
    if not cleanup or packet == (UNPROVEN + "\n").encode("ascii"):
        return UNPROVEN
    try:
        if workspace is not None:
            shutil.rmtree(workspace)
        shutil.rmtree(scratch)
    except OSError:
        return UNPROVEN
    if terminal_restore_unproven:
        return UNPROVEN
    if timed_out:
        return "real-seat-timeout"
    if terminal_lost:
        return "protected-control-terminal-lost"
    if interrupted_at is not None:
        return "real-seat-interrupted"
    if not re.fullmatch(rb"[a-z][a-z0-9-]{0,95}\n", packet):
        return "real-seat-evidence-unavailable"
    result = packet.decode("ascii").strip()
    if (result == success) != (child.returncode == 0):
        return "real-seat-evidence-unavailable"
    return result


if __name__ == "__main__":
    scope, success = {
        "--real-seat-contained": ("synthetic-contained-restart", CONTAINED_SUCCESS),
        "--real-seat-interactive": ("interactive-cli-local-fixture", INTERACTIVE_SUCCESS),
    }.get(next(iter(sys.argv[1:2]), ""), ("synthetic-window-checkpoint", SUCCESS))
    try:
        code = run(sys.argv[1:])
    except KeyboardInterrupt:
        code = "real-seat-interrupted"
    except (OSError, RuntimeError, ValueError):
        code = "real-seat-evidence-unavailable"
    print(json.dumps({
        "ok": code == success, "strictState": "unverified", "code": code,
        "scope": scope,
        "windowAttribution": "attribution-unavailable",
    }), flush=True)
    sys.exit(0 if code == success else 2 if code == REFUSED else 1)
