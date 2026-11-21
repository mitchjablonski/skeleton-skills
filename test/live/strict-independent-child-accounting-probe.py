#!/usr/bin/python3
"""Opt-in Linux fixture for independent census of an unreported owned child."""
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
SCRATCH_PREFIX = "strict-independent-child-accounting-"


def load_lifecycle():
    spec = importlib.util.spec_from_file_location(
        "strict_lifecycle_fault", HERE / "strict-lifecycle-fault-probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_accounting(lifecycle, run, inject):
    namespace = lifecycle.start_namespace(run, "silent-child", silent_child=True)
    lifecycle.alive_at_fault(namespace)

    # Stopping the separate agent group leaves the worker's ordinary child
    # alive. Require both the independent pidfd and census to see survivors.
    lifecycle.selective_child_stop(namespace)
    try:
        lifecycle.prove_stopped(namespace, time.monotonic() + lifecycle.NEGATIVE_BOUND)
    except lifecycle.Unproven as exc:
        refusal = exc.args[0]
        assert refusal == {"alive": ["escapee", "init", "silentChild", "worker"], "remaining": 4}
        if inject:
            raise
    else:
        raise RuntimeError("selective stop accepted as a namespace stop")

    started = time.monotonic()
    deadline = started + lifecycle.STOP_BOUND
    lifecycle.stop_namespace(namespace)
    lifecycle.prove_stopped(namespace, deadline, extra=[("bwrap", namespace["outerFd"])])
    try:
        namespace["process"].wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired as exc:
        raise lifecycle.Unproven({"wrapperWaitTimedOut": True}) from exc
    if time.monotonic() > deadline:
        raise lifecycle.Unproven({"late": True})
    return {
        "selectiveStopRefused": refusal,
        "silentChildPidfdExited": True,
        "namespaceEmpty": True,
        "wrapperReaped": True,
        "stopMs": lifecycle.ms(time.monotonic() - started),
    }


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = run = None
    lifecycle = load_lifecycle()

    def wall(signum, frame):
        raise RuntimeError("wall bound")

    try:
        args = sys.argv[1:]
        assert args in ([], ["--inject-unproven"])
        assert not sys.flags.optimize and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file() and lifecycle.HELPER.is_file()
        assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
        root = pathlib.Path(tempfile.mkdtemp(prefix=SCRATCH_PREFIX)).resolve()
        run = lifecycle.Run(root)
        signal.signal(signal.SIGALRM, wall)
        signal.alarm(lifecycle.WALL_SECONDS)
        proof = check_accounting(lifecycle, run, inject=bool(args))
        result.update(ok=True, code="independent-child-accounting-fixture-passed", proof=proof)
        exit_code = 0
    except lifecycle.Unproven as exc:
        exit_code = 1
        result.update(code="stop-unproven", stopUnproven=exc.args[0])
    except (AssertionError, OSError, ValueError, TypeError, RuntimeError, KeyError,
            subprocess.SubprocessError):
        if run is not None and run.recorded:
            exit_code = 1
            result["code"] = "fixture-failed"
    finally:
        signal.alarm(0)
        if run is not None and not lifecycle.cleanup_run(run):
            exit_code = 1
            result["cleanupFailed"] = True
            if result["code"] != "stop-unproven":
                result["code"] = "cleanup-failed"
        if root is not None and exit_code != 1:
            try:
                assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
                assert root.name.startswith(SCRATCH_PREFIX) and not root.is_symlink()
                shutil.rmtree(root)
            except (OSError, AssertionError):
                exit_code = 1
                result.update(code="cleanup-failed", cleanupFailed=True)
        if exit_code == 1:
            result["ok"] = False
            if root is not None and root.exists():
                result["retainedScratch"] = str(root)
        print(json.dumps(result, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
