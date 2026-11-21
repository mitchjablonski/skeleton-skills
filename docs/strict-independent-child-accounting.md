# Independent child accounting fixture

The opt-in fixture runs a Bubblewrap PID namespace with the fixture's worker,
separate agent-group child, session-escaping descendant, and one additional
ordinary child. The additional child inherits the worker's group and session.
It closes the status output and sends no identity or acknowledgment. The worker
emits the same identity fields as in the original fixture.

Run from the repository root on Linux with Bubblewrap and Python pidfd support.

```sh
/usr/bin/python3 -B test/live/strict-independent-child-accounting-probe.py
/usr/bin/python3 -B test/live/strict-independent-child-accounting-probe.py --inject-unproven
```

The host anchors the census to the live, verified namespace init. It finds
exactly one additional member by PID namespace inode, opens its pidfd, rechecks
its identity, and verifies its parent, group, and session. The original
lifecycle fixture continues to reject additional members in its default mode.

The positive run first requires a selective agent-group stop to fail proof,
with the silent child among the live pidfds and four remaining namespace
members visible in the census. The host then stops the namespace through
its init pidfd. Success requires every member's pidfd to report exit, the
Bubblewrap wrapper to be reaped, and the census to be empty within the shared
stop deadline.

The injection run exits 1 with `stop-unproven` at the refusal. A bounded
cleanup stops and reaps owned processes, checks the census again, and retains
the scratch directory for diagnosis. The positive run exits 0 on success.
Exit 2 indicates missing prerequisites. These results leave strict state
`unverified` and cover only the fixed local fixture.
