# Strict boundary implementation plan (#75 / #76)

Status: protocol groundwork only. There is no strict launcher, private writer,
human listener or authenticated runtime evidence in this change. Default mode
is unchanged. Nothing here enables containment or authorizes a transition.

## Trust map and first supported profile

Candidate v1 is a pinned Claude Code CLI launched as a whole process inside a
minimal Linux boundary. Linux/WSL support must be demonstrated for each profile;
native Windows, macOS, IDE/Desktop and arbitrary MCP bridges are not supported
by inference. The existing Bubblewrap OS probe and Bash sandbox network probe
are feasibility evidence, not whole-agent acceptance evidence.

| Component | Placement and authority |
|---|---|
| CLI, built-in tools, shell, children, filler | Inside one process/filesystem/network boundary; no inherited host authority |
| Enabled local MCP and hooks/plugins | Inside that boundary, with immutable implementation/config; refuse unverified outside bridges |
| Project files and public verification snapshots | Readable inside; permitted workspace writes remain possible; drift checked before completion |
| Private authority, receipts, human listener | Outside; no agent-visible key, writable implementation or alternate writer |
| Human decision UI | Served by the outside human listener, on its own origin; never executes scripts supplied by the project |
| Source/feedback review server | Untrusted source/feedback channel; its token never authorizes approval/reshape |
| Model transport | Explicit restricted egress design required; do not expose host credential files, arbitrary network or host proxy sockets |

The launcher must start from an empty/minimal filesystem view, pass an explicit
environment and descriptor allowlist, isolate host processes and sockets, and
refuse unsupported mount/interop/network/tool configurations. Read-only code
can still be copied/executed: secrecy of a command path is not authority.

First implementation milestones:

1. Enumerate the actual CLI's runtime, credential and model-transport needs in
   a disposable profile. Review every mount/socket/descriptor before execution.
2. Construct the whole-process launcher; initially disable optional MCP and
   outside tool bridges. Refuse launch when requirements cannot be proved.
3. Run actual built-in tool and child-process acceptance cases from #79, with
   protected outside assets and verified cleanup. Do not substitute OS-only
   fixtures for the actual client/tool test.
4. Add the outside writer and human listener only after the profile boundary
   passes. Installation or dependency checks never produce `strict active`.

## Protocol v1 groundwork

`lib/strict-protocol.mjs` validates data shapes and pure transition preconditions.
It is not loaded by default CLI/hook/server code. Passing validation, or receiving
a public `AuthorityState`, grants no capability and does not prove human origin.

- IDs are bounded opaque authority-assigned strings, not project paths. Bind
  canonical project identity and fresh session/round identity at registration.
- State exposes current reviewable `reviewVersion`, phase, approved version
  and revision. Human decisions re-read it through the protected listener;
  public copies are informational only.
- Actions initially are `approve`, `reshape`, `finalize`. `replace` is undefined
  and is removed. Strict `init --force` and `migrate` must refuse until dedicated
  protected semantics are implemented. Removing public `.skeleton/` cannot
  clear private authority or make an enrolled project look unenrolled.
- Approve refers to the current reviewable version. Reshape/finalize refer to
  the currently approved version. The writer verifies current content itself.
  Finalize also requires completed steps and drift checks; protocol preconditions
  alone cannot permit it.
- Expected revision is compared and committed atomically. Persist request ID,
  canonical intent and result in the same durable transaction. Same ID/intent
  returns the original result across restart; different intent is `request-reused`.
- `unavailable` can mean an unknown outcome, including a lost committed reply.
  Never treat it as proof nothing happened. Retry the same request ID; authority
  recovery reconciles its durable journal before accepting any new transition.
- Successful replies echo request ID, action, version and committed revision.
  UI must still re-read authoritative state before showing approval.

## Evidence and remaining proof

Runtime status needs authenticated, live, project/session-bound evidence from
the outside authority. Wall-clock `observedAt`/`expiresAt` describe freshness
but cannot authenticate or prove liveness. Initial fixture caps are not production
policy; production activation must define restart, revocation, clock rollback
and expiry semantics. No active state from a writable JSON file, environment,
settings inspection or browser response. Missing proof means unverified/refused.

The proposed human listener is outside the agent network namespace and serves
its own trusted UI. Its address need not be secret; its inaccessibility must be
proved, including every model/network proxy path. Browser-origin/CSRF handling,
source/diagram isolation, stale review, durable writes, identity aliases and
all actual-runtime escape cases remain implementation gates in #75–#79.

These guarantees protect phase authority and detect drift before completion.
They do not prevent every exterior workspace write. A fence-write containment
claim additionally requires a mediated/staged publication mechanism.
