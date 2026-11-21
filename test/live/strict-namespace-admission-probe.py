#!/usr/bin/env python3
"""Opt-in Linux test of capture admission with owned namespace teardown."""
import argparse
from dataclasses import dataclass
from hashlib import sha256
from http.client import HTTPConnection, HTTPException
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
request_stop = runpy.run_path(str(HERE / 'strict-graceful-stop-probe.py'))['request_stop']
CaptureLauncher = capture['CaptureLauncher']
handoff = runpy.run_path(str(HERE.parent.parent / 'lib' / 'strict-supervisor-handoff.py'))
StopHandoff, StopUnproven = handoff['StopHandoff'], handoff['StopUnproven']
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


@dataclass(frozen=True)
class Listener:
    process: object
    port: int
    generation: object
    capture_versions: tuple

    def alive(self):
        return self.process.poll() is None

    def responds(self):
        if not self.alive():
            return False
        connection = HTTPConnection('127.0.0.1', self.port, timeout=0.5)
        try:
            connection.request('GET', '/api/state', headers={'Sec-Fetch-Site': 'same-origin'})
            response = connection.getresponse()
            return (response.status == 403 and response.read(64) == b'{"error":"tab-binding"}'
                    and self.alive())
        except (OSError, HTTPException):
            return False
        finally:
            connection.close()


class NamespaceLauncher(CaptureLauncher):
    def __init__(self, node, scratch, check_runtime, stop_mode=None, *, listener_required=False):
        super().__init__(node, scratch)
        self.run = lifecycle['Run'](scratch)
        self.check_runtime = check_runtime
        self.stop_mode = stop_mode
        self.listener_required = listener_required
        self.listener = None
        self.supervisor = StopHandoff(lifecycle['stop_namespace'], self.prove_stopped, lifecycle['STOP_BOUND'])

    def stage(self, enrollment, directory=None, *, approved=False):
        if self.listener is not None:
            stop_listener(self)
            self.listener = None
        return super().stage(enrollment, directory, approved=approved)

    def stage_listener(self, enrollment, *, binding=None, role='decision-listener'):
        if self.current is None or self.current.enrollment is not enrollment:
            raise RuntimeError('listener requires the current enrollment')
        if self.listener is not None:
            raise RuntimeError('listener already staged')
        selected = enrollment.expected if binding is None else binding
        versions = selected['reviewVersion'], selected['captureVersion']
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, 'rb', buffering=0) as report:
            try:
                process = self.spawn([self.node, capture['WORKER'], role,
                                      enrollment.directory / 'captures', enrollment.identity, str(write_fd),
                                      *versions], (write_fd,))
            finally:
                os.close(write_fd)
            try:
                ready = capture['read_json'](report)
            except (OSError, RuntimeError, ValueError):
                return
        if set(ready) == {'port'} and type(ready['port']) is int and 1 <= ready['port'] <= 65535:
            self.listener = Listener(process, ready['port'], self.current, versions)

    def listener_ready(self, generation, *, check_response=True):
        if not self.listener_required:
            return True
        listener = self.listener
        if listener is None or generation is None or listener.generation is not generation:
            return False
        expected = generation.enrollment.expected
        if listener.capture_versions != (expected['reviewVersion'], expected['captureVersion']):
            return False
        return listener.responds() if check_response else listener.alive()

    def admit_capture(self, selected, report, stage, stop=None):
        if self.listener_required and (self.current is None or self.current.enrollment is not selected):
            return None
        if not self.listener_ready(self.current):
            return None
        return super().admit_capture(selected, report, stage, stop)

    @staticmethod
    def prove_stopped(namespace, deadline):
        lifecycle['prove_stopped'](namespace, deadline, extra=[('wrapper', namespace['outerFd'])])
        return True

    def start_owned_namespace(self, generation, label, *, stage=None):
        if self.check_runtime is not None:
            self.check_runtime()
        if not self.peers_live(generation) or not self.listener_ready(generation):
            return None
        namespace = lifecycle['start_namespace'](self.run, label, stage=stage,
                                                 stop_mode=self.stop_mode if stage is not None else None)
        self.supervisor.own(namespace, namespace['process'])
        return namespace

    def start_fill(self, generation, stage):
        namespace = self.start_owned_namespace(generation, stage.name, stage=stage)
        if namespace is None:
            return None
        lifecycle['alive_at_fault'](namespace)
        if not self.peers_live(generation) or not self.listener_ready(generation, check_response=False):
            self.supervisor.stop(namespace)
            return None
        self.active = NamespaceFill(generation, namespace['process'], namespace)
        self.fills.append(self.active)
        return namespace['digests']

    def restart_proved(self, previous, report, stop):
        return self.supervisor.consume_restart(previous.namespace, stop, report.requested_at)

    def stop_planned(self, namespace, *, expire_before_proof=False):
        observation = None

        def request(owned, started, deadline):
            nonlocal observation
            observation = request_stop(lifecycle, owned, started, deadline)
            if expire_before_proof:
                time.sleep(max(0, deadline - time.monotonic()))

        receipt = self.supervisor.stop_planned(namespace, request)
        return receipt, observation

    def cleanup(self):
        if self.admission is not None:
            self.admission.invalidate()
        try:
            if not lifecycle['cleanup_run'](self.run):
                raise RuntimeError('namespace cleanup unproven')
        finally:
            capture['Launcher'].cleanup(self)


