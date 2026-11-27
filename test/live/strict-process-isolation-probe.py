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
from contextlib import ExitStack
from pathlib import Path
import select
import subprocess
import sys
import time


PYTHON = "/usr/bin/python3"
BWRAP = "/usr/bin/bwrap"
PROC = Path("/proc")
YAMA = PROC / "sys/kernel/yama/ptrace_scope"
TIMEOUT = 5
MAX_REPORT = 1024
MAX_PROCESSES = 16
STATUS_KEYS = ("NSpid", "PPid", "Uid", "CapEff", "NoNewPrivs", "Seccomp", "Threads")


class Refused(Exception):
    """A required piece of evidence is missing or ambiguous."""


def proc_text(pid, name, process_fd=None, limit=65536):
    fd = os.open(PROC / str(pid) / name if process_fd is None else name, os.O_RDONLY, dir_fd=process_fd)
    with os.fdopen(fd, encoding="ascii") as stream:
        text = stream.read(limit + 1)
    if len(text) > limit:
        raise Refused("process-evidence-oversized")
    return text


def status_of(pid="self", *, process_fd=None):
    fields = {}
    for line in proc_text(pid, "status", process_fd).splitlines():
        key, _, value = line.partition(":")
        if key in STATUS_KEYS:
            fields[key] = value.split()
    if any(key not in fields for key in STATUS_KEYS):
        raise Refused("status-field-missing")
    return fields


def ns_id(pid, kind, *, process_fd=None):
    name = "ns/" + kind
    identity = os.stat(PROC / str(pid) / name if process_fd is None else name, dir_fd=process_fd)
    return [identity.st_dev, identity.st_ino]


def read_line(stream):
    """One report line from the raw fd, bounded in size and time: a partial or
    oversized line refuses instead of blocking on a worker that waits for us."""
    fd, data, deadline = stream.fileno(), b"", time.monotonic() + TIMEOUT
    while b"\n" not in data:
        left = deadline - time.monotonic()
        if left <= 0 or len(data) > MAX_REPORT:
            raise Refused("worker-evidence-missing")
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            continue
        chunk = os.read(fd, MAX_REPORT + 1 - len(data))
        if not chunk:
            raise Refused("worker-evidence-missing")
        data += chunk
    line, _, rest = data.partition(b"\n")
    if rest or len(line) > MAX_REPORT:
        raise Refused("worker-evidence-missing")
    return line


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


def locate(scope, bwrap_pid, inner_pid, pidns):
    """Open only the owned root and descendants named by their parent."""
    def pin(pid):
        fd = os.open(PROC / str(pid), os.O_RDONLY | os.O_DIRECTORY)
        scope.callback(os.close, fd)
        return fd

    pending = [(bwrap_pid, os.getpid())]
    seen = set()
    matches = []
    while pending:
        pid, parent = pending.pop()
        if pid in seen or len(seen) == MAX_PROCESSES:
            raise Refused("ownership-ambiguous")
        seen.add(pid)
        fd = pin(pid)
        status = status_of(process_fd=fd)
        if status["PPid"] != [str(parent)] or status["Threads"] != ["1"]:
            raise Refused("ownership-ambiguous")
        nspid = status["NSpid"]
        if pid != bwrap_pid and len(nspid) >= 2 and nspid[-1] == str(inner_pid):
            if ns_id(pid, "pid", process_fd=fd) == pidns:
                matches.append((fd, parent))
        children = proc_text(pid, f"task/{pid}/children", fd, limit=1024).split()
        if len(seen) + len(pending) + len(children) > MAX_PROCESSES:
            raise Refused("ownership-ambiguous")
        pending.extend((int(child), pid) for child in children)
    if len(matches) != 1:
        raise Refused("ownership-ambiguous" if matches else "worker-not-found")
    return matches[0]


def uid_map(process_fd):
    lines = [line.split() for line in proc_text(None, "uid_map", process_fd).splitlines() if line.strip()]
    return [[int(v) for v in line] for line in lines]


def measure(report):
    me = os.getpid()
    my_pidns, my_userns = ns_id(me, "pid"), ns_id(me, "user")
    my_uid = os.getuid()
    proc = subprocess.Popen(
        sandbox() + ["--ro-bind", str(Path(__file__).resolve()), "/fixture.py",
                     "--", PYTHON, "-I", "/fixture.py", "--worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={}, bufsize=0,
    )
    try:
        inner = json.loads(read_line(proc.stdout))
        if not isinstance(inner, dict):
            raise Refused("worker-evidence-missing")
        for key in ("pid", "nspid", "pidns", "userns", "capeff", "nnp"):
            if key not in inner:
                raise Refused("worker-evidence-missing")
        if proc.poll() is not None:
            raise Refused("worker-not-found")
        with ExitStack() as scope:
            host_fd, parent = locate(scope, proc.pid, inner["pid"], inner["pidns"])
            outside = status_of(process_fd=host_fd)
            if outside["PPid"] != [str(parent)]:
                raise Refused("ownership-ambiguous")
            mapping = uid_map(host_fd)
            checks = {
                "pidns_agrees": ns_id(None, "pid", process_fd=host_fd) == inner["pidns"],
                "userns_agrees": ns_id(None, "user", process_fd=host_fd) == inner["userns"],
                "pidns_private": inner["pidns"] != my_pidns,
                "userns_private": inner["userns"] != my_userns,
                "nspid_levels": len(outside["NSpid"]) == 2 and len(inner["nspid"]) == 1,
                "capeff_zero": int(outside["CapEff"][0], 16) == 0 and int(inner["capeff"], 16) == 0,
                "no_new_privs": outside["NoNewPrivs"][0] == "1" and inner["nnp"] == "1",
                "same_host_uid": len(outside["Uid"]) == 4 and all(u == str(my_uid) for u in outside["Uid"]),
                "single_uid_map": len(mapping) == 1 and mapping[0][1:] == [my_uid, 1],
            }
            report["checks"] = checks
            report["seccomp"] = outside["Seccomp"][0]
            try:
                report["cgroupns_private"] = ns_id(None, "cgroup", process_fd=host_fd) != ns_id(me, "cgroup")
            except OSError:
                report["cgroupns_private"] = None
            alive = proc.poll() is None
    finally:
        report["wrapper_exit"] = "unproven"
        try:
            try:
                proc.stdin.close()
                clean = proc.wait(timeout=TIMEOUT) == 0
                report["wrapper_exit"] = "clean" if clean else "nonzero"
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait(timeout=TIMEOUT)
                report["wrapper_exit"] = "forced"
                clean = False
            if clean:
                # A clean wrapper exit must leave a closed report pipe with no extra bytes.
                # Avoid a blocking read if a process unexpectedly still holds the writer.
                os.set_blocking(proc.stdout.fileno(), False)
                try:
                    extra = os.read(proc.stdout.fileno(), 1)
                except BlockingIOError:
                    report["report_end"] = "pipe-open"
                    clean = False
                else:
                    report["report_end"] = "extra-output" if extra else "eof"
                    clean = not extra
        finally:
            proc.stdout.close()
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
