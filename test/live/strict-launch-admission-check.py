"""Deterministic checks for the launcher admission boundary."""
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace

LaunchAdmission = runpy.run_path(str(Path(__file__).resolve().parents[2] / 'lib' /
                                     'strict-launch-admission.py'))['LaunchAdmission']
state = {'phase': 'fill', 'revision': 1, 'reviewVersion': 'a' * 64,
         'captureVersion': 'b' * 64, 'admissions': 'live'}
enrollment = object()
generation = SimpleNamespace(enrollment=enrollment)
report = SimpleNamespace(origin=generation, sequence=0, state=state.copy())
events = []


def materialize(review, capture):
    assert (review, capture) == ('a' * 64, 'b' * 64)
    events.append('materialize')
    return True


def start(owner):
    assert owner is generation
    events.append('start')
    return 'started'


def check():
    expected = state.copy()
    gate = LaunchAdmission(generation, expected, lambda _: True)
    expected['captureVersion'] = 'c' * 64
    wrong_origin = SimpleNamespace(origin=object(), sequence=0, state=state)
    assert gate.admit(enrollment, wrong_origin, 0, materialize, start) is None
    assert gate.admit(object(), report, 0, materialize, start) is None
    assert gate.admit(enrollment, None, 0, materialize, start) is None
    assert gate.admit(enrollment, report, 0, materialize, start) == 'started'
    assert gate.admit(enrollment, report, 0, materialize, start) is None
    assert events == ['materialize', 'start']
    events.clear()

    for bad_state in ({**state, 'revision': True}, {**state, 'revision': 2**53},
                      {**state, 'admissions': 'revoked'}, {**state, 'extra': False}):
        gate = LaunchAdmission(generation, state, lambda _: True)
        bad = SimpleNamespace(origin=generation, sequence=0, state=bad_state)
        assert gate.admit(enrollment, bad, 0, materialize, start) is None
        assert gate.admit(enrollment, report, 0, materialize, start) is None
    assert not events

    live = iter((True, False))
    gate = LaunchAdmission(generation, state, lambda _: next(live))
    assert gate.admit(enrollment, report, 0, materialize, start) is None
    assert events == ['materialize']
    events.clear()

    gate = LaunchAdmission(generation, state, lambda _: True)

    def canceled(review, capture):
        next_report = SimpleNamespace(origin=generation, sequence=1, state=state)
        assert gate.admit(enrollment, next_report, 1, materialize, start) is None
        gate.invalidate()
        return materialize(review, capture)

    assert gate.admit(enrollment, report, 0, canceled, start) is None
    assert events == ['materialize']
    events.clear()

    def peer_check(_):
        if events:
            gate.invalidate()
        return True

    gate = LaunchAdmission(generation, state, peer_check)
    assert gate.admit(enrollment, report, 0, materialize, start) is None
    assert events == ['materialize']
    print('strict launch admission checks passed')


if __name__ == '__main__':
    if sys.flags.optimize:
        raise SystemExit(2)
    check()
