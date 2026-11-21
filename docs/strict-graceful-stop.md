# Bounded graceful namespace stop fixture

Run the opt-in fixture on Linux with Bubblewrap, unprivileged namespaces,
and Python pidfd support.

```sh
/usr/bin/python3 -B test/live/strict-graceful-stop-probe.py
/usr/bin/python3 -B test/live/strict-graceful-stop-probe.py --inject-expired-deadline
```

The fixture sends SIGTERM through the verified worker pidfd. The
cooperative worker acknowledges TERM and exits with status zero.
The stubborn worker explicitly ignores TERM. The supervisor waits for
the 500 ms grace period to expire, observes the worker still alive, and
then sends SIGKILL through the verified namespace init pidfd.

Both paths share a two-second deadline measured from before the TERM
request. The fixture reaps the Bubblewrap wrapper, waits for the verified
member pidfds, and confirms an empty live-process namespace census before
returning stop observations. The fixture uses owned synthetic processes
and reports `strictState: unverified`.

The first command expects exit 0 and `graceful-stop-fixture-passed`.
The injected control lets the wrapper exit, then expires the shared
deadline before final proof. It expects exit 1 and `stop-unproven` with
`stopUnproven.late` and `retainedScratch`. Best-effort cleanup runs even
when the fixture retains scratch. Exit 2 indicates unsupported arguments
or prerequisites.
