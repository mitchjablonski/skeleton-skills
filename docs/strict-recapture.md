# Journaled Recapture (#76)

V2 adds the private-host `recapture` action. It is not a V1 action, a new public
route, an approval, or a way to change a fill in progress. The decision adapter
does not offer it yet. The protected host must authenticate its control channel,
capture and durably store the actual new blob first, then plan the transaction.

The request names the currently selected shape/capture pair and existing
project/session/round/revision. The host facts name the newly observed pair,
with `nextReviewRoundId: null` and `completionVerified: false`. Only skeleton
phase is allowed; the round stays fixed and both approved fields stay null.

Changed pairs advance the revision once. Unchanged pairs preserve state and
revision, including revision zero, but still journal the original request/result.
The dedicated result is `{kind:"recaptured",protocolVersion:2,action:"recapture",
requestId,reviewVersion,captureVersion,revision,changed}` and names the resulting
selected pair. It must never be treated as a committed approval.

Exact retries use the shared request-ID journal before reading current facts.
Changed same-ID requests, including a different action, refuse. Every terminal
Recapture outcome counts against the existing 1024-entry bound; there is no
unreviewed separate allowance or automatic pruning.

This answers the earlier design questions: unchanged **transactional Recapture
does write a journal entry**. Zero writes cannot also promise a durable original
answer after restart. Re-read remains a non-transactional observation of current
state; it does not refresh source content or resolve a lost historical request.

The core and Linux authority store support this action, but no protected
listener/orchestrator invokes it. The future coordinator must order immutable
capture publication before authority reference, enforce enrollment/session
binding, and close capture/commit races. Anti-rollback, recovery/compaction,
host enumeration and launcher gates remain open.
