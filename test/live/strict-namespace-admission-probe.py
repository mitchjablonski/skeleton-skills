#!/usr/bin/env python3
"""Opt-in Linux test of capture admission with owned namespace teardown."""
import argparse
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from hashlib import sha256
from http.client import HTTPConnection, HTTPException
import json
from math import ceil
import os
from pathlib import Path
import runpy
import select
import shutil
import signal
import stat
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
capture = runpy.run_path(str(HERE / 'strict-capture-admission-probe.py'))
terminal_host = runpy.run_path(str(HERE / 'strict-terminal-host-probe.py'))
lifecycle = runpy.run_path(str(HERE / 'strict-lifecycle-fault-probe.py'))
request_stop = runpy.run_path(str(HERE / 'strict-graceful-stop-probe.py'))['request_stop']
CaptureLauncher = capture['CaptureLauncher']
handoff = runpy.run_path(str(HERE.parent.parent / 'lib' / 'strict-supervisor-handoff.py'))
StopHandoff, StopUnproven = handoff['StopHandoff'], handoff['StopUnproven']
MAX_RECEIPT_BYTES = 512 * 1024
LISTENER_SCOPE = HERE / 'strict-owned-listener-scope.py'
LISTENER_SCOPE_TIMEOUT = 12  # Allow the scope's bounded descendant reaping to finish.


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


