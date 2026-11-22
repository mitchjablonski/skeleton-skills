"""Display-slot proof for owned Xvfb displays (read-only; never connects to any socket).

Where /tmp/.X11-unix is not writable (WSL: a read-only bind of WSLg's tmpfs), Xvfb can't
create the filesystem socket and listens only on the abstract socket @/tmp/.X11-unix/X<n>.
A slot is proven clean only when the lock file, the filesystem socket and the abstract socket
are all gone. Abstract sockets are seen only by reading /proc/<pid>/net/unix, which is per
network namespace. The owned window's Xvfb is started by the listener scope without any
namespace change, so it shares this probe's network namespace and /proc/self/net/unix is
the right table, also after Xvfb has exited. An unreadable or malformed table is "not proven".
"""
import os
import re

SOCKET_DIR = '/tmp/.X11-unix'
_HEADER = re.compile(r'^Num\s+RefCount\s+Protocol\s+Flags\s+Type\s+St\s+Inode(\s+Path)?\s*$')
_ROW = re.compile(r'^\s*[0-9a-fA-F]+:\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{4}\s+[0-9A-Fa-f]{2}\s+\d+(?:\s+(\S.*))?$')


def parse_unix_socket_table(text):
    """Pure parser: (bound paths, rows, malformed, header ok). Abstract paths start with '@'."""
    lines = str(text).split('\n')
    if not _HEADER.match(lines[0] if lines else ''):
        return set(), 0, 1, False
    paths, rows, malformed = set(), 0, 0
    for line in lines[1:]:
        if not line.strip():
            continue
        match = _ROW.match(line)
        if not match:
            malformed += 1
            continue
        rows += 1
        if match.group(1) is not None:
            paths.add(match.group(1))
    return paths, rows, malformed, True


def x11_socket_state(text, number):
    """Pure: {'abstract', 'filesystem', 'proven'} for display `number`; None text = unreadable."""
    if text is None:
        return {'abstract': None, 'filesystem': None, 'proven': False}
    paths, _, malformed, header = parse_unix_socket_table(text)
    name = f'{SOCKET_DIR}/X{number}'
    return {'abstract': '@' + name in paths, 'filesystem': name in paths, 'proven': header and malformed == 0}


def socket_directory_label():
    """Fixed label: can this host's X socket directory take a filesystem socket?"""
    if not os.path.lexists(SOCKET_DIR):
        return 'absent'
    return 'writable' if os.access(SOCKET_DIR, os.W_OK) else 'read-only'


def slot_clean(number):
    """True only when lock, filesystem socket and abstract socket are all proven gone."""
    try:
        with open('/proc/self/net/unix', encoding='utf-8') as source:
            text = source.read(1 << 22)
    except OSError:
        text = None
    state = x11_socket_state(text, number)
    if not state['proven'] or state['abstract'] is not False or state['filesystem']:
        return False
    return not any(os.path.lexists(path) for path in (f'/tmp/.X{number}-lock', f'{SOCKET_DIR}/X{number}'))


if __name__ == '__main__':
    # Test entry: JSON cases on stdin -> JSON results on stdout (pure parser only).
    import json
    import sys
    cases = json.load(sys.stdin)
    print(json.dumps([x11_socket_state(case['text'], case['number']) for case in cases]))
