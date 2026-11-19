#!/usr/bin/python3
"""Opt-in Linux X14 fixture (#169): fixture-owned listeners on other addresses
are unreachable from a network-namespaced sandbox.

Listeners (all owned by the fixture): one on 0.0.0.0, reached via 127.0.0.1,
0.0.0.0 and the default-route interface's address; one dual-stack [::],
reached via [::1], [::] and [::ffff:127.0.0.1]. Each label has an exact
expected errno in the sandbox. With the network namespace shared, all
connect, and the fixture's listeners must accept exactly those connections.
Before any connect, the sandbox's route tables must show no default route
(read from /proc, so a sandbox with one is stopped before anything is sent).
Output uses address labels, never raw IPs. Never human proof.

Exit 0: passed. Exit 1: a check or positive control failed. Exit 2: unsupported.
"""
import json
import os
import pathlib
import platform
import shutil
import socket
import struct
import subprocess
import sys
import tempfile

MAX = 32768

WORKER = r'''
import errno, json, socket, sys
plan = json.loads(sys.argv[1])
def name(e): return errno.errorcode.get(e.errno, "E?") if isinstance(e, OSError) and e.errno else type(e).__name__
out = {}
LIMIT = 1 << 20
def read_table(path):
    # Read to EOF; an error or a table over LIMIT refuses rather than reading as "no routes".
    with open(path, "rb") as f:
        data = f.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise SystemExit(3)
    return data.decode("ascii").splitlines()
# Default routes visible in THIS namespace, read before any connect; nothing is sent.
try:
    rows4 = read_table("/proc/net/route")
    rows6 = read_table("/proc/net/ipv6_route")
except (OSError, UnicodeDecodeError):
    raise SystemExit(3)
if not rows4 or not rows4[0].startswith("Iface"):
    raise SystemExit(3)
v4 = sum(1 for r in rows4[1:] if len(r.split()) > 1 and r.split()[1] == "00000000")
v6 = 0
for r in rows6:
    f6 = r.split()
    if len(f6) != 10:
        raise SystemExit(3)
    # ::/0 entries flagged RTF_REJECT (0x0200) are the kernel's own unreachable
    # routes on lo; they block traffic, so they don't count.
    if f6[:2] == ["0" * 32, "00"] and not int(f6[8], 16) & 0x0200:
        v6 += 1
out["defaultRoutes"] = {"ipv4": v4, "ipv6": v6}
# The route prerequisite gates this worker's own connects.
if plan["requireNoRoute"] and (v4 or v6):
    print(json.dumps(out, sort_keys=True))
    raise SystemExit(0)
for label, family, addr, port in plan["targets"]:
    s = socket.socket(socket.AF_INET6 if family == 6 else socket.AF_INET, socket.SOCK_STREAM); s.settimeout(1)
    try: s.connect((addr, port)); out[label] = "connected"
    except OSError as e: out[label] = name(e)
    finally: s.close()
print(json.dumps(out, sort_keys=True))
'''


def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))


def bwrap_argv(net=True):
    argv = ["/usr/bin/bwrap", "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts",
            "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--clearenv"]
    if net:
        argv.append("--unshare-net")
    argv += ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"]
    if pathlib.Path("/lib64").exists():
        argv += ["--ro-bind", "/lib64", "/lib64"]
    return argv + ["--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev"]


def run(root, label, prefix, plan):
    argv = prefix + ["--", "/usr/bin/python3", "-I", "-c", WORKER, json.dumps(plan)]
    with (root / (label + ".out")).open("wb") as out, (root / (label + ".err")).open("wb") as err:
        process = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env={},
                                 preexec_fn=limits, timeout=60)
    assert process.returncode == 0, label + " worker failed or refused to read its route tables"
    data = (root / (label + ".out")).read_bytes()
    assert len(data) <= MAX
    return json.loads(data)


