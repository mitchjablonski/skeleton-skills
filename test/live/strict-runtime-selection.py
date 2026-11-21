#!/usr/bin/env python3
"""Disabled launcher-side policy for a trusted selected runtime receipt."""
from pathlib import Path
import runpy
import sys

receipt = runpy.run_path(str(Path(__file__).resolve().with_name('strict-runtime-receipt.py')))
normalize = receipt['receipt_from_observations']
PIN_FIELDS = ('client_sha256', 'client_entrypoint_sha256', 'node_sha256', 'bwrap_sha256')


def canonical_receipt(value):
    if type(value) is not dict or set(value) != {'schema', 'descriptor', 'fingerprint_sha256'}:
        return None
    if type(value['schema']) is not str or type(value['fingerprint_sha256']) is not str:
        return None
    try:
        canonical = normalize(value['descriptor'])
    except (receipt['ReceiptUnavailable'], UnicodeError):
        return None
    return canonical if canonical == value else None


def select_runtime(expected, observe):
    """Check one launcher-selected receipt against a new trusted observation.

    The launcher owns the selection. The observer must validate these
    executable pins before executing version commands and must sample
    current metadata on every call. Neither function starts a worker.
    """
    selected = canonical_receipt(expected)
    if selected is None:
        return {'kind': 'refused', 'code': 'runtime-selection-invalid'}
    pins = {key: selected['descriptor'][key] for key in PIN_FIELDS}
    try:
        current = canonical_receipt(observe(pins))
    except receipt['ReceiptCleanupFailed']:
        return {'kind': 'refused', 'code': 'runtime-observation-cleanup-unproven'}
    except Exception:
        return {'kind': 'refused', 'code': 'runtime-observation-unavailable'}
    if current is None:
        return {'kind': 'refused', 'code': 'runtime-observation-invalid'}
    if current != selected:
        return {'kind': 'refused', 'code': 'runtime-fingerprint-mismatch'}
    return {'kind': 'runtime-selected', 'fingerprint_sha256': selected['fingerprint_sha256']}


def self_test():
    descriptor = dict.fromkeys(receipt['FIELDS'], 'fixture')
    descriptor.update(platform='Linux', uid='1000', gid='1000', client_role='pinned-cli',
                      namespace_types='ipc,mnt,net,pid,user,uts', userns_max='100',
                      unprivileged_userns_clone='1')
    for index, key in enumerate((k for k in descriptor if k.endswith('_sha256')), start=1):
        descriptor[key] = f'{index:064x}'
    expected = normalize(descriptor)
    different = normalize({**descriptor, 'kernel_release': 'changed'})
    changed_entrypoint = normalize({**descriptor, 'client_entrypoint_sha256': 'a' * 64})
    seen = []
    observed = expected

    def observer(pins):
        assert pins == {key: descriptor[key] for key in PIN_FIELDS}
        seen.append(True)
        return observed

    assert select_runtime(None, observer)['code'] == 'runtime-selection-invalid'
    forged = {**expected, 'descriptor': {**descriptor, 'kernel_release': 'changed'}}
    assert select_runtime(forged, observer)['code'] == 'runtime-selection-invalid'
    invalid_text = {**expected, 'descriptor': {**descriptor, 'kernel_release': '\ud800'}}
    assert select_runtime(invalid_text, observer)['code'] == 'runtime-selection-invalid'
    assert not seen
    assert select_runtime(expected, observer) == {
        'kind': 'runtime-selected', 'fingerprint_sha256': expected['fingerprint_sha256']}
    for observed, code in ((different, 'runtime-fingerprint-mismatch'),
                           (changed_entrypoint, 'runtime-fingerprint-mismatch'),
                           (forged, 'runtime-observation-invalid'),
                           (None, 'runtime-observation-invalid')):
        assert select_runtime(expected, observer) == {'kind': 'refused', 'code': code}
    assert len(seen) == 5

    def unavailable(_pins):
        raise OSError('private path from observer')

    assert select_runtime(expected, unavailable) == {
        'kind': 'refused', 'code': 'runtime-observation-unavailable'}

    def unproven_cleanup(_pins):
        raise receipt['ReceiptCleanupFailed']('private helper detail')

    assert select_runtime(expected, unproven_cleanup) == {
        'kind': 'refused', 'code': 'runtime-observation-cleanup-unproven'}
    print('strict-runtime-selection self-test passed')


if __name__ == '__main__':
    if sys.argv[1:] != ['--self-test'] or sys.flags.optimize:
        raise SystemExit(2)
    self_test()
