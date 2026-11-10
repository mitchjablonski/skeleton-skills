# Strict tier: protected-origin decision page and status integration (#77 / #78)

Status: **design proposal only.** No production code, no listener, no launcher and no evidence producer exist. This answers the open questions in [docs/strict-transport.md](strict-transport.md) section 6 and proposes how `skel status` and the skills consume evidence (#78). [docs/strict-boundary.md](strict-boundary.md) is authoritative; where this document differs, that plan wins. **Nothing here claims containment.** Every "the agent can't reach X" below is conditional on #75 proving it for every agent path, including the model-egress path.

Owners: the launcher (#75) and the private authority, journal and evidence producer (#76) belong to Sol. The page, transport proposal (#77), status, skills and recovery copy (#78) are ours. Each section ends with what it needs from Sol, what stays unproven, and the tests it adds to #79.

The adversary assumed throughout: **the agent controls everything inside the boundary, including whatever answers on the review server's port.** `skel serve` runs inside the boundary, so the agent can replace it with any server. Treat the review origin as fully hostile script running in the human's browser.

## (a) How the browser reaches the listener

| Option | Browser reaches it by | Agent can reach | Agent can't reach (if #75 holds) | Cost |
|---|---|---|---|---|
| **A1. Launcher opens the browser** to a host-netns loopback listener | URL the launcher passes to `xdg-open` / `wslview` | Nothing new. It may learn the address; the address isn't a secret. | The listener socket: no route from the agent netns to host loopback | One process the launcher runs on the host; per-profile browser opener |
| **A2. Loopback port in the host netns, address printed** on the launcher's own terminal | The human opens or types it | Same as A1 | Same as A1 | The human copies a URL; the agent's transcript never needs it |
| **A3. Unix socket plus host-side proxy** | A small proxy exposes a loopback TCP port to the browser | Same as A1 | The socket file, if its directory is launcher-private and never mounted in | Adds a forwarder. The browser-facing port has A2's reachability, so this changes nothing for the browser and only helps if listener and authority are separate processes |
| **A4. Native window** (webview the launcher starts) | No browser origin at all | Same as A1 | Same as A1 | New dependency, WSLg on WSL, out of scope for v1 |

**Recommendation: A1 with A2 as the fallback.** The listener binds `127.0.0.1` (never `0.0.0.0`, never inside the agent netns) on a per-launch random port. The launcher opens the browser once with a one-time navigation nonce (see b). It also prints the bare origin, without the nonce, on its own terminal so the human can reopen it. Reopening goes through a fresh nonce: the bare origin shows "open from the launcher" and the launcher has a "reopen" command. A3 is acceptable as an implementation detail of Sol's process layout, not as a security layer.

Two things A1 depends on that aren't the listener's own:

- **The review server needs a forward too.** `skel serve` inside the agent netns is unreachable from the browser (that's the direction the #19 spike measured). In strict, the launcher has to forward one host loopback port inward to the review server's port. The forward carries connections host to agent only; the agent must not be able to open connections outward through it. Without it, strict has no review page, and the decision page (c) must carry the whole review.
- **Model egress must refuse host addresses.** If the model transport is a proxy the agent can address, it must refuse `127.0.0.0/8`, `::1`, the host's own interfaces and the WSL host/gateway addresses. Otherwise it's a path to the listener.

WSL: the browser is usually a Windows process. It reaches WSL loopback through localhost forwarding (NAT mode) or the shared loopback (mirrored mode). Either way, **any Windows-side process can reach the listener too.** That's in the same class as same-user host malware (b, residual), but it needs to be recorded per profile.

**Needs from Sol.** The listener's bind address and port in the host netns. A launcher command that opens and reopens the page with a fresh nonce. The inward-only review-server forward. An egress design that refuses loopback and host addresses.
**Unproven.** That agent-netns code can't reach host loopback (the spike measured the other direction). That built-in tools, MCP and hooks are inside the same netns. Browser reachability on each WSL networking mode.
**#79 tests.** From every agent path (Bash, built-in tools, subagent, MCP, hook, model-egress proxy), connect to the listener's port, the host's other loopback ports and the WSL host address: all fail. A real browser on the supported profile loads the launcher-opened page. The review-server forward accepts host-to-agent connections and gives the agent no outbound path.

## (b) Origin and CSRF without a page-carried authority secret

The hostile page is the review origin `http://127.0.0.1:R`. **It's same-site with the listener `http://127.0.0.1:L`**: a site ignores the port. Cookies ignore the port too. So "same-site" defenses (SameSite cookies, `Sec-Fetch-Site: same-site`) don't separate the two. Only exact origin does.

| Control | Defends against | Doesn't defend against |
|---|---|---|
| **Exact `Origin` check**: every non-GET request must carry `Origin: http://127.0.0.1:L`, and a missing Origin is refused | Cross-origin fetches and form posts from the review page or any web page | A same-user host process making raw HTTP requests (it can forge any header) |
| **Exact `Host` check**: `Host` must be `127.0.0.1:L` | DNS rebinding (an attacker hostname resolving to 127.0.0.1) | Same as above |
| **`Sec-Fetch-Site`**: API calls must be `same-origin`; the page document only `none` (opened by the launcher or typed) | `same-site` requests from the review origin, including top-level navigations that steer the human onto the page | Older browsers without Fetch Metadata. The `Origin` check stays the primary control, and the supported-profile matrix pins browser versions |
| **JSON only**: `Content-Type: application/json`, no CORS headers ever, preflight refused | Simple-request CSRF (form POST, `no-cors` fetch). A cross-origin read of AuthorityState comes back opaque | Nothing the Origin check doesn't already cover. This is defense in depth |
| **No framing**: `frame-ancestors 'none'` and `X-Frame-Options: DENY` | Clickjacking: the review page framing the decision page under a decoy | Social engineering in a separate tab ("go click Approve") |
| **No cookies, no storage** on the listener origin | Cookie tossing from the review origin (it can set cookies for `127.0.0.1` that the listener would receive) | n/a |
| **Per-launch random port** | Stale tabs from an earlier launch reaching a new listener; collisions | Discovery. A page can scan loopback ports. **Not a security control.** |
| **One-time navigation nonce** in the launcher-opened URL, exchanged once for an in-memory tab binding sent as a request header | A second tab or a stale tab acting as the decision page; a URL replayed from history (the nonce is dead after first use) | A same-user host process that drives the browser itself |

Reads (AuthorityState and the content capture) are GETs, which browsers send without `Origin` when same-origin. They require `Sec-Fetch-Site: same-origin` plus the binding header; a cross-origin request carrying that custom header triggers a preflight, which fails. Nothing they return is secret, since the agent wrote the content, so this only keeps stale tabs and other origins from driving the page.

**The nonce is not an authority secret.** It only picks which listener-origin tab is the live decision page. Alone it authorizes nothing: the listener still requires the exact Origin and Fetch Metadata, and the authority still checks the Intent and verifies content. A leaked binding is useless from any other origin, and from the agent, which can't reach the listener. It never appears on the review page and never enters Copy/Send. It lives only in the tab's JavaScript memory, so closing the tab drops it.

**Agent-controlled content never runs on the listener origin.** Strict CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`. No inline script. The listener serves only its own fixed assets, with no project-derived paths. All project text goes in through `textContent` (lib/review-decision.mjs already does this), with `require-trusted-types-for 'script'` as a backstop. **No diagrams on the listener origin in v1:** a diagram renderer runs a library over agent-controlled input. Diagrams stay on the review page as untrusted presentation. The approved version doesn't cover them (see c).

**Residual risk, stated plainly.** Everything above proves only that a request came from a page on the listener origin, in a browser tab the launcher opened, holding a fresh binding. **It doesn't prove a human clicked**, and it doesn't stop:

- same-user host malware or browser extensions (they can drive the browser);
- Windows-side processes on WSL;
- browser bugs;
- the human approving without reading;
- the review page persuading the human in another tab.

"Human origin" in strict means human-channel origin under these assumptions, not proof of a person.

**Needs from Sol.** The listener enforces Origin, Host and Fetch Metadata; serves no CORS headers and no cookies; serves only fixed assets under that CSP; does the nonce exchange; and refuses everything else. Also whether the tab binding is checked by the listener alone or forwarded to the authority (we suggest listener-only, since the authority's checks don't depend on it).
**Unproven.** Fetch Metadata and `Origin` behaviour on each pinned browser on the supported profile; whether `wslview` hands the URL to the browser without exposing it to other processes.
**#79 tests.** These run in a real browser. From the review origin `127.0.0.1:R`: a form POST, `fetch` with and without `no-cors`, a JSON fetch with preflight, a top-level navigation, an iframe embed, and setting a `127.0.0.1` cookie. All of them are refused, or have no effect. The same requests from a `localhost:L` origin and from a rebinding hostname are refused. A reused nonce, a stale tab from the previous launch and a second listener-origin tab without the binding are all refused. A malicious skeleton (HTML, script, `javascript:` URLs, CSP-bypass strings, oversized lines) renders as inert text, and the listener origin's CSP report shows no violations.

## (c) What the human sees versus what gets approved

The problem: the controller's `shown` (version and pending notes) currently has no trustworthy source. The review page is agent-controlled, so it can show content A while claiming version A' for content B. **A version hash cross-checked against the review page doesn't satisfy #66:** the hostile page can display harmless text beside the real hash of the malicious version.

**Proposal: the decision page renders the reviewed content itself, from the authority's own read.**

1. **The authority captures content.** When a review round opens (or on Re-read), the authority reads the workspace, computes the record the way `lib/snapshot.mjs` does (exteriors and the fence set), stores the bytes privately and content-addressed, and sets `reviewVersion` to their hash.
2. **The page renders that capture**, served by the listener as data and drawn as text: every exterior line, every fence id and title. The tab's `shown.reviewVersion` is the version **it rendered**, never one it was told. The page never live-reloads: new content appears only when the human presses Re-read, which maps to `setShown`.
3. **At commit, the writer verifies.** The workspace still produces exactly the captured bytes, otherwise `stale-review`. The approved record is the captured one.
4. **Strict versions are full-length.** The default `skeletonVersion` is 12 hex characters, which is 48 bits. An agent that controls content can find two colliding skeletons in about 2^24 tries: show one, swap in the other. Strict `reviewVersion` must be the full SHA-256 (64 hex fits the protocol's ID rule), or the writer must compare captured bytes, never the short version.
5. **The human states pending notes on the decision page.** The listener can't see drafts on the review origin, and must not trust that page's word for it. Approve on the decision page is two explicit choices: **"Approve: I have no unsent notes on this version"**, or **"I have notes"**, which sends the human to Copy/Send on the review page and offers nothing to approve. The declaration sets `shown.pendingNotes`. Approve-with-comments stays feedback (#71). The listener doesn't take notes, because that would open a listener-to-agent write path.

**Why this answers #66.** APPROVED can only name the bytes that tab drew on the protected origin, and the writer refuses unless the workspace still matches them. It still can't prove the human read them.

**Tradeoff.** The decision page duplicates the review as text. Diagrams, rich layout and feedback stay on the review page, which is labelled untrusted. Large skeletons need paging. Approve stays available, because paging changes nothing about what is bound, but the page shows "you've viewed n of m files" next to Approve. A smaller alternative, a diff against the previous approved version, is fine for reshape later but not for a first approval.

**Needs from Sol.** A content capture bound to `reviewRoundId` and `reviewVersion`. A read-only listener route that returns the capture as data (bounded size, UTF-8 text, paths as opaque display strings). A full-length `reviewVersion`. Commit-time verification against the captured bytes. A ruling on whether coverage beyond the record (the baselined source set) is in what the human approves; it isn't today.
**Unproven.** That rendering the full capture is usable for real skeletons. That the authority's workspace read can't be raced: the writer's commit-time check must be atomic with its read (#76).
**#79 tests.** The agent edits the exterior between capture and click, and between click and commit: no approval, and the shown version is unchanged until Re-read. The review page shows content A and version A' while the workspace holds B: the decision page shows B, and approving names B. A 48-bit collision pair (two exteriors with equal 12-hex `skeletonVersion`) gets distinct strict versions. With "I have notes", nothing can be sent. A malicious exterior renders inert (shared with b).

## (d) requestId retention and recovery (UX requirements for Sol's journal)

These are requirements on behaviour. Storage is Sol's choice.

- **R1. Retention.** A requestId and its original Result can be found at least until its session ends, across listener and authority restarts within the session.
- **R2. Unknown ID with an intact journal** is processed as a new request. The first attempt never committed, and the intent's `expectedRevision` still guards against anything that has happened since. The page treats the answer like any other.
- **R3. A journal that can't be trusted** (missing, corrupt or discontinuous) means the authority answers `unavailable` to everything until recovery finishes. If recovery can't reconstruct it, the session ends (`session-ended`). It never answers "not found, so process it as new" from a damaged journal.
- **R4. After the session ends**, any requestId gets `session-ended`. The page then says the decision may or may not have landed and shows the last state it read.
- **R5. Kept intents live only in tab memory.** A new or reloaded tab never offers Retry for an old intent; it re-reads AuthorityState, which settles approve (`approvedVersion` at or after the revision) and offers a fresh decision. The UI needs no lookup by ID.
- **R6. Listener restart.** The port is per-launch, so an old tab's request fails as a network error. The page treats that as an unknown outcome (as today), then says "the decision service restarted: reopen the page from the launcher", and holds actions. The new tab's first read settles it.

Recovery copy, per state:

| State | Copy (next step) |
|---|---|
| Retry still unknown | "Still unconfirmed. Retry asks for the original answer; Re-read shows the current state." |
| Authority recovering (R3) | "The decision service is recovering its records. Nothing is shown as approved. Wait, then Re-read." |
| Listener gone (R6) | "This page's decision service has stopped. Reopen the page from the launcher; the new page shows whether the decision landed." |
| Session ended (R4) | "The strict session ended. This page can't tell whether the last decision landed; start a new session through the launcher and check its state." |

**Needs from Sol.** R1 to R4 as journal behaviour. A ruling on whether R3 needs its own rejection code (`recovering`) or `unavailable` is enough. We think `unavailable` is enough, because the page's handling is the same.
**Unproven.** All of it until the journal exists.
**#79 tests.** Commit, then kill the authority before the reply, restart, retry the same ID: the original Result comes back. Same ID with a changed intent: `request-reused`. Corrupt the journal: every request is refused, nothing new commits, and a fresh session is required. Restart the listener mid-request: the old tab shows the R6 copy, and the new tab's state shows the true outcome. Reload the tab after `unavailable`: no Retry is offered, and the state settles it.

## (e) Status and skills integration (#78)

**Status inside the boundary is advice, not a gate.** `skel status` and the skills run inside the agent's boundary. The agent can run any program, including a copy of skel that prints `active`, and can point any verifier at a file it wrote. So agent-side status can never be made unforgeable *to the agent*. It doesn't need to be: the writer refuses regardless of what status says. Two consequences:

- **The status the human trusts is shown outside:** on the decision page (from the listener) and on the launcher's terminal. Copy never tells the human to trust `skel status` in the agent transcript for strict.
- **Inside, status routes:** it refuses early with the right recovery copy, and it keeps the skills from pretending to approve.

**Who produces evidence.** Sol's authority signs RuntimeEvidence. The launcher puts it, and the context it binds to, in a **read-only** mount it supplies, refreshed by the authority. A production verifier, `launcherVerifier`, implements the existing interface `verify({projectId, sessionId}) → RuntimeEvidence`. It reads that mount, checks the signature with a public key pinned in the read-only install, and returns the evidence. `classifyEvidence` stays as it is: freshness caps, binding and profile.

**Identity.** Today `skel status` passes the project root as `projectId` and `null` as `sessionId`. In strict, both come from the launcher's read-only context, as the opaque authority-assigned IDs (strict-protocol IDs are not paths).

**How `requested` is set.** Never from a project file, settings or environment.

- **Under the launcher:** `requested: true` comes from the launcher's read-only context.
- **Outside the launcher:** a host-level enrollment registry outside the workspace, written only by the launcher at enrollment, names enrolled projects. Plain skel reads it. A match gives `requested: true` and `unverified:launcher-absent`, so privileged actions refuse and nothing falls back silently. This registry can only make skel *more* restrictive: it can never produce `active`.
- **Residual:** outside the launcher, the agent has full user access and can delete the registry entry. Then plain skel shows default mode. Private authority is unaffected (strict-boundary.md), and the next strict launch reports the divergence (below).

**Recovery copy.** The existing reasons and copy in `lib/strict-status.mjs` stay. Proposed additions:

| Condition | Who detects | Proposed state / reason | Next step |
|---|---|---|---|
| Public `.skeleton/` disagrees with the authority (an approval made outside strict, or erased public state) | Authority, at launch or Re-read | `unverified:state-diverged` (new) | "This project's public review state doesn't match the strict record. Approve, reshape and finalize are refused. Review again from the decision page; don't edit `.skeleton/` to match." |
| Authority recovering its journal | Authority | `unverified:evidence-stale` (existing) until fresh evidence returns | Existing copy |
| Listener not running while evidence is fresh | Launcher | Not a status state. The launcher reports it on its terminal and its reopen command restarts the listener | "Reopen the decision page from the launcher." |
| Skill asked to approve in strict | Skill | n/a | The skill tells the human to decide on the decision page the launcher opened and stops. It never runs `skel approve`, never asks for a token (current SKILL.md text already says this) |

**Needs from Sol.** The evidence signature and pinned key. The read-only mount and its refresh, liveness, revocation and clock-rollback rules (the caps in `strict-status.mjs` stay provisional until then). Opaque IDs in the launcher context. The host enrollment registry: its location, who writes it, and that the launcher writes it. Whether `state-diverged` is evidence the authority emits or a local reason.
**Unproven.** Liveness. A signed record proves origin, not that the authority is alive now. The proposal relies on short lifetimes plus refresh, and both need Sol's revocation design.
**#79 tests.** Outside the launcher, with the project in the registry: `requested: true`, `unverified:launcher-absent`, privileged refused. An agent-written evidence file, an env var pointing the verifier at it, a replayed genuine record from an earlier session, and a record signed with another key: none reaches `active`. Delete public `.skeleton/` and relaunch: `state-diverged`, not "no skeleton". The skills, driven in a real session, never run a privileged command in strict and give the decision-page instruction. The default-mode status output and approve path are unchanged.

## Questions for Sol

1. (a) Do you accept a host-netns loopback listener on a per-launch port, opened by the launcher with a nonce? And an inward-only forward for `skel serve`?
2. (a) Will the egress design refuse loopback, host and WSL-gateway addresses?
3. (b) Should the listener alone check the tab binding, with the authority never seeing it?
4. (c) Will the authority capture content per round, serve it read-only to the listener page, and verify the captured bytes at commit? And use a full-length strict `reviewVersion` (the 12-hex version is collision-prone against an adversarial agent)?
5. (c) Is the baselined coverage set part of what the human approves in strict?
6. (d) Do you accept journal requirements R1 to R4? Is `unavailable` enough while recovering, or do you want a separate code?
7. (e) How is evidence signed and refreshed, and what are its lifetime and revocation rules? Who writes the host enrollment registry, and where does it live?
8. (e) Should `state-diverged` be emitted by the authority or derived locally?
