#!/usr/bin/env python3
"""Opt-in Linux harness for host-owned readiness binding and one-shot recovery."""
import argparse
from contextlib import ExitStack
from dataclasses import dataclass
import json
import os
from pathlib import Path
import runpy
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
WORKER = HERE / 'strict-launcher-binding-worker.mjs'
MAX_REPORT = 512
MAX_RECOVERY_REQUEST = 1024
TIMEOUT = 6
UNAVAILABLE = {'kind': 'rejected', 'code': 'unavailable'}


def read_json(reader):
    data = bytearray()
    deadline = time.monotonic() + TIMEOUT
    while True:
        if not select.select([reader], [], [], max(0, deadline - time.monotonic()))[0]:
            raise RuntimeError('missing report EOF')
        chunk = os.read(reader.fileno(), MAX_REPORT + 1 - len(data))
        if not chunk:
            return json.loads(data)
        data.extend(chunk)
        if len(data) > MAX_REPORT:
            raise RuntimeError('oversize report')


def encode_request(request):
    return json.dumps(request, separators=(',', ':')).encode()


@dataclass(eq=False, frozen=True)
class Enrollment:
    directory: Path
    identity: str
    expected: dict


@dataclass(eq=False)
class Generation:
    enrollment: Enrollment
    authority: subprocess.Popen
    console: subprocess.Popen
    reader: object
    descriptors: frozenset
    consumed: bool = False

    def report(self):
        # Only the designated console inherited this pipe's single writing end.
        with self.reader:
            return Report(self, read_json(self.reader))


@dataclass(frozen=True)
class Report:
    origin: Generation
    state: dict


def snapshot(enrollments):
    return {file: file.read_bytes() for item in enrollments for name in ('captures', 'authority')
            for file in (item.directory / name).rglob('*') if file.is_file()}


