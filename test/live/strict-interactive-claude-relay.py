"""Owned host relay. Agent bytes are reduced to plain text here, and only the
pinned pane filter may receive that text."""
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


ESC, BEL, LF, ST = 0x1B, 0x07, 0x0A, 0x9C
OSC, DCS, APC, PM, SOS, CSI = 0x9D, 0x90, 0x9F, 0x9E, 0x98, 0x9B
TMUX_PREFIX = b"tmux;"


class PtyTextFilter:
    """Byte-for-byte port of lib/strict-pty-output.mjs push(): only printable
    ASCII and LF leave; every escape, CSI and control string (OSC, DCS, APC,
    PM, SOS, 7- or 8-bit) is consumed, across chunk boundaries (#270). A
    conformance test runs both over the same streams."""

    def __init__(self):
        self.state = "text"
        self.kind = 0
        self.string_escape = False
        self.dcs_prefix = -1
        self.continuation = 0
        self.cont_min, self.cont_max = 0x80, 0xBF

    def _unicode(self, byte):
        if self.continuation and self.cont_min <= byte <= self.cont_max:
            self.continuation -= 1
            self.cont_min, self.cont_max = 0x80, 0xBF
            return True
        self.continuation = 0
        if byte < 0xC2 or byte > 0xF4:
            return False
        self.continuation = 1 if byte < 0xE0 else 2 if byte < 0xF0 else 3
        self.cont_min = 0xA0 if byte == 0xE0 else 0x90 if byte == 0xF0 else 0x80
        self.cont_max = 0x9F if byte == 0xED else 0x8F if byte == 0xF4 else 0xBF
        return True

    def _start_string(self, kind):
        self.state, self.kind, self.string_escape = "string", kind, False
        self.dcs_prefix = 0 if kind == DCS else -1

    def _discard(self, byte, unicode):
        if 0 <= self.dcs_prefix < len(TMUX_PREFIX):
            self.dcs_prefix = self.dcs_prefix + 1 if byte == TMUX_PREFIX[self.dcs_prefix] else -1
        wrapped = self.dcs_prefix == len(TMUX_PREFIX)
        if ((not unicode and byte == ST and not wrapped) or (byte == BEL and self.kind == OSC)
                or (self.string_escape and byte == 0x5C)):
            self.state = "text"
            return
        self.string_escape = byte == ESC and not (self.kind == DCS and self.string_escape)

    def _plain(self, byte):
        unicode = self._unicode(byte)
        if self.state == "string":
            self._discard(byte, unicode)
            return False
        if unicode:
            return False
        control = byte + 0x40 if self.state == "escape" and 0x40 <= byte <= 0x5F else byte
        if byte == ESC:
            self.state = "escape"
        elif control == CSI:
            self.state = "csi"
        elif control in (OSC, DCS, APC, PM, SOS):
            self._start_string(control)
        elif self.state in ("escape", "escape-intermediate"):
            if 0x20 <= byte <= 0x2F:
                self.state = "escape-intermediate"
            if 0x30 <= byte <= 0x7E:
                self.state = "text"
        elif self.state == "csi":
            if 0x40 <= byte <= 0x7E:
                self.state = "text"
        else:
            return byte == LF or 0x20 <= byte <= 0x7E
        return False

    def push(self, chunk):
        return bytes(byte for byte in chunk if self._plain(byte))


def pane_process_matches(pid, node_identity, script, sock):
    """True only for the reviewed pane filter: the pinned Node executable
    running exactly [absolute pane script, this relay's socket] (#270). The
    relay already reduces agent bytes to plain text; this pin is defence in
    depth, so another checkout's script or socat gets nothing."""
    try:
        exe = os.stat(f"/proc/{pid}/exe")
        with open(f"/proc/{pid}/cmdline", "rb") as record:
            argv = record.read(8193)
        with open(f"/proc/{pid}/environ", "rb") as record:
            environ = record.read(1024 * 1024 + 1)
    except OSError:
        return False
    if (exe.st_dev, exe.st_ino) != node_identity or len(argv) > 8192 or not argv.endswith(b"\0"):
        return False
    # NODE_OPTIONS (--require, --import, --inspect) would run other code in
    # the pane without showing in its argv.
    if len(environ) > 1024 * 1024 or any(entry.startswith(b"NODE_OPTIONS=") for entry in environ.split(b"\0")):
        return False
    args = argv[:-1].split(b"\0")
    return (len(args) == 3 and args[1] == os.fsencode(script)
            and os.path.realpath(os.fsdecode(args[2])) == os.path.realpath(sock))


class AgentRelay:
    def __init__(self, root, control_identity, node, pane_script):
        self.path = root / "agent.sock"
        self.control_identity = control_identity
        node_stat = os.stat(node)
        self.node_identity = node_stat.st_dev, node_stat.st_ino
        self.pane_script = str(pane_script)
        if not os.path.isabs(self.pane_script):
            raise RuntimeError("interactive-agent-pane-path-refused")
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
        self.text = PtyTextFilter()
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
            with open(f"/proc/{pid}/stat", "rb") as record:
                fields = record.read(4096).rsplit(b")", 1)[-1].split()
            if len(fields) < 6 or fields[4] == b"0" or fields[2] != fields[5]:
                return
            if not pane_process_matches(pid, self.node_identity, self.pane_script, self.path):
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
                # Filter on the host before anything can reach the pane socket.
                self.output.extend(self.text.push(payload))
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
