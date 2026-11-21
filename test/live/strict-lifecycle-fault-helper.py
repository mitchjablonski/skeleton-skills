#!/usr/bin/python3
"""Helpers for the N10 lifecycle fault fixture. Never human proof.

Modes (fixed, no other arguments):
  agent                      inside the Bubblewrap PID namespace: the worker
                             (Bubblewrap's main command), a fixed child that
                             leads its own process group (the agent group),
                             and a descendant that escapes into a new session
  agent-capture              same roles, with digests of the two fixture files
  authority SOCK REL STATUS  authority stub: hold one request, reply only
                             after the host writes to REL
  control SOCK               control stand-in: exit when told to hang up
  launcher -- ARGV...        launcher stand-in: start ARGV, then wait forever
"""
import hashlib
import json
import os
import pathlib
import select
import subprocess
import sys
import time

LINE = 256


def sleep_forever():
    while True:
        time.sleep(1)


def agent(capture=False):
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
    record = {
        "pidNs": os.readlink("/proc/self/ns/pid"),
        "worker": os.getpid(),
        "child": child,
        "escapee": escapee,
    }
    if capture:
        record["digests"] = digests
    sys.stdout.write(json.dumps(record, sort_keys=True) + "\n")
    sys.stdout.flush()
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
    elif args == ["agent-capture"]:
        agent(capture=True)
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
