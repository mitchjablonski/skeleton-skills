"""Owned host relay. Agent bytes may only reach the separate pane filter."""
import hashlib
import os
from pathlib import Path
import select
import socket
import stat
import struct

MAX_BUFFER = 128 * 1024
PROMPT = b"Desktop witness message: DESKTOP-WITNESS\r"


def terminal_identity(details):
    if not stat.S_ISCHR(details.st_mode):
        return None
    return details.st_dev, details.st_ino, details.st_rdev


def pin_client(source, expected, root):
    # Snapshot only a bounded native executable. The sandbox binds the copy,
    # which it cannot reach through a writable mount.
    target = root / "pinned-client"
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as original, target.open("xb") as copy:
        before = os.fstat(original.fileno())
        if (not stat.S_ISREG(before.st_mode) or not before.st_mode & 0o111
                or not 4 <= before.st_size <= 512 * 1024 * 1024):
            raise RuntimeError("interactive-client-pin-refused")
        if original.read(4) != b"\x7fELF":
            raise RuntimeError("interactive-client-pin-refused")
        original.seek(0)
        digest = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            chunk = original.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise RuntimeError("interactive-client-pin-refused")
            remaining -= len(chunk)
            digest.update(chunk)
            copy.write(chunk)
        after = os.fstat(original.fileno())
        if (original.read(1) or digest.hexdigest() != expected
                or (before.st_size, before.st_ctime_ns) != (after.st_size, after.st_ctime_ns)):
            raise RuntimeError("interactive-client-pin-refused")
        os.fchmod(copy.fileno(), 0o500)
    return target


class AgentRelay:
    def __init__(self, root, control_identity):
        self.path = root / "agent.sock"
        self.control_identity = control_identity
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.listener.bind(str(self.path))
            os.chmod(self.path, 0o600)
            self.listener.listen(1)
            self.listener.setblocking(False)
        except BaseException:
            self.listener.close()
            raise
        self.channel = self.pane = self.inner = None

    def prepare(self):
        self.end_generation()
        self.channel, self.inner = socket.socketpair()
        self.pending = bytearray()
        self.output = bytearray()
        self.input = bytearray()
        self.send = bytearray(b"s")
        self.ready = self.prompted = self.turn = False
        self.channel.setblocking(False)
        return self.inner

    def end_generation(self):
        for peer in (self.channel, self.inner, self.pane):
            if peer is not None:
                peer.close()
        self.channel = self.pane = self.inner = None

    def close(self):
        self.end_generation()
        self.listener.close()

    def owned_namespace(self):
        self.inner.close()
        self.inner = None

    def attach(self):
        peer, _ = self.listener.accept()
        try:
            pid, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid() or pid <= 0 or self.pane is not None:
                return
            pair = [terminal_identity(os.stat(f"/proc/{pid}/fd/{fd}")) for fd in (0, 1)]
            if pair[0] is None or pair[0] != pair[1] or pair[0] == self.control_identity:
                return
            peer.setblocking(False)
            self.pane = peer
            peer = None
        except OSError:
            return
        finally:
            if peer is not None:
                peer.close()

    def receive(self, block):
        if not block:
            raise RuntimeError("interactive-agent-exited")
        self.pending.extend(block)
        while len(self.pending) >= 3:
            kind = self.pending[0]
            length = int.from_bytes(self.pending[1:3], "big")
            limit = {ord("O"): 8192, ord("S"): 512}.get(kind, 0)
            if not 0 < length <= limit:
                raise RuntimeError("interactive-agent-frame-refused")
            if len(self.pending) < length + 3:
                return
            payload = self.pending[3:length + 3]
            del self.pending[:length + 3]
            if kind == ord("O"):
                self.output.extend(payload)
            elif payload == b'{"event":"ready"}' and not self.ready:
                self.ready = True
            elif payload == b'{"event":"turn"}' and self.ready and self.prompted and not self.turn:
                self.turn = True
            else:
                raise RuntimeError("interactive-agent-status-refused")
            if len(self.output) > MAX_BUFFER:
                raise RuntimeError("interactive-agent-output-limit")

    def poll(self, timeout):
        readers = [0, self.listener, self.channel]
        writers = [self.channel] if self.send else []
        if self.pane is not None:
            readers.append(self.pane)
            if self.output:
                writers.append(self.pane)
        readable, writable, _ = select.select(readers, writers, [], timeout)
        if self.channel in writable:
            del self.send[:self.channel.send(self.send)]
        if self.channel in readable:
            self.receive(self.channel.recv(8192))
        if self.pane in writable:
            del self.output[:self.pane.send(self.output)]
        if self.pane in readable:
            data = self.pane.recv(32)
            if not data:
                raise RuntimeError("interactive-agent-pane-closed")
            self.input.extend(data)
            if self.prompted or not b"witness\n".startswith(self.input):
                raise RuntimeError("interactive-agent-input-refused")
            if self.input == b"witness\n":
                if not self.ready:
                    raise RuntimeError("interactive-agent-not-ready")
                self.prompted = True
                self.send.extend(PROMPT)
        if self.listener in readable:
            self.attach()
        return 0 in readable

    def verified_turn(self):
        return self.pane is not None and self.prompted and self.turn