def runtime_check(selection, node, scratch, *, terminal_pin=None):
    receipt = runpy.run_path(str(HERE / 'strict-runtime-receipt.py'))
    select = runpy.run_path(str(HERE / 'strict-runtime-selection.py'))['select_runtime']

    def check():
        if terminal_pin is not None:
            try:
                digest = receipt['_digest'](terminal_host['HOST_WORKER'])
            except receipt['ReceiptCleanupFailed'] as exc:
                raise RuntimeRefused('runtime-observation-cleanup-unproven') from exc
            except receipt['ReceiptUnavailable'] as exc:
                raise RuntimeRefused('terminal-entrypoint-unavailable') from exc
            if digest != terminal_pin:
                raise RuntimeRefused('terminal-entrypoint-mismatch')

        def observe(pins):
            return receipt['observe_pinned_runtime'](node, node, scratch, pins, client_role='node-channel-control',
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
class PeerWatch:
    fill: NamespaceFill
    poller: object
    roles: dict
    exited: tuple


@dataclass(frozen=True)
class ListenerScope:
    process: object
    lifeline: object

    def stop(self):
        self.lifeline.close()
        status = self.process.wait(LISTENER_SCOPE_TIMEOUT)
        if status < 0 or status == 125:
            raise RuntimeError('listener scope cleanup unproven')


@dataclass(frozen=True)
class Listener:
    scope: ListenerScope
    port: int
    generation: object
    capture_versions: tuple

    @property
    def process(self):
        return self.scope.process

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
    def __init__(self, node, scratch, check_runtime, stop_mode=None, *, protected=False, terminal_mode='restart'):
        super().__init__(node, scratch)
        self.run = lifecycle['Run'](scratch)
        self.check_runtime = check_runtime
        self.stop_mode = stop_mode
        self.protected = protected
        self.terminal_mode = terminal_mode
        self.terminal = None
        self.listener = None
        self.listener_scopes = []
        self.peer_fault = False
        self.peer_watch = None
        self.supervisor = StopHandoff(lifecycle['stop_namespace'], self.prove_stopped, lifecycle['STOP_BOUND'])

    def stage(self, enrollment, directory=None, *, approved=False):
        if self.peer_fault:
            raise RuntimeError('peer fault is latched')
        if self.listener is not None:
            stop_listener(self)
            self.listener = None
        if self.terminal is not None:
            self.terminal.close()
            self.terminal = None
        if self.protected:
            self.terminal = terminal_host['FixtureTerminal']()
        return super().stage(enrollment, directory, approved=approved)

    def spawn(self, command, fds=()):
        if self.protected and command[1:3] == [capture['WORKER'], 'restart-console']:
            terminal = self.terminal
            if terminal is None or terminal.closed or terminal.process is not None:
                raise RuntimeError('console requires a fresh owned terminal')
            terminal.process = terminal_host['spawn_terminal_console'](
                self, command, fds, terminal.slave, self.terminal_mode)
            return terminal.process
        return super().spawn(command, fds)

    def peers_live(self, generation):
        return not self.peer_fault and super().peers_live(generation) and (
            not self.protected or (self.terminal is not None and self.terminal.owns(generation)))

    def refresh(self, generation):
        if not self.peers_live(generation):
            self.admission.invalidate()
            return None
        try:
            return generation.fresh_report()
        except (OSError, RuntimeError, ValueError, RecursionError):
            self.admission.invalidate()
            return None

    def stage_listener(self, enrollment, *, binding=None, role='decision-listener'):
        if self.current is None or self.current.enrollment is not enrollment:
            raise RuntimeError('listener requires the current enrollment')
        if self.listener is not None:
            raise RuntimeError('listener already staged')
        selected = enrollment.expected if binding is None else binding
        versions = selected['reviewVersion'], selected['captureVersion']
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, 'rb', buffering=0) as report, ExitStack() as lifeline_owner:
            with os.fdopen(write_fd, 'wb', buffering=0):
                stop_read, stop_write = os.pipe()
                lifeline = lifeline_owner.enter_context(os.fdopen(stop_write, 'wb', buffering=0))
                with os.fdopen(stop_read, 'rb', buffering=0):
                    process = self.spawn([sys.executable, '-I', LISTENER_SCOPE, str(stop_read), str(write_fd),
                                          self.node, capture['WORKER'], role, enrollment.directory / 'captures',
                                          enrollment.identity, str(write_fd), *versions], (stop_read, write_fd))
                scope = ListenerScope(process, lifeline)
                self.listener_scopes.append(scope)
                lifeline_owner.pop_all()
            try:
                ready = capture['read_json'](report)
            except (OSError, RuntimeError, ValueError):
                return
        if set(ready) == {'port'} and type(ready['port']) is int and 1 <= ready['port'] <= 65535:
            self.listener = Listener(scope, ready['port'], self.current, versions)

    def listener_ready(self, generation):
        if not self.protected:
            return True
        listener = self.listener
        if listener is None or generation is None or listener.generation is not generation:
            return False
        expected = generation.enrollment.expected
        if listener.capture_versions != (expected['reviewVersion'], expected['captureVersion']):
            return False
        return listener.responds()

    def admit_capture(self, selected, report, stage, stop=None):
        if self.peer_fault or report is None:
            return None
        if self.protected and (self.current is None or self.current.enrollment is not selected):
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
        if not self.peers_live(generation) or not self.listener_ready(generation):
            self.supervisor.stop_fault(namespace, time.monotonic() + lifecycle['STOP_BOUND'])
            return None
        self.active = NamespaceFill(generation, namespace['process'], namespace)
        self.fills.append(self.active)
        return namespace['digests']

    @contextmanager
    def watch_active(self, fill):
        if (self.peer_watch is not None or self.peer_fault or fill is None or fill is not self.active
                or fill.generation is not self.current):
            raise RuntimeError('peer watch requires the current fill')
        with ExitStack() as fds:
            poller = select.poll()
            roles = {}
            exited = []
            try:
                for role in ('authority', 'console'):
                    child = getattr(fill.generation, role)
                    if child.returncode is not None:
                        exited.append(role)
                        continue
                    # This single-threaded launcher has not reaped the Popen child.
                    fd = os.pidfd_open(child.pid)
                    fds.callback(os.close, fd)
                    roles[fd] = role
                    poller.register(fd, select.POLLIN)
            except OSError:
                self._stop_active_fault(fill, time.monotonic() + lifecycle['STOP_BOUND'])
                raise
            watch = PeerWatch(fill, poller, roles, tuple(exited))
            self.peer_watch = watch
            try:
                yield watch
            finally:
                self.peer_watch = None

    def stop_on_peer_exit(self, watch, deadline):
        fill = watch.fill
        if watch is not self.peer_watch or fill is not self.active or fill.generation is not self.current:
            raise RuntimeError('peer watch no longer owns the fill')
        timeout = 0 if watch.exited else ceil(max(0, deadline - time.monotonic()) * 1000)
        events = watch.poller.poll(timeout)
        if not events and not watch.exited:
            return ()
        self._stop_active_fault(fill, deadline)
        if any(not (flags & select.POLLIN) for _, flags in events):
            raise RuntimeError('peer exit observation unavailable')
        return watch.exited + tuple(watch.roles[fd] for fd, _ in events)

    def _stop_active_fault(self, fill, deadline):
        self.peer_fault = True
        self.admission.invalidate()
        self.supervisor.stop_fault(fill.namespace, deadline)
        self.active = None

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
            try:
                with ExitStack() as cleanup:
                    cleanup.callback(capture['Launcher'].cleanup, self)
                    for scope in self.listener_scopes:
                        # The generic launcher hard-kills children. Give each scope its
                        # own stop and reaping path, including on readiness failure.
                        self.children.remove(scope.process)
                        cleanup.callback(scope.stop)
            finally:
                if self.terminal is not None:
                    self.terminal.close()


