# Local launcher binding fixture (#178)

From the repository root on Linux, run with an absolute Node executable and its independently selected SHA-256 pin.

```sh
/usr/bin/python3 -I test/live/strict-launcher-binding-probe.py \
  --node /home/mitch/.nvm/versions/node/v20.20.0/bin/node \
  --node-sha256 d01614ef369e36eee9ab8d86fbfa93ddf44931010add45e5262a63e3ddda784e
```

The Python launcher owns each pair of child process handles. It creates a fresh unnamed Unix socketpair and a dedicated console-to-launcher pipe per generation. Only the authority and console inherit their respective socket ends. Only that console inherits the pipe writer. The authority opens the selected durable store with the supplied context before attaching the command server. The console uses the existing channel client to call `state()` once, writes one bounded JSON observation to its pipe, closes the writer, and retains the client. The launcher associates the observation with the object owning that pipe. No child-supplied identity label enters this decision.

The launcher compares the report origin with its current generation, consumes the report once, requires the selected enrollment and expected live state, and checks both owned children immediately before spawning a fixed marker-writing child. Expected versions come from the fixture's initial capture during enrollment. The harness checks marker creation and compares private authority and immutable capture file contents after every case.

| Case | Required result |
| --- | --- |
| Live A | One marker child starts. |
| Repeat A's consumed report | The first admission starts one child. The repeated admission leaves its marker absent. |
| A's context, B's store | Open fails in the authority. The console receives unavailable. |
| Correctly opened B, admission requests A | Both children are alive and B returns identical public state. The enrollment-object check refuses. |
| A's context, different saved capture | Both children are alive. The revision, review version, and admission state match, but the capture version differs. The state check refuses. |
| Replace the original A generation | Both original peers are still alive and the replacement returns identical state. The old report fails the generation check. |
| Revoked enrollment | A separately prepared durable store reports revoked admissions. |
| Authority or console exits after reporting | The harness waits for the selected child to exit before admission. Both cases leave their markers absent. |

All helpers are fixed leaf processes running under the same trusted Linux user. The harness kills and waits for its children on exit and retains scratch if it cannot confirm cleanup. The pipe is a local fixture reporting mechanism. The existing command protocol and durable store format are unchanged.

The fixture leaves strict mode unverified. A real terminal, protected enrollment selection and storage, listener gates, the check-to-spawn race, termination of a running namespace and its descendants, and checkpoint or restart supervision still require independent evidence. The peer replacement case checks only report freshness. See the [enrollment binding design](strict-enrollment-binding.md).
