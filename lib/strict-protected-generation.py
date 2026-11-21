"""Host-owned Linux descriptors and readiness reports for a protected generation."""
from __future__ import annotations

from contextlib import ExitStack
from dataclasses import dataclass
import json
import os
import select
import socket
from subprocess import Popen
import time
from typing import BinaryIO

MAX_REPORT = 512
TIMEOUT = 6


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate report key')
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError(f'invalid JSON constant: {value}')


def read_json(reader):
    """Read exactly one UTF-8 JSON object from a pipe through EOF."""
    data = bytearray()
    deadline = time.monotonic() + TIMEOUT
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([reader], [], [], remaining)[0]:
            raise RuntimeError('missing report EOF')
        chunk = os.read(reader.fileno(), MAX_REPORT + 1 - len(data))
        if not chunk:
            report = json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object,
                                parse_constant=_invalid_constant)
            if not isinstance(report, dict):
                raise ValueError('report must be a JSON object')
            return report
        data.extend(chunk)
        if len(data) > MAX_REPORT:
            raise RuntimeError('oversize report')


@dataclass(eq=False)
class Generation:
    enrollment: object
    authority: Popen
    console: Popen
    reader: BinaryIO
    descriptors: frozenset
    consumed: bool = False
    refresh_reader: BinaryIO | None = None
    refresh_request: BinaryIO | None = None

    def report(self):
        with self.reader:
            return Report(self, read_json(self.reader))

    def fresh_report(self):
        if self.refresh_reader is None or self.refresh_request is None:
            raise RuntimeError('generation has no refresh pipe')
        # The same console owns a distinct pipe for its second observation.
        requested_at = time.monotonic_ns()
        with self.refresh_reader:
            with self.refresh_request:
                self.refresh_request.write(b'R')
            return Report(self, read_json(self.refresh_reader), sequence=1, requested_at=requested_at)

    def close_reports(self):
        for pipe in (self.reader, self.refresh_reader, self.refresh_request):
            if pipe is not None:
                pipe.close()


@dataclass(frozen=True)
class Report:
    origin: Generation
    state: dict
    sequence: int = 0
    requested_at: int | None = None


def _pipe(peers, reports, *, parent_reads):
    read_fd, write_fd = os.pipe()
    parent_fd, child_fd = (read_fd, write_fd) if parent_reads else (write_fd, read_fd)
    peers.callback(os.close, child_fd)
    try:
        parent = os.fdopen(parent_fd, 'rb' if parent_reads else 'wb', buffering=0)
    except BaseException:
        os.close(parent_fd)
        raise
    return reports.enter_context(parent), child_fd


def stage_generation(enrollment, launch_authority, launch_console, *, refresh=False):
    """Stage a pair through trusted launch callbacks that track their child processes."""
    with ExitStack() as peers, ExitStack() as reports:
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        peers.enter_context(left)
        peers.enter_context(right)
        descriptors = {os.readlink(f'/proc/self/fd/{left.fileno()}')}
        authority = launch_authority(left.fileno())
        left.close()

        reader, write = _pipe(peers, reports, parent_reads=True)
        console_fds = (right.fileno(), write)
        refresh_reader = refresh_request = None
        if refresh:
            refresh_request, signal_read = _pipe(peers, reports, parent_reads=False)
            refresh_reader, refresh_write = _pipe(peers, reports, parent_reads=True)
            console_fds += (signal_read, refresh_write)

        descriptors.update(os.readlink(f'/proc/self/fd/{fd}') for fd in console_fds)
        console = launch_console(console_fds)
        generation = Generation(enrollment, authority, console, reader, frozenset(descriptors),
                                refresh_reader=refresh_reader, refresh_request=refresh_request)
        peers.close()
        reports.pop_all()  # Generation owns the readiness pipes after setup succeeds.
        return generation
