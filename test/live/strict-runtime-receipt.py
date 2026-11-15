"""Bounded configuration receipt; never a runtime support or authentication verdict."""
import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
from pathlib import Path

SCHEMA = 'strict-runtime-receipt/v1'
class ReceiptUnavailable(RuntimeError):
    pass

FIELDS = ('platform', 'kernel_release', 'machine', 'uid', 'gid', 'client_role', 'client_entrypoint_sha256', 'client_sha256',
          'client_version', 'node_sha256', 'node_version', 'bwrap_sha256', 'bwrap_version',
          'filesystem_type', 'filesystem_source_sha256', 'mount_options_sha256',
          'namespace_types', 'userns_max', 'unprivileged_userns_clone')

def receipt_from_observations(observations):
    if type(observations) is not dict or set(observations) != set(FIELDS):
        raise ReceiptUnavailable('incomplete or unexpected descriptor fields')
    d = dict(observations)
    for key, value in d.items():
        if type(value) is not str or not value or len(value.encode('utf-8')) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ReceiptUnavailable('invalid descriptor field: ' + key)
    if d['platform'] != 'Linux':
        raise ReceiptUnavailable('Linux observations required')
    if d['client_role'] not in ('pinned-cli', 'node-channel-control'):
        raise ReceiptUnavailable('invalid client role')
    for key in ('client_sha256', 'client_entrypoint_sha256', 'node_sha256', 'bwrap_sha256', 'filesystem_source_sha256', 'mount_options_sha256'):
        if len(d[key]) != 64 or any(c not in '0123456789abcdef' for c in d[key]):
            raise ReceiptUnavailable('invalid digest')
    for key in ('uid', 'gid', 'userns_max'):
        if not d[key].isascii() or not d[key].isdigit():
            raise ReceiptUnavailable('invalid numeric prerequisite')
    if d['unprivileged_userns_clone'] not in ('0', '1', 'not-exposed'):
        raise ReceiptUnavailable('invalid userns flag')
    if not {'user', 'mnt', 'pid', 'net', 'ipc', 'uts'}.issubset(set(d['namespace_types'].split(','))):
        raise ReceiptUnavailable('required namespace metadata missing')
    canonical = json.dumps({'schema': SCHEMA, 'descriptor': d}, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    return {'schema': SCHEMA, 'descriptor': d, 'fingerprint_sha256': hashlib.sha256(canonical).hexdigest()}

def _limit_output():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))

def _run(argv):
    # Regular-file output is capped in the child; no unbounded PIPE allocation.
    import tempfile
    with tempfile.TemporaryFile() as out:
        try:
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL,
                                     env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, close_fds=True,
                                     start_new_session=True, preexec_fn=_limit_output)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # The leader remains unreaped here, so its process-group ID
                # cannot be reused before this timeout cleanup signal.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
                raise
            out.seek(0)
            data = out.read(65537)
            if child.returncode or len(data) > 65536:
                raise ReceiptUnavailable('metadata command failed or exceeded bound')
            return data.decode('utf-8', errors='strict').strip()
        except (OSError, subprocess.TimeoutExpired, UnicodeError) as exc:
            raise ReceiptUnavailable('metadata command unavailable') from exc

def _read(path):
    try:
        with open(path, 'rb') as source:
            raw = source.read(4097)
        if len(raw) > 4096:
            raise ReceiptUnavailable('metadata exceeds bound')
        return raw.decode('ascii').strip()
    except (OSError, UnicodeError) as exc:
        raise ReceiptUnavailable('prerequisite metadata unavailable') from exc

def _clone_policy():
    # Absence of this kernel-specific knob is an observation, never a pass.
    path = '/proc/sys/kernel/unprivileged_userns_clone'
    try:
        with open(path, 'rb') as source:
            raw = source.read(4097)
        if len(raw) > 4096:
            raise ReceiptUnavailable('metadata exceeds bound')
        return raw.decode('ascii').strip()
    except FileNotFoundError:
        return 'not-exposed'
    except (OSError, UnicodeError) as exc:
        raise ReceiptUnavailable('clone policy metadata unreadable') from exc