ENROLLMENT_REFUSALS = ('wrong-enrollment', 'stale-generation', 'lost-authority', 'lost-console')
PLANNED_STOPS = {'graceful-restart': 'cooperative', 'forced-restart': 'stubborn',
                 'planned-proof-too-late': 'cooperative'}
LISTENER_REFUSALS = ('listener-store-mismatch', 'listener-missing-selected-view', 'listener-crashed-with-detached-child',
                     'listener-invalid-readiness', 'listener-exited-before-start',
                     'stale-listener-generation')
STARTUP_FAULTS = ('peer-loss-during-start', 'listener-loss-before-namespace', 'listener-loss-after-namespace')
REFRESH_FAILURES = {'terminal-refresh-lost': 'refresh-lost', 'terminal-refresh-malformed': 'refresh-malformed',
                    'terminal-hangup-before-refresh': 'restart'}
ACTIVE_FAULTS = {'active-terminal-hangup': 'console', 'active-authority-loss': 'authority',
                 'active-authority-already-reaped': 'authority'}


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


def exercise_active_peer(launcher, fill, case, selected, before):
    generation = fill.generation
    with launcher.watch_active(fill) as watch:
        try:
            launcher.stop_on_peer_exit(PeerWatch(fill, watch.poller, watch.roles, watch.exited), time.monotonic())
        except RuntimeError as exc:
            assert str(exc) == 'peer watch no longer owns the fill'
        else:
            raise AssertionError('the launcher accepted an unregistered watcher')
        assert launcher.stop_on_peer_exit(watch, time.monotonic() + 0.05) == ()
        assert launcher.active is fill
        lifecycle['alive_at_fault'](fill.namespace)
        if case == 'restart':
            return

        stale = launcher.refresh(generation)
        assert stale.state == selected.expected
        lifecycle['alive_at_fault'](fill.namespace)
        deadline = time.monotonic() + lifecycle['STOP_BOUND']
        peer = ACTIVE_FAULTS[case]
        if peer == 'console':
            launcher.terminal.close()
        else:
            generation.authority.kill()
        if case != 'active-authority-already-reaped':
            assert launcher.stop_on_peer_exit(watch, deadline) == (peer,)
    if case == 'active-authority-already-reaped':
        generation.authority.wait(max(0, deadline - time.monotonic()))
        with launcher.watch_active(fill) as watch:
            assert watch.exited == ('authority',)
            assert launcher.stop_on_peer_exit(watch, deadline) == ('authority',)
    assert launcher.peer_fault and launcher.active is None and fill.child.poll() is not None
    assert launcher.prove_stopped(fill.namespace, deadline)
    survivor = generation.authority if peer == 'console' else generation.console
    assert survivor.poll() is None and launcher.listener_ready(generation)
    children = len(launcher.children)
    replacement = selected.directory.parent / 'stage-restart'
    assert launcher.admit_capture(selected, stale, replacement) is None
    try:
        launcher.stage(selected, approved=True)
    except RuntimeError as exc:
        assert str(exc) == 'peer fault is latched'
    else:
        raise AssertionError('the stopped run prepared a new generation')
    assert len(launcher.children) == children and not replacement.exists()
    assert launcher.fills == [fill] and launcher.run.namespaces == [fill.namespace]
    assert capture['snapshot']((selected,)) == before


