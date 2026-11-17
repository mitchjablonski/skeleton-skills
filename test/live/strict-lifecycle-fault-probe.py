#!/usr/bin/python3
"""Opt-in Linux N10 lifecycle fault fixture (#154). Never human proof.

The host plays the launcher. It starts an authority stub that holds one
request without replying, and a Bubblewrap PID namespace with a worker, a
fixed child and a session-escaping descendant. On each fault it stops the
namespace by killing its init through a pidfd, without calling the
authority, and proves the stop independently: every member's pidfd reports
exit and no process remains in the namespace's pid-ns inode. Only then may
the stub reply.

Exit 0: passed. Exit 1: a scenario, negative control or cleanup failed.
Exit 2: unsupported arguments or prerequisites.
"""
import json
import os
import pathlib
import platform
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
HELPER = HERE / "strict-lifecycle-fault-helper.py"
MAX = 32768
WALL_SECONDS = 60
STOP_BOUND = 2.0      # seconds from fault detection to a proven namespace stop
KILL_BOUND = 0.05     # seconds from fault detection to the kill being issued
DEADLINE = 0.3        # the launcher's authority request deadline
NEGATIVE_BOUND = 0.5  # how long the negative control waits before judging


class Unproven(Exception):
    pass


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))


def ms(seconds):
    return round(seconds * 1000, 1)


def exited(fd, timeout=0):
    return bool(select.select([fd], [], [], timeout)[0])


class Run:
    def __init__(self, root):
        self.root = root
        self.recorded = False  # a namespace record arrived: later failures are fixture failures
        self.processes = []  # Popen objects, each in its own session
        self.fds = []
        self.inits = []      # pidfds of namespace inits
        self.members = []    # every member pidfd ever opened
        self.namespaces = []

    def fd(self, value):
        self.fds.append(value)
        return value

    def launch(self, argv, label, pass_fds=(), stdout=None):
        err = (self.root / (label + ".err")).open("wb")
        try:
            process = subprocess.Popen(
                argv, stdin=subprocess.DEVNULL,
                stdout=stdout if stdout is not None else subprocess.DEVNULL,
                stderr=err, pass_fds=pass_fds, env={}, start_new_session=True,
                preexec_fn=limits)
        finally:
            err.close()
        self.processes.append(process)
        return process


def bwrap_argv():
    argv = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
            "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if pathlib.Path("/lib64").exists():
        argv += ["--ro-bind", "/lib64", "/lib64"]
    return argv + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev",
                   "--ro-bind", str(HELPER), "/helper.py",
                   "--", "/usr/bin/python3", "-I", "/helper.py", "agent"]


def read_record(fd, deadline):
    data = b""
    while not data.endswith(b"\n"):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise RuntimeError("helper record timeout")
        chunk = os.read(fd, 1024)
        if not chunk or len(data) + len(chunk) > 4096:
            raise RuntimeError("helper record malformed")
        data += chunk
    return json.loads(data)


def boot_ticks():
    """Now, in the clock ticks /proc/<pid>/stat uses for start times."""
    return int(time.clock_gettime(time.CLOCK_BOOTTIME) * os.sysconf("SC_CLK_TCK"))


def started_at(pid):
    with open("/proc/%d/stat" % pid) as source:
        data = source.read(4096)
    return int(data[data.rindex(")") + 2:].split()[19])


def ns_of(pid, since=None):
    try:
        return os.readlink("/proc/%d/ns/pid" % pid)
    except (FileNotFoundError, ProcessLookupError):
        return None  # gone, or a zombie that has released its namespaces
    except PermissionError:
        # Other users' processes, and our own older ones such as the user
        # manager, are normal. One of ours that started after the namespace
        # did could be a member we can't inspect, so the scan is unproven.
        try:
            if since is not None and os.stat("/proc/%d" % pid).st_uid == os.getuid() and started_at(pid) >= since:
                raise Unproven({"inaccessible": 1})
        except (FileNotFoundError, ProcessLookupError):
            pass
        return None


def nspid_of(pid):
    with open("/proc/%d/status" % pid) as source:
        for row in source.read(16384).splitlines():
            if row.startswith("NSpid:"):
                return [int(x) for x in row.split()[1:]]
    raise RuntimeError("no NSpid")


def stat_of(pid):
    with open("/proc/%d/stat" % pid) as source:
        data = source.read(4096)
    fields = data[data.rindex(")") + 2:].split()
    return {"state": fields[0], "ppid": int(fields[1]), "pgrp": int(fields[2]), "session": int(fields[3])}


def parent_of(pid):
    try:
        return stat_of(pid)["ppid"]
    except (OSError, ValueError):
        return None


