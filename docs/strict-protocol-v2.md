# Exact-capture authority protocol v2 (#76)

V2 binds a transition to both the full exterior/fence `reviewVersion` and the
full raw-byte `captureVersion`. Both are 64 lowercase hex SHA256 values. A
same-shape capture swap can no longer satisfy an approval that named another
capture. Valid envelopes are data, never proof of human origin.

V1 remains supported for disabled prototype compatibility. A future strict host
must explicitly require V2; it must never register a V1 authority or silently
downgrade an existing V2 record. No default CLI/server starts a strict host.

## Envelopes

V2 intents retain the V1 fields, set `protocolVersion: 2`, and add mandatory
`captureVersion`. V2 authority state retains the base state fields and adds
`protocolVersion: 2`, the selected round's `captureVersion`, and
`approvedCaptureVersion` (null in skeleton phase). Selected capture means the
immutable review selection, not an assertion about live workspace bytes.

Committed V2 replies add `protocolVersion: 2` and echo the intent's
`captureVersion`, alongside requestId/action/reviewVersion/revision. Rejected
replies keep the shared `{kind:"rejected",code,requestId?}` format; they make
no commit assertion. Envelopes reject missing/extra fields and mixed versions.

| Action | Intent names | Independent host facts / next state |
|---|---|---|
| approve | Selected shape and exact capture | Both observed digests must match; install the approved pair |
| reshape | Approved pair | Fresh round plus newly captured pair; clear both approved fields |
| finalize | Approved pair | Matching shape and verified completion; current body-byte capture may differ |

The V2-only private-host [Recapture operation](strict-recapture.md) names the
current selected pair and installs the independently captured pair only in
skeleton phase. Its distinct `recaptured` result is never an approval.

V2 host facts are exactly `{contentVersion,captureVersion,nextReviewRoundId,
completionVerified}`. They come from the protected host's own checks, not the
request. Finalize's boolean is not itself verification. It must represent real
completed-step and drift checks against the approved capture.

## Journal and storage

V2 authority records use `protocolVersion: 2`; their initial/current states,
intents, facts and committed replies must agree. Replay checks every capture
binding. Request-ID identity includes captureVersion, so reusing an ID for a
different raw capture is refused even when its shape is identical. Exact
retained retries still precede current facts/revision checks.

The trusted Linux store persists these records without a different write path.
It does not persist or validate capture blobs: the host must durably store and
validate the immutable capture before acknowledging an authority reference.
Do not promote V1 history by filling guessed capture IDs; migration/registration
needs explicit reviewed host semantics.

## Integration gates

The decision controller still emits V1 intents. Claude's protected adapter must
explicitly emit and check V2, correlate the echoed capture digest, and confirm
the authoritative approved pair. It must not infer exact bytes from shape
equality or use the public live-review page as an authority source.

Private capture and Recapture primitives now exist, but their protected service
integration is still required. Complete host
enumeration, content freeze/staging and commit publication, anti-rollback,
enrollment/session lifecycle, protected origin and authenticated live evidence
remain required. This change supplies protocol/core/storage groundwork only;
it does not enable strict mode or authenticate a human.
