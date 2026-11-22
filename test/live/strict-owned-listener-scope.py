#!/usr/bin/python3
"""Supervise one opt-in fixture listener and reap its descendants on Linux."""

import os
import pathlib
import runpy
import select
import subprocess
import sys


SCOPE_FAILURE = 125


def wait_for_stop(lifeline_fd, child_pid):
    """Return true for parent EOF and false for a natural listener exit."""
    child_fd = os.pidfd_open(child_pid)
    try:
        poller = select.poll()
        poller.register(lifeline_fd, select.POLLHUP)
        poller.register(child_fd, select.POLLIN)
        events = dict(poller.poll())
        if events.get(child_fd, 0) & select.POLLIN:
            return False
        if events.get(lifeline_fd, 0) & select.POLLHUP:
            return True
        raise RuntimeError("listener scope received an unexpected poll event")
    finally:
        os.close(child_fd)


def main(args):
    child = None
    try:
        lifeline, readiness, *command = args
        lifeline_fd, readiness_fd = int(lifeline), int(readiness)
        if min(lifeline_fd, readiness_fd) < 3 or lifeline_fd == readiness_fd or not command:
            raise ValueError("expected distinct pipe descriptors and a listener command")

        helpers = runpy.run_path(str(pathlib.Path(__file__).with_name("strict-browser-endpoint-probe.py")))
        helpers["enable_child_supervision"]()
        with os.fdopen(lifeline_fd, "rb") as parent_pipe:
            try:
                with os.fdopen(readiness_fd, "wb") as readiness_pipe:
                    child = subprocess.Popen(command, pass_fds=(readiness_pipe.fileno(),))
                parent_stopped = wait_for_stop(parent_pipe.fileno(), child.pid)
            finally:
                if child is not None and not helpers["stop_owned_children"](child):
                    raise RuntimeError("listener descendant cleanup unproven")

        # The cleanup helper owns waitpid and records the listener's original status.
        if child.returncode is None:
            raise RuntimeError("listener exit status unproven")
        if parent_stopped:
            return 0
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"strict listener scope: {error}", file=sys.stderr)
        return SCOPE_FAILURE


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
