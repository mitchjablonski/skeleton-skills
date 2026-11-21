#!/usr/bin/env python3
"""Collect passive Linux terminal metadata for development evidence."""

import argparse
import json
import platform
import sys
from pathlib import Path


SYSCTL_NAME = 'dev.tty.legacy_tiocsti'
SYSCTL_PATH = Path('/proc/sys/dev/tty/legacy_tiocsti')


def read_legacy_tiocsti(path):
    try:
        with path.open('rb') as source:
            raw = source.read(3)
    except FileNotFoundError:
        return 'not-exposed'
    except PermissionError:
        return 'permission-denied'
    except OSError:
        return 'read-failed'

    if raw in (b'0', b'0\n'):
        return '0'
    if raw in (b'1', b'1\n'):
        return '1'
    return 'invalid-value'


def collect():
    result = {'ok': False, 'strictState': 'unverified'}
    if platform.system() != 'Linux':
        return dict(result, code='linux-required')

    kernel_release = platform.release()
    machine = platform.machine()
    if any(not value or len(value) > 256 for value in (kernel_release, machine)):
        return dict(result, code='invalid-platform-metadata')

    value = read_legacy_tiocsti(SYSCTL_PATH)
    result.update(platform='Linux', kernel_release=kernel_release, machine=machine)
    if value not in ('0', '1', 'not-exposed'):
        return dict(result, code=value)
    result[SYSCTL_NAME] = value
    result['ok'] = True
    return result


def self_test():
    from tempfile import TemporaryDirectory
    from unittest.mock import Mock, patch

    with TemporaryDirectory() as directory:
        path = Path(directory) / 'legacy_tiocsti'
        assert read_legacy_tiocsti(path) == 'not-exposed'
        for raw, expected in (
            (b'0\n', '0'), (b'1\n', '1'), (b'0', '0'), (b'1', '1'),
            (b'', 'invalid-value'), (b'2\n', 'invalid-value'),
            (b'0\n\x00', 'invalid-value'), (b' 1\n', 'invalid-value'),
        ):
            path.write_bytes(raw)
            assert read_legacy_tiocsti(path) == expected

    for error, expected in ((PermissionError, 'permission-denied'), (OSError, 'read-failed')):
        path = Mock()
        path.open.side_effect = error
        assert read_legacy_tiocsti(path) == expected

    with patch.object(platform, 'system', return_value='Linux'), \
         patch.object(platform, 'release', return_value='test-release'), \
         patch.object(platform, 'machine', return_value='test-machine'), \
         patch(__name__ + '.read_legacy_tiocsti') as read:
        base = {'strictState': 'unverified', 'platform': 'Linux',
                'kernel_release': 'test-release', 'machine': 'test-machine'}
        for value in ('0', '1', 'not-exposed'):
            read.return_value = value
            assert collect() == dict(base, ok=True, **{SYSCTL_NAME: value})
        for code in ('permission-denied', 'read-failed', 'invalid-value'):
            read.return_value = code
            assert collect() == dict(base, ok=False, code=code)

    with patch.object(platform, 'system', return_value='Windows'):
        assert collect() == {'ok': False, 'strictState': 'unverified', 'code': 'linux-required'}
    return {'ok': True, 'strictState': 'unverified', 'selfTest': 'passed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true', help='test with synthetic metadata')
    args = parser.parse_args()
    if args.self_test and sys.flags.optimize:
        parser.error('the self-test requires assertions')
    result = self_test() if args.self_test else collect()
    print(json.dumps(result, sort_keys=True))
    return 0 if result['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