ENROLLMENT_REFUSALS = ('wrong-enrollment', 'stale-generation', 'lost-authority', 'lost-console')
PLANNED_STOPS = {'graceful-restart': 'cooperative', 'forced-restart': 'stubborn',
                 'planned-proof-too-late': 'cooperative'}
LISTENER_REFUSALS = ('listener-store-mismatch', 'listener-invalid-readiness', 'listener-exited-before-start',
                     'stale-listener-generation')
STARTUP_FAULTS = ('peer-loss-during-start', 'listener-loss-before-namespace', 'listener-loss-after-namespace')


class StartupFaultLauncher(NamespaceLauncher):
    def __init__(self, *args, fault, **kwargs):
        super().__init__(*args, **kwargs)
        self.fault = fault

    def start_owned_namespace(self, generation, label, *, stage=None):
        if self.fault == 'listener-loss-before-namespace':
            stop_listener(self)
        namespace = super().start_owned_namespace(generation, label, stage=stage)
        if namespace is not None:
            if self.fault == 'peer-loss-during-start':
                generation.console.kill()
                generation.console.wait(capture['TIMEOUT'])
            elif self.fault == 'listener-loss-after-namespace':
                stop_listener(self)
        return namespace


def refuse_enrollment(launcher, selected, first_stage, case):
    source = selected
    if case == 'wrong-enrollment':
        source = launcher.prepare_approved(case + '-other', 'other')
        assert source.expected == selected.expected
    before = capture['snapshot']((selected, source))
    generation = launcher.stage(selected, source.directory, approved=True)
    report = generation.report()
    if case == 'wrong-enrollment':
        assert generation.authority.wait(capture['TIMEOUT']) == 23
        assert report.state == capture['UNAVAILABLE']
    else:
        assert report.state == selected.expected and launcher.peers_live(generation)
        if case == 'stale-generation':
            generation.close_reports()
            for peer in (generation.console, generation.authority):
                peer.kill()
                peer.wait(capture['TIMEOUT'])
            current = launcher.stage(selected, approved=True)
            assert current.report().state == selected.expected and launcher.peers_live(current)
        else:
            peer, survivor = generation.console, generation.authority
            if case == 'lost-authority':
                peer, survivor = survivor, peer
            peer.kill()
            peer.wait(capture['TIMEOUT'])
            assert survivor.poll() is None
    owned_children = len(launcher.children)
    # Exercise the enrollment gate directly so a missing listener cannot mask a regression.
    assert CaptureLauncher.admit_capture(launcher, selected, report, first_stage) is None
    assert len(launcher.children) == owned_children
    assert not launcher.run.namespaces and not launcher.fills and not first_stage.exists()
    assert capture['snapshot']((selected, source)) == before


