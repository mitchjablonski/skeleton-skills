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
class ReceiptCleanupFailed(ReceiptUnavailable):
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
                except OSError as exc:
                    raise ReceiptCleanupFailed('metadata helper signal failed') from exc
                try:
                    child.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    raise ReceiptCleanupFailed('metadata helper cleanup unproven') from exc
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

_DIGEST_HELPER = '''import hashlib,os,stat,sys
limit=512*1024*1024
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
try:
 before=os.fstat(fd)
 if not stat.S_ISREG(before.st_mode) or before.st_size>limit:raise ValueError('digest file bound')
 h=hashlib.sha256();size=0
 while True:
  chunk=os.read(fd,1024*1024)
  if not chunk:break
  size+=len(chunk)
  if size>limit:raise ValueError('digest file bound')
  h.update(chunk)
 after=os.fstat(fd)
 if size!=before.st_size or any(getattr(before,k)!=getattr(after,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')):raise ValueError('digest file changed')
 print(h.hexdigest())
finally:os.close(fd)
'''

def _digest(path):
    # Hashing is also a bounded child operation, including open/read stalls.
    digest = _run([sys.executable, '-I', '-c', _DIGEST_HELPER, str(path)])
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ReceiptUnavailable('invalid executable digest')
    return digest

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
    # Cleanup cannot turn a command timeout into an unbounded wait.
    old_popen, old_killpg = subprocess.Popen, os.killpg
    waits, signals = [], []
    class Stuck:
        pid = 13579
        returncode = None
        def wait(self, timeout=None):
            waits.append(timeout)
            raise subprocess.TimeoutExpired('fixture', timeout)
    try:
        subprocess.Popen = lambda *a, **k: Stuck()
        os.killpg = lambda pid, sig: signals.append((pid, sig))
        try:
            _run(['fixed-metadata-fixture'])
        except ReceiptCleanupFailed:
            pass
        else:
            raise AssertionError('unproven cleanup accepted')
    finally:
        subprocess.Popen, os.killpg = old_popen, old_killpg
    assert waits == [5, 2] and signals == [(13579, signal.SIGKILL)]
    if platform.system() == 'Linux':
        import tempfile
        with tempfile.TemporaryDirectory(prefix='runtime-digest-test-') as directory:
            file = Path(directory) / 'sample'
            file.write_bytes(b'abc')
            assert _digest(file) == hashlib.sha256(b'abc').hexdigest()
            with file.open('wb') as stream:
                stream.truncate(512 * 1024 * 1024 + 1)
            for target in (file, Path(directory)):
                try:
                    _digest(target)
                except ReceiptUnavailable:
                    pass
                else:
                    raise AssertionError('unbounded/nonregular digest input accepted')
    print('strict-runtime-receipt self-test passed')

if __name__ == '__main__':
    if sys.argv[1:] != ['--self-test']:
        raise SystemExit('usage: strict-runtime-receipt.py --self-test')
    self_test()

