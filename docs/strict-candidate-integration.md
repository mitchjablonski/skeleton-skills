# Controlled candidate integration (#99)

This disabled development fixture connects quiescent copied source to existing
capture and authority primitives. It does not enable strict mode. Every output
has `strictState: "unverified"`.

`test/live/strict-candidate-inner.mjs` requires Linux Node 20+ and genuine host
procfs. The caller must establish source quiescence before starting it:

```sh
node test/live/strict-candidate-inner.mjs --source /absolute/fixture-source
node test/live/strict-candidate-inner.mjs --self-test
```

The first invocation is a trusted host continuation after the controlled PID
namespace fixture has exited. A source argument, JSON flag, or successful helper
result does not certify teardown. `--self-test` creates its own fixed source and
needs no worker. The helper accepts exactly `context.txt` and `plan.js`; its
exported `FIXTURE_PLAN` and `FIXTURE_CONTEXT` define the source text. Keep the
`initial` body line in fence 1 for its controlled replacement; fixture writers
may synchronously modify an additional line inside that same fence. No paths,
commands, provider credentials or runtime programs come from a model.

The helper makes a fresh private directory outside the worker's bind, copies
regular single-linked files through pinned descriptors into exclusive new
inodes, and preserves modes. Its fixed two-file policy rejects extra members,
exclusions and dangerous types. It independently enumerates and captures the
copied directory while no fixture owns it. The private copy has no worker writers
in this controlled lifetime; chmod and same-user private paths are not hostile
immutability protection.

It durably puts the validated capture in the real capture store and reopens it
before creating a V2 test authority referencing the exact pair. A hard-coded mock
approve transition uses independently captured facts with completion false.
Under this single-host-writer test lifetime it parses the stored authority record
and resolves its approved capture from the capture store. It materializes a fresh
fill directory from that stored capture and verifies exact capture identity before
the mock fill. It never seeds fill from the old mutable source. Existing store
contracts and unknown-outcome/recovery rules still apply.

The controlled mock fill changes only fence 1 of `plan.js`, including an inserted
line to exercise shifted later fence positions. Independent re-enumeration checks
membership. Canonical capture validation, shape hash and explicit comparisons
check paths, capture modes, unix modes, exact exterior bytes and fence IDs/titles.
Other fence bodies and whole files must remain byte-identical. An unchanged
selected body fails this particular experiment; this is fixture evidence, not a
completion criterion. Built-in negative cases reject member addition, mode drift,
exterior drift, another fence body change, whole-file drift, unchanged selected
body, malformed markers, symlinks and hard links. A second fresh
clone must still equal the approved capture; wrong approved pair binding fails.

A successful record reports operation order, negative cases and exact clone
identity. Exit 1 reports a failed attempt. The outer checkpoint probe remains
responsible for PID-namespace teardown evidence and distinct restart namespaces.
The controlled outer probe now connects actual fixture teardown to this helper:

```sh
/usr/bin/python3 test/live/strict-candidate-probe.py \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

The executable path and full SHA256 are host-selected runtime pins. The probe
hashes that executable before launch and uses the fixed adjacent helper path.
It imports the existing checkpoint probe without generating bytecode and replaces
only its controlled inner fixture. Two detached synchronous writers retain file
descriptors and append bytes to actual `plan.js` and `context.txt`. Plan appends
are exterior bytes established before the first mock approval; the subsequent
mock fill preserves them. Temporary writer aliases are deliberate hard links
used only for the checkpoint fixture's existing growth/read checks. After all
tracked pidfds exit, the census shows no live namespace members, and Bubblewrap
exits, the host removes those aliases and control metadata, checks link counts
returned to one, and invokes the helper on those exact stopped files. It never
reconstructs source from diagnostic output. This controlled alias setup supplies
no hostile hard-link containment guarantee.

Both rounds run the complete teardown and candidate helper sequence. Namespace
descriptors stay open across rounds to prevent namespace identifier recycling;
each restart must have a different namespace. Time, CPU, fixture file sizes and
helper diagnostic sizes are bounded. Unproven teardown retains its scratch
directory and reports failure. Fill execution remains a host-controlled mock;
there is no fill-worker namespace in this slice.

On 2026-11-12 the pinned Node 20.20.0 / system Python WSL run passed both rounds,
tracking three pidfds each, with namespaces `pid:[4026532231]` and
`pid:[4026532233]`. Both rounds passed all nine negative cases. These identifiers
are observations, not expected constants or production qualification.

Temporary roots carry a UUID ownership marker;
cleanup checks their real paths, bounded direct-child prefixes and marker before
recursive removal. Cleanup errors fail the process without forced removal.

The inner helper does not implement or claim arbitrary hostile runtime
containment, human approval, pending asynchronous I/O completion, external-writer
absence, completion verification, finalization, publication or rollback safety.
No production command imports it.
