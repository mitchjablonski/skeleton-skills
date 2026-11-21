# Stored capture admission and restart fixture (#189)

Run from the repository root on Linux with a pinned Node executable.

```sh
/usr/bin/python3 -I test/live/strict-capture-admission-probe.py \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

Trusted setup uses the directory manager and real stores to enroll and
approve a two-file capture. The launcher retains the expected state and
changes the fixture's copy of the live workspace before admission. The
authority reopens the selected manager paths. The designated console reports
state on its inherited pipe. The launcher checks the selected enrollment,
freshness, exact state and both peer handles. The checkpoint materializer
reads the immutable capture for that pair and revalidates a fresh stage before
the launcher starts a fixed leaf. The leaf reports its own digests from the
stage, which must match the independently recorded approved bytes.

For restart, the launcher observes exit of the exact prior leaf using its
owned process handle. It asks the same console for another state call on the
existing command connection. The console writes that result to a second
inherited report pipe. The same authority and console stay alive through the
new start. The fixture changes the first stage and verifies that the restarted
leaf sees the approved bytes in independently created files.

The cases refuse a different enrollment with identical public state, missing
or corrupt stored bytes, a live predecessor with missing or borrowed exit
evidence, reuse of the first report, an unavailable fresh state, and a genuine
history lookup result used as restart evidence. Refusal starts no additional
leaf and preserves the authority and capture bytes present at admission.

This opt-in fixture covers fixed, owned leaf processes. Namespace teardown,
production admission and the check-to-spawn race remain open. Strict stays
disabled and unverified. See the [enrollment design](strict-enrollment-binding.md).