def _digest(path):
    h = hashlib.sha256()
    try:
        with open(path, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                h.update(chunk)
    except OSError as exc:
        raise ReceiptUnavailable('executable unavailable') from exc
    return h.hexdigest()

def capture_runtime_receipt(client, node, root, *, client_role='pinned-cli', client_entrypoint=None):
    if platform.system() != 'Linux':
        raise ReceiptUnavailable('Linux required')
    try:
        client, node, root = (str(Path(p).resolve(strict=True)) for p in (client, node, root))
        bwrap = shutil.which('bwrap', path='/usr/bin:/bin')
        findmnt = shutil.which('findmnt', path='/usr/bin:/bin')
        if not bwrap or not findmnt:
            raise ReceiptUnavailable('required metadata executable missing')
        mount = json.loads(_run([findmnt, '--json', '--target', root, '--output', 'FSTYPE,SOURCE,OPTIONS']))['filesystems']
        if len(mount) != 1:
            raise ReceiptUnavailable('ambiguous filesystem')
        fs = mount[0]
        if type(fs) is not dict or any(type(fs.get(k)) is not str or not fs[k] or len(fs[k].encode()) > 4096 for k in ('fstype', 'source', 'options')):
            raise ReceiptUnavailable('incomplete filesystem metadata')
        source = fs['source']
        if type(source) is not str or not source or len(source.encode()) > 4096:
            raise ReceiptUnavailable('invalid filesystem source')
        namespaces = ','.join(sorted(p.name for p in Path('/proc/self/ns').iterdir()))
        return receipt_from_observations(dict(zip(FIELDS, (
            'Linux', platform.release(), platform.machine(), str(os.getuid()), str(os.getgid()), client_role, _digest(client_entrypoint or client),
            _digest(client), _run([client, '--version']), _digest(node), _run([node, '--version']),
            _digest(bwrap), _run([bwrap, '--version']), fs['fstype'], hashlib.sha256(source.encode()).hexdigest(),
            hashlib.sha256(fs['options'].encode()).hexdigest(), namespaces, _read('/proc/sys/user/max_user_namespaces'),
            _clone_policy()))))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ReceiptUnavailable('runtime metadata unavailable') from exc

def self_test():
    base = {k: 'observed' for k in FIELDS}
    base.update(platform='Linux', uid='1000', gid='1000', client_role='pinned-cli', namespace_types='ipc,mnt,net,pid,user,uts', userns_max='100', unprivileged_userns_clone='1')
    for k in ('client_sha256', 'client_entrypoint_sha256', 'node_sha256', 'bwrap_sha256', 'filesystem_source_sha256', 'mount_options_sha256'):
        base[k] = 'a' * 64
    expected = receipt_from_observations(base)
    assert receipt_from_observations(dict(base, unprivileged_userns_clone='not-exposed'))['descriptor']['unprivileged_userns_clone'] == 'not-exposed'
    assert expected == receipt_from_observations(dict(reversed(list(base.items()))))
    for key in FIELDS:
        changed = dict(base)
        changed[key] = ('b' * 64 if key.endswith('sha256') else '2' if key in ('uid', 'gid', 'userns_max') else '0' if key == 'unprivileged_userns_clone' else 'node-channel-control' if key == 'client_role' else 'ipc,mnt,net,pid,user,uts,cgroup' if key == 'namespace_types' else 'changed')
        if key == 'platform':
            continue
        assert receipt_from_observations(changed)['fingerprint_sha256'] != expected['fingerprint_sha256']
    for bad in ({}, dict(base, platform='Windows'), dict(base, uid='-1'), dict(base, machine='x' * 4097), dict(base, machine=''), dict(base, node_sha256='bad'), dict(base, machine='x\n')):
        try:
            receipt_from_observations(bad)
        except ReceiptUnavailable:
            pass
        else:
            raise AssertionError('malformed observations accepted')
    print('strict-runtime-receipt self-test passed')

if __name__ == '__main__':
    if sys.argv[1:] != ['--self-test']:
        raise SystemExit('usage: strict-runtime-receipt.py --self-test')
    self_test()