def exercise(node, scratch, case, check_runtime=None, *, protected=False):
    if check_runtime is not None:
        check_runtime()
    stop_mode = PLANNED_STOPS.get(case)
    options = {'protected': protected, 'terminal_mode': REFRESH_FAILURES.get(case, 'restart')}
    if case in STARTUP_FAULTS:
        launcher = StartupFaultLauncher(node, scratch, check_runtime, stop_mode, fault=case, **options)
    else:
        launcher = NamespaceLauncher(node, scratch, check_runtime, stop_mode, **options)
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
            terminal = launcher.terminal
            terminal_host['check_terminal'](terminal.master, terminal.slave, generation)
            terminal_host['expect_terminal'](terminal.master, b'SKELETON STRICT CONTROL\r\n')
            terminal_host['read_console_status'](terminal.master, selected.expected)
            binding = None
            if case == 'listener-store-mismatch':
                binding = {**selected.expected, 'reviewVersion': '0' * 64}
            role = {'listener-invalid-readiness': 'invalid-listener-ready',
                    'listener-missing-selected-view': 'listener-missing-selected-view',
                    'listener-crashed-with-detached-child': 'listener-crashed-with-detached-child'}.get(
                        case, 'decision-listener')
            launcher.stage_listener(selected, binding=binding, role=role)
            if case == 'listener-store-mismatch':
                assert launcher.children[-1].wait(capture['TIMEOUT']) != 0
                assert launcher.listener is None
            elif case == 'listener-invalid-readiness':
                assert launcher.children[-1].wait(capture['TIMEOUT']) == 0
                assert launcher.listener is None
            elif case == 'listener-missing-selected-view':
                assert launcher.children[-1].wait(capture['TIMEOUT']) == 23
                assert launcher.listener is None
            elif case == 'listener-crashed-with-detached-child':
                assert launcher.children[-1].wait(LISTENER_SCOPE_TIMEOUT) == 128 + signal.SIGKILL
                child_pid = int((scratch / 'listener-scope-test-child').read_text())
                assert not (Path('/proc') / str(child_pid)).exists()
                assert launcher.listener is None
            else:
                assert launcher.listener_ready(generation)
        if case == 'listener-exited-before-start':
            stop_listener(launcher)
        if case == 'stale-listener-generation':
            stale_listener = launcher.listener
            # Hold the old listener open to test its binding independently of disposal.
            launcher.listener = None
            generation = launcher.stage(selected, approved=True)
            launcher.listener = stale_listener
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
        if protected and (case == 'restart' or case in ACTIVE_FAULTS):
            exercise_active_peer(launcher, first, case, selected, before)
            if case in ACTIVE_FAULTS:
                return
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
                fresh = launcher.refresh(generation)
                assert fresh is not None and first.child.poll() is None
            stop = launcher.supervisor.stop(namespace)
            (first_stage / 'plan.js').write_bytes(b'changed previous stage\n')
            if case == 'borrowed-namespace-stop':
                unrelated = launcher.start_owned_namespace(generation, 'unrelated')
                assert unrelated is not None
                stop = launcher.supervisor.stop(unrelated)

        if fresh is None:
            if case == 'terminal-hangup-before-refresh':
                hangup_terminal(launcher, generation)
            fresh = launcher.refresh(generation)
        if case in REFRESH_FAILURES:
            assert fresh is None
            if case != 'terminal-hangup-before-refresh':
                assert launcher.peers_live(generation) and launcher.listener_ready(generation)
        else:
            assert fresh.state == selected.expected and launcher.peers_live(generation)
        if case == 'terminal-hangup-after-refresh':
            hangup_terminal(launcher, generation)
        if case == 'listener-exited-before-restart':
            stop_listener(launcher)
        next_stage = directory / 'stage-restart'
        if case in ('restart', 'graceful-restart', 'forced-restart'):
            assert launcher.admit_capture(selected, fresh, next_stage, stop) == expected
            second = launcher.active
            assert len(launcher.fills) == 2 and second.generation is generation
            assert second.child is not first.child and second.namespace['pidNs'] != namespace['pidNs']
            assert launcher.peers_live(generation)
            if protected:
                assert launcher.terminal is terminal and launcher.listener_ready(generation)
                terminal_host['read_console_status'](terminal.master, selected.expected)
            for name in capture['MEMBERS']:
                assert not os.path.samefile(first_stage / name, next_stage / name)
            launcher.supervisor.stop(second.namespace)
        else:
            count = len(launcher.run.namespaces)
            children = len(launcher.children)
            assert launcher.admit_capture(selected, fresh, next_stage, stop) is None
            assert launcher.fills == [first] and len(launcher.run.namespaces) == count
            assert len(launcher.children) == children and not next_stage.exists()
            if case == 'partial-stop':
                assert not lifecycle['exited'](namespace['members']['escapee']['fd'])
        assert capture['snapshot']((selected,)) == before
    finally:
        launcher.cleanup()


