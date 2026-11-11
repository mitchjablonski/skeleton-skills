#!/usr/bin/env python3
"""Run a pinned Claude CLI against a fixed local mock API inside Bubblewrap."""

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


ROOT = pathlib.Path(__file__).resolve().parents[2]
INNER = ROOT / "test" / "live" / "strict-tools-inner.mjs"
TIMEOUT_SECONDS = 120
MAX_OUTPUT = 16 * 1024


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise SystemExit(emit({"ok": False, "code": "invalid-arguments", "error": message}, 2))


def emit(result: dict, exit_code: int) -> int:
    result.setdefault("scope", "pinned deterministic local tool probe")
    result["strictState"] = "unverified"
    print(json.dumps(result, sort_keys=True))
    return exit_code


def validate_pin(raw_path: str, raw_hash: str, label: str) -> tuple[pathlib.Path | None, str | None, dict | None]:
    candidate = pathlib.Path(raw_path)
    if not candidate.is_absolute():
        return None, None, {"ok": False, "code": f"{label}-path-not-absolute"}
    if len(raw_hash) != 64 or any(char not in "0123456789abcdefABCDEF" for char in raw_hash):
        return None, None, {"ok": False, "code": f"invalid-{label}-sha256-format"}
    try:
        if candidate.is_symlink():
            return None, None, {"ok": False, "code": f"{label}-symlink-refused"}
        canonical = candidate.resolve(strict=True)
        details = canonical.stat()
        if not stat.S_ISREG(details.st_mode):
            return None, None, {"ok": False, "code": f"{label}-not-regular-file"}
        if not os.access(canonical, os.X_OK):
            return None, None, {"ok": False, "code": f"{label}-not-executable"}
        digest = hashlib.sha256()
        with canonical.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        actual = digest.hexdigest()
    except OSError as exc:
        return None, None, {"ok": False, "code": f"{label}-unavailable", "error": str(exc)}
    if actual.lower() != raw_hash.lower():
        return None, None, {
            "ok": False,
            "code": f"{label}-sha256-mismatch",
            "expectedSha256": raw_hash.lower(),
            "actualSha256": actual,
        }
    return canonical, actual, None


def read_namespace(path: str) -> str | None:
    try:
        return os.readlink(path)
    except OSError:
        return None


