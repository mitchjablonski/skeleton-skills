#!/usr/bin/python3
"""Opt-in Linux X14 fixture (#169): fixture-owned listeners on other addresses
are unreachable from a network-namespaced sandbox.

Listeners (all owned by the fixture): one on 0.0.0.0, reached via 127.0.0.1
and via the host's own global IPv4 address; one dual-stack [::], reached via
[::1] and [::ffff:127.0.0.1]. The sandbox must reach none. With the network
namespace shared, all connect (positive control). The sandbox's route to the
host gateway is recorded with one connect to the discard port, which must
fail for lack of a route; nothing is ever sent to a host or Windows service.
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
    assert process.returncode == 0, label + " worker failed"
    data = (root / (label + ".out")).read_bytes()
    assert len(data) <= MAX
    return json.loads(data)


def global_ipv4():
    """The host's first global IPv4 address (from the default route's interface)."""
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
    assert not address.startswith("127."), "no global IPv4 address"
    return address, gateway


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = None
    cleanup = True
    listeners = []
    try:
        if sys.flags.optimize:
            raise RuntimeError("optimized interpreter unsupported")
        assert sys.argv[1:] == [] and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file() and socket.has_ipv6
        address, gateway = global_ipv4()
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
                   ["any4-via-host-address", 4, address, port4],
                   ["dual-via-ipv6-loopback", 6, "::1", port6],
                   ["dual-via-mapped-loopback", 6, "::ffff:127.0.0.1", port6]]
        plan = {"targets": targets}
        # The sandbox's route to the gateway: one connect to the discard port, no route expected.
        route_plan = {"targets": [["gateway-route", 4, gateway, 9]]}

        agent = run(root, "agent", bwrap_argv(), plan)
        assert all(v in ("ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL") for v in agent.values()) \
            and len(agent) == len(targets), "a fixture listener is reachable from the sandbox"
        route = run(root, "agent-route", bwrap_argv(), route_plan)
        assert route["gateway-route"] in ("ENETUNREACH", "EHOSTUNREACH"), "the sandbox has a route to the host gateway"
        shared = run(root, "shared-net", bwrap_argv(net=False), plan)
        assert shared == {t[0]: "connected" for t in targets}, "shared-netns positive control failed"

        result.update(ok=True, code="listener-address-fixture-passed", agent=agent,
                      agentGatewayRoute=route["gateway-route"], positiveSharedNet=shared,
                      platform={"kernelRelease": platform.release()[:256], "machine": platform.machine(),
                                "pythonVersion": platform.python_version()},
                      limitations=["fixture-owned listeners only, not the real decision listener",
                                   "DNS-rebinding names are not tested: the sandbox has no resolver or route",
                                   "model egress and AF_VSOCK (#160) are separate",
                                   "measured host only"])
        exit_code = 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, RuntimeError, StopIteration,
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
