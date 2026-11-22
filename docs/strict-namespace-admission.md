# Stored capture admission with namespace teardown

Run from the repository root on Linux or WSL2. Supply independently selected
pins for the Node executable and system Bubblewrap.

```sh
/usr/bin/python3 -I test/live/strict-namespace-admission-probe.py \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e \
  --bwrap-sha256 e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71
```

The fixture reuses the [stored capture admission gate](strict-capture-admission.md)
and the [lifecycle probe](strict-lifecycle-fault.md). It admits only the
selected enrollment and exact capture from the store. The fixed worker reads
the staged files inside a private PID namespace from a read-only mount and
reports their digests. The launcher compares those digests with the approved
fixture bytes, with different bytes in the live workspace.

The launcher stops the exact namespace via its verified init pidfd. It
requires exit readiness for the init, worker, fixed group child, separate-session
descendant and outer wrapper, an empty live namespace census, and a reaped
wrapper within one deadline. Only then can the launcher mint a stop receipt.
The receipt belongs to the previous owned namespace and predates the report
request to the still-running console. A successful restart uses a new namespace
and a fresh stage from the stored capture. Both stages are checked from inside
their namespaces, and the prior stage is changed before the second start.

The fixture uses the packaged `lib/strict-supervisor-handoff.py` gate.
It registers the supervisor's exact namespace and wrapper handles, then
issues a receipt only after the independent proof and wrapper reaping have
both finished within the shared deadline. Restart consumes that receipt
once. A failed proof remains ineligible for restart even if a later cleanup
succeeds. A caller's confirmation deadline can shorten the configured bound.
The gate is scoped to one supervisor and leaves signal delivery,
process discovery, scratch retention and cleanup to that supervisor.

The fixture refuses a partial group stop, a genuine receipt from another
namespace, and a matching state report requested before the stop. Each
refusal leaves the next stage absent and durable bytes unchanged. On cleanup
the launcher verifies the namespace stop before removing scratch. Failure
retains scratch.