def stop_listener(launcher):
    launcher.listener.scope.stop()


def hangup_terminal(launcher, generation):
    launcher.terminal.close()
    assert generation.console.wait(capture['TIMEOUT']) == 0
    assert generation.authority.poll() is None and launcher.listener_ready(generation)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--bwrap-sha256', required=True)
    parser.add_argument('--runtime-receipt', type=Path,
                        help='require the preselected canonical fixture receipt before admission')
    parser.add_argument('--terminal-worker-sha256', help='independently selected terminal entrypoint pin')
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
        terminal_pin = args.terminal_worker_sha256
        if args.protected_launcher and (terminal_pin is None or len(terminal_pin) != 64
                                        or any(c not in '0123456789abcdef' for c in terminal_pin)):
            raise RuntimeRefused('terminal-entrypoint-pin-required')
        selection = read_runtime_selection(args.runtime_receipt) if args.runtime_receipt is not None else None
    except RuntimeRefused as exc:
        print(json.dumps({'ok': False, 'strictState': 'unverified', 'code': str(exc)}))
        raise SystemExit(2)
    scratch = Path(tempfile.mkdtemp(prefix='strict-namespace-admission-')).resolve()
    check_runtime = (runtime_check(selection, node, scratch, terminal_pin=terminal_pin)
                     if args.runtime_receipt is not None else None)
    cases = ('restart', 'partial-stop', 'borrowed-namespace-stop', 'report-before-stop')
    if args.protected_launcher:
        cases += ENROLLMENT_REFUSALS + STARTUP_FAULTS + tuple(PLANNED_STOPS)
        cases += LISTENER_REFUSALS + ('listener-exited-before-restart',)
        cases += tuple(REFRESH_FAILURES) + ('terminal-hangup-after-refresh',)
        cases += tuple(ACTIVE_FAULTS)
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
                      'runtimeReceiptChecked': check_runtime is not None,
                      'terminalPinChecked': check_runtime is not None and terminal_pin is not None}))


if __name__ == '__main__':
    main()
