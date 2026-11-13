#!/usr/bin/env python3
"""Development-only Linux PID-namespace checkpoint teardown experiment."""

import json
import os
import pathlib
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

TIMEOUT = 8
MAX_CAPTURE = 8192

# Two double-forked, session-detached writers retain open stage descriptors.
# Their launching process exits, leaving the writers adopted by namespace PID 1.
INNER = r'''
import json, os, pathlib, time
stage = pathlib.Path('/stage')
for index in range(2):
    launcher = os.fork()
    if launcher == 0:
        os.setsid()
        if os.fork():
            os._exit(0)
        fd = os.open(str(stage / ('writer-%d' % index)), os.O_CREAT | os.O_WRONLY, 0o600)
        (stage / ('ready-%d' % index)).write_text(json.dumps({'pid': os.getpid(), 'ppid': os.getppid()}))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            os.write(fd, b'x')
            time.sleep(0.005)
        os._exit(0)
    os.waitpid(launcher, 0)
(stage / 'init').write_text(json.dumps({'pid': os.getpid(), 'namespace': os.readlink('/proc/self/ns/pid')}))
time.sleep(20)
'''


def wait_until(predicate, label):
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.02)
    raise RuntimeError('timeout: ' + label)


def bounded_json(path):
    if path.stat().st_size > MAX_CAPTURE:
        raise RuntimeError('oversized metadata')
    return json.loads(path.read_bytes())


def members(namespace):
    result = {}
    host_depth = len(next(line for line in pathlib.Path('/proc/self/status').read_text().splitlines()
                          if line.startswith('NSpid:')).split()) - 1
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / 'status').read_text()
            fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
            try:
                observed_namespace = os.readlink(entry / 'ns/pid')
            except PermissionError:
                # NSpid is relative to this /proc mount. A process at or above
                # our namespace depth cannot belong to our newly nested namespace.
                # Inaccessible nested processes remain an explicit failure.
                if 0 < len(fields['NSpid'].split()) <= host_depth:
                    continue
                raise
            if observed_namespace != namespace:
                continue
            result[int(entry.name)] = (int(fields['NSpid'].split()[-1]), fields['State'].strip()[0])
        except (FileNotFoundError, ProcessLookupError):
            continue
    return result


