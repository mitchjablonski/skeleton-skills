"""Host-side admission for a single launcher-owned authority/console generation."""

_STATE_FIELDS = ('phase', 'revision', 'reviewVersion', 'captureVersion', 'admissions')


def _live_state(value):
    if type(value) is not dict or set(value) != set(_STATE_FIELDS):
        return None
    phase, revision, review, capture, admissions = (value[key] for key in _STATE_FIELDS)
    if (type(phase) is not str or phase not in ('skeleton', 'fill', 'finalized')
            or type(revision) is not int or not 0 <= revision <= 2**53 - 1):
        return None
    if type(admissions) is not str or admissions != 'live' or any(type(digest) is not str or len(digest) != 64
                                   or any(c not in '0123456789abcdef' for c in digest)
                                   for digest in (review, capture)):
        return None
    return phase, revision, review, capture


class LaunchAdmission:
    """Bind expected state to the launcher's own console and authority.

    A single-threaded supervisor passes its actual generation, with enrollment already verified
    before staging. Reports must come from that generation's dedicated pipe.
    The host owns stop receipts, pinned runtime checks, and cleanup if startup
    throws or either peer exits during or after spawn.
    """

    def __init__(self, generation, expected, peers_live):
        self._generation = generation
        self._enrollment = generation.enrollment
        self._expected = _live_state(expected)
        self._peers_live = peers_live
        self._next_sequence = 0
        self._admitting = False

    def invalidate(self):
        self._generation = None

    def _live_generation(self, generation):
        return (self._generation is generation and self._peers_live(generation) is True
                and self._generation is generation)

    def admit(self, enrollment, report, sequence, materialize, start):
        generation = self._generation
        report_sequence = getattr(report, 'sequence', None)
        if (self._admitting or generation is None or self._expected is None or enrollment is not self._enrollment
                or getattr(report, 'origin', None) is not generation or type(report_sequence) is not int
                or type(sequence) is not int or report_sequence != sequence or sequence != self._next_sequence):
            return None
        self._next_sequence += 1
        self._admitting = True
        try:
            if _live_state(getattr(report, 'state', None)) != self._expected or not self._live_generation(generation):
                return None
            _, _, review, capture = self._expected
            if materialize(review, capture) is not True:
                return None
            if not self._live_generation(generation):
                return None
            return start(generation)
        finally:
            self._admitting = False
