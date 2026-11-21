# Authority-child adapter fixture (#186)

The disabled adapter uses existing capture and authority stores in two separate
child modes. The launcher selects the expected project and session, supplies
the pre-enrolled authority and capture directories, and owns the inherited
descriptors. The fixture creates these inputs under disposable private scratch.

- **Serving.** `serveHumanAuthorityChild` opens the capture store and the
  selected authority for the expected context before attaching the existing
  four-method command server to the inherited endpoint. Failed open closes the
  endpoint and refuses. An absent store stays absent. The console owns its
  channel sequence. The launcher uses the designated console's report and
  owned process handles to decide admission.
- **Recovery.** The supervisor owns the stop proof and the decision to attempt
  one recovery for the fault. `recoverHumanAuthorityChild` consumes a distinct,
  binary input. It accepts one compact JSON object with `operation` and `args`,
  up to 1,024 bytes through EOF within one second. The fixture launcher sends the
  exact retained request over a dedicated inherited socket. The child replies
  once over a separate inherited pipe. Retained command arguments travel
  through the input descriptor and stay out of argv, the environment and logs.
  The adapter opens the history reader for the selected enrollment. It returns
  the result already recorded for the exact normalized command identity, or
  unavailable, then closes its input. Recovery uses a transient holder lock
  and durability checks. It leaves authority record and capture bytes intact
  and has no command server or start gate.

The [launcher binding probe](strict-launcher-binding-fixture.md) exercises
both modes with real inherited descriptors. Recovery can return a previously
committed approval after admissions were revoked. Absent, mismatched,
wrong-context, or locked history refuses. The launcher also checks incomplete,
malformed and oversized input, a second request, and descriptor separation.
The fixture compares durable authority and capture bytes and checks that
recovery starts no marker child.

The adapter consumes already-enrolled paths and an already-owned endpoint.
Serving readiness checks the reported capture identity. The serving adapter
opens the capture directory and leaves validation of the requested capture
bytes to the command and supported-runtime start gates that consume them.
Supported-runtime directory validation, process supervision and proof of
physical stop, bound readiness during a real restart, and durable retention of
an in-flight request remain separate integration work. Strict remains disabled
and unverified.
