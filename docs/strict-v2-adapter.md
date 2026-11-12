# Protected decision adapter v2 (#77)

The decision controller now supports explicit V2 shown context and authority
state. It is still not loaded by a production page or server; no channel or
listener is constructed. This does not authenticate a human or enable strict.

A V2 shown context must include protocolVersion, shape/review version, exact
captureVersion, approvedCaptureVersion and the existing phase/notes fields.
These come from the protected host's immutable view binding, never from the
public live-review page. Missing/malformed V2 context cannot fall back to V1.
The adapter does not infer shown bytes from whatever authority state says now.

New approve requests compare both shown digests to the selected authority pair.
Reshape names the approved pair. Replies must match protocol, request/action and
both digests; approval confirmation must match the approved pair and revision.
Same-shape raw changes hold new decisions, including moves during asynchronous
reads and replies. A retained Retry sends the original request unchanged; a
Re-read shows only current state, not a historical outcome.

The V1 prototype remains compatible. Recapture is not offered by this adapter,
and a `recaptured` result is never interpreted as approval. V2 identity is
rendered using text nodes. The tests use the real authority planner for V2
channels and exercise commits followed by lost replies and original-result
replay rather than a second duplicated transaction model.

## Remaining integration

The outside listener still must authenticate the control channel, bind project,
session and round, fetch validated immutable captures, render source safely and
coordinate freeze/staging with commits. Capture storage primitives exist, but
the adapter does not integrate them; its absent-gate list describes requirements
it does not provide. Anti-rollback, live evidence and a supported launcher
profile also remain open. No public feedback token authorizes a decision.
