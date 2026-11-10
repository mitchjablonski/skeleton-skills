#!/usr/bin/env python3
"""Run only a pinned client's --version command inside a disposable bwrap sandbox."""

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


MAX_OUTPUT = 4096
TIMEOUT_SECONDS = 30


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise SystemExit(emit({"ok": False, "code": "invalid-arguments", "error": message}, 2))


def emit(result: dict, exit_code: int) -> int:
    # Every outcome, including preflight refusal, uses the same machine-readable shape.
    result.setdefault("scope", "bootstrap-only client --version probe")
    result["strictState"] = "unverified"
    print(json.dumps(result, sort_keys=True))
    return exit_code


def output_text(value: bytes | None) -> str:
    if not value:
        return ""
    decoded = value.decode("utf-8", errors="replace")
    if len(decoded) > MAX_OUTPUT:
        return decoded[:MAX_OUTPUT] + "...[truncated]"
    return decoded


def main() -> int:
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("--client", required=True, help="absolute path to a regular executable")
    parser.add_argument("--sha256", required=True, help="required 64-character SHA-256 digest")
    args = parser.parse_args()

    if not sys.platform.startswith("linux"):
        return emit({"ok": False, "code": "unsupported-platform", "platform": sys.platform}, 2)

    client = pathlib.Path(args.client)
    if not client.is_absolute():
        return emit({"ok": False, "code": "client-path-not-absolute"}, 2)
    if len(args.sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in args.sha256):
        return emit({"ok": False, "code": "invalid-sha256-format"}, 2)

    try:
        client_stat = client.stat()
        if not stat.S_ISREG(client_stat.st_mode):
            return emit({"ok": False, "code": "client-not-regular-file"}, 2)
        if not os.access(client, os.X_OK):
            return emit({"ok": False, "code": "client-not-executable"}, 2)
        digest = hashlib.sha256()
        with client.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        actual_sha256 = digest.hexdigest()
    except OSError as exc:
        return emit({"ok": False, "code": "client-unavailable", "error": str(exc)}, 2)

    if actual_sha256.lower() != args.sha256.lower():
        return emit({
            "ok": False,
            "code": "sha256-mismatch",
            "client": str(client),
            "expectedSha256": args.sha256.lower(),
            "actualSha256": actual_sha256,
        }, 2)

    bwrap = shutil.which("bwrap")
    if bwrap is None:
        return emit({"ok": False, "code": "bubblewrap-not-on-PATH"}, 2)
    if not pathlib.Path("/usr").is_dir() or not pathlib.Path("/lib").is_dir():
        return emit({"ok": False, "code": "required-runtime-bind-missing"}, 2)

    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="strict-client-smoke-") as scratch_text:
            scratch = pathlib.Path(scratch_text)
            home = scratch / "home"
            work = scratch / "work"
            home.mkdir()
            work.mkdir()
            mounted_client = "/opt/strict-client/client"

            command = [
                bwrap,
                "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
                "--ro-bind", "/usr", "/usr",
                "--ro-bind", "/lib", "/lib",
            ]
            if pathlib.Path("/lib64").exists():
                command += ["--ro-bind", "/lib64", "/lib64"]
            command += [
                "--symlink", "usr/bin", "/bin",
                "--proc", "/proc", "--dev", "/dev",
                "--tmpfs", "/tmp", "--dir", "/run", "--dir", "/home", "--dir", "/opt",
                "--dir", "/opt/strict-client",
                "--ro-bind", str(client), mounted_client,
                "--bind", str(home), "/home/agent",
                "--bind", str(work), "/work",
                "--setenv", "HOME", "/home/agent",
                "--setenv", "PATH", "/usr/bin:/bin",
                "--setenv", "LANG", "C.UTF-8",
                "--chdir", "/work",
                "--", mounted_client, "--version",
            ]
            started_at = time.monotonic()
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                start_new_session=True,
                env={},
            )
            try:
                stdout, stderr = process.communicate(timeout=TIMEOUT_SECONDS)
                timed_out = False
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                stdout, stderr = process.communicate()

            result = {
                "ok": not timed_out and process.returncode == 0,
                "code": "timeout" if timed_out else ("completed" if process.returncode == 0 else "client-failed"),
                "client": str(client),
                "sha256": actual_sha256,
                "command": [mounted_client, "--version"],
                "bubblewrapFoundOnPath": True,
                "bubblewrapPath": bwrap,
                "environment": {"HOME": "/home/agent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                "privateHomeMounted": False,
                "hostCredentialsPassed": False,
                "egressAvailable": False,
                "elapsedSeconds": round(time.monotonic() - started_at, 3),
                "stdout": output_text(stdout),
                "stderr": output_text(stderr),
            }
            return emit(result, 0 if result["ok"] else 1)
    except (OSError, subprocess.SubprocessError) as exc:
        return emit({
            "ok": False,
            "code": "sandbox-launch-failed",
            "client": str(client),
            "sha256": actual_sha256,
            "error": str(exc),
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }, 2)


if __name__ == "__main__":
    raise SystemExit(main())
