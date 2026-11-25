#!/usr/bin/env python3
"""Opt-in Linux control-console host on a fixture-owned PTY."""
import argparse
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import re
import runpy
import select
import shutil
import subprocess
import sys
import tempfile
import termios
import time
import tty

HERE = Path(__file__).resolve().parent
HOST_WORKER = HERE / 'strict-terminal-host-worker.mjs'
DECISION_AUTHORITY = HERE / 'strict-terminal-decision-authority.mjs'
capture = runpy.run_path(str(HERE / 'strict-capture-admission-probe.py'))
Launcher, WORKER, TIMEOUT, snapshot = (capture[key] for key in ('Launcher', 'WORKER', 'TIMEOUT', 'snapshot'))
Enrollment = capture['Enrollment']


def acquire_terminal(terminal):
    os.setsid()
    fcntl.ioctl(terminal, termios.TIOCSCTTY, 0)


def spawn_terminal_console(launcher, command, fds, terminal, mode):
    owned_fds = (*fds, terminal)
    # Node may abort restoring a hung-up standard stream. Keep the PTY on its own descriptor.
    with (Path(command[3]).parent / 'console.err').open('ab') as errors:
        child = subprocess.Popen([launcher.node, HOST_WORKER, mode, *map(str, owned_fds)],
                                 pass_fds=owned_fds, env={}, cwd=launcher.scratch,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=errors, preexec_fn=lambda: acquire_terminal(terminal))
    launcher.children.append(child)
    return child


class FixtureTerminal:
    def __init__(self):
        self._resources = ExitStack()
        self.master, self.slave = os.openpty()
        self._resources.callback(os.close, self.master)
        self._resources.callback(os.close, self.slave)
        self.process = None
        self.started_at = None
        self.closed = False
        try:
            self.original = termios.tcgetattr(self.slave)
            self._resources.callback(self.restore)
            tty.setraw(self.slave)
            assert not termios.tcgetattr(self.slave)[3] & (termios.ECHO | termios.ICANON)
        except BaseException:
            self.close()
            raise

    def restore(self):
        termios.tcsetattr(self.slave, termios.TCSANOW, self.original)
        assert termios.tcgetattr(self.slave) == self.original

    def close(self):
        self.closed = True
        self._resources.close()

    def owns(self, generation):
        if self.closed or self.process is not generation.console:
            return False
        try:
            return os.tcgetpgrp(self.master) == generation.console.pid
        except OSError:
            return False


class TerminalLauncher(Launcher):
    prepare_approved = capture['CaptureLauncher'].prepare_approved

    def __init__(self, node, scratch):
        super().__init__(node, scratch)
        self.terminal = None
        self.terminal_mode = 'standalone'

    def spawn(self, command, fds=()):
        if self.terminal_mode == 'decision' and command[1:3] == [WORKER, 'managed-authority']:
            command = [self.node, DECISION_AUTHORITY, 'serve', Path(command[3]).parent, command[5]]
        if command[1:3] != [WORKER, 'restart-console']:
            return super().spawn(command, fds)
        terminal, self.terminal = self.terminal, None
        if terminal is None:
            raise RuntimeError('terminal already used')
        return spawn_terminal_console(self, command, fds, terminal, self.terminal_mode)


def fd_links(child):
    links = {}
    for fd in Path(f'/proc/{child.pid}/fd').iterdir():
        try:
            links[int(fd.name)] = os.readlink(fd)
        except FileNotFoundError:
            continue
    return links


class TerminalReadFailure(AssertionError):
    def __init__(self, code, phase, age_ms, status):
        super().__init__(code)
        self.phase = phase
        self.age_ms = age_ms
        self.status = status


def terminal_failure(terminal, phase, code, message):
    if terminal is None:
        raise AssertionError(message)
    status = terminal.process.poll()
    if status == 3:  # strict-terminal-host-worker.mjs lifetime watchdog
        code = 'terminal-watchdog-expired'
    elif status is not None:
        code = 'terminal-console-exited'
    age_ms = round((time.monotonic() - terminal.started_at) * 1000)
    raise TerminalReadFailure(code, phase, age_ms, status)


def expect_terminal(fd, expected, *, terminal=None, phase=None):
    data = bytearray()
    with ExitStack() as owned:
        watched = [fd]
        console_fd = None
        if terminal is not None:
            if terminal.process.poll() is not None:
                terminal_failure(terminal, phase, 'terminal-console-exited', 'terminal closed early')
            try:
                console_fd = os.pidfd_open(terminal.process.pid)
            except OSError:
                terminal_failure(terminal, phase, 'terminal-exit-unobservable', 'terminal closed early')
            owned.callback(os.close, console_fd)
            watched.append(console_fd)
        deadline = time.monotonic() + TIMEOUT
        while len(data) < len(expected):
            remaining = deadline - time.monotonic()
            ready = select.select(watched, [], [], remaining)[0] if remaining > 0 else ()
            if console_fd in ready:
                terminal_failure(terminal, phase, 'terminal-console-exited', 'terminal closed early')
            if fd not in ready:
                terminal_failure(terminal, phase, 'terminal-response-timeout', 'terminal timeout')
            try:
                chunk = os.read(fd, len(expected) - len(data))
            except OSError:
                if terminal is None:
                    raise
                terminal_failure(terminal, phase, 'terminal-read-failed', 'terminal closed early')
            if not chunk:
                terminal_failure(terminal, phase, 'terminal-response-eof', 'terminal closed early')
            data.extend(chunk)
        if data != expected:
            terminal_failure(terminal, phase, 'terminal-response-invalid', 'unexpected terminal bytes')