def interface_ipv4():
    """The default-route interface's IPv4 address (often a private address on WSL NAT)."""
    with open("/proc/net/route") as f:
        rows = [r.split() for r in f.read(65536).splitlines()[1:]]
    default = next((r for r in rows if len(r) > 2 and r[1] == "00000000"), None)
    assert default, "no default route"
    gateway = socket.inet_ntoa(struct.pack("<I", int(default[2], 16)))
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect((gateway, 9))  # UDP connect sends nothing; it only selects a source address
        address = probe.getsockname()[0]
    finally:
        probe.close()
    assert not address.startswith("127."), "no default-route interface address"
    return address, gateway


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    listeners = []
    failed = None
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file() and socket.has_ipv6
        address, _gateway = interface_ipv4()
        root = pathlib.Path(tempfile.mkdtemp(prefix="strict-listener-address-")).resolve()
        os.chmod(root, 0o700)
        capability = subprocess.run(bwrap_argv() + ["--", "/usr/bin/true"], stdin=subprocess.DEVNULL,
                                    capture_output=True, env={}, timeout=30, preexec_fn=limits)
        assert capability.returncode == 0, "bubblewrap cannot start a sandbox"

        any4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listeners.append(any4)
        any4.bind(("0.0.0.0", 0))
        any4.listen(32)
        port4 = any4.getsockname()[1]
        dual = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        listeners.append(dual)
        dual.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        dual.bind(("::", 0))
        dual.listen(32)
        port6 = dual.getsockname()[1]
        exit_code = 1
        result["code"] = "fixture-failed"

        targets = [["any4-via-loopback", 4, "127.0.0.1", port4],
                   ["any4-via-unspecified", 4, "0.0.0.0", port4],
                   ["any4-via-host-address", 4, address, port4],
                   ["dual-via-ipv6-loopback", 6, "::1", port6],
                   ["dual-via-unspecified", 6, "::", port6],
                   ["dual-via-mapped-loopback", 6, "::ffff:127.0.0.1", port6]]
        # Exact expectations per label: loopback-local addresses are refused by
        # the sandbox's own empty loopback; the host address has no route there.
        expected = {"any4-via-loopback": "ECONNREFUSED", "any4-via-unspecified": "ECONNREFUSED",
                    "any4-via-host-address": "ENETUNREACH", "dual-via-ipv6-loopback": "ECONNREFUSED",
                    "dual-via-unspecified": "ECONNREFUSED", "dual-via-mapped-loopback": "ECONNREFUSED"}
        # The sandbox worker reads its own route tables and connects only if it
        # has no default route, in the same namespace and process.
        agent = run(root, "agent", bwrap_argv(), {"targets": targets, "requireNoRoute": True})
        failed = "sandbox has a default route"
        assert agent.pop("defaultRoutes") == {"ipv4": 0, "ipv6": 0}, failed
        failed = "a fixture listener answered or failed unexpectedly in the sandbox"
        assert agent == expected, failed
        # Positive controls: the same reader in the shared namespace sees the
        # host's default route, and every fixture listener connects.
        shared = run(root, "shared-net", bwrap_argv(net=False), {"targets": targets, "requireNoRoute": False})
        host_routes = shared.pop("defaultRoutes")
        failed = "route reader positive control saw no default route"
        assert host_routes["ipv4"] + host_routes["ipv6"] >= 1, failed
        failed = "shared-netns positive control failed"
        assert shared == {t[0]: "connected" for t in targets}, failed
        # And the fixture's own listeners took exactly those connections.
        accepted = {}
        for listener, label in ((any4, "any4"), (dual, "dual")):
            listener.setblocking(False)
            count = 0
            while True:
                try:
                    conn, _ = listener.accept()
                except BlockingIOError:
                    break
                conn.close()
                count += 1
            accepted[label] = count
        failed = "the fixture listeners did not take exactly the positive-control connections"
        assert accepted == {"any4": 3, "dual": 3}, failed
        failed = None

        result.update(ok=True, code="listener-address-fixture-passed", agent=agent,
                      agentDefaultRoutes=0, positiveSharedNet=shared, acceptedByFixtureListeners=accepted,
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version()},
                      limitations=["fixture-owned listeners only, not the real decision listener",
                                   "DNS-rebinding names are not tested: the sandbox has no resolver or route",
                                   "model egress and AF_VSOCK (#160) are separate",
                                   "measured host only"])
        exit_code = 0
    except AssertionError as error:
        result["failedCheck"] = str(error)[:120] or "assertion"
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, StopIteration,
            subprocess.SubprocessError):
        pass
    finally:
        for listener in listeners:
            listener.close()
        if root is not None and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith("strict-listener-address-") and not root.is_symlink()
                shutil.rmtree(root)
            except (OSError, AssertionError):
                cleanup = False
        if not cleanup:
            result.update(ok=False, code="cleanup-failed", cleanupFailed=True)
            exit_code = 1
        if exit_code == 1 and root is not None and root.exists():
            result["ok"] = False
            result["retainedScratch"] = str(root)
        print(json.dumps(result, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
