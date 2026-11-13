# Strict capture benchmark

Opt-in development microbenchmark for existing strict primitives. It never
activates strict mode, contacts a model or service, or establishes durability.
Its synthetic V2 authority transactions occur only in disposable fixture stores;
they are not human approvals. Strict remains unverified.

Run on Linux with Node 20 or newer:

```sh
node test/live/strict-capture-benchmark.mjs --repo /absolute/path/to/skeleton-skills --local-parent /tmp
```

`--repo` defaults to the current directory; `--local-parent` defaults to `/tmp`.
Add `--mount-parent /absolute/existing/mounted/directory` for a separate mounted
storage observation. All supplied paths must be absolute and parents must exist.
Filesystem labels reflect operator selection, not automatic verification of local
storage semantics. Use reserved fixture parents; never use production stores.
The harness creates uniquely named directories, verifies resolved containment and
an ownership marker before recursive cleanup, and reports cleanup failures.

Datasets contain 1 or 32 approximately 4 KiB fenced text files, with exact byte
counts reported. Five warmups precede 20 measured samples. Operations are pure
capture, canonical validation, new capture-store puts, stored capture reads, and
V2 authority-store submissions. Distinct precomputed captures keep put timings on
the new-object path; authority stores are prepared before timing. Timed authority
submissions use synthetic matching facts, not independent completion evidence.

One JSON object reports median and nearest-rank p95, minimum/maximum, fixture or
record byte sizes, platform and Node version, and process RSS snapshots after
samples. RSS is observed process memory, not per-operation allocation. Unsupported
operations retain explicit rows so partial results remain visible. Cleanup status
is separate from timing success. Native Windows reports unsupported; Linux errors
or mounted-storage refusals provide no durability evidence. No thresholds are
adopted. The harness does not test crash recovery, power loss or production
activation; local and mounted measurements must not be conflated.
