#!/usr/bin/python3
"""Opt-in passive PID visibility fixture for #172. All processes are owned."""
import json
import os
from pathlib import Path
import subprocess
import sys


PYTHON = "/usr/bin/python3"
BWRAP = "/usr/bin/bwrap"
PROC = Path("/proc")
TIMEOUT = 5
STAND_IN = "import sys; sys.stdin.buffer.read()"


def classify(entries, local_pid, proc_self, fixture_pid, private):
    if proc_self != local_pid or local_pid not in entries:
        return "proc-self-mismatch"
    if fixture_pid in entries:
        return "numeric-collision" if private else "visible"
    return "absent" if private else "missing-shared-control"


def worker(fixture_pid, private):
    local_pid = str(os.getpid())
    with os.scandir(PROC) as listing:
        entries = {entry.name for entry in listing if entry.name in (fixture_pid, local_pid)}
    proc_self = os.readlink(PROC / "self")
    status = classify(entries, local_pid, proc_self, fixture_pid, private)
    local_alias = classify(entries, local_pid, proc_self, local_pid, True)
    return {"status": status, "namespace": namespace(), "localAliasRefused": local_alias == "numeric-collision"}


def namespace():
    identity = os.stat(PROC / "self/ns/pid")
    return [identity.st_dev, identity.st_ino]


def sandbox(private):
    args = [
        BWRAP, "--unshare-user", "--unshare-ipc", "--unshare-net", "--unshare-uts",
        "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--clearenv",
    ]
    if private:
        args.append("--unshare-pid")
    args += ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if Path("/lib64").is_dir():
        args += ["--ro-bind", "/lib64", "/lib64"]
    return args + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"]


def run(args):
    return subprocess.run(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env={}, text=True, timeout=TIMEOUT,
    )


def observe(fixture, private, host_namespace):
    if fixture.poll() is not None:
        return "fixture-exited"
    result = run(sandbox(private) + [
        "--ro-bind", str(Path(__file__).resolve()), "/fixture.py",
        "--", PYTHON, "-I", "/fixture.py", "--worker", str(fixture.pid),
        "private" if private else "shared",
    ])
    if fixture.poll() is not None:
        return "fixture-exited"
    if result.returncode != 0 or len(result.stdout) > 512:
        return "worker-failed"
    record = json.loads(result.stdout)
    actual = record["namespace"]
    if not isinstance(actual, list) or len(actual) != 2 or any(type(v) != int for v in actual):
        return "namespace-missing"
    same_namespace = actual == host_namespace
    if same_namespace != (not private):
        return "namespace-mismatch"
    if record["localAliasRefused"] is not True:
        return "local-alias-control-failed"
    status = record["status"]
    expected = {"absent", "numeric-collision"} if private else {"visible", "missing-shared-control"}
    if result.returncode == 0 and status in expected | {"proc-self-mismatch"}:
        return status
    return "worker-failed"


def measure(report):
    host_namespace = namespace()
    fixture = subprocess.Popen(
        [PYTHON, "-I", "-c", STAND_IN], stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={},
    )
    try:
        report["shared"] = observe(fixture, private=False, host_namespace=host_namespace)
        report["private"] = observe(fixture, private=True, host_namespace=host_namespace)
        alive = fixture.poll() is None
    finally:
        fixture.stdin.close()
        try:
            clean_exit = fixture.wait(timeout=TIMEOUT) == 0
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait(timeout=TIMEOUT)
            clean_exit = False
    report["fixture_exit"] = "clean" if alive and clean_exit else "failed"
    return alive and clean_exit and report["shared"] == "visible" and report["private"] == "absent"


def main():
    report = {"ok": False, "code": "unsupported", "strictState": "unverified"}
    exit_code = 2
    if sys.platform == "linux" and not sys.flags.optimize and not sys.argv[1:]:
        try:
            supported = all(
                run(sandbox(private) + ["--", "/usr/bin/true"]).returncode == 0
                for private in (False, True)
            )
        except (OSError, subprocess.TimeoutExpired):
            supported = False
        if supported:
            report["code"] = "pid-visibility-fixture-failed"
            exit_code = 1
            try:
                if measure(report):
                    report.update(ok=True, code="pid-visibility-fixture-passed")
                    exit_code = 0
            except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
                report["error"] = "fixture-io-or-timeout"
    print(json.dumps(report, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    if (len(sys.argv) == 4 and sys.argv[1] == "--worker"
            and sys.argv[2].isascii() and sys.argv[2].isdecimal()
            and sys.argv[3] in ("private", "shared") and not sys.flags.optimize):
        print(json.dumps(worker(sys.argv[2], private=sys.argv[3] == "private")))
    else:
        sys.exit(main())