def scan(pid_ns, since):
    """Host PIDs of live (non-zombie) processes in the given pid namespace."""
    found = []
    for name in os.listdir("/proc"):
        if name.isdigit() and ns_of(int(name), since) == pid_ns:
            found.append(int(name))
    return sorted(found)


def start_namespace(run, label, launcher=False):
    """Start the agent namespace, directly or under a launcher stand-in."""
    read_end, write_end = os.pipe()
    run.fd(read_end)
    since = boot_ticks() - 1  # one tick of margin for rounding
    try:
        if launcher:
            argv = ["/usr/bin/python3", "-I", str(HELPER), "launcher", "--"] + bwrap_argv()
        else:
            argv = bwrap_argv()
        process = run.launch(argv, label, stdout=write_end)
    finally:
        os.close(write_end)
    record = read_record(read_end, time.monotonic() + 5)
    run.recorded = True
    pid_ns = record["pidNs"]
    assert isinstance(pid_ns, str) and pid_ns.startswith("pid:[") and len(pid_ns) < 64
    assert pid_ns != os.readlink("/proc/self/ns/pid")
    roles = {1: "init", record["worker"]: "worker", record["child"]: "child", record["escapee"]: "escapee"}
    assert len(roles) == 4
    members = {}
    for pid in scan(pid_ns, since):
        fd = os.pidfd_open(pid)
        run.members.append(fd)
        # Re-check after opening, so the handle is the namespace member.
        assert ns_of(pid) == pid_ns and not exited(fd)
        nspid = nspid_of(pid)
        assert len(nspid) >= 2 and nspid[0] == pid
        role = roles.get(nspid[-1])
        assert role and role not in members, "unexpected namespace member"
        members[role] = {"pid": pid, "fd": fd}
    assert set(members) == set(roles.values()), "namespace members missing"
    run.inits.append(members["init"]["fd"])
    worker, child, escapee = (stat_of(members[r]["pid"]) for r in ("worker", "child", "escapee"))
    assert child["pgrp"] == members["child"]["pid"] != worker["pgrp"], "agent group not separate"
    assert escapee["pgrp"] != child["pgrp"] and escapee["session"] not in (worker["session"], child["session"])
    namespace = {"pidNs": pid_ns, "members": members, "process": process, "since": since}
    run.namespaces.append(namespace)
    return namespace


def stop_namespace(namespace):
    """Physical stop: kill the namespace init through its pidfd. No authority call."""
    try:
        signal.pidfd_send_signal(namespace["members"]["init"]["fd"], signal.SIGKILL)
    except ProcessLookupError:
        pass


def prove_stopped(namespace, deadline, extra=()):
    """By the deadline, every member (and any extra handle) has exited and the namespace is empty."""
    handles = [(role, m["fd"]) for role, m in namespace["members"].items()] + list(extra)
    alive = []
    for role, fd in handles:
        if not exited(fd, max(0, deadline - time.monotonic())):
            alive.append(role)
    left = scan(namespace["pidNs"], namespace["since"])
    if alive or left:
        raise Unproven({"alive": sorted(alive), "remaining": len(left)})


def start_authority(run, label):
    host, stub = socket.socketpair()
    host_fd = run.fd(host.detach())
    release_r, release_w = os.pipe()
    run.fd(release_w)
    status_r, status_w = os.pipe()
    run.fd(status_r)
    try:
        process = run.launch(["/usr/bin/python3", "-I", str(HELPER), "authority",
                              str(stub.fileno()), str(release_r), str(status_w)],
                             label, pass_fds=(stub.fileno(), release_r, status_w))
    finally:
        stub.close()  # the stub holds the only peer end, so its exit is EOF here
        os.close(release_r)
        os.close(status_w)
    authority = {"sock": host_fd, "release": release_w, "status": status_r,
                 "process": process, "fd": run.fd(os.pidfd_open(process.pid))}
    os.write(host_fd, b"endSession\n")
    authority["sentAt"] = time.monotonic()
    assert read_record_raw(status_r, time.monotonic() + 5) == b"held\n", "authority did not hold"
    return authority


def read_record_raw(fd, deadline):
    data = b""
    while not data.endswith(b"\n"):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise RuntimeError("helper status timeout")
        chunk = os.read(fd, 64)
        if not chunk or len(data) + len(chunk) > 64:
            raise RuntimeError("helper status malformed")
        data += chunk
    return data


def still_held(authority):
    return not exited(authority["fd"]) and not select.select([authority["sock"]], [], [], 0)[0]


