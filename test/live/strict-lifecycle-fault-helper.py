#!/usr/bin/python3
"""Helpers for the N10 lifecycle fault fixture. Never human proof.

Modes (fixed, no other arguments):
  agent                      inside the Bubblewrap PID namespace: the worker
                             (Bubblewrap's main command), a fixed child that
                             leads its own process group (the agent group),
                             and a descendant that escapes into a new session
  agent-capture              same roles, with digests of the two fixture files
  agent-cooperative          report SIGTERM and exit the worker
  agent-stubborn             ignore SIGTERM in the worker
  agent-capture-cooperative  staged digests and cooperative SIGTERM
  agent-capture-stubborn     staged digests and ignored SIGTERM
  agent-silent-child         fork one additional child without reporting its ID
  authority SOCK REL STATUS  authority stub: hold one request, reply only
                             after the host writes to REL
  control SOCK               control stand-in: exit when told to hang up
  launcher -- ARGV...        launcher stand-in: start ARGV, then wait forever
"""
import errno
import hashlib
import json
import os
import pathlib
import select
import signal
import socket
import subprocess
import sys
import time

LINE = 256


def sleep_forever():
    while True:
        time.sleep(1)


def acknowledge_term(signum, frame):
    os.write(sys.stdout.fileno(), b"worker-term\n")
    raise SystemExit(0)


def agent(capture=False, stop_mode=None, silent_child=False, desktop_policy=False, interactive=False):
    if desktop_policy:
        # Creation and close only. No endpoint is contacted.
        try:
            socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM).close()
        except OSError as error:
            if error.errno != errno.EAFNOSUPPORT:
                raise SystemExit(7)
        else:
            raise SystemExit(7)
        socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close()
    digests = {}
    if capture:
        stage = pathlib.Path("/fixture-stage")
        for name in ("context.txt", "plan.js"):
            digests[name] = hashlib.sha256((stage / name).read_bytes()).hexdigest()
    child = os.fork()
    if child == 0:
        os.setpgid(0, 0)
        sleep_forever()
    os.setpgid(child, child)  # either side may win the race; both set the same group
    ready_r, ready_w = os.pipe()
    first = os.fork()
    if first == 0:
        os.close(ready_r)
        os.setsid()  # a new session and group, outside the agent group
        if os.fork():
            os._exit(0)
        os.write(ready_w, b"%d\n" % os.getpid())
        os.close(ready_w)
        sleep_forever()
    os.close(ready_w)
    os.waitpid(first, 0)
    escapee = int(os.read(ready_r, 32).strip())
    os.close(ready_r)
    if silent_child and os.fork() == 0:
        os.close(sys.stdout.fileno())
        sleep_forever()
    if stop_mode == "cooperative":
        signal.signal(signal.SIGTERM, acknowledge_term)
    elif stop_mode == "stubborn":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    record = {
        "pidNs": os.readlink("/proc/self/ns/pid"),
        "worker": os.getpid(),
        "child": child,
        "escapee": escapee,
    }
    if capture:
        record["digests"] = digests
    if desktop_policy:
        record["desktopIsolation"] = "vsock-denied"
        if capture:
            if any(os.isatty(fd) for fd in (0, 1, 2)):
                raise SystemExit(7)
            try:
                terminal = os.open("/dev/tty", os.O_RDONLY | os.O_NOCTTY)
            except OSError as error:
                if error.errno not in (errno.ENXIO, errno.ENOENT):
                    raise SystemExit(7)
            else:
                os.close(terminal)
                raise SystemExit(7)
            record["controlTerminalAbsent"] = True
    if interactive:
        desktop_vars = {"DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
                        "WSL_INTEROP", "WSLENV", "PULSE_SERVER"}
        desktop_paths = ("/tmp/.X11-unix", "/mnt/wslg", "/run/WSL", "/proc/sys/fs/binfmt_misc/WSLInterop")
        if desktop_vars.intersection(os.environ) or any(os.path.lexists(p) for p in desktop_paths):
            raise SystemExit(7)
        record["desktopEndpointsAbsent"] = True
    sys.stdout.write(json.dumps(record, sort_keys=True) + "\n")
    sys.stdout.flush()
    if interactive:
        import runpy
        runpy.run_path("/opt/interactive-pty.py")["run"]()
        raise SystemExit(7)
    sleep_forever()


def read_line(fd):
    data = b""
    while not data.endswith(b"\n"):
        chunk = os.read(fd, LINE - len(data))
        if not chunk or len(data) + len(chunk) >= LINE:
            raise SystemExit(3)
        data += chunk
    return data


def authority(sock, release, status):
    request = read_line(sock)
    received_at = time.monotonic_ns()
    if request != b"endSession\n":
        raise SystemExit(4)
    os.write(status, b"held\n")  # the request is outstanding from here on
    # Watch the authority link too: anything the host sends before release
    # (a revoke, a retry, a second call) is counted and reported.
    seen = 0
    while True:
        ready = select.select([sock, release], [], [])[0]
        if sock in ready:
            data = os.read(sock, 256)
            if not data:
                raise SystemExit(5)  # host gone: never reply
            seen += len(data)
        if release in ready:
            break
    if os.read(release, 1) != b"R":
        raise SystemExit(5)
    released_at = time.monotonic_ns()
    reply = {"result": "admissions-revoked", "receivedAtNs": received_at,
             "releasedAtNs": released_at, "bytesBeforeRelease": seen}
    os.write(sock, json.dumps(reply, sort_keys=True).encode() + b"\n")


def control(sock):
    if read_line(sock) == b"hangup\n":
        os._exit(0)
    raise SystemExit(6)


def launcher(argv):
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, close_fds=True)
    del process  # keep it as a direct child; never wait for it
    sleep_forever()


def main():
    args = sys.argv[1:]
    if args == ["agent"]:
        agent()
    elif args == ["agent-desktop-policy"]:
        agent(desktop_policy=True)
    elif args == ["agent-capture-desktop-policy"]:
        agent(capture=True, desktop_policy=True)
    elif args == ["agent-capture-cooperative-desktop-policy"]:
        agent(capture=True, stop_mode="cooperative", desktop_policy=True)
    elif args == ["agent-capture-cooperative-desktop-policy-interactive"]:
        agent(capture=True, stop_mode="cooperative", desktop_policy=True, interactive=True)
    elif args == ["agent-capture"]:
        agent(capture=True)
    elif args == ["agent-cooperative"]:
        agent(stop_mode="cooperative")
    elif args == ["agent-stubborn"]:
        agent(stop_mode="stubborn")
    elif args == ["agent-capture-cooperative"]:
        agent(capture=True, stop_mode="cooperative")
    elif args == ["agent-capture-stubborn"]:
        agent(capture=True, stop_mode="stubborn")
    elif args == ["agent-silent-child"]:
        agent(silent_child=True)
    elif len(args) == 4 and args[0] == "authority":
        authority(int(args[1]), int(args[2]), int(args[3]))
    elif len(args) == 2 and args[0] == "control":
        control(int(args[1]))
    elif len(args) > 2 and args[:2] == ["launcher", "--"]:
        launcher(args[2:])
    else:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
