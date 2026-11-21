"""Deterministic checks for the supervisor stop and restart boundary."""
from pathlib import Path
import runpy
from subprocess import TimeoutExpired
import sys
from types import SimpleNamespace

handoff = runpy.run_path(str(Path(__file__).resolve().parents[2] / 'lib' /
                             'strict-supervisor-handoff.py'))
StopHandoff = handoff['StopHandoff']
StopUnproven = handoff['StopUnproven']
clock = SimpleNamespace(now=0)
StopHandoff.stop.__globals__['time'] = SimpleNamespace(
    monotonic=lambda: clock.now, monotonic_ns=lambda: clock.now * 1_000_000_000)


class Wrapper:
    def __init__(self, events, times_out, wait_seconds):
        self.events = events
        self.times_out = times_out
        self.wait_seconds = wait_seconds

    def wait(self, *, timeout):
        self.events.append(('wait', timeout))
        if self.times_out:
            raise TimeoutExpired('fake-wrapper', timeout)
        clock.now += self.wait_seconds
        return 0


def expect_unproven(action):
    try:
        action()
    except StopUnproven:
        return
    raise AssertionError('unproven stop was accepted')


def setup(*, proved=True, times_out=False, wait_seconds=1):
    clock.now = 100
    namespace = SimpleNamespace(label='owned')
    proof = SimpleNamespace(result=proved)
    events = []

    def terminate(candidate):
        assert candidate is namespace
        events.append('terminate')
        clock.now += 3

    def prove(candidate, deadline):
        assert candidate is namespace
        events.append(('prove', deadline))
        clock.now += 5
        return proof.result

    gate = StopHandoff(terminate, prove, 30)
    gate.own(namespace, Wrapper(events, times_out, wait_seconds))
    return gate, namespace, events, proof


def check():
    gate, namespace, events, _ = setup()
    wrong_namespace = SimpleNamespace(label='owned')
    assert wrong_namespace == namespace and wrong_namespace is not namespace
    expect_unproven(lambda: gate.stop(wrong_namespace))
    assert events == []

    receipt = gate.stop(namespace)
    stopped = ['terminate', ('prove', 130), ('wait', 22)]
    assert events == stopped
    assert receipt.proved_at == 109_000_000_000
    after_proof = receipt.proved_at + 1
    assert not gate.consume_restart(namespace, receipt, receipt.proved_at - 1)
    assert not gate.consume_restart(namespace, receipt, receipt.proved_at)
    assert not gate.consume_restart(wrong_namespace, receipt, after_proof)
    foreign_gate, foreign_namespace, _, _ = setup()
    foreign_receipt = foreign_gate.stop(foreign_namespace)
    assert not gate.consume_restart(namespace, foreign_receipt, after_proof)
    forged = SimpleNamespace(proved_at=receipt.proved_at)
    assert not gate.consume_restart(namespace, forged, after_proof)
    assert gate.consume_restart(namespace, receipt, after_proof)
    assert not gate.consume_restart(namespace, receipt, after_proof)
    expect_unproven(lambda: gate.stop(namespace))
    assert events == stopped

    gate, namespace, events, _ = setup()
    deadline = 110
    expect_unproven(lambda: gate.confirm(wrong_namespace, deadline))
    assert events == []
    receipt = gate.confirm(namespace, deadline)
    assert events == [('prove', deadline), ('wait', 5)]
    assert gate.consume_restart(namespace, receipt, receipt.proved_at + 1)

    gate, namespace, events, _ = setup()
    receipt = gate.confirm(namespace, 1000)
    assert events == [('prove', 130), ('wait', 25)]
    assert gate.consume_restart(namespace, receipt, receipt.proved_at + 1)

    gate, namespace, events, _ = setup(wait_seconds=30)
    expect_unproven(lambda: gate.confirm(namespace, 1000))
    assert events == [('prove', 130), ('wait', 25)]
    expect_unproven(lambda: gate.confirm(namespace, 1100))

    gate, namespace, events, _ = setup()
    expect_unproven(lambda: gate.confirm(namespace, 104))
    assert events == [('prove', 104)]

    gate, namespace, events, _ = setup()
    expect_unproven(lambda: gate.confirm(namespace, 99))
    expect_unproven(lambda: gate.stop(namespace))
    assert events == []

    for proved in (False, 1):
        gate, namespace, events, proof = setup(proved=proved)
        expect_unproven(lambda: gate.stop(namespace))
        assert events == stopped[:2]
        proof.result = True
        expect_unproven(lambda: gate.stop(namespace))
        expect_unproven(lambda: gate.confirm(namespace, 140))
        assert events == stopped[:2]

    gate, namespace, events, _ = setup(times_out=True)
    expect_unproven(lambda: gate.stop(namespace))
    assert events == stopped
    expect_unproven(lambda: gate.stop(namespace))
    assert events == stopped

    print('strict supervisor handoff checks passed')


if __name__ == '__main__':
    if sys.flags.optimize:
        raise SystemExit(2)
    check()