def one_round(bwrap, scratch, number, previous_namespace):
    import resource

    def child_limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_CAPTURE, MAX_CAPTURE))
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))

    stage = scratch / ('stage-%d' % number)
    stage.mkdir()
    info = scratch / ('info-%d' % number)
    stderr_path = scratch / ('stderr-%d' % number)
    handles = []
    process = None
    init_fd = None
    namespace = None
    try:
        with info.open('wb') as info_stream, stderr_path.open('wb') as errors:
            command = [bwrap, '--unshare-all', '--as-pid-1', '--die-with-parent',
                       '--new-session', '--clearenv', '--ro-bind', '/usr', '/usr',
                       '--ro-bind', '/lib', '/lib']
            if pathlib.Path('/lib64').exists():
                command += ['--ro-bind', '/lib64', '/lib64']
            command += ['--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev',
                        '--tmpfs', '/tmp', '--bind', str(stage), '/stage',
                        '--info-fd', str(info_stream.fileno()), '--', sys.executable, '-I', '-c', INNER]
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=errors, pass_fds=(info_stream.fileno(),),
                                       start_new_session=True, env={}, preexec_fn=child_limits)
            def info_ready():
                if process.poll() is not None:
                    raise RuntimeError('bubblewrap exited before init metadata')
                try:
                    return bounded_json(info)
                except (json.JSONDecodeError, FileNotFoundError):
                    return None
            metadata = wait_until(info_ready, 'namespace init metadata')
            init_pid = metadata['child-pid']
            init_fd = os.pidfd_open(init_pid)
            handles.append(init_fd)
            namespace = os.readlink('/proc/%d/ns/pid' % init_pid)
            if namespace == os.readlink('/proc/self/ns/pid') or namespace == previous_namespace:
                raise RuntimeError('namespace is not distinct')
            wait_until(lambda: all((stage / name).exists() for name in ('init', 'ready-0', 'ready-1')), 'writers ready')
            inner = bounded_json(stage / 'init')
            observed = members(namespace)
            if inner != {'pid': 1, 'namespace': namespace} or observed.get(init_pid, (None,))[0] != 1:
                raise RuntimeError('bubblewrap child is not verified namespace PID 1')
            writers = [bounded_json(stage / ('ready-%d' % i))['pid'] for i in range(2)]
            if len(observed) != 3 or set(pid for pid, state in observed.values()) != {1, *writers}:
                raise RuntimeError('unexpected namespace membership')
            for pid in observed:
                if pid != init_pid:
                    handles.append(os.pidfd_open(pid))
                    parent_line = next(line for line in pathlib.Path('/proc/%d/status' % pid).read_text().splitlines()
                                       if line.startswith('PPid:'))
                    if int(parent_line.split()[1]) != init_pid:
                        raise RuntimeError('writer not adopted by namespace init')
            before = [(stage / ('writer-%d' % i)).stat().st_size for i in range(2)]
            time.sleep(0.1)
            after = [(stage / ('writer-%d' % i)).stat().st_size for i in range(2)]
            if not all(end > start for start, end in zip(before, after)):
                raise RuntimeError('writers did not both advance')
            # Signal the stable init handle, never a cached numeric PID.
            signal.pidfd_send_signal(init_fd, signal.SIGKILL)
            wait_until(lambda: len(select.select(handles, [], [], 0)[0]) == len(handles), 'all namespace pidfds exited')
            wait_until(lambda: not any(state != 'Z' for pid, state in members(namespace).values()), 'no live namespace members')
            process.wait(timeout=TIMEOUT)
            # First host reads of writer content occur strictly after death checks.
            candidate = [(stage / ('writer-%d' % i)).read_bytes() for i in range(2)]
            time.sleep(0.1)
            if candidate != [(stage / ('writer-%d' % i)).read_bytes() for i in range(2)]:
                raise RuntimeError('candidate changed after teardown')
            return {'namespace': namespace, 'initHostPid': init_pid, 'trackedProcesses': len(handles),
                    'candidateBytes': [len(data) for data in candidate], 'allPidfdsExitedBeforeRead': True,
                    'noLiveNamespaceMembersBeforeRead': True, 'bothWritersAdvanced': True}
    finally:
        try:
            if init_fd is not None:
                try:
                    signal.pidfd_send_signal(init_fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                # Let namespace teardown finish before removing writable fixtures.
                if not select.select([init_fd], [], [], TIMEOUT)[0]:
                    raise RuntimeError('cleanup namespace init did not exit')
            if process is not None and process.poll() is None:
                # On pre-pidfd startup failure, bwrap death triggers parent-death policy.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=TIMEOUT)
        finally:
            for fd in handles:
                os.close(fd)


def main():
    result = {'ok': False, 'strictState': 'unverified', 'scope': 'development-only PID namespace teardown probe'}
    exit_code = 2
    try:
        if len(sys.argv) != 1:
            result['code'] = 'invalid-arguments'
        elif not sys.platform.startswith('linux'):
            result.update(code='unsupported-platform', platform=sys.platform)
        elif not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            result['code'] = 'unsupported-pidfd-api'
        elif not shutil.which('bwrap'):
            result['code'] = 'bubblewrap-not-on-PATH'
        elif not str(pathlib.Path(sys.executable).resolve()).startswith('/usr/'):
            result['code'] = 'unsupported-python-runtime-use-system-usr-python'
        else:
            # Fail before launching if Python exposes pidfds but the kernel does not.
            own_fd = os.pidfd_open(os.getpid())
            try:
                signal.pidfd_send_signal(own_fd, 0)
            finally:
                os.close(own_fd)
            with tempfile.TemporaryDirectory(prefix='strict-checkpoint-probe-') as directory:
                scratch = pathlib.Path(directory)
                try:
                    first = one_round(shutil.which('bwrap'), scratch, 1, None)
                    second = one_round(shutil.which('bwrap'), scratch, 2, first['namespace'])
                    result.update(ok=True, code='probe-passed', rounds=[first, second], freshNamespaceRestart=True)
                    exit_code = 0
                except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as exc:
                    result.update(code='probe-failed', error=str(exc)[:1024])
                    result['stderr'] = {p.name: p.open('rb').read(MAX_CAPTURE).decode('utf-8', 'replace')
                                        for p in scratch.glob('stderr-*')}
                    exit_code = 1
    except OSError as exc:
        result.update(code='probe-unavailable', error=str(exc)[:1024])
    print(json.dumps(result, sort_keys=True))
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
