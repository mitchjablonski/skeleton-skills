#!/usr/bin/python3
"""Operator entry for the synthetic WSLg window and retained checkpoint."""

import json
import os
from pathlib import Path
import re
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import time


SUCCESS = "real-seat-window-checkpoint-passed"
REFUSED = "real-desktop-invocation-invalid"


def run(argv):
    if argv != ["--real-seat-launcher"] or not (sys.stdin.isatty() and sys.stdout.isatty()):
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
    read_fd, write_fd = os.pipe()
    child = None
    cleanup = False
    try:
        try:
            child = subprocess.Popen(
                [node, str(directory / "strict-real-seat-launcher.mjs"), "--supervised-wslg-window",
                 scratch, str(write_fd)],
                env={"DISPLAY": os.environ.get("DISPLAY", ""), "PATH": "/usr/bin:/bin"},
                # This single-threaded wrapper keeps supervision as a fallback
                # while the Node child samples its own adopted Chrome helpers.
                preexec_fn=helpers["enable_child_supervision"],
                pass_fds=(write_fd,), stderr=subprocess.DEVNULL,
            )
        finally:
            os.close(write_fd)

        watchdog = time.monotonic() + 19 * 60
        forwarded = False
        while child.poll() is None:
            now = time.monotonic()
            if now >= watchdog:
                mark_interrupted(None, None)
            if interrupted_at is not None:
                if now >= interrupted_at + 8:
                    break
                if not forwarded:
                    child.terminate()
                    forwarded = True
            time.sleep(0.05)
    finally:
        try:
            cleanup = helpers["stop_owned_children"](child)
            if cleanup:
                shutil.rmtree(scratch)
            os.set_blocking(read_fd, False)
            packet = os.read(read_fd, 192)
        finally:
            os.close(read_fd)
    if not cleanup:
        return "real-seat-cleanup-unproven"
    if interrupted_at is not None:
        return "real-seat-interrupted"
    if not re.fullmatch(rb"[a-z][a-z0-9-]{0,95}\n", packet):
        return "real-seat-evidence-unavailable"
    result = packet.decode("ascii").strip()
    if (result == SUCCESS) != (child.returncode == 0):
        return "real-seat-evidence-unavailable"
    return result


if __name__ == "__main__":
    try:
        code = run(sys.argv[1:])
    except (OSError, RuntimeError, ValueError):
        code = "real-seat-evidence-unavailable"
    print(json.dumps({
        "ok": code == SUCCESS, "strictState": "unverified", "code": code,
        "scope": "synthetic-window-checkpoint", "windowAttribution": "attribution-unavailable",
    }), flush=True)
    sys.exit(0 if code == SUCCESS else 2 if code == REFUSED else 1)