class Launcher:
    def __init__(self, node, scratch):
        self.node = node
        self.scratch = scratch
        self.children = []
        self.current = None

    def spawn(self, command, fds=()):
        child = subprocess.Popen(command, pass_fds=fds, env={}, cwd=self.scratch,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(child)
        return child

    def prepare(self, identity, *, different_capture=False):
        directory = self.scratch / (identity + '-different-capture' if different_capture else identity)
        directory.mkdir(mode=0o700)
        variant = 'different' if different_capture else 'initial'
        child = self.spawn([self.node, WORKER, 'prepare', directory, identity, variant])
        if child.wait(TIMEOUT) != 0:
            raise RuntimeError('enrollment failed')
        return Enrollment(directory, identity, json.loads((directory / 'expected.json').read_bytes()))

    def stage(self, enrollment, directory=None):
        self.current = None
        with ExitStack() as stack:
            left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            stack.enter_context(left)
            stack.enter_context(right)
            ordinary_descriptors = {os.readlink(f'/proc/self/fd/{endpoint.fileno()}') for endpoint in (left, right)}
            authority = self.spawn([self.node, WORKER, 'authority', directory or enrollment.directory,
                                    enrollment.identity, str(left.fileno())], (left.fileno(),))
            left.close()
            read, write = os.pipe()
            reader = os.fdopen(read, 'rb', buffering=0)
            try:
                with os.fdopen(write, 'wb', buffering=0):
                    ordinary_descriptors.add(os.readlink(f'/proc/self/fd/{read}'))
                    console = self.spawn([self.node, WORKER, 'console', enrollment.directory, enrollment.identity,
                                          str(right.fileno()), str(write)], (right.fileno(), write))
            except BaseException:
                reader.close()
                raise
        self.current = Generation(enrollment, authority, console, reader, frozenset(ordinary_descriptors))
        return self.current

    def recover(self, enrollment, request, *, identity=None, close_request=True, ordinary=None):
        with ExitStack() as stack:
            parent, request_reader = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            stack.enter_context(parent)
            stack.enter_context(request_reader)
            parent.settimeout(TIMEOUT)
            read, write = os.pipe()
            response = stack.enter_context(os.fdopen(read, 'rb', buffering=0))
            recovery_descriptors = {os.readlink(f'/proc/self/fd/{fd}') for fd in (request_reader.fileno(), write)}
            with os.fdopen(write, 'wb', buffering=0):
                child = self.spawn([self.node, WORKER, 'recover', enrollment.directory,
                                    identity or enrollment.identity, str(request_reader.fileno()), str(write)],
                                   (request_reader.fileno(), write))
            request_reader.close()
            parent.sendall(request)
            if close_request:
                parent.shutdown(socket.SHUT_WR)
            if ordinary is not None:
                # The unclosed request leaves the child alive while we inspect its descriptors.
                descriptors = Path(f'/proc/{child.pid}/fd')
                inherited = set()
                for descriptor in descriptors.iterdir():
                    try:
                        inherited.add(os.readlink(descriptor))
                    except FileNotFoundError:
                        continue  # Node can close its own short-lived descriptors.
                assert recovery_descriptors <= inherited
                assert inherited.isdisjoint(ordinary.descriptors)
            result = read_json(response)
            assert child.wait(TIMEOUT) == 0
            return result

    def admit(self, enrollment, report, marker):
        current = self.current
        if current is None or current is not report.origin or current.consumed:
            return False
        current.consumed = True
        if current.enrollment is not enrollment:
            return False
        # JSON canonicalization keeps boolean and numeric values distinct in Python.
        if json.dumps(report.state, sort_keys=True) != json.dumps(enrollment.expected, sort_keys=True):
            return False
        if current.authority.poll() is not None or current.console.poll() is not None:
            return False
        sentinel = self.spawn([sys.executable, '-I', '-c',
                               "import sys; open(sys.argv[1], 'xb').write(b'started\\n')", marker])
        if sentinel.wait(TIMEOUT) != 0:
            raise RuntimeError('sentinel failed')
        return True

    def cleanup(self):
        if self.current and not self.current.reader.closed:
            self.current.reader.close()
        for child in reversed(self.children):
            if child.poll() is None:
                child.kill()
        for child in self.children:
            child.wait(TIMEOUT)


def exercise_readiness(launcher, a, b, revoked, different):
    assert a.expected == b.expected == revoked.expected
    assert different.expected['captureVersion'] != a.expected['captureVersion']
    assert {**different.expected, 'captureVersion': a.expected['captureVersion']} == a.expected
    missing = launcher.scratch / 'missing-authority'
    missing.mkdir(mode=0o700)
    shutil.copytree(a.directory / 'captures', missing / 'captures')
    enrollments = (a, b, revoked, different, Enrollment(missing, a.identity, a.expected))
    before = snapshot(enrollments)
    cases = ('live', 'consumed', 'wrong-open', 'wrong-generation', 'wrong-capture', 'stale', 'revoked',
             'lost-authority', 'lost-console', 'missing-store')
    for case in cases:
        selected = revoked if case == 'revoked' else a
        alternate_store = {'wrong-open': b.directory, 'wrong-capture': different.directory,
                           'missing-store': missing}.get(case)
        active = launcher.stage(b if case == 'wrong-generation' else selected, alternate_store)
        report = active.report()
        if case in ('wrong-open', 'missing-store'):
            assert active.authority.wait(TIMEOUT) == 23
            assert report.state == UNAVAILABLE
            if case == 'missing-store':
                assert not (missing / 'authority').exists()
        elif case == 'revoked':
            assert report.state == {**selected.expected, 'admissions': 'revoked'}
        elif case == 'wrong-capture':
            assert report.state == different.expected
        else:
            assert report.state == selected.expected
        if case in ('wrong-generation', 'wrong-capture'):
            assert active.authority.poll() is None and active.console.poll() is None
        if case == 'stale':
            # Keep the previous peers alive so liveness alone cannot reject their report.
            replacement = launcher.stage(selected)
            assert replacement.report().state == report.state
            assert active.console.poll() is None and active.authority.poll() is None
            assert replacement.console.poll() is None and replacement.authority.poll() is None
        if case.startswith('lost-'):
            child, survivor = (active.authority, active.console) if case == 'lost-authority' else (
                active.console, active.authority)
            child.kill()
            child.wait(TIMEOUT)
            assert survivor.poll() is None
        marker = launcher.scratch / ('marker-' + case)
        if case == 'consumed':
            initial = launcher.scratch / 'marker-first-consumption'
            assert launcher.admit(selected, report, initial) and initial.read_bytes() == b'started\n'
        assert launcher.admit(selected, report, marker) == (case == 'live')
        assert (marker.read_bytes() if marker.exists() else None) == (b'started\n' if case == 'live' else None)
        if case.startswith('lost-'):
            assert survivor.poll() is None
        launcher.cleanup()
        assert snapshot(enrollments) == before
    return cases


def exercise_recovery(launcher, live, retained):
    fixture = json.loads((retained.directory / 'recovery.json').read_bytes())
    request = fixture['request']
    encoded = encode_request(request)
    code = request['args']['code']
    mismatched_code = ('1' if code[0] == '0' else '0') + code[1:]
    mismatched = {**request, 'args': {**request['args'], 'code': mismatched_code}}
    absent = {'operation': 'endSession', 'args': {'requestId': 'uncommitted-end'}}
    before = snapshot((live, retained))
    markers = set(launcher.scratch.glob('marker-*'))
    cases = (
        ('recovery-after-revocation', retained, encoded, fixture['result'], {}),
        ('recovery-before-commit', live, encode_request(absent), UNAVAILABLE, {}),
        ('recovery-mismatched-args', retained, encode_request(mismatched), UNAVAILABLE, {}),
        ('recovery-wrong-context', retained, encoded, UNAVAILABLE, {'identity': live.identity}),
        ('recovery-malformed', retained, b'{', UNAVAILABLE, {}),
        ('recovery-repeated', retained, encoded + b'\n' + encoded, UNAVAILABLE, {}),
        ('recovery-oversized', retained, encoded.ljust(MAX_RECOVERY_REQUEST + 1, b' '), UNAVAILABLE,
         {'close_request': False}),
        ('recovery-unclosed', retained, encoded, UNAVAILABLE, {'close_request': False}),
        ('recovery-held-lock', retained, encoded, UNAVAILABLE, {}),
    )
    for case, enrollment, payload, expected, options in cases:
        lock = retained.directory / 'authority' / '.authority-lock'
        if case == 'recovery-held-lock':
            lock.mkdir(mode=0o700)
        ordinary = launcher.stage(live) if case == 'recovery-unclosed' else None
        child_count = len(launcher.children)
        assert launcher.recover(enrollment, payload, ordinary=ordinary, **options) == expected, case
        assert len(launcher.children) == child_count + 1
        assert set(launcher.scratch.glob('marker-*')) == markers
        if case == 'recovery-held-lock':
            assert lock.is_dir() and not tuple(lock.iterdir())
        if ordinary is not None:
            assert ordinary.report().state == live.expected
            assert ordinary.authority.poll() is None and ordinary.console.poll() is None
        launcher.cleanup()
        assert snapshot((live, retained)) == before, case
    return tuple(case[0] for case in cases)


def exercise(launcher):
    a, b, revoked = [launcher.prepare(identity) for identity in ('a', 'b', 'revoked')]
    different = launcher.prepare('a', different_capture=True)
    readiness = exercise_readiness(launcher, a, b, revoked, different)
    retained = launcher.prepare('recovery')
    return readiness + exercise_recovery(launcher, a, retained)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or sys.flags.optimize:
        parser.error('requires Linux Python with assertions enabled')
    pin = runpy.run_path(str(HERE / 'strict-client-probe.py'))['validate_pin']
    node, _, error = pin(args.node, args.node_sha256, 'node')
    if error:
        parser.error('invalid Node pin')
    scratch = Path(tempfile.mkdtemp(prefix='strict-launcher-binding-'))
    launcher = Launcher(node, scratch)
    try:
        cases = exercise(launcher)
    finally:
        try:
            launcher.cleanup()
        except BaseException:
            print('Child cleanup unconfirmed. Retained scratch at ' + str(scratch), file=sys.stderr)
            raise
        shutil.rmtree(scratch)
    print(json.dumps({'ok': True, 'strictState': 'unverified', 'cases': cases, 'durableBytesUnchanged': True}))


if __name__ == '__main__':
    main()