def release_and_reply(authority, stopped_ns):
    """Let the stub reply only now, and show its reply came after the stop."""
    assert still_held(authority), "authority replied or exited before release"
    os.write(authority["release"], b"R")
    reply = read_record(authority["sock"], time.monotonic() + 5)
    assert reply["result"] == "admissions-revoked"
    assert isinstance(reply["releasedAtNs"], int) and reply["releasedAtNs"] > stopped_ns
    # Observed by the stub, not read from our code: no byte reached it
    # between the request and the release, so the stop made no authority call.
    assert reply["bytesBeforeRelease"] == 0, "the launcher wrote to the authority before release"
    authority["process"].wait(timeout=5)
    assert authority["process"].returncode == 0
    return True


def fault_stop(namespace, inject, fault_at):
    """The launcher's stop step, timed from the moment the fault was detected.

    The kill must be issued within KILL_BOUND and proven within STOP_BOUND of
    fault_at, so any wait on the authority before stopping fails the run. The
    injected failure replaces the stop with an agent-group kill.
    """
    if inject:
        os.killpg(namespace["members"]["child"]["pid"], signal.SIGKILL)
    else:
        stop_namespace(namespace)
    killed = time.monotonic()
    assert killed - fault_at <= KILL_BOUND, "stop was delayed after the fault"
    prove_stopped(namespace, fault_at + STOP_BOUND)
    return ms(killed - fault_at), ms(time.monotonic() - fault_at), time.monotonic_ns()


def scenario_authority_stall(run, inject):
    namespace = start_namespace(run, "stall-agent")
    authority = start_authority(run, "stall-authority")
    # The fault: the outstanding request passes its deadline unanswered.
    remaining = authority["sentAt"] + DEADLINE - time.monotonic()
    assert not select.select([authority["sock"]], [], [], max(0, remaining))[0]
    fault_at = time.monotonic()
    kill_ms, stop_ms, stopped_ns = fault_stop(namespace, inject, fault_at)
    assert still_held(authority), "authority replied or exited during the stop"
    release_and_reply(authority, stopped_ns)
    return {"fault": "authority-deadline", "killMs": kill_ms, "stopMs": stop_ms,
            "authorityHeldThroughStop": True, "authorityBytesBeforeRelease": 0}


def scenario_authority_exit(run, inject):
    namespace = start_namespace(run, "exit-agent")
    authority = start_authority(run, "exit-authority")
    signal.pidfd_send_signal(authority["fd"], signal.SIGKILL)
    # The fault: the authority link reaches end of file.
    assert select.select([authority["sock"]], [], [], 5)[0] and os.read(authority["sock"], 64) == b""
    fault_at = time.monotonic()
    kill_ms, stop_ms, _ = fault_stop(namespace, inject, fault_at)
    authority["process"].wait(timeout=5)
    return {"fault": "authority-exited", "killMs": kill_ms, "stopMs": stop_ms, "authorityReplied": False}


def scenario_control_loss(run, inject):
    namespace = start_namespace(run, "control-agent")
    authority = start_authority(run, "control-authority")
    host, stub = socket.socketpair()
    control_fd = run.fd(host.detach())
    try:
        control = run.launch(["/usr/bin/python3", "-I", str(HELPER), "control", str(stub.fileno())],
                             "control", pass_fds=(stub.fileno(),))
    finally:
        stub.close()
    os.write(control_fd, b"hangup\n")
    # The fault: the control link reaches end of file.
    assert select.select([control_fd], [], [], 5)[0] and os.read(control_fd, 64) == b""
    fault_at = time.monotonic()
    kill_ms, stop_ms, stopped_ns = fault_stop(namespace, inject, fault_at)
    control.wait(timeout=5)
    assert still_held(authority), "authority replied or exited during the stop"
    release_and_reply(authority, stopped_ns)
    return {"fault": "control-link-closed", "killMs": kill_ms, "stopMs": stop_ms,
            "authorityHeldThroughStop": True, "authorityBytesBeforeRelease": 0}


def negative_group_kill(run):
    """Killing the agent's process group is not a namespace stop."""
    namespace = start_namespace(run, "negative-agent")
    os.killpg(namespace["members"]["child"]["pid"], signal.SIGKILL)
    try:
        prove_stopped(namespace, time.monotonic() + NEGATIVE_BOUND)
    except Unproven as detail:
        survivors = detail.args[0]
    else:
        raise RuntimeError("negative control: group kill was accepted as a stop")
    assert survivors["alive"] == ["escapee", "init", "worker"], "negative control: unexpected survivors"
    stop_namespace(namespace)
    prove_stopped(namespace, time.monotonic() + STOP_BOUND)
    return {"groupKillSurvivors": survivors["alive"], "detectedUnproven": True}


