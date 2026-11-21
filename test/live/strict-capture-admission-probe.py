#!/usr/bin/env python3
"""Opt-in Linux fixture for admitted stored bytes and owned leaf restart."""
import argparse
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile

HERE = Path(__file__).resolve().parent
binding = runpy.run_path(str(HERE / 'strict-launcher-binding-probe.py'))
Launcher, Enrollment, WORKER, TIMEOUT, UNAVAILABLE, read_json, snapshot, encode_request = (
    binding[name] for name in ('Launcher', 'Enrollment', 'WORKER', 'TIMEOUT',
                               'UNAVAILABLE', 'read_json', 'snapshot', 'encode_request'))
MEMBERS = ('context.txt', 'plan.js')
LEAF = """
import hashlib, json, os, pathlib, sys
stage = pathlib.Path(sys.argv[1])
result = {name: hashlib.sha256((stage / name).read_bytes()).hexdigest()
          for name in ('context.txt', 'plan.js')}
with os.fdopen(int(sys.argv[2]), 'wb') as output:
    output.write(json.dumps(result).encode())
with os.fdopen(int(sys.argv[3]), 'rb') as lifetime:
    lifetime.read(1)
"""


@dataclass(eq=False)
class Fill:
    generation: object
    child: object
    stage: Path
    lifetime: object


class CaptureLauncher(Launcher):
    def __init__(self, node, scratch):
        super().__init__(node, scratch)
        self.active = None
        self.stopped = {}
        self.reports_used = set()
        self.fills = []

    def prepare_approved(self, case, identity):
        directory = self.scratch / case
        directory.mkdir(mode=0o700)
        child = self.spawn([self.node, WORKER, 'prepare-approved', directory, identity])
        assert child.wait(TIMEOUT) == 0
        expected = json.loads((directory / 'expected.json').read_bytes())
        assert expected['phase'] == 'fill' and expected['admissions'] == 'live'
        return Enrollment(directory / 'history', identity, expected)

    def observe_stop(self, child):
        assert child in self.children and child not in self.stopped
        assert child.wait(TIMEOUT) == 0
        receipt = object()
        self.stopped[child] = receipt
        return receipt

    def admit_capture(self, selected, report, stage, stop=None):
        current = self.current
        previous = self.active
        if previous is None and stop is not None:
            return None
        if previous is not None and (previous.generation is not current
                                     or stop is None
                                     or self.stopped.get(previous.child) is not stop
                                     or previous.child.poll() is None):
            return None
        sequence = 0 if previous is None else 1
        report_key = (current, sequence)
        if (current is None or current is not report.origin or current.enrollment is not selected
                or report.sequence != sequence or report_key in self.reports_used):
            return None
        self.reports_used.add(report_key)
        expected = selected.expected
        if json.dumps(report.state, sort_keys=True) != json.dumps(expected, sort_keys=True):
            return None
        if not self.peers_live(current):
            return None
        materializer = self.spawn([self.node, WORKER, 'materialize-approved', selected.directory,
                                   selected.identity, stage, expected['reviewVersion'], expected['captureVersion']])
        status = materializer.wait(TIMEOUT)
        if status == 23:
            return None
        assert status == 0
        if not self.peers_live(current):
            return None
        read, write = os.pipe()
        lifetime_read, lifetime_write = os.pipe()
        with os.fdopen(read, 'rb', buffering=0) as observation:
            lifetime = os.fdopen(lifetime_write, 'wb', buffering=0)
            try:
                with os.fdopen(write, 'wb', buffering=0), os.fdopen(lifetime_read, 'rb', buffering=0):
                    child = self.spawn([sys.executable, '-I', '-c', LEAF, stage, str(write), str(lifetime_read)],
                                       (write, lifetime_read))
                self.active = Fill(current, child, stage, lifetime)
                self.fills.append(self.active)
            except BaseException:
                lifetime.close()
                raise
            return read_json(observation)

    @staticmethod
    def peers_live(generation):
        return generation.authority.poll() is None and generation.console.poll() is None

    def cleanup(self):
        for fill in self.fills:
            fill.lifetime.close()
        super().cleanup()