def status_line(state):
    review, capture_version = (state[key][:12] + '…' for key in ('reviewVersion', 'captureVersion'))
    return (f"Phase {state['phase']} · shape {review} · capture {capture_version} · "
            f"revision {state['revision']}.\r\n").encode()


def check_terminal(master, slave, generation):
    console, authority = generation.console, generation.authority
    assert os.tcgetpgrp(master) == console.pid
    fields = Path(f'/proc/{console.pid}/stat').read_text().rsplit(')', 1)[1].split()
    assert [int(v) for v in fields[2:6]] == [console.pid, console.pid, os.fstat(slave).st_rdev, console.pid]
    name = os.ttyname(slave)
    links = fd_links(console)
    assert links[0] == links[1] == '/dev/null'
    assert [fd for fd, link in links.items() if link == name] == [slave]
    assert name not in fd_links(authority).values()
    inherited = {link for fd, link in links.items() if fd > 2}
    assert name not in generation.descriptors
    assert any(link.startswith('socket:[') for link in inherited & generation.descriptors)


def read_console_status(master, state, *, terminal=None, phase=None):
    try:
        os.write(master, b'status\r')
    except OSError:
        if terminal is None:
            raise
        terminal_failure(terminal, phase, 'terminal-write-failed', 'terminal closed early')
    expect_terminal(master, status_line(state), terminal=terminal, phase=phase)


def exercise(launcher):
    enrollment = launcher.prepare_approved('terminal', 'terminal-session')
    before = snapshot((enrollment,))
    terminal = FixtureTerminal()
    try:
        launcher.terminal = terminal.slave
        generation = launcher.stage(enrollment, approved=True)
        report = generation.report()
        assert report.state == enrollment.expected and launcher.terminal is None
        check_terminal(terminal.master, terminal.slave, generation)

        expect_terminal(terminal.master, b'SKELETON STRICT CONTROL\r\n')
        read_console_status(terminal.master, enrollment.expected)
        os.write(terminal.master, b'status')
        assert not select.select([terminal.master], [], [], 0.3)[0], 'incomplete input produced output'
    finally:
        terminal.close()
    status = generation.console.wait(TIMEOUT)
    assert status == 0, f'console exited with status {status}'
    assert generation.authority.poll() is None
    marker = launcher.scratch / 'marker-terminal'
    assert not launcher.admit(enrollment, report, marker) and not marker.exists()
    assert snapshot((enrollment,)) == before


def refuse_missing_terminal(launcher):
    enrollment = launcher.prepare_approved('terminal-refusal', 'terminal-refusal-session')
    before = snapshot((enrollment,))
    children = len(launcher.children)
    with open(os.devnull, 'rb', buffering=0) as non_terminal:
        launcher.terminal = non_terminal.fileno()
        try:
            launcher.stage(enrollment, approved=True)
        except subprocess.SubprocessError:
            assert launcher.current is None
        else:
            raise AssertionError('control started without a controlling terminal')
    assert len(launcher.children) == children + 1  # Only the owned authority started.
    assert not (launcher.scratch / 'marker-refusal').exists()
    assert snapshot((enrollment,)) == before


