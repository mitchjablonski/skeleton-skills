"""Private namespace PTY relay; fd 1 belongs exclusively to the supervisor.

Mount at /opt/interactive-pty.py and invoke run() inside the fixed worker.
No diagnostics or terminal content are written to inherited output descriptors.
"""

import errno
import fcntl
import json
import os
import resource
import select
import socket
import struct
import termios
import time


def run():
    """Wait for census release, then relay one private interactive child."""
    child = None
    owned = []
    master = status_read = status_write = slave = None
    try:
        # Refuse pipes/terminals/INET sockets as the host transport.
        transport = socket.socket(fileno=0)
        try:
            if (transport.family != socket.AF_UNIX or
                    transport.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM):
                return 1
            if transport.recv(1) != b's':
                return 1
        finally:
            transport.detach()

        master, slave = os.openpty()
        owned.extend((master, slave))
        status_read, status_write = os.pipe()
        owned.extend((status_read, status_write))
        # A fixed terminal size avoids inheriting any desktop terminal state.
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
        child = os.fork()
        if child == 0:
            try:
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                for target in (0, 1, 2):
                    os.dup2(slave, target)
                os.set_inheritable(status_write, True)
                # Close lifecycle pipe, transport, master, and all unrelated FDs.
                limit = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
                if limit == resource.RLIM_INFINITY:
                    limit = 1048576
                os.closerange(3, status_write)
                os.closerange(status_write + 1, int(limit))
                os.execve('/opt/node', ['/opt/node', '/opt/interactive-claude.mjs'],
                          {'STRICT_INTERACTIVE_STATUS_FD': str(status_write)})
            except BaseException:
                os._exit(1)
        os.close(slave)
        owned.remove(slave)
        os.close(status_write)
        owned.remove(status_write)
        for fd in (0, master, status_read):
            os.set_blocking(fd, False)

        incoming = bytearray()
        outgoing = bytearray()
        status_buffer = bytearray()
        blocked_since = None
        child_exited = False
        pty_open = status_open = True
        while True:
            if not child_exited:
                ended, _ = os.waitpid(child, os.WNOHANG)
                child_exited = ended == child
            if not pty_open and not status_open and not outgoing:
                return 0
            if outgoing:
                if blocked_since is None:
                    blocked_since = time.monotonic()
                elif time.monotonic() - blocked_since > 5:
                    return 1
            else:
                blocked_since = None
            reads = [0] if len(incoming) < 16384 else []
            # Reserve one maximum PTY frame and a full status read, including
            # framing overhead if that read contains many short JSON lines.
            if len(outgoing) <= 65536 - 8195 - 2048:
                if pty_open:
                    reads.append(master)
                if status_open:
                    reads.append(status_read)
            writes = ([0] if outgoing else []) + ([master] if incoming and pty_open else [])
            readable, writable, _ = select.select(reads, writes, [], 0.1)
            for fd in writable:
                queue = outgoing if fd == 0 else incoming
                try:
                    count = os.write(fd, queue)
                except BlockingIOError:
                    continue
                if count <= 0:
                    return 1
                del queue[:count]
                if fd == 0:
                    blocked_since = time.monotonic() if outgoing else None
            for fd in readable:
                try:
                    chunk = os.read(fd, min(8192, 16384 - len(incoming)) if fd == 0 else
                                    (8192 if fd == master else 512))
                except BlockingIOError:
                    continue
                except OSError as error:
                    if fd == master and error.errno == errno.EIO:
                        chunk = b''
                    else:
                        raise
                if fd == 0:
                    if not chunk:
                        return 0
                    incoming.extend(chunk)
                elif fd == master:
                    if not chunk:
                        pty_open = False
                        incoming.clear()
                    else:
                        outgoing.extend(b'O' + len(chunk).to_bytes(2, 'big') + chunk)
                else:
                    if not chunk:
                        if status_buffer:
                            return 1
                        status_open = False
                        continue
                    status_buffer.extend(chunk)
                    while b'\n' in status_buffer:
                        line, _, rest = status_buffer.partition(b'\n')
                        status_buffer = bytearray(rest)
                        if not line or len(line) > 512:
                            return 1
                        message = json.loads(line)
                        if not isinstance(message, dict) or not isinstance(message.get('event'), str):
                            return 1
                        outgoing.extend(b'S' + len(line).to_bytes(2, 'big') + line)
                    if len(status_buffer) > 512 or len(outgoing) > 65536:
                        return 1
    except Exception:
        # Deliberately redact exceptions, tracebacks, and command output.
        return 1
    finally:
        for fd in owned:
            try:
                os.close(fd)
            except OSError:
                pass
        if child and child > 0:
            # Closing the private master hangs up its controlling terminal.
            # Never signal a numeric PID: the namespace supervisor owns cleanup.
            try:
                os.waitpid(child, os.WNOHANG)
            except (ChildProcessError, OSError):
                pass