def exercise_case(node, scratch, case):
    launcher = CaptureLauncher(node, scratch)
    try:
        selected = launcher.prepare_approved(case, 'selected')
        directory = selected.directory.parent
        expected = {name: sha256((directory / 'candidate' / name).read_bytes()).hexdigest() for name in MEMBERS}
        (directory / 'candidate' / 'plan.js').write_bytes(b'different live workspace\n')
        source = selected
        if case == 'wrong-enrollment':
            source = launcher.prepare_approved(case + '-other', 'other')
            assert source.expected == selected.expected
        blob = selected.directory / 'captures' / (selected.expected['captureVersion'] + '.json')
        if case == 'missing-capture':
            blob.unlink()
        if case == 'corrupt-capture':
            blob.write_bytes(b'{}')
        before = snapshot((selected, source))
        generation = launcher.stage(source, approved=True)
        initial = generation.report()
        assert initial.state == selected.expected and launcher.peers_live(generation)
        first_stage = directory / 'stage-first'
        observed = launcher.admit_capture(selected, initial, first_stage)
        if case in ('wrong-enrollment', 'missing-capture', 'corrupt-capture'):
            assert observed is None and not launcher.fills and not first_stage.exists()
        else:
            assert observed == expected
            first = launcher.active
            assert first.child.poll() is None
            (first_stage / 'plan.js').write_bytes(b'different previous stage\n')
            stop = None
            if case == 'borrowed-stop':
                unrelated = launcher.spawn([sys.executable, '-I', '-c', 'pass'])
                stop = launcher.observe_stop(unrelated)
            elif case != 'missing-stop':
                first.lifetime.close()
                stop = launcher.observe_stop(first.child)
                if case == 'recovery-result':
                    history = json.loads((directory / 'recovery.json').read_bytes())
                    stop = launcher.recover(selected, encode_request(history['request']))
                    assert stop == history['result']
            assert (first.child.poll() is None) == (case in ('missing-stop', 'borrowed-stop'))
            lock = selected.directory / 'authority' / '.authority-lock'
            if case == 'unreadable-after-stop':
                lock.mkdir(mode=0o700)
            fresh = generation.fresh_report()
            assert fresh.state == (UNAVAILABLE if case == 'unreadable-after-stop' else initial.state)
            assert launcher.peers_live(generation)
            next_stage = directory / 'stage-restart'
            observed = launcher.admit_capture(selected, initial if case == 'stale-report' else fresh, next_stage, stop)
            if case == 'restart':
                assert observed == expected and len(launcher.fills) == 2
                assert launcher.active.child is not first.child and launcher.active.child.poll() is None
                assert launcher.active.generation is generation
                assert launcher.peers_live(generation)
                for name in MEMBERS:
                    assert not os.path.samefile(first_stage / name, next_stage / name)
                assert launcher.admit_capture(selected, fresh, directory / 'stage-replayed', stop) is None
                assert len(launcher.fills) == 2 and not (directory / 'stage-replayed').exists()
            else:
                assert observed is None and launcher.fills == [first] and not next_stage.exists()
                if case in ('missing-stop', 'borrowed-stop'):
                    assert first.child.poll() is None
                if case == 'unreadable-after-stop':
                    assert lock.is_dir() and not list(lock.iterdir())
        assert snapshot((selected, source)) == before
    finally:
        launcher.cleanup()


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
    scratch = Path(tempfile.mkdtemp(prefix='strict-capture-admission-')).resolve()
    cases = ('restart', 'wrong-enrollment', 'missing-capture', 'corrupt-capture',
             'missing-stop', 'borrowed-stop', 'stale-report', 'unreadable-after-stop', 'recovery-result')
    try:
        for case in cases:
            exercise_case(node, scratch, case)
    except BaseException:
        print('Fixture failed. Retained scratch at ' + str(scratch), file=sys.stderr)
        raise
    shutil.rmtree(scratch)
    print(json.dumps({'ok': True, 'strictState': 'unverified', 'cases': cases, 'durableBytesUnchanged': True}))


if __name__ == '__main__':
    main()
