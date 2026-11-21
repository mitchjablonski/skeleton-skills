#!/usr/bin/env python3
"""Opt-in Linux test of capture admission with owned namespace teardown."""
import argparse
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
capture = runpy.run_path(str(HERE / 'strict-capture-admission-probe.py'))
lifecycle = runpy.run_path(str(HERE / 'strict-lifecycle-fault-probe.py'))
CaptureLauncher = capture['CaptureLauncher']


@dataclass(eq=False)
class NamespaceFill:
    generation: object
    child: object
    namespace: dict


@dataclass(eq=False, frozen=True)
class NamespaceStop:
    proved_at: int


class NamespaceLauncher(CaptureLauncher):
    def __init__(self, node, scratch):
        super().__init__(node, scratch)
        self.run = lifecycle['Run'](scratch)

    def start_fill(self, generation, stage):
        namespace = lifecycle['start_namespace'](self.run, stage.name, stage=stage)
        lifecycle['alive_at_fault'](namespace)
        self.active = NamespaceFill(generation, namespace['process'], namespace)
        self.fills.append(self.active)
        return namespace['digests']

    def prove_namespace_exit(self, namespace, deadline):
        process = namespace['process']
        assert any(item is namespace for item in self.run.namespaces) and process not in self.stopped
        lifecycle['prove_stopped'](namespace, deadline, extra=[('wrapper', namespace['outerFd'])])
        process.wait(timeout=max(0, deadline - time.monotonic()))
        if time.monotonic() > deadline:
            raise lifecycle['Unproven']({'late': True})
        receipt = NamespaceStop(time.monotonic_ns())
        self.stopped[process] = receipt
        return receipt

    def stop(self, namespace):
        assert any(item is namespace for item in self.run.namespaces)
        deadline = time.monotonic() + lifecycle['STOP_BOUND']
        lifecycle['stop_namespace'](namespace)
        return self.prove_namespace_exit(namespace, deadline)

    def admit_capture(self, selected, report, stage, stop=None):
        if self.active is not None and (
                not isinstance(stop, NamespaceStop) or report.requested_at is None
                or report.requested_at <= stop.proved_at):
            return None
        return super().admit_capture(selected, report, stage, stop)

    def cleanup(self):
        try:
            if not lifecycle['cleanup_run'](self.run):
                raise RuntimeError('namespace cleanup unproven')
        finally:
            capture['Launcher'].cleanup(self)


def exercise(node, scratch, case):
    launcher = NamespaceLauncher(node, scratch)
    try:
        selected = launcher.prepare_approved(case, 'selected')
        directory = selected.directory.parent
        candidate = directory / 'candidate'
        expected = {name: sha256((candidate / name).read_bytes()).hexdigest()
                    for name in capture['MEMBERS']}
        (candidate / 'plan.js').write_bytes(b'changed live workspace\n')
        before = capture['snapshot']((selected,))
        generation = launcher.stage(selected, approved=True)
        initial = generation.report()
        assert initial.state == selected.expected
        first_stage = directory / 'stage-first'
        assert launcher.admit_capture(selected, initial, first_stage) == expected
        first = launcher.active
        namespace = first.namespace
        fresh = None

        if case == 'partial-stop':
            lifecycle['selective_child_stop'](namespace)
            assert lifecycle['exited'](namespace['members']['child']['fd'], 0.5)
            try:
                launcher.prove_namespace_exit(namespace, time.monotonic() + 0.1)
            except lifecycle['Unproven'] as error:
                assert {'init', 'worker', 'escapee'}.issubset(error.args[0]['alive'])
                assert error.args[0]['remaining'] >= 3
            else:
                raise AssertionError('partial stop minted a restart receipt')
            assert first.child not in launcher.stopped
            stop = None
        else:
            if case == 'report-before-stop':
                fresh = generation.fresh_report()
                assert first.child.poll() is None
            stop = launcher.stop(namespace)
            (first_stage / 'plan.js').write_bytes(b'changed previous stage\n')
            if case == 'borrowed-namespace-stop':
                unrelated = lifecycle['start_namespace'](launcher.run, 'unrelated')
                stop = launcher.stop(unrelated)

        if fresh is None:
            fresh = generation.fresh_report()
        assert fresh.state == selected.expected and launcher.peers_live(generation)
        next_stage = directory / 'stage-restart'
        if case == 'restart':
            assert launcher.admit_capture(selected, fresh, next_stage, stop) == expected
            second = launcher.active
            assert len(launcher.fills) == 2 and second.generation is generation
            assert second.child is not first.child and second.namespace['pidNs'] != namespace['pidNs']
            assert launcher.peers_live(generation)
            for name in capture['MEMBERS']:
                assert not os.path.samefile(first_stage / name, next_stage / name)
            launcher.stop(second.namespace)
        else:
            count = len(launcher.run.namespaces)
            assert launcher.admit_capture(selected, fresh, next_stage, stop) is None
            assert launcher.fills == [first] and len(launcher.run.namespaces) == count
            assert not next_stage.exists()
            if case == 'partial-stop':
                assert not lifecycle['exited'](namespace['members']['escapee']['fd'])
                launcher.stop(namespace)
        assert capture['snapshot']((selected,)) == before
    finally:
        launcher.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--bwrap-sha256', required=True)
    args = parser.parse_args()
    if (sys.platform != 'linux' or sys.flags.optimize
            or Path(sys.executable).resolve() != Path('/usr/bin/python3').resolve()
            or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal')):
        parser.error('requires system Linux Python, pidfd support and assertions enabled')
    pin = runpy.run_path(str(HERE / 'strict-client-probe.py'))['validate_pin']
    node, _, node_error = pin(args.node, args.node_sha256, 'node')
    _, _, bwrap_error = pin('/usr/bin/bwrap', args.bwrap_sha256, 'bwrap')
    if node_error or bwrap_error:
        parser.error('fixture executable pin refused')
    scratch = Path(tempfile.mkdtemp(prefix='strict-namespace-admission-')).resolve()
    cases = ('restart', 'partial-stop', 'borrowed-namespace-stop', 'report-before-stop')
    try:
        for case in cases:
            exercise(node, scratch, case)
    except BaseException:
        print('Fixture failed. Retained scratch at ' + str(scratch), file=sys.stderr)
        raise
    shutil.rmtree(scratch)
    print(json.dumps({'ok': True, 'strictState': 'unverified', 'cases': cases, 'durableBytesUnchanged': True}))


if __name__ == '__main__':
    main()
