"""Single-threaded host handoff from owned namespace stop proof to restart."""
from dataclasses import dataclass
import math
import subprocess
import time


class StopUnproven(RuntimeError):
    """A stop that cannot authorize restart."""


@dataclass(eq=False, frozen=True)
class _StopReceipt:
    proved_at: int


@dataclass
class _Owned:
    namespace: object
    wrapper: object
    attempted: bool = False
    receipt: object = None


class StopHandoff:
    """Use trusted host callbacks for signaling and independent teardown proof.

    The supervisor registers only verified namespaces and owned wrapper
    handles. The proof callback must check member exits and the empty census
    before returning True, within the given monotonic deadline. Cleanup after
    a failed proof belongs to the supervisor and cannot mint a restart receipt.
    """

    def __init__(self, terminate, prove, stop_seconds):
        if type(stop_seconds) not in (int, float) or not math.isfinite(stop_seconds) or stop_seconds <= 0:
            raise StopUnproven('stop-bound-invalid')
        self._terminate = terminate
        self._prove = prove
        self._stop_seconds = stop_seconds
        self._owned = {}

    def own(self, namespace, wrapper):
        if id(namespace) in self._owned or any(entry.wrapper is wrapper for entry in self._owned.values()):
            raise StopUnproven('namespace-already-owned')
        self._owned[id(namespace)] = _Owned(namespace, wrapper)

    def _begin(self, namespace):
        owned = self._owned.get(id(namespace))
        if owned is None or owned.attempted:
            raise StopUnproven('stop-not-available')
        owned.attempted = True
        return owned

    def _finish(self, owned, deadline):
        if time.monotonic() >= deadline:
            raise StopUnproven('stop-deadline-unavailable')
        if self._prove(owned.namespace, deadline) is not True:
            raise StopUnproven('namespace-proof-missing')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise StopUnproven('stop-proof-late')
        try:
            owned.wrapper.wait(timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            raise StopUnproven('wrapper-wait-unproven') from exc
        proved_at = time.monotonic_ns()
        if proved_at / 1_000_000_000 > deadline:
            raise StopUnproven('stop-proof-late')
        owned.receipt = _StopReceipt(proved_at)
        return owned.receipt

    def stop(self, namespace):
        owned = self._begin(namespace)
        deadline = time.monotonic() + self._stop_seconds
        self._terminate(namespace)
        return self._finish(owned, deadline)

    def stop_planned(self, namespace, request_stop):
        """Let the supervisor perform bounded graceful escalation before proving stop."""
        owned = self._begin(namespace)
        started = time.monotonic()
        deadline = started + self._stop_seconds
        request_stop(namespace, started, deadline)
        return self._finish(owned, deadline)

    def confirm(self, namespace, deadline):
        owned = self._begin(namespace)
        if type(deadline) not in (int, float) or not math.isfinite(deadline):
            raise StopUnproven('stop-deadline-unavailable')
        return self._finish(owned, min(deadline, time.monotonic() + self._stop_seconds))

    def consume_restart(self, namespace, receipt, requested_at):
        owned = self._owned.get(id(namespace))
        if (owned is None or receipt is None or owned.receipt is not receipt
                or type(requested_at) is not int or requested_at <= receipt.proved_at):
            return False
        owned.receipt = None
        return True
