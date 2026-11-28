"""Owned Linux host filter. Only validated plain text may leave push()."""
import os
from pathlib import Path
import select
import struct
import subprocess
import time


class RelayTextFilter:
    """One pinned Node child and one stateful parser, used serially by a relay.

    node and script must be absolute trusted, pinned paths. close() must succeed
    before the owner removes the scratch directory containing those paths.
    """

    def __init__(self, node, script):
        if not Path(node).is_absolute() or not Path(script).is_absolute():
            raise RuntimeError("relay-filter-path")
        self._child = subprocess.Popen(
            [str(node), str(script)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={}, close_fds=True, bufsize=0,
        )
        self._failed = False
        self._closed = False
        try:
            os.set_blocking(self._child.stdin.fileno(), False)
            os.set_blocking(self._child.stdout.fileno(), False)
        except BaseException:
            self._failed = True
            self.close()
            raise RuntimeError("relay-filter-start") from None

    def _ready(self, stream, writing, deadline):
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("relay-filter-deadline")
            try:
                readable, writable, _ = select.select(
                    [] if writing else [stream], [stream] if writing else [], [], remaining)
            except InterruptedError:
                continue
            if (writable if writing else readable):
                return

    def _read(self, size, deadline):
        result = bytearray()
        while len(result) < size:
            self._ready(self._child.stdout, False, deadline)
            try:
                part = os.read(self._child.stdout.fileno(), size - len(result))
            except BlockingIOError:
                continue
            if not part:
                raise RuntimeError("relay-filter-eof")
            result.extend(part)
        return bytes(result)

    def push(self, chunk):
        if self._closed or self._failed:
            raise RuntimeError("relay-filter-closed")
        deadline = time.monotonic() + 1.0
        try:
            if type(chunk) is not bytes or not 1 <= len(chunk) <= 8192:
                raise RuntimeError("relay-filter-input")
            frame = memoryview(struct.pack(">H", len(chunk)) + chunk)
            while frame:
                self._ready(self._child.stdin, True, deadline)
                try:
                    count = os.write(self._child.stdin.fileno(), frame)
                except BlockingIOError:
                    continue
                if count <= 0:
                    raise RuntimeError("relay-filter-write")
                frame = frame[count:]
            size = struct.unpack(">H", self._read(2, deadline))[0]
            if size > len(chunk):
                raise RuntimeError("relay-filter-size")
            result = self._read(size, deadline)
            if any(b != 10 and not 32 <= b <= 126 for b in result):
                raise RuntimeError("relay-filter-text")
            if time.monotonic() > deadline:
                raise RuntimeError("relay-filter-deadline")
            return result
        except Exception:
            self._failed = True
            # The relay receives a fixed error, never any child or pane bytes.
            raise RuntimeError("relay-filter-failed") from None

    def close(self):
        if self._closed:
            return
        self._failed = True
        for stream in (self._child.stdin, self._child.stdout):
            if stream is not None:
                stream.close()
        try:
            self._child.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            self._child.kill()
            try:
                self._child.wait(timeout=0.75)
            except subprocess.TimeoutExpired:
                raise RuntimeError("relay-filter-exit-unproven") from None
        if self._child.poll() is None:
            raise RuntimeError("relay-filter-exit-unproven")
        self._closed = True
