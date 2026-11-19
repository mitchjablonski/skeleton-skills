# Launcher-side PID visibility fixture (#172 / #124 / #75)

This opt-in development fixture checks whether a disposable host child’s PID
number appears in the process directory listing visible to a Bubblewrap worker.
Strict stays `unverified` after a pass.

```sh
/usr/bin/python3 -I test/live/strict-process-reach-probe.py
```

The launcher starts a fixed Python child that waits for EOF on its own stdin.
It holds that pipe open throughout both observations, checks that the child
hasn't exited before and after each worker, and closes the pipe at cleanup.
The launcher waits for a clean exit and reaps the child. Worker runs and child
cleanup have timeouts.

Each worker checks that its `/proc/self` link resolves to its own local PID and
that this number occurs among the ASCII decimal names at the top of `/proc`.
The launcher compares the worker's own PID namespace identity with its own,
and checks the reported lookup result for the fixture child's host number.
A positive alias control uses the worker's own number in the private
classification and must return `numeric-collision`.

| Worker | Required observation |
| --- | --- |
| Shared PID namespace | The host child’s PID number appears. |
| Private PID namespace | The host child’s PID number is absent. |

If the private listing contains the same number, the fixture records
`numeric-collision` and fails. It leaves the matching entry untouched.
See the [Linux PID namespace documentation](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
for how PID numbers and the `/proc` mount relate to namespace identity.

The launcher emits one JSON object with fixture status labels. Each field
describes a fixture observation or cleanup result. Exit 0 means both
observations and cleanup succeeded. Exit 1 means a check or fixture operation
failed. Exit 2 means the platform is unsupported or Bubblewrap could not start
one of the control sandboxes.

This measures PID naming and visibility for the specific fixture configuration.
Attach, read, and descriptor policy remain open. The observations do not
establish reach to the real console or authority.