Pass `--runtime-receipt /path/to/selected-receipt.json` to exercise selected
runtime admission. Supply a canonical receipt from trusted configuration
before running the fixture. The [pinned receipt recorder](strict-runtime-receipt.md#record-the-protected-fixture-candidate-216)
can collect a candidate for comparison. This mode expects `node-channel-control`, with
Node as the client and `test/live/strict-launcher-binding-worker.mjs` as its
entrypoint. The launcher collects a fresh pinned receipt before staging any
fixture workers and again immediately before each namespace start. A
refusal starts no namespace for that attempt. Unproven observation cleanup
retains scratch. The invocation above exercises namespace teardown with the
explicit binary pins alone.

Add `--protected-launcher` to exercise all enrollment, readiness and restart
checks together. Supply both the selected receipt and an independently
chosen `--terminal-worker-sha256` for `test/live/strict-terminal-host-worker.mjs`.
The launcher checks the terminal entrypoint as well as the live receipt
before starting fixture workers and before each namespace start. The packaged
`lib/strict-protected-generation.py` adapter creates the authority/console
socket pair and separate initial and refresh report pipes. Only the owned
console inherits the report writers. The authority must open the selected
durable enrollment, and the launcher checks the generation and owned peers
before materializing the stored capture. The protected fixture checks a
wrong-context store with equal public state, an old report from a replaced
generation, and loss of each peer after a valid report. Each check verifies
that no materialization worker or namespace starts and durable bytes stay
unchanged. A separate case loses the console during namespace startup and
requires full teardown and wrapper reaping before admission returns.

The console uses its own foreground PTY in the protected mode. The launcher
checks its session, terminal identity and inherited command socket before
admission. The terminal parser serves a fixture `status` command while the
separate readiness pipes carry initial and refresh observations. The same
terminal, authority and listener persist through a healthy restart. After
proving the stop and reaping the wrapper, the supervisor requires a new
`state()` observation from that console on the refresh pipe. Lost or
malformed refresh and a terminal hangup on either side of refresh refuse
the replacement without staging bytes or changing durable history.

Planned restart cases exercise a cooperative shutdown and bounded forced
escalation of the fixed staged worker. The graceful request, escalation,
independent namespace proof and wrapper reap share one deadline. A proof
attempt after that deadline cannot authorize another namespace. Faults and
peer loss continue to use the immediate owned stop.

While an admitted namespace is running, the protected fixture watches the
exact console and authority pidfds for that fill. Its live control leaves
both peers and the namespace running and then completes a healthy restart.
An exit already recorded on an owned child triggers the stop without
reopening its numeric PID.
Closing the owned terminal or stopping the owned authority triggers an
immediate namespace stop. The launcher invalidates admission, proves no
namespace members remain and reaps the wrapper within the fault deadline.
The fault stop issues no restart receipt. The run refuses further staging
and restart, and the surviving peer, listener and durable history remain
intact. This measures peer exit and physical stop. Authority request stalls
and revocation are separate cases.

The protected fixture starts the read-only decision listener as a separate
owned process after console readiness. The worker checks its selected view
against the immutable capture store and consumes the one-use observation
for its private startup read before reporting its port on an inherited
pipe. The launcher confirms the loopback response and requires the
listener at initial admission and planned restart. Readiness binds the
exact enrolled generation and capture pair,
and replacing that generation disposes its listener. The launcher checks
again before each namespace start. A mismatched stored view, malformed
report, stale listener or listener already dead at admission refuses before
materialization. A successful HTTP read under a superseding navigation also
refuses because it cannot satisfy the selected observation. Loss during
startup prevents namespace admission and requires full teardown if a
namespace already exists. The startup tab is revoked before the report.
The fixture exports no navigation link or decision capability.
Closing an already admitted listener does not authorize another start.

The listener runs under a dedicated Linux child subreaper. The launcher
requests stop by closing the private lifeline pipe. The scope also watches
for the exact listener's exit and reaps its owned descendants before
reporting its own exit. The crash case starts a detached child that ignores
SIGTERM, kills the listener, and verifies the scope reaped the child before
admission can proceed. The launcher leaves scratch for inspection if the
scope cannot prove teardown. The scope itself must remain alive to do this
work.

## Protected browser window

Add `--chrome-sha256 <hex>` to the protected-launcher invocation to run
the window and restart cases. The digest is for the selected Chrome ELF.
The fixture requires Xvfb and the system X11 helper tools. Its browser
profile, X cookie and display ownership marker use a fresh private
directory on the verified `/dev/shm` tmpfs.

The listener checks the stored selection and revokes the startup tab
before minting a separate navigation for the pinned, sandboxed browser.
It reports the port only after the authenticated private display maps the
window and the listener observes a completed read for that exact selected
capture and navigation. The launcher checks the same owned browser, X
window and enrolled capture over an inherited private socket at admission
and restart. A healthy same-generation restart preserves the window and
the selected-view proof. A replacement generation disposes the old scope
and must obtain its own proof.

The cases cover refusal for a stale generation, a stored view mismatch, a
wrong browser pin, and a mapped window without the selected navigation
observation. They verify that loss of the listener, browser or display
blocks restart before staging any replacement. The scope waits for
descendants to exit and be reaped before the launcher checks the display
slot and removes the profile. Unproven cleanup retains the scratch
directory.

This check applies at admission and restart. Active-fill teardown remains
covered separately by the authority and console fault cases. Window
evidence combines the selected listener read with mapped X window and
process identity. Browser argument visibility is limited by the owned
fixture namespace, and qualification of the actual human desktop remains
open.

An unexpected readiness refusal in a window case reports the fixture
case, the initial or replacement phase, and a fixed reason. Startup
reasons distinguish the worker, display, browser checks, and selected-view
proof from an incomplete report. Once the port has been reported, the
launcher distinguishes the private window check from the HTTP listener
health check. These labels carry no navigation data. After an empty
report, diagnostics allow the existing scope cleanup interval to collect
the worker exit status. Admission deadlines and evidence are unchanged.

This fixture uses explicitly pinned binaries and a fixed, owned workload.
It leaves strict disabled and unverified. Actual desktop qualification,
protected code issuance and production launcher ownership remain open.
