# Opt-in hostile Git configuration discovery probe

Run this development-only probe from Linux or WSL Linux Python 3.10+ with an
already-installed Linux Git and a pinned Node executable:

```sh
python3 test/live/strict-host-git-config-probe.py \
  --node /absolute/path/to/node \
  --node-sha256 <trusted-64-hex-digest>
```

The existing `strict-client-probe.py` executable-pin validator checks the absolute
Node path, regular executable file, leaf symlink refusal, and SHA-256 digest.
Use a digest from a trusted distribution record. The probe accepts no arbitrary
Git or Node arguments, installs nothing, and performs no network operations.
Git is selected from `/usr/bin:/bin`; the JSON records its exact observed
`git --version` output. Git itself is not digest pinned.

Two fresh repository fixtures test global configuration and repository-local
configuration separately. Each includes tracked, untracked, ignored, and nested
repository source files. The harness imports the real `discoverSource` export
from `lib/source-set.mjs` into the pinned Node process and requires exact eligible
membership, nested discovery, and the expected ignored count. Each hostile
result must also exactly match an actual discovery run under neutral configuration.

The hostile configuration points `core.fsmonitor`, `core.hooksPath`, and clean
and smudge filters at fixed harmless shell helpers that write fixture-only
sentinels. Positive controls run `git status`, `git add`, `git commit` with a
pre-commit hook, and `git checkout-index` to prove the applicable helpers really
execute separately in both root and nested repositories before their sentinels
are cleared. This avoids treating an unreachable
hook as evidence of protection. The subsequent actual source-discovery call
must leave every sentinel absent. In particular, the implementation's explicit
`-c core.fsmonitor=false` override is exercised against configured fsmonitor
helpers. Discovery does not ordinarily perform add, commit, or checkout, so
hook/filter absence only describes this fixed discovery command sequence.

Every child receives a newly constructed environment with disposable HOME,
USERPROFILE, XDG directories and global config, disabled system Git config,
fixed Linux PATH, closed inherited descriptors, and no stdin. No real repository
or personal Git settings are used as a fixture. The source module and executable
files are read from their supplied locations. Each command has a 15-second wall
limit, a 10-second CPU limit, and a 32 KiB bound on each captured output file.
The harness retains the process-group leader until group cleanup, kills the
owned process group, then reaps it. Temporary-directory cleanup only removes
the uniquely created fixture directory. If group cleanup or child reaping fails,
the scratch directory is retained and its path is reported as `retainedScratch`. These limits are for these fixed helpers;
the harness is not an arbitrary-code sandbox or a detached-descendant supervisor.

The single JSON result always reports `strictState: "unverified"`. Success
requires every reported check to pass; a missing positive control, membership
difference, helper sentinel, timeout, command failure, or output overflow fails
the probe. Failed cases retain their observations in the result when available.

This is evidence about these helper mechanisms and the exact Git version used.
It does not prove universal non-execution, containment, protection from every Git
configuration option, or resistance to a malicious Git/Node executable. Windows
Git and mounted-path behavior are explicitly untested. Running the Linux probe
from a mounted checkout does not test Windows Git interop or establish mounted
filesystem semantics generally. No production strict-state claim changes.
