# Bootstrap fault sequencing fixture (N10)

`test/strict-bootstrap-fault.test.mjs` exercises the sequence described in the
[protected bootstrap contract](strict-protected-bootstrap.md#bootstrap-sequence).
Run it with `node --test test/strict-bootstrap-fault.test.mjs`.

| Phase | Fixture effect |
| --- | --- |
| Preflight | Record a fixed receipt marker. |
| Directories | Read seeded durable history and create a fresh scratch directory. |
| Initial capture and authority | Write a scratch capture marker and start the authority stand-in. |
| Control process | Start the console stand-in. |
| Readiness | Require a reply matching the fresh nonce in the fixture `state` request to the console stand-in over Node IPC. |
| Listener | Wait for the listener stand-in and create a scratch directory representing a fresh browser profile. |
| Agent | Start the agent stand-in and wait for its ready message. |

The positive case checks the full trace, including the authority and console's
ready messages, the matched `state` reply, and listener readiness before the
agent starts. Only receipt of the matched reply records readiness and opens
the agent startup gate. A separate case uses a console that never replies and
verifies refusal before either listener or agent startup. The 14 fault cases
inject immediately before and after each phase's
effects. Each checks where the trace stops, which children were started, and
whether all of those children exited. Refusal through the start of the agent
phase makes zero agent start attempts. The final fault occurs after the agent
has announced readiness and checks its exit along with the other children.

Each role uses the same fixed Node IPC worker and creates zero descendants.
Each worker writes its role and PID in a per-test file beside scratch before announcing
startup. The test harness waits for ready notifications from all workers
spawned through its fixed worker function and checks that file independently
of the bootstrap trace and the launcher's child list. This detects extra
fixed workers launched through that function.

The fixture records each child handle immediately and disconnects its IPC
channel in reverse start order. Readiness and cleanup waits are bounded, and
each worker has an independent lifetime limit. Scratch removal requires an
observed exit and IPC disconnection for all owned children. In separate early
and late fault cases, a real worker stays alive past the cooperative exit
deadline. The fixture returns `cleanup unproven` and retains owned scratch.
After verifying both outcomes, the test harness terminates that worker through
its own child handle and waits for its exit before removing its temporary
directory. Every scenario checks that the seeded durable history remains
intact. A directory collision test confirms that an existing scratch directory
causes refusal and its contents survive fixture cleanup.

The evidence is limited to sequencing and rollback in the stand-in fixture,
including OS-observed exits of its direct children. It returns refusal status
to the test harness. A real launcher still needs operator-facing failure output,
its own bootstrap faults, readiness through the control-to-authority link,
browser isolation, and namespace teardown tests. The fixture does not change
the disabled contract or establish support, adoption, release, or Phase-2
readiness.
