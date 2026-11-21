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
before running the fixture. This mode expects `node-channel-control`, with
Node as the client and `test/live/strict-launcher-binding-worker.mjs` as its
entrypoint. The launcher collects a fresh pinned receipt before staging any
fixture workers and again immediately before each namespace start. A
refusal starts no namespace for that attempt. Unproven observation cleanup
retains scratch. The invocation above exercises namespace teardown with the
explicit binary pins alone.

This fixture uses explicitly pinned binaries and a fixed, owned workload.
It leaves strict disabled and unverified. The supported-runtime profile,
graceful-stop escalation, listener gates, and production launcher ownership
remain open.