def exercise(node, scratch, case, check_runtime=None, *, protected=False):
    if check_runtime is not None:
        check_runtime()
    stop_mode = PLANNED_STOPS.get(case)
    if case in STARTUP_FAULTS:
        launcher = StartupFaultLauncher(node, scratch, check_runtime, stop_mode,
                                        fault=case, listener_required=protected)
    else:
        launcher = NamespaceLauncher(node, scratch, check_runtime, stop_mode, listener_required=protected)
    try:
        selected = launcher.prepare_approved(case, 'selected')
        directory = selected.directory.parent
        first_stage = directory / 'stage-first'
        if case in ENROLLMENT_REFUSALS:
            refuse_enrollment(launcher, selected, first_stage, case)
            return
        candidate = directory / 'candidate'
        expected = {name: sha256((candidate / name).read_bytes()).hexdigest()
                    for name in capture['MEMBERS']}
        (candidate / 'plan.js').write_bytes(b'changed live workspace\n')
        before = capture['snapshot']((selected,))
        generation = launcher.stage(selected, approved=True)
        initial = generation.report()
        assert initial.state == selected.expected
        if protected:
            binding = None
            if case == 'listener-store-mismatch':
                binding = {**selected.expected, 'reviewVersion': '0' * 64}
            role = 'invalid-listener-ready' if case == 'listener-invalid-readiness' else 'decision-listener'
            launcher.stage_listener(selected, binding=binding, role=role)
            if case == 'listener-store-mismatch':
                assert launcher.children[-1].wait(capture['TIMEOUT']) != 0
                assert launcher.listener is None
            elif case == 'listener-invalid-readiness':
                assert launcher.children[-1].wait(capture['TIMEOUT']) == 0
                assert launcher.listener is None
            else:
                assert launcher.listener_ready(generation)
        if case == 'listener-exited-before-start':
            stop_listener(launcher)
        if case == 'stale-listener-generation':
            stale_listener = launcher.listener
            # Bypass normal disposal to test binding even while the old listener still answers.
            generation = CaptureLauncher.stage(launcher, selected, approved=True)
            initial = generation.report()
            assert initial.state == selected.expected and launcher.peers_live(generation)
            assert stale_listener.responds()
        if case in LISTENER_REFUSALS:
            children = len(launcher.children)
            assert launcher.admit_capture(selected, initial, first_stage) is None
            assert len(launcher.children) == children and not launcher.run.namespaces and not first_stage.exists()
            if case == 'stale-listener-generation':
                launcher.stage(selected, approved=True)
                assert launcher.listener is None and stale_listener.process.poll() is not None
            assert capture['snapshot']((selected,)) == before
            return
        admitted = launcher.admit_capture(selected, initial, first_stage)
        if case in STARTUP_FAULTS:
            assert admitted is None and not launcher.fills and launcher.active is None
            assert generation.authority.poll() is None and first_stage.is_dir()
            if case == 'listener-loss-before-namespace':
                assert not launcher.run.namespaces
            else:
                owned, = launcher.run.namespaces
                assert owned['process'].poll() is not None
                assert launcher.prove_stopped(owned, time.monotonic() + lifecycle['STOP_BOUND'])
            assert capture['snapshot']((selected,)) == before
            return
        assert admitted == expected
        first = launcher.active
        namespace = first.namespace
        fresh = None

        if case == 'planned-proof-too-late':
            try:
                launcher.stop_planned(namespace, expire_before_proof=True)
            except StopUnproven as error:
                assert str(error) == 'stop-deadline-unavailable'
            else:
                raise AssertionError('late planned stop minted a restart receipt')
            stop = None
        elif stop_mode is not None:
            stop, observation = launcher.stop_planned(namespace)
            if stop_mode == 'cooperative':
                assert observation['stopPath'] == 'graceful' and observation['workerAcknowledgedTerm']
            else:
                assert observation['stopPath'] == 'forced' and observation['workerAliveAtGraceEnd']
            (first_stage / 'plan.js').write_bytes(b'changed previous stage\n')
        elif case == 'partial-stop':
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
        if case == 'listener-exited-before-restart':
            stop_listener(launcher)
        next_stage = directory / 'stage-restart'
        if case in ('restart', 'graceful-restart', 'forced-restart'):
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


def stop_listener(launcher):
    listener = launcher.listener.process
    listener.kill()
    listener.wait(capture['TIMEOUT'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--bwrap-sha256', required=True)
    parser.add_argument('--runtime-receipt', type=Path,
                        help='require the preselected canonical fixture receipt before admission')
    parser.add_argument('--protected-launcher', action='store_true',
                        help='require a runtime receipt and also exercise enrollment and peer refusals')
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
        if args.protected_launcher and args.runtime_receipt is None:
            raise RuntimeRefused('runtime-selection-required')
        selection = read_runtime_selection(args.runtime_receipt) if args.runtime_receipt is not None else None
    except RuntimeRefused as exc:
        print(json.dumps({'ok': False, 'strictState': 'unverified', 'code': str(exc)}))
        raise SystemExit(2)
    scratch = Path(tempfile.mkdtemp(prefix='strict-namespace-admission-')).resolve()
    check_runtime = runtime_check(selection, node, scratch) if args.runtime_receipt is not None else None
    cases = ('restart', 'partial-stop', 'borrowed-namespace-stop', 'report-before-stop')
    if args.protected_launcher:
        cases += ENROLLMENT_REFUSALS + STARTUP_FAULTS + tuple(PLANNED_STOPS)
        cases += LISTENER_REFUSALS + ('listener-exited-before-restart',)
    try:
        for case in cases:
            exercise(node, scratch, case, check_runtime, protected=args.protected_launcher)
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
