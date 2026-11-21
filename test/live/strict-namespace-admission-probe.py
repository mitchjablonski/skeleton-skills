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
import stat
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
capture = runpy.run_path(str(HERE / 'strict-capture-admission-probe.py'))
lifecycle = runpy.run_path(str(HERE / 'strict-lifecycle-fault-probe.py'))
CaptureLauncher = capture['CaptureLauncher']
StopHandoff = runpy.run_path(str(HERE.parent.parent / 'lib' / 'strict-supervisor-handoff.py'))['StopHandoff']
MAX_RECEIPT_BYTES = 512 * 1024


class RuntimeRefused(Exception):
    pass


def read_runtime_selection(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise RuntimeRefused('runtime-selection-invalid')
            data = source.read(MAX_RECEIPT_BYTES + 1)
        if len(data) > MAX_RECEIPT_BYTES:
            raise RuntimeRefused('runtime-selection-invalid')
        return json.loads(data.decode('utf-8'))
    except (OSError, ValueError, RecursionError) as exc:
        raise RuntimeRefused('runtime-selection-invalid') from exc


def runtime_check(selection, node, scratch):
    observer = runpy.run_path(str(HERE / 'strict-runtime-receipt.py'))['observe_pinned_runtime']
    select = runpy.run_path(str(HERE / 'strict-runtime-selection.py'))['select_runtime']

    def check():
        def observe(pins):
            return observer(node, node, scratch, pins, client_role='node-channel-control',
                            client_entrypoint=capture['WORKER'])

        result = select(selection, observe)
        if result['kind'] != 'runtime-selected':
            raise RuntimeRefused(result['code'])

    return check


@dataclass(eq=False)
class NamespaceFill:
    generation: object
    child: object
    namespace: dict


class NamespaceLauncher(CaptureLauncher):
    def __init__(self, node, scratch, check_runtime):
        super().__init__(node, scratch)
        self.run = lifecycle['Run'](scratch)
        self.check_runtime = check_runtime
        self.supervisor = StopHandoff(lifecycle['stop_namespace'], self.prove_stopped, lifecycle['STOP_BOUND'])

    @staticmethod
    def prove_stopped(namespace, deadline):
        lifecycle['prove_stopped'](namespace, deadline, extra=[('wrapper', namespace['outerFd'])])
        return True

    def start_owned_namespace(self, generation, label, *, stage=None):
        if self.check_runtime is not None:
            self.check_runtime()
            if not self.peers_live(generation):
                return None
        namespace = lifecycle['start_namespace'](self.run, label, stage=stage)
        self.supervisor.own(namespace, namespace['process'])
        return namespace

    def start_fill(self, generation, stage):
        namespace = self.start_owned_namespace(generation, stage.name, stage=stage)
        if namespace is None:
            return None
        lifecycle['alive_at_fault'](namespace)
        self.active = NamespaceFill(generation, namespace['process'], namespace)
        self.fills.append(self.active)
        return namespace['digests']

    def restart_proved(self, previous, report, stop):
        return self.supervisor.consume_restart(previous.namespace, stop, report.requested_at)

    def cleanup(self):
        if self.admission is not None:
            self.admission.invalidate()
        try:
            if not lifecycle['cleanup_run'](self.run):
                raise RuntimeError('namespace cleanup unproven')
        finally:
            capture['Launcher'].cleanup(self)


def exercise(node, scratch, case, check_runtime=None):
    if check_runtime is not None:
        check_runtime()
    launcher = NamespaceLauncher(node, scratch, check_runtime)
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
                launcher.supervisor.confirm(namespace, time.monotonic() + 0.1)
            except lifecycle['Unproven'] as error:
                assert {'init', 'worker', 'escapee'}.issubset(error.args[0]['alive'])
                assert error.args[0]['remaining'] >= 3
            else:
                raise AssertionError('partial stop minted a restart receipt')
            stop = None
        else:
            if case == 'report-before-stop':
                fresh = generation.fresh_report()
                assert first.child.poll() is None
            stop = launcher.supervisor.stop(namespace)
            (first_stage / 'plan.js').write_bytes(b'changed previous stage\n')
            if case == 'borrowed-namespace-stop':
                unrelated = launcher.start_owned_namespace(generation, 'unrelated')
                assert unrelated is not None
                stop = launcher.supervisor.stop(unrelated)

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
            launcher.supervisor.stop(second.namespace)
        else:
            count = len(launcher.run.namespaces)
            assert launcher.admit_capture(selected, fresh, next_stage, stop) is None
            assert launcher.fills == [first] and len(launcher.run.namespaces) == count
            assert not next_stage.exists()
            if case == 'partial-stop':
                assert not lifecycle['exited'](namespace['members']['escapee']['fd'])
        assert capture['snapshot']((selected,)) == before
    finally:
        launcher.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--bwrap-sha256', required=True)
    parser.add_argument('--runtime-receipt', type=Path,
                        help='require the preselected canonical fixture receipt before admission')
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
    try:
        selection = read_runtime_selection(args.runtime_receipt) if args.runtime_receipt is not None else None
    except RuntimeRefused as exc:
        print(json.dumps({'ok': False, 'strictState': 'unverified', 'code': str(exc)}))
        raise SystemExit(2)
    scratch = Path(tempfile.mkdtemp(prefix='strict-namespace-admission-')).resolve()
    check_runtime = runtime_check(selection, node, scratch) if args.runtime_receipt is not None else None
    cases = ('restart', 'partial-stop', 'borrowed-namespace-stop', 'report-before-stop')
    try:
        for case in cases:
            exercise(node, scratch, case, check_runtime)
    except RuntimeRefused as exc:
        code = str(exc)
        if code == 'runtime-observation-cleanup-unproven':
            print('Runtime cleanup unproven. Retained scratch at ' + str(scratch), file=sys.stderr)
        else:
            shutil.rmtree(scratch)
        print(json.dumps({'ok': False, 'strictState': 'unverified', 'code': code}))
        raise SystemExit(2)
    except BaseException:
        print('Fixture failed. Retained scratch at ' + str(scratch), file=sys.stderr)
        raise
    shutil.rmtree(scratch)
    print(json.dumps({'ok': True, 'strictState': 'unverified', 'cases': cases, 'durableBytesUnchanged': True,
                      'runtimeReceiptChecked': check_runtime is not None}))


if __name__ == '__main__':
    main()