def decode_capture(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    if len(text) > MAX_OUTPUT:
        return text[:MAX_OUTPUT] + "...[truncated]"
    return text


def main() -> int:
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("--client", required=True, help="absolute path to pinned Claude CLI executable")
    parser.add_argument("--client-sha256", required=True, help="trusted 64-character Claude CLI SHA-256")
    parser.add_argument("--node", required=True, help="absolute path to pinned Node executable")
    parser.add_argument("--node-sha256", required=True, help="trusted 64-character Node SHA-256")
    args = parser.parse_args()

    if not sys.platform.startswith("linux"):
        return emit({"ok": False, "code": "unsupported-platform", "platform": sys.platform}, 2)
    client, client_hash, error = validate_pin(args.client, args.client_sha256, "client")
    if error:
        return emit(error, 2)
    node, node_hash, error = validate_pin(args.node, args.node_sha256, "node")
    if error:
        return emit(error, 2)
    bwrap = shutil.which("bwrap")
    if bwrap is None:
        return emit({"ok": False, "code": "bubblewrap-not-on-PATH"}, 2)
    if not pathlib.Path("/usr").is_dir() or not pathlib.Path("/lib").is_dir():
        return emit({"ok": False, "code": "required-runtime-bind-missing"}, 2)
    if not INNER.is_file():
        return emit({"ok": False, "code": "inner-probe-missing"}, 2)

    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="strict-client-tool-probe-") as scratch_text:
            scratch = pathlib.Path(scratch_text)
            home = scratch / "home"
            work = scratch / "work"
            private_dir = scratch / "private-outside"
            home.mkdir()
            (home / ".claude").mkdir()
            work.mkdir()
            private_dir.mkdir()
            (work / "inside.txt").write_text("PUBLIC_PROBE\n", encoding="utf-8")
            public_control = scratch / "public-control.txt"
            public_control.write_text("PUBLIC_CONTROL\n", encoding="utf-8")
            private_receipt = private_dir / "receipt.txt"
            private_receipt.write_text("PRIVATE_RECEIPT_DO_NOT_MOUNT\n", encoding="utf-8")
            original_private_hash = hashlib.sha256(private_receipt.read_bytes()).hexdigest()
            uid, gid = os.getuid(), os.getgid()
            passwd_file = scratch / "passwd"
            group_file = scratch / "group"
            passwd_file.write_text(f"agent:x:{uid}:{gid}:Probe Agent:/home/agent:/bin/bash\n", encoding="utf-8")
            group_file.write_text(f"agent:x:{gid}:\n", encoding="utf-8")

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
                "--tmpfs", "/tmp", "--dir", "/run",
                "--dir", "/home", "--dir", "/home/agent", "--dir", "/opt", "--dir", "/etc",
                "--ro-bind", str(passwd_file), "/etc/passwd",
                "--ro-bind", str(group_file), "/etc/group",
                "--ro-bind", str(client), "/opt/claude",
                "--ro-bind", str(node), "/opt/node",
                "--ro-bind", str(INNER), "/opt/strict-tools-inner.mjs",
                "--ro-bind", str(public_control), "/opt/public-control.txt",
                "--bind", str(home), "/home/agent",
                "--bind", str(work), "/work",
                "--setenv", "HOME", "/home/agent",
                "--setenv", "USER", "agent",
                "--setenv", "SHELL", "/bin/bash",
                "--setenv", "PATH", "/usr/bin:/bin",
                "--setenv", "LANG", "C.UTF-8",
                "--setenv", "PROBE_PRIVATE_PATH", str(private_receipt),
                "--chdir", "/work",
                "--", "/opt/node", "/opt/strict-tools-inner.mjs",
            ]
            started_at = time.monotonic()
            outer_namespaces = {
                "net": read_namespace("/proc/self/ns/net"),
                "pid": read_namespace("/proc/self/ns/pid"),
            }
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                start_new_session=True,
                env={},
            )
            timed_out = False
            try:
                stdout, stderr = process.communicate(timeout=TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                stdout, stderr = process.communicate()

            private_unchanged = hashlib.sha256(private_receipt.read_bytes()).hexdigest() == original_private_hash
            inner = None
            try:
                inner = json.loads(stdout.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
            if timed_out:
                return emit({
                    "ok": False, "code": "timeout", "timeoutSeconds": TIMEOUT_SECONDS,
                    "clientSha256": client_hash, "nodeSha256": node_hash,
                    "privateHostReceiptUnchanged": private_unchanged,
                    "outsideNamespaces": outer_namespaces,
                    "elapsedSeconds": round(time.monotonic() - started_at, 3),
                    "stdout": decode_capture(stdout), "stderr": decode_capture(stderr),
                }, 1)
            if not isinstance(inner, dict):
                return emit({
                    "ok": False,
                    "code": "probe-process-failed" if process.returncode != 0 else "invalid-inner-result",
                    "processExit": process.returncode,
                    "clientSha256": client_hash,
                    "nodeSha256": node_hash,
                    "privateHostReceiptUnchanged": private_unchanged,
                    "outsideNamespaces": outer_namespaces,
                    "elapsedSeconds": round(time.monotonic() - started_at, 3),
                    "stdout": decode_capture(stdout),
                    "stderr": decode_capture(stderr),
                }, 1)

            checks = dict(inner.get("checks", {}))
            checks["outerProcessExitZero"] = process.returncode == 0
            checks["privateHostReceiptUnchanged"] = private_unchanged
            inside_namespaces = inner.get("insideNamespaces") or {}
            checks["networkNamespaceDiffers"] = bool(
                inside_namespaces.get("net") and outer_namespaces.get("net")
                and inside_namespaces["net"] != outer_namespaces["net"]
            )
            checks["pidNamespaceDiffers"] = bool(
                inside_namespaces.get("pid") and outer_namespaces.get("pid")
                and inside_namespaces["pid"] != outer_namespaces["pid"]
            )
            inner["checks"] = checks
            inner["ok"] = inner.get("ok") is True and all(checks.values())
            inner["code"] = "probe-passed" if inner["ok"] else "probe-acceptance-failed"
            inner["clientSha256"] = client_hash
            inner["nodeSha256"] = node_hash
            inner["processExit"] = process.returncode
            inner["outsideNamespaces"] = outer_namespaces
            inner["privateHostReceiptUnchanged"] = private_unchanged
            inner["elapsedSeconds"] = round(time.monotonic() - started_at, 3)
            return emit(inner, 0 if inner["ok"] else 1)
    except (OSError, subprocess.SubprocessError) as exc:
        return emit({
            "ok": False,
            "code": "sandbox-launch-failed",
            "clientSha256": client_hash,
            "nodeSha256": node_hash,
            "error": str(exc),
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }, 2)


if __name__ == "__main__":
    raise SystemExit(main())