def scenario_launcher_crash(run):
    namespace = start_namespace(run, "launcher-crash", launcher=True)
    launcher = namespace["process"]
    outer = [pid for pid in (int(n) for n in os.listdir("/proc") if n.isdigit()) if parent_of(pid) == launcher.pid]
    assert len(outer) == 1, "launcher stand-in should have one child"
    outer_fd = run.fd(os.pidfd_open(outer[0]))
    assert stat_of(outer[0])["ppid"] == launcher.pid and not exited(outer_fd)
    launcher_fd = run.fd(os.pidfd_open(launcher.pid))
    started = time.monotonic()
    signal.pidfd_send_signal(launcher_fd, signal.SIGKILL)
    # Nothing else is done: the namespace must die through parent-death alone.
    prove_stopped(namespace, started + STOP_BOUND, extra=[("launcher", launcher_fd), ("bwrap", outer_fd)])
    return {"fault": "launcher-killed", "stopMs": ms(time.monotonic() - started), "hostActions": "none"}


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    run = None
    cleanup = True
    retain = False

    def wall(signum, frame):
        raise RuntimeError("wall bound")

    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        args = sys.argv[1:]
        assert args in ([], ["--inject-unproven"]) and sys.platform.startswith("linux")
        inject = args == ["--inject-unproven"]
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file() and HELPER.is_file()
        assert all(hasattr(os, n) for n in ("pidfd_open", "killpg")) and hasattr(signal, "pidfd_send_signal")
        observations = {"kernelRelease": platform.release(), "machine": platform.machine(),
                        "pythonVersion": platform.python_version()}
        assert all(len(v) <= 256 for v in observations.values())
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-lifecycle-fault-")).resolve()
        os.chmod(root, 0o700)
        run = Run(root)
        signal.signal(signal.SIGALRM, wall)
        signal.alarm(WALL_SECONDS)
        # Prerequisite: the namespace starts and its members can be observed.
        probe = start_namespace(run, "prerequisite")
        exit_code = 1
        result["code"] = "fixture-failed"
        stop_namespace(probe)
        prove_stopped(probe, time.monotonic() + STOP_BOUND)
        scenarios = {}
        try:
            scenarios["authorityStall"] = scenario_authority_stall(run, inject)
            scenarios["authorityExit"] = scenario_authority_exit(run, inject)
            scenarios["controlLoss"] = scenario_control_loss(run, inject)
        except Unproven as detail:
            retain = True
            result.update(code="stop-unproven", stopUnproven=detail.args[0], injected=inject)
            raise
        scenarios["launcherCrash"] = scenario_launcher_crash(run)
        negative = negative_group_kill(run)
        result.update(ok=True, code="lifecycle-fault-fixture-passed", scenarios=scenarios,
                      negativeControl=negative, platform=observations,
                      boundary="bubblewrap PID namespace init; pidfds on init, worker, child and a "
                               "session-escaping descendant; /proc pid-ns inode scan",
                      limitations=["synthetic fixture only", "no real authority, console, listener or launcher",
                                   "stand-in faults, not every bootstrap step",
                                   "no hostile ptrace, cgroup escape or user-namespace nesting coverage",
                                   "zombies are reported by pidfd, not by the inode scan"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, RuntimeError, KeyError, Unproven,
            subprocess.SubprocessError):
        if exit_code == 2 and run is not None and run.recorded:
            exit_code = 1  # the namespace started: a layout or discovery failure is not "unsupported"
            result["code"] = "fixture-failed"
    finally:
        signal.alarm(0)
        if run is not None:
            for fd in run.inits:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError:
                    cleanup = False
            for process in run.processes:
                try:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
                except (OSError, subprocess.SubprocessError):
                    cleanup = False
            for fd in run.members:
                try:
                    if not exited(fd, 5):
                        cleanup = False
                except OSError:
                    cleanup = False
            for namespace in run.namespaces:
                try:
                    if scan(namespace["pidNs"], namespace["since"]):
                        cleanup = False
                except (OSError, Unproven):
                    cleanup = False
            for fd in run.fds + run.members:
                try:
                    os.close(fd)
                except OSError:
                    pass  # already closed by its owner
        if not cleanup:
            retain = True
            result.update(ok=False, code="cleanup-failed", cleanupFailed=True)
            exit_code = 1
        if root is not None and not retain and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith("strict-lifecycle-fault-") and not root.is_symlink()
                shutil.rmtree(root)
            except (OSError, AssertionError):
                retain = True
                result.update(ok=False, code="cleanup-failed", cleanupFailed=True)
                exit_code = 1
        if exit_code == 1:
            result["ok"] = False
            if root is not None and root.exists():
                result["retainedScratch"] = str(root)
        print(json.dumps(result, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
