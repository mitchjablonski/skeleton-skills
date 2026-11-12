# Trusted-host Recapture coordinator

`createRecaptureCoordinator({authorityStore,captureStore})` joins existing
synchronous store handles. It neither creates stores nor authenticates callers.
The host must supply independently captured data from its protected capture path.

`recapture(intent,capture)` accepts only V2 Recapture intents. It rebuilds the
capture, resolves the request's previous selected pair, publishes the new capture,
then submits independently constructed host facts to the authority. A successful
historical result is resolved against its own stored capture before return. It
may name a different pair from the new capture because exact retries precede
current facts. Rejected replies must have no request ID or the matching ID.

`retry(intent)` resolves the previous pair and submits null facts, without a
fresh capture or publication. A new request remains unavailable without reserving
its ID. Unavailable is never treated as a preflight permission to continue.

A failure after publication can leave an orphan blob. A failure after authority
commit can return unavailable despite a committed journal entry. Stop/reconcile
storage health and retry the same intent and ID; never infer that nothing changed.
Old blobs are retained. Missing/corrupt historical captures refuse, rather than
being rebuilt from current workspace contents. No repair, pruning or GC occurs.

The existing authority lock/revision checks arbitrate competing processes; this
adapter adds no global lock. Unchanged Recapture still journals its result and
consumes the shared cap. Store durability and namespace assumptions still apply.

This is publication ordering, not an atomic authority/blob transaction. It does
not establish complete enumeration, freeze/staging, authentication, protected
service routing, enrollment, anti-rollback or live evidence. Strict stays disabled.
