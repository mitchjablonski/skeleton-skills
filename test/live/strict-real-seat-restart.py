#!/usr/bin/python3
"""Private launcher child for a fixed, human-approved namespace restart."""

from hashlib import sha256
import os
from pathlib import Path
import re
import runpy
import select
import signal
import stat
import sys
import time

HERE = Path(__file__).resolve().parent
admission = runpy.run_path(str(HERE / "strict-namespace-admission-probe.py"))
Enrollment = admission["capture"]["Enrollment"]
NamespaceLauncher = admission["NamespaceLauncher"]
MEMBERS = admission["capture"]["MEMBERS"]
WORKER = admission["capture"]["WORKER"]
interactive = runpy.run_path(str(HERE / "strict-interactive-claude-relay.py"))
interrupted = False


class Refused(Exception):
    pass


def require(condition):
    if not condition:
        raise Refused()


def interrupt(_number, _frame):
    global interrupted
    interrupted = True


def ask(step, *, timeout=8, live=lambda: True, relay=None):
    deadline = time.monotonic() + timeout
    os.write(1, step)
    while not interrupted and live():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        interval = min(0.15, remaining)
        readable = relay.poll(interval) if relay is not None else select.select([0], [], [], interval)[0]
        if readable:
            return os.read(0, 2) == b"y" and not interrupted and live()
    return False


class OperatorLauncher(NamespaceLauncher):
    agent = None

    def spawn(self, command, fds=()):
        if command[1:3] == [WORKER, "managed-authority"]:
            command = [*command[:2], "operator-managed-authority", *command[3:]]
        return super().spawn(command, fds)

    def listener_ready(self, generation):
        return (generation is self.current and generation is not None
                and self.peers_live(generation) and ask(b"W") and self.peers_live(generation))

    def interactive_client(self, stage):
        if self.agent is None:
            return None
        relay, client = self.agent
        return {"client": client, "node": self.node, "channel": relay.prepare()}


def exercise(root, node, runtime, terminal_pin, review, capture, profile=None):
    selection = admission["read_runtime_selection"](runtime)
    verify_runtime = admission["runtime_check"](selection, node, root, terminal_pin=terminal_pin)
    launcher = OperatorLauncher(node, root, verify_runtime, stop_mode="cooperative",
                                protected=True, terminal_mode="operator-restart",
                                desktop_policy=True)
    result = 1
    relay = None
    try:
        verify_runtime()
        if profile is not None:
            client, expected_pin, control_identity = profile
            pinned = interactive["pin_client"](client, expected_pin, root)
            relay = interactive["AgentRelay"](root, control_identity, node,
                                              HERE / "strict-real-seat-agent-pane.mjs")
            launcher.agent = relay, pinned
        expected = {"phase": "fill", "revision": 1, "reviewVersion": review, "captureVersion": capture,
                    "admissions": "live"}
        enrollment = Enrollment(root / "history", "selected", expected)
        candidate = root / "candidate"
        digests = {name: sha256((candidate / name).read_bytes()).hexdigest() for name in MEMBERS}
        before = admission["capture"]["snapshot"]((enrollment,))
        (candidate / "plan.js").write_text("changed synthetic workspace\n", encoding="utf-8")
        generation = launcher.stage(enrollment, approved=True)
        first_dir, second_dir = root / "stage-first", root / "stage-restart"
        require(launcher.admit_capture(enrollment, generation.report(), first_dir) == digests)
        first = launcher.active

        def active(fill):
            return launcher.active is fill and fill.child.poll() is None and launcher.peers_live(generation)

        if relay is not None:
            relay.owned_namespace()
        require(ask(b"1", timeout=130 if relay else 8, live=lambda: active(first), relay=relay))
        require(relay is None or relay.verified_turn())
        stop, observation = launcher.stop_planned(first.namespace)
        require(first.child.poll() is not None and observation.get("workerAcknowledgedTerm") is True)
        if relay is not None:
            relay.end_generation()
        (first_dir / "plan.js").write_text("changed synthetic first stage\n", encoding="utf-8")
        require(ask(b"R", timeout=130, live=lambda: launcher.peers_live(generation)))
        report = launcher.refresh(generation)
        require(launcher.admit_capture(enrollment, report, second_dir, stop) == digests)
        second = launcher.active
        require(second.generation is generation and second.child is not first.child
                and second.namespace["pidNs"] != first.namespace["pidNs"])
        require(all(not os.path.samefile(first_dir / name, second_dir / name) for name in MEMBERS))
        if relay is not None:
            relay.owned_namespace()
        require(ask(b"2", timeout=250 if relay else 130, live=lambda: active(second), relay=relay))
        require(relay is None or relay.verified_turn())
        launcher.stop_planned(second.namespace)
        require(second.child.poll() is not None and launcher.peers_live(generation))
        require(admission["capture"]["snapshot"]((enrollment,)) == before)
        result = 0
    except admission["RuntimeRefused"] as exc:
        if str(exc) == "runtime-observation-cleanup-unproven":
            result = 125
    except (AssertionError, OSError, RuntimeError, ValueError, Refused, admission["lifecycle"]["Unproven"]):
        pass
    finally:
        try:
            launcher.cleanup()
        except Exception:
            result = 125
        if relay is not None:
            relay.close()
    return result


def main(args):
    if len(args) not in (6, 9) or sys.flags.optimize or sys.executable != "/usr/bin/python3":
        return 1
    root, node, runtime = map(Path, args[:3])
    if (not all(path.is_absolute() for path in (root, node, runtime))
            or not re.fullmatch(r"/tmp/skel-wslg-state-[a-z0-9_]{8}", str(root)) or root.resolve() != root
            or not all(re.fullmatch(r"[0-9a-f]{64}", digest) for digest in args[3:6])):
        return 1
    status = root.lstat()
    if not stat.S_ISDIR(status.st_mode) or status.st_uid != os.getuid() or stat.S_IMODE(status.st_mode) != 0o700:
        return 1
    modes = [os.fstat(fd).st_mode for fd in (0, 1)]
    if not all(stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode) for mode in modes):
        return 1
    for name in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM):
        signal.signal(name, interrupt)
    profile = None
    if len(args) == 9:
        client, client_pin, terminal = args[6:]
        if (not Path(client).is_absolute() or not re.fullmatch(r"[0-9a-f]{64}", client_pin)
                or not re.fullmatch(r"[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,20}", terminal)):
            return 1
        profile = client, client_pin, tuple(map(int, terminal.split(":")))
    return exercise(root, node, runtime, *args[3:6], profile)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (AssertionError, OSError, RuntimeError, ValueError, admission["RuntimeRefused"]):
        sys.exit(1)
