#!/usr/bin/env python3
"""Opt-in Linux control-console host on a fixture-owned PTY."""
import argparse
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
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
capture = runpy.run_path(str(HERE / 'strict-capture-admission-probe.py'))
Launcher, WORKER, TIMEOUT, snapshot = (capture[key] for key in ('Launcher', 'WORKER', 'TIMEOUT', 'snapshot'))


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

    def spawn(self, command, fds=()):
        if command[1:3] != [WORKER, 'restart-console']:
            return super().spawn(command, fds)
        terminal, self.terminal = self.terminal, None
        if terminal is None:
            raise RuntimeError('terminal already used')
        return spawn_terminal_console(self, command, fds, terminal, 'standalone')


def fd_links(child):
    links = {}
    for fd in Path(f'/proc/{child.pid}/fd').iterdir():
        try:
            links[int(fd.name)] = os.readlink(fd)
        except FileNotFoundError:
            continue
    return links


def expect_terminal(fd, expected):
    data = bytearray()
    deadline = time.monotonic() + TIMEOUT
    while len(data) < len(expected):
        remaining = deadline - time.monotonic()
        assert remaining > 0 and select.select([fd], [], [], remaining)[0], 'terminal timeout'
        chunk = os.read(fd, len(expected) - len(data))
        assert chunk, 'terminal closed early'
        data.extend(chunk)
    assert data == expected, 'unexpected terminal bytes'


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


def read_console_status(master, state):
    os.write(master, b'status\r')
    expect_terminal(master, status_line(state))


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
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
    print(json.dumps({'ok': True, 'strictState': 'unverified', 'durableBytesUnchanged': True,
                      'cases': ['terminal-status', 'terminal-incomplete', 'terminal-hangup',
                                'terminal-setup-refused']}))


if __name__ == '__main__':
    main()
