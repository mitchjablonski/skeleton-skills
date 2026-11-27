#!/usr/bin/python3
"""Opt-in passive process-isolation fixture for #172. All processes are owned.

The launcher starts one Bubblewrap worker and, while it waits, compares what
the worker reports about itself with what the launcher reads from outside:
the worker must be in its own PID and user namespaces, with no effective
capabilities, no_new_privs set and a single-uid map to the launcher's uid. It
refuses when the worker's host process can't be identified uniquely, or when
any piece of evidence is missing. It attempts no attach, memory read or
descriptor take, and sends no signal to anything but its own sandbox.
"""
import json
import os
from pathlib import Path
import select
import subprocess
import sys


PYTHON = "/usr/bin/python3"
BWRAP = "/usr/bin/bwrap"
PROC = Path("/proc")
YAMA = PROC / "sys/kernel/yama/ptrace_scope"
TIMEOUT = 5
STATUS_KEYS = ("NSpid", "PPid", "Uid", "CapEff", "NoNewPrivs", "Seccomp")


class Refused(Exception):
    """A required piece of evidence is missing or ambiguous."""


def status_of(pid="self"):
    fields = {}
    for line in (PROC / str(pid) / "status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in STATUS_KEYS:
            fields[key] = value.split()
    if any(key not in fields for key in STATUS_KEYS):
        raise Refused("status-field-missing")
    return fields


def ns_id(pid, kind):
    identity = os.stat(PROC / str(pid) / "ns" / kind)
    return [identity.st_dev, identity.st_ino]


def worker():
    """Inside the sandbox: report evidence, then wait for EOF so the launcher can look."""
    status = status_of()
    report = {
        "pid": os.getpid(), "nspid": status["NSpid"], "pidns": ns_id("self", "pid"),
        "userns": ns_id("self", "user"), "capeff": status["CapEff"][0],
        "nnp": status["NoNewPrivs"][0],
    }
    sys.stdout.write(json.dumps(report) + "\n")
    sys.stdout.flush()
    sys.stdin.buffer.read()


def sandbox():
    args = [
        BWRAP, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-net",
        "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--new-session",
        "--clearenv", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib",
    ]
    if Path("/lib64").is_dir():
        args += ["--ro-bind", "/lib64", "/lib64"]
    return args + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"]


def descendants(root):
    """Host pids whose parent chain reaches root (root excluded), read once."""
    parents = {}
    for entry in os.scandir(PROC):
        if entry.name.isdecimal():
            try:
                parents[int(entry.name)] = int(status_of(entry.name)["PPid"][0])
            except (OSError, Refused, ValueError):
                continue
    found = []
    for pid in parents:
        seen, cur = set(), pid
        while cur in parents and cur not in seen and cur != root:
            seen.add(cur)
            cur = parents[cur]
        if cur == root and pid != root:
            found.append(pid)
    return found


def locate(bwrap_pid, inner_pid, pidns):
    """The one descendant of bwrap whose innermost NSpid and PID namespace match the report."""
    matches = []
    for pid in descendants(bwrap_pid):
        try:
            nspid = status_of(pid)["NSpid"]
            if len(nspid) >= 2 and nspid[-1] == str(inner_pid) and ns_id(pid, "pid") == pidns:
                matches.append(pid)
        except (OSError, Refused):
            continue
    if len(matches) != 1:
        raise Refused("ownership-ambiguous" if matches else "worker-not-found")
    return matches[0]


def uid_map(pid):
    lines = [line.split() for line in (PROC / str(pid) / "uid_map").read_text().splitlines() if line.strip()]
    return [[int(v) for v in line] for line in lines]


def measure(report):
    me = os.getpid()
    my_pidns, my_userns = ns_id(me, "pid"), ns_id(me, "user")
    my_uid = os.getuid()
    proc = subprocess.Popen(
        sandbox() + ["--ro-bind", str(Path(__file__).resolve()), "/fixture.py",
                     "--", PYTHON, "-I", "/fixture.py", "--worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={},
    )
    try:
        ready, _, _ = select.select([proc.stdout], [], [], TIMEOUT)
        line = proc.stdout.readline() if ready else b""
        if not line or len(line) > 1024:
            raise Refused("worker-evidence-missing")
        inner = json.loads(line)
        for key in ("pid", "nspid", "pidns", "userns", "capeff", "nnp"):
            if key not in inner:
                raise Refused("worker-evidence-missing")
        host = locate(proc.pid, inner["pid"], inner["pidns"])
        outside = status_of(host)
        checks = {
            # The worker's own view and the launcher's view name the same namespaces.
            "pidns_agrees": ns_id(host, "pid") == inner["pidns"],
            "userns_agrees": ns_id(host, "user") == inner["userns"],
            # Both are new namespaces, not the launcher's.
            "pidns_private": inner["pidns"] != my_pidns,
            "userns_private": inner["userns"] != my_userns,
            # The host sees two PID levels; the worker sees only its own.
            "nspid_levels": len(outside["NSpid"]) == 2 and len(inner["nspid"]) == 1,
            "capeff_zero": int(outside["CapEff"][0], 16) == 0 and int(inner["capeff"], 16) == 0,
            "no_new_privs": outside["NoNewPrivs"][0] == "1" and inner["nnp"] == "1",
            "same_host_uid": all(u == str(my_uid) for u in outside["Uid"]),
            "single_uid_map": len(uid_map(host)) == 1 and uid_map(host)[0][1:] == [my_uid, 1],
        }
        report["checks"] = checks
        report["seccomp"] = outside["Seccomp"][0]
        alive = proc.poll() is None
    finally:
        try:
            proc.stdin.close()
            clean = proc.wait(timeout=TIMEOUT) == 0
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()
            proc.wait(timeout=TIMEOUT)
            clean = False
        proc.stdout.close()
    report["worker_exit"] = "clean" if clean else "failed"
    return alive and clean and all(checks.values())


def main():
    report = {"ok": False, "code": "unsupported", "strictState": "unverified"}
    exit_code = 2
    if sys.platform == "linux" and not sys.flags.optimize and not sys.argv[1:]:
        try:
            report["yama_ptrace_scope"] = YAMA.read_text().strip()
        except OSError:
            report["yama_ptrace_scope"] = "absent"
        try:
            supported = subprocess.run(sandbox() + ["--", "/usr/bin/true"], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       env={}, timeout=TIMEOUT).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            supported = False
        if supported:
            report["code"] = "process-isolation-fixture-failed"
            exit_code = 1
            try:
                if measure(report):
                    report.update(ok=True, code="process-isolation-fixture-passed")
                    exit_code = 0
            except Refused as refusal:
                report["refused"] = str(refusal)
            except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
                report["error"] = "fixture-io-or-timeout"
    print(json.dumps(report, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    if sys.argv[1:] == ["--worker"] and not sys.flags.optimize:
        worker()
    else:
        sys.exit(main())