def exercise_decision(launcher):
    root = launcher.scratch / 'decision'
    root.mkdir(mode=0o700)
    history = root / 'history'
    record_path = history / 'authority' / 'human-authority.json'
    read_fd, write_fd = os.pipe()
    with os.fdopen(read_fd, 'rb') as code_pipe, os.fdopen(write_fd, 'wb') as writer:
        prepare = launcher.spawn([launcher.node, DECISION_AUTHORITY, 'prepare', root, str(write_fd)], (write_fd,))
        writer.close()
        assert prepare.wait(TIMEOUT) == 0, 'decision enrollment failed'
        code = code_pipe.read(10)
    assert re.fullmatch(rb'[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}', code), 'invalid private code'
    record = json.loads(record_path.read_bytes())
    state = record['authority']['state']
    assert state['phase'] == 'skeleton' and state['revision'] == 0
    assert record['commands'] == record['authority']['journal'] == []
    expected = {key: state[key] for key in ('phase', 'revision', 'reviewVersion', 'captureVersion')}
    expected['admissions'] = 'live'
    enrollment = Enrollment(history, 'terminal-decision', expected)
    before = snapshot((enrollment,))

    terminal = FixtureTerminal()
    try:
        launcher.terminal = terminal.slave
        launcher.terminal_mode = 'decision'
        generation = launcher.stage(enrollment, approved=True)
        assert generation.report().state == expected
        check_terminal(terminal.master, terminal.slave, generation)
        expect_terminal(terminal.master, b'SKELETON STRICT CONTROL\r\n')

        # A pasted newline must not turn the secret-bearing text into a command.
        command = b'approve ' + code
        os.write(terminal.master, b'\x1b[200~' + command + b'\rstatus\x1b[201~\r')
        expect_terminal(terminal.master, b'Input refused: type one line of plain letters, digits, spaces and hyphens. '
                        b'Text with line breaks or control characters is refused whole, and any pending question is cancelled.\r\n')
        read_console_status(terminal.master, expected)
        assert snapshot((enrollment,)) == before, 'rejected input changed durable state'

        os.write(terminal.master, b'\x1b[200~' + command + b'\x1b[201~')
        assert not select.select([terminal.master], [], [], 0.3)[0], 'paste produced output before Enter'
        assert snapshot((enrollment,)) == before, 'paste changed durable state before Enter'
        os.write(terminal.master, b'\r')
        review, capture_version = (expected[key][:12] + '…' for key in ('reviewVersion', 'captureVersion'))
        expect_terminal(terminal.master, (f'Recorded: approve · shape {review} · capture {capture_version} · '
                                         'revision 1 · 2026-01-01T00:00:00.000Z.\r\n').encode())
        read_console_status(terminal.master, {**expected, 'phase': 'fill', 'revision': 1})
    finally:
        terminal.close()
        launcher.terminal_mode = 'standalone'

    assert generation.console.wait(TIMEOUT) == 0, 'decision console did not close cleanly'
    assert generation.authority.wait(TIMEOUT) == 0, 'decision authority did not close cleanly'
    after = snapshot((enrollment,))
    assert record_path in before and record_path in after and before.pop(record_path) != after.pop(record_path)
    assert after == before, 'approval changed other durable files'

    committed = json.loads(record_path.read_bytes())
    assert committed['authority']['state'] == {**state, 'phase': 'fill', 'revision': 1,
                                               'approvedVersion': state['reviewVersion'],
                                               'approvedCaptureVersion': state['captureVersion']}
    assert committed['initial'] == record['initial'] and committed['epochs'] == record['epochs']
    assert committed['current'] == record['current']
    entry, = committed['commands']
    core, = committed['authority']['journal']
    assert entry['command']['requestId'] == core['intent']['requestId'] == 'terminal-fixture-only'
    assert entry['command']['action'] == core['intent']['action'] == 'approve'
    assert entry['command']['code'].encode() == code
    assert entry['result'] == {'kind': 'committed', 'action': 'approve', 'requestId': 'terminal-fixture-only',
                               'reviewVersion': state['reviewVersion'], 'captureVersion': state['captureVersion'],
                               'revision': 1, 'at': '2026-01-01T00:00:00.000Z'}
    assert not any(code in file.read_bytes() for file in launcher.scratch.rglob('*')
                   if file.is_file() and file != record_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--protected-decision', action='store_true',
                        help='exercise synthetic approval over the protected terminal and durable authority')
    args = parser.parse_args()
    if sys.platform != 'linux' or sys.flags.optimize or not sys.flags.isolated:
        parser.error('requires Linux Python -I with assertions enabled')
    pin = runpy.run_path(str(HERE / 'strict-client-probe.py'))['validate_pin']
    node, _, error = pin(args.node, args.node_sha256, 'node')
    if error:
        parser.error('invalid Node pin')
    scratch = Path(tempfile.mkdtemp(prefix='strict-terminal-host-')).resolve()
    launcher = TerminalLauncher(node, scratch)
    descriptors = set(os.listdir('/proc/self/fd'))
    try:
        try:
            if args.protected_decision:
                exercise_decision(launcher)
            else:
                exercise(launcher)
                refuse_missing_terminal(launcher)
        finally:
            launcher.cleanup()
        assert all(child.returncode is not None for child in launcher.children)
        assert set(os.listdir('/proc/self/fd')) == descriptors
    except BaseException:
        print('Terminal fixture failed. Retained scratch at ' + str(scratch), file=sys.stderr)
        raise
    shutil.rmtree(scratch)
    if args.protected_decision:
        print(json.dumps({'ok': True, 'strictState': 'unverified', 'terminalDecisionCommitted': True,
                          'cases': ['terminal-multiline-refused', 'terminal-paste-needs-enter', 'terminal-decision']}))
    else:
        print(json.dumps({'ok': True, 'strictState': 'unverified', 'durableBytesUnchanged': True,
                          'cases': ['terminal-status', 'terminal-incomplete', 'terminal-hangup',
                                    'terminal-setup-refused']}))


if __name__ == '__main__':
    main()
