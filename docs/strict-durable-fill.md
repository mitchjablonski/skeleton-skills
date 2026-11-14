# Durable approval and actual fill fixture

`test/live/strict-durable-fill-probe.py` is a Linux development experiment. Supply the same explicit pinned client and Node paths and SHA-256 arguments as `strict-actual-fill-probe.py`. It uses the pinned real CLI against a deterministic loopback mock API in a fresh Bubblewrap namespace, with no model inference or external networking.

The outside host privately stages the fixed source, durably stores its capture, and creates the disabled human-authority store. Its independent observer enumerates and captures the staged source while the authority lock is held. A host-injected fixture code commits an approval journal entry. Later, separate Node processes reopen the store and retry the same request ID with observation, clock, and entropy callbacks that throw if invoked. The retained result and record bytes must remain identical. Each worker tree comes from the exact approved durable capture and fresh file inodes.

Both the valid selected-body edit and the exterior-edit negative control run through the existing actual CLI fixture. The existing pidfd supervisor proves the detached writer advances after CLI exit, kills namespace PID 1, waits for every observed pidfd and for no live namespace members, and only then captures the candidate. The exterior edit must be rejected while its selected-body edit is present. The worker binds its cloned tree, control files, disposable home, passwd/group, and pinned client/runtime files; authority keys, journal and capture blobs remain outside that explicit bind list. No private store descriptors are inherited by the CLI.

This fixture remains `unverified`. Injected codes do not demonstrate a human, authenticated channel, enrollment, antirollback, production host profile, production activation or completion verification. Host staging quiescence is established by this fixed experiment's sequencing, not by a general admission mechanism. It changes no production launcher, library, console or permissions policy.

The stored-byte control poisons both disposable source copies after approval and before either seed. Both workers must still read the original `initial` sentinel from the approved blob. A separate minimal Bubblewrap process attempts to read the exact private authority and capture paths and create exclusive canaries inside both private directories; all must fail with missing paths. It also rejects inherited descriptors beyond standard input/output/error. This separate minimal sandbox does not detect regressions in the actual CLI mount list; that scoping is established by the shared actual_round bind construction. Neither is an exhaustive attack-path claim.

Example with previously observed local pins (verify current local binaries before use):

```sh
/usr/bin/python3 test/live/strict-durable-fill-probe.py \
  --client /home/mitch/.local/share/claude/versions/2.1.323 \
  --client-sha256 604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

Use the repository lab runner's existing admission and process guards when executing in the shared Linux lab. Exit 0 means the bounded fixture passed, exit 1 means experiment/cleanup failure, and exit 2 means unsupported prerequisites or invalid pins. Failed namespace teardown retains scratch instead of claiming cleanup.

Observed on 2026-11-14 with the pins above: both actual-CLI rounds passed. Both seeds matched the same approved stored capture after source poisoning; valid fill was accepted and exterior drift refused. Detached writers advanced after CLI exit and all tracked pidfds exited before capture. Private-path reads and canary creation were denied. Completion remained false and strict state remained `unverified`. This is a fixture observation, not supported-profile qualification.

The console/store bridge now also exercises a lost committed approval response: the fixed host types the injected code through `createControlConsole`, reopens the writer with protected effects disabled, then confirms console retry. It must retain the original command and result with one observation and one core entry. `test/strict-control-store.test.mjs` separately uses real Linux stores to recover both lost approval and lost logical-closure replies, preserving the original IDs and durable bytes while new decisions remain gated. This is simulated console input, not evidence of a protected terminal or human channel.

Observed bridge validation on 2026-11-14: targeted console/store suites passed 43 with one platform skip; the updated pinned actual-client fixture again passed valid and exterior rounds, exact stored-byte reseeding, pidfd teardown and the bounded separate private-path checks. Strict remained `unverified` and completion remained false.
