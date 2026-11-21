#!/usr/bin/python3
"""Opt-in Linux graceful-to-forced namespace stop fixture (#185)."""
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
GRACE_SECONDS = 0.5
SCRATCH_PREFIX = "strict-graceful-stop-"


def load_lifecycle():
    spec = importlib.util.spec_from_file_location(
        "strict_lifecycle_fault", HERE / "strict-lifecycle-fault-probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bounded_stop(lifecycle, namespace, *, expire_before_proof=False):
    """Return observations only after exact stop proof within one total bound."""
    lifecycle.alive_at_fault(namespace)
    worker_fd = namespace["members"]["worker"]["fd"]
    started = time.monotonic()
    grace_deadline = started + GRACE_SECONDS
    stop_deadline = started + lifecycle.STOP_BOUND
    signal.pidfd_send_signal(worker_fd, signal.SIGTERM)
    term_sent_at = time.monotonic()
    if term_sent_at >= grace_deadline:
        raise lifecycle.Unproven({"termLate": True})

    forced_at = None
    worker_alive_at_grace_end = None
    wrapper_exited = lifecycle.exited(namespace["outerFd"], max(0, grace_deadline - time.monotonic()))
    observed_at = time.monotonic()
    if wrapper_exited:
        if observed_at > grace_deadline:
            raise lifecycle.Unproven({"graceObservationLate": True})
    else:
        if observed_at < grace_deadline:
            raise lifecycle.Unproven({"graceIncomplete": True})
        worker_alive_at_grace_end = not lifecycle.exited(worker_fd)
        if time.monotonic() >= stop_deadline:
            raise lifecycle.Unproven({"forceLate": True})
        try:
            signal.pidfd_send_signal(namespace["members"]["init"]["fd"], signal.SIGKILL)
        except ProcessLookupError as exc:
            raise lifecycle.Unproven({"forceNotConfirmed": True}) from exc
        forced_at = time.monotonic()

    try:
        return_code = namespace["process"].wait(timeout=max(0, stop_deadline - time.monotonic()))
    except subprocess.TimeoutExpired as exc:
        raise lifecycle.Unproven({"wrapperWaitTimedOut": True}) from exc
    if expire_before_proof:
        # Exercise the same proof gate after the exact wrapper has exited.
        # The real shared deadline expires before the census starts.
        time.sleep(max(0, stop_deadline - time.monotonic()))
    lifecycle.prove_stopped(namespace, stop_deadline, extra=[("bwrap", namespace["outerFd"])])
    observation = {
        "stopPath": "forced" if forced_at is not None else "graceful",
        "termMs": lifecycle.ms(term_sent_at - started),
        "wrapperReaped": True,
        "namespaceEmpty": True,
    }
    if forced_at is None:
        try:
            worker_status = lifecycle.read_record_raw(namespace["workerStatus"], stop_deadline)
        except RuntimeError as exc:
            raise lifecycle.Unproven({"workerGracefulExitUnproven": True}) from exc
        if worker_status != b"worker-term\n" or return_code != 0:
            raise lifecycle.Unproven({"workerGracefulExitUnproven": True})
        observation["workerAcknowledgedTerm"] = True
    else:
        observation.update(forceMs=lifecycle.ms(forced_at - started),
                           workerAliveAtGraceEnd=worker_alive_at_grace_end)
    stopped_at = time.monotonic()
    if stopped_at > stop_deadline:
        raise lifecycle.Unproven({"late": True})
    observation["stopMs"] = lifecycle.ms(stopped_at - started)
    return observation


def main():
    result = {"ok": False, "strictState": "unverified", "code": "unsupported"}
    exit_code = 2
    root = run = None
    lifecycle = load_lifecycle()

    def wall(signum, frame):
        raise RuntimeError("wall bound")

    try:
        args = sys.argv[1:]
        assert args in ([], ["--inject-expired-deadline"])
        assert not sys.flags.optimize and sys.platform.startswith("linux")
        assert pathlib.Path(sys.executable).resolve() == pathlib.Path("/usr/bin/python3").resolve()
        assert pathlib.Path("/usr/bin/bwrap").is_file() and lifecycle.HELPER.is_file()
        assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
        root = pathlib.Path(tempfile.mkdtemp(prefix=SCRATCH_PREFIX)).resolve()
        run = lifecycle.Run(root)
        signal.signal(signal.SIGALRM, wall)
        signal.alarm(lifecycle.WALL_SECONDS)

        namespace = lifecycle.start_namespace(run, "cooperative", stop_mode="cooperative")
        exit_code = 1
        result["code"] = "fixture-failed"
        cooperative = bounded_stop(lifecycle, namespace, expire_before_proof=bool(args))
        if args:
            raise RuntimeError("expired proof returned a receipt")
        assert cooperative["stopPath"] == "graceful"
        namespace = lifecycle.start_namespace(run, "stubborn", stop_mode="stubborn")
        stubborn = bounded_stop(lifecycle, namespace)
        assert stubborn["stopPath"] == "forced" and stubborn["workerAliveAtGraceEnd"]
        result.update(ok=True, code="graceful-stop-fixture-passed", cooperative=cooperative,
                      stubborn=stubborn, graceMs=lifecycle.ms(GRACE_SECONDS),
                      stopBoundMs=lifecycle.ms(lifecycle.STOP_BOUND))
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
        if run is not None:
            signal.alarm(0)
            if not lifecycle.cleanup_run(run):
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
