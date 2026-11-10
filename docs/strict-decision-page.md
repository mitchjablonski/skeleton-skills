# Strict tier: protected-origin decision page and status integration (#77 / #78)

Status: **design proposal only.** No production code, no listener, no launcher and no evidence producer exist. This answers the open questions in [docs/strict-transport.md](strict-transport.md) section 6 and proposes how `skel status` and the skills consume evidence (#78). [docs/strict-boundary.md](strict-boundary.md) is authoritative, and so is #83's `docs/strict-authority.md` once it merges; where this document differs, they win. **Nothing here claims containment.** Every "the agent can't reach X" below is conditional on #75 proving it for every agent path, including the model-egress path.

Owners: the launcher (#75) and the private authority, journal, capture and evidence producer (#76, #83) belong to Sol. The page, the transport proposal (#77), status, skills and recovery copy (#78) are ours. Each section ends with what it needs from Sol, what stays unproven, and the tests it adds to #79.

Adversaries assumed throughout:

- **The agent controls everything inside the boundary.** That includes the workspace, its `.git/` directory, and whatever answers on the review server's port. `skel serve` runs inside the boundary, so the agent can replace it with any server.
- **The review origin is hostile script in the human's browser.** It has whatever network reach the browser has: the internet and every host loopback port.
- **The agent shares the launcher's terminal.** A whole-process launcher runs the agent on the same PTY, so the agent can overwrite anything printed there with ANSI escapes, print fake status lines, and read what the human types.

## The trusted human channel

The human trusts exactly two things:

- **The launcher control channel.** This is a surface the agent can't write to or read from. Either the launcher opens a separate terminal or window it alone owns, or the controls live only on the decision page and the launcher's own terminal carries nothing to trust.
- **The decision page at the origin that channel names.**

Everything on the agent's terminal is untrusted, including anything the launcher printed there before or after the agent started. That covers origins, status and "reopen" prompts. The control channel shows:

- the decision page's origin;
- a reopen control;
- strict status;
- **an echo of every committed transition**: action, version, revision and time. A transition the human didn't make is visible there even when the agent's terminal says otherwise.

## (a) How the browser reaches the listener

| Option | Browser reaches it by | Agent can reach (if #75 holds) | Cost |
|---|---|---|---|
| **A1. Launcher opens the browser** to a host-netns loopback listener | The launcher hands the URL to the browser | Nothing new. The address isn't a secret; the socket has no route from the agent netns | Per-profile browser opener |
| **A2. Loopback port in the host netns, address shown on the control channel** | The human opens it from the control channel | Same as A1 | One manual step |
| **A3. Unix socket plus host-side proxy** | A forwarder exposes a loopback TCP port | Same as A1 for the browser-facing port | Adds a hop and changes nothing for the browser |
| **A4. Native window** started by the launcher | No browser origin | Same as A1 | New dependency (WSLg on WSL); out of scope for v1 |

**Recommendation: A1, with A2 as the fallback.** Parts:

- **The listener** binds `127.0.0.1` in the host netns, never `0.0.0.0` and never inside the agent netns, on a per-launch random port.
- **Opening the page.** The launcher opens the browser with a one-time navigation nonce (b). Reopening goes through the control channel and always mints a fresh nonce. It can't be triggered from the agent's terminal, the review page or anything else the agent can write.
- **Only the listener is TCP.** The hostile review origin can reach every host loopback port, so every other launcher-owned link uses Unix sockets in a launcher-private directory that is never mounted into the boundary. That covers listener to authority, evidence refresh and reopen. A3 is acceptable only as that internal layout.

**New boundary crossings this adds**, each to be recorded in strict-boundary.md's trust map:

- **The review server forward.** `skel serve` inside the agent netns is unreachable from the browser. That is the direction the #19 spike measured. Strict needs a launcher forward from one host loopback port inward to the review server's port. The forward carries connections host to agent only and gives the agent no outbound path. It is a new crossing, missing from the current trust map. Without it, strict has no review page, and the decision page (c) carries the whole review.
- **Agent script in the browser.** The review origin runs agent-supplied script in a browser that has internet and loopback egress. That bypasses the model-egress limits for **exfiltration**: anything the agent can put on the review page, it can send anywhere. The page's CSP limits the review server's own pages, but the agent controls those headers. Strict makes no confidentiality claim for content the agent can read, and the trust map has to say so.

**Model egress must refuse host and local addresses.** If the model transport is a proxy the agent can address, it refuses:

- all of `127.0.0.0/8`, `0.0.0.0/8`, `::1`, `::` and `::ffff:127.0.0.0/104`;
- the host's own interfaces;
- the WSL host and gateway addresses, and in mirrored mode the Windows host addresses.

It checks the **resolved address it actually connects to**, not the requested name, so DNS rebinding and names resolving to any of these are refused.

**Agent-driven browser paths are a launcher requirement, not residual risk.** The agent must not be able to start or steer the human's browser. If any of these is visible inside the boundary, the launcher refuses to start:

- WSL interop (`cmd.exe`, `powershell.exe`, binfmt `WSLInterop`);
- write access to `/mnt/*`;
- a session D-Bus or XDG portal (OpenURI);
- `xdg-open`, or any browser binary that reaches the host display;
- the host's browser profile directories.

A specific attack: the agent pre-launches the default-profile browser with remote debugging enabled. The launcher's later URL then lands in that instance, and the agent clicks Approve over CDP. Mitigations:

- The launcher opens the page in a **fresh, launcher-owned browser profile** with remote debugging off.
- Alternatively, the launcher refuses if a debugging port or pipe is already open for the target browser.

WSL: the browser is usually a Windows process. It reaches WSL loopback through localhost forwarding (NAT mode) or the shared loopback (mirrored mode). **Any Windows-side process can reach the listener too.** Record that per profile, and treat the human's Windows session as trusted host.

**Needs from Sol.**

- The listener's host-netns bind and port.
- The control channel (separate terminal or window, or page-only controls) and reopen through it.
- Unix sockets for every internal link.
- The inward-only review forward, and the trust-map entries for it and for browser exfiltration.
- The egress refusal list, checked on connected addresses.
- The launch refusals for interop, `/mnt/*`, a session bus, browser openers and debugging ports.
- A fresh browser profile.

**Unproven.**

- That agent-netns code can't reach host loopback. The spike measured the other direction.
- That built-in tools, MCP and hooks share that netns.
- Browser reachability on each WSL networking mode.
- That a fresh profile can be opened from WSL on Windows without exposing the URL to other processes.

**#79 tests.**

- **Agent reach.** From every agent path (Bash, built-in tools, subagent, MCP, hook, model-egress proxy), connect to the listener, the internal Unix sockets, other host loopback ports and the WSL host address. Include `0.0.0.0:L`, `[::]:L`, `[::ffff:127.0.0.1]:L`, `127.1.2.3:L` and a hostname that rebinds to 127.0.0.1. All fail.
- **Launch refusals.** Launch with interop enabled, with `/mnt/c` writable, with a session bus visible, and with a browser already running with remote debugging. Each is refused.
- **Terminal.** The agent writes ANSI that rewrites the screen and prints a fake origin and "strict: active". None of it reaches the control channel, and reopen can't be triggered from the agent's terminal.
- **Browser.** A real browser on the supported profile loads the launcher-opened page.
- **Review forward.** It accepts host-to-agent connections and gives the agent no outbound path.

## (b) Origin and CSRF without a page-carried authority secret

The hostile page is the review origin `http://127.0.0.1:R`. **It's same-site with the listener `http://127.0.0.1:L`**: a site ignores the port. Cookies ignore the port too. So same-site defenses (SameSite cookies, `Sec-Fetch-Site: same-site`) don't separate the two. Only exact origin does.

| Control | Defends against | Doesn't defend against |
|---|---|---|
| **Exact `Origin`**: every non-GET request carries `Origin: http://127.0.0.1:L`; a missing Origin is refused | Cross-origin fetches and form posts from the review page or any web page | A host process sending raw HTTP (it can forge headers) |
| **Exact `Host`**: `127.0.0.1:L` only; `localhost:L`, `0.0.0.0:L`, `[::1]:L` and anything else are refused | DNS rebinding | Same as above |
| **`Sec-Fetch-Site` required**: API calls must be `same-origin`, the document must be `none`, and a request without the header is refused (no fallback to Origin) | `same-site` requests from the review origin, including navigations that steer the human onto the page; old browsers | Same as above. Pinned browser versions belong in the profile matrix |
| **JSON only**, no CORS headers ever, preflight refused, HTTP/1.1 only | Simple-request CSRF (form POST, `no-cors` fetch); a cross-origin read comes back opaque | Defense in depth only |
| **No framing**: `frame-ancestors 'none'`, `X-Frame-Options: DENY` | Classic clickjacking | Double-clickjacking and focus stealing (next row) |
| **Approve arms late and confirms**: Approve stays disabled until about one second after the page last gained focus or visibility, and then needs a separate confirm step | Double-clickjacking, focus steal, a click carried over from another window | The human choosing to approve without reading |
| **No cookies, no storage**: the listener ignores `Cookie` headers of any size | Cookie tossing from the review origin; cookie-bomb denial of service | n/a |
| **Response headers**: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` | Cached captures, the nonce leaking in a referrer, cross-origin embedding of responses | n/a |
| **Per-launch random port** | Stale tabs from an earlier launch; collisions | Discovery: a page can scan loopback ports. **Not a security control.** |
| **One-time navigation nonce** in the **URL fragment**. Page script consumes it with a POST (so prefetch or a speculative GET can't burn it), strips it with `history.replaceState`, and gets back an in-memory tab binding sent as a request header | A second or stale tab acting as the decision page; replay from history | A process that can drive the browser (mitigated in a) |

**Reads.** AuthorityState and capture pages are GETs, which browsers send without `Origin` when same-origin. They require `Sec-Fetch-Site: same-origin` and the binding header. A cross-origin request carrying that custom header triggers a preflight, which fails. Re-read is not a read (c).

**The nonce is not an authority secret.** It only picks which listener-origin tab is the live decision page:

- Alone, it authorizes nothing. The listener still requires the exact Origin and Fetch Metadata, and the authority still checks the Intent.
- It's useless from any other origin, and the agent can't reach the listener.
- It never appears on the review page or in Copy/Send, and it lives only in the tab's memory.

**Agent-controlled content never runs on the listener origin.**

- Strict CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`, plus `require-trusted-types-for 'script'`.
- The listener serves only its own fixed assets, with no project-derived paths.
- All project text goes in through `textContent`, which lib/review-decision.mjs already uses.
- **No diagrams on the listener origin in v1.** Diagrams stay on the review page as untrusted presentation.

**Residual risk.** This proves only that a request came from a page on the listener origin, in a tab opened through the control channel, holding a fresh binding. It doesn't prove a human clicked, and it doesn't stop:

- host malware or browser extensions in the human's own session;
- browser bugs;
- the human approving without reading;
- the review page persuading the human in another tab.

**Needs from Sol.** Listener enforcement of every row above. The nonce exchange as a POST. A ruling that the tab binding is checked by the listener alone; we suggest that, since the authority's checks don't depend on it.

**Unproven.** Fetch Metadata and `Origin` behaviour on each pinned browser.

**#79 tests**, in a real browser:

- **From the review origin:** a form POST, `fetch` with and without `no-cors`, a JSON fetch with preflight, a top-level navigation, an iframe embed, setting a `127.0.0.1` cookie, and an oversized cookie. All are refused or have no effect.
- **Wrong origins and hosts:** the same requests from `localhost:L`, a rebinding hostname, and `Host` values of `0.0.0.0:L` and `[::1]:L` are refused.
- **Missing Fetch Metadata:** a document request without `Sec-Fetch-Site` is refused.
- **Nonce and tabs:** a reused nonce, a prefetch of the nonce URL, a stale tab from the previous launch, and a second tab without the binding are all refused. The nonce isn't in history after load.
- **Clicks:** a double-click lure and a focus-steal attempt from the review origin don't approve. Approve isn't armed within the delay after focus changes.
- **Leaked token:** the review/feedback token from `.skeleton/serve.json` is presented to the listener in every header and body position. It's refused and grants nothing.
- **Malicious skeleton:** a skeleton containing HTML, script, `javascript:` URLs, CSP-bypass strings and oversized lines renders inert, with no CSP violations.

## (c) What the human sees versus what gets approved

The controller's `shown` value (version and pending notes) has no trustworthy source today. The review page is agent-controlled, so it can show content A beside the real hash of malicious content B. A hash cross-check therefore doesn't satisfy #66. **The decision page renders the reviewed content itself, from a capture the authority makes.**

**C1. Capture runs nothing and follows nothing.** Capture is the first host code to touch agent-controlled bytes, so:

- **No subprocesses and no git.** The default scan runs `git grep` and `git ls-files` in the agent's repository (lib/markers.mjs). Git executes code named in the agent-writable `.git/config` (`core.fsmonitor`, hooks, filters), so reusing that scan host-side hands the agent code execution as the authority.
- **No symlinks.** lib/snapshot.mjs `readText` follows a symlink after its inside-root check, so a swap to `~/.ssh/...` would copy host secrets into the approved record and the public snapshot.
- **The rules:**
  - Every open resolves beneath the workspace without following any symlink (`openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, or per-component `O_NOFOLLOW`).
  - It takes regular files only (refusing FIFOs, devices and sockets), and refuses hard links (`st_nlink > 1`) unless Sol can bound them another way.
  - It reads with `fstat` on the open descriptor and caps per-file size, file count and total bytes.
  - It runs with least privilege: a capture process that can read only the workspace, never the private store or the user's home.
- **Choosing the files.** The proposed split: the agent-side scan (inside the boundary) names the files and fences, and the host capture only opens, reads and hashes those named files under the rules above. The list is untrusted. A wrong list only changes what the human sees and approves, and the human sees exactly that.

**C2. The capture is the approved record.**

- The capture is stored privately, content-addressed.
- `reviewVersion` is a full SHA-256 over a **canonical, length-prefixed serialization of exactly the bytes served to the page**: each path, file content and fence id and title, in sorted order. That replaces the default `skeletonVersion`, which keeps 12 hex characters (48 bits, lib/snapshot.mjs). An agent can find two colliding skeletons in about 2^24 tries, show one and swap in the other. Strict doesn't extend the short hash; it hashes the served capture.
- The approved record **is** the capture, not a later re-read. A torn or racing workspace read at commit time affects only drift detection, never what was approved.

**C3. The page shows what it was given, in a form a human can perceive.**

- Capture pages are fetched by capture version, so one view never mixes two captures.
- Drawn text isn't necessarily what the human perceives, so the page:
  - shows bidi controls, zero-width and other invisible characters as visible escapes;
  - wraps long lines (nothing hides past the right edge);
  - flags non-ASCII and confusable characters in paths and identifiers.
- Paging shows "you've viewed n of m files" next to Approve.

**C4. Re-read is a mutation.**

- Re-read asks the authority to recapture, which can change `reviewVersion`. It's a journaled host operation, a POST behind the same Origin, Fetch Metadata and binding checks, never a GET. #83 lists "refreshing a changed draft's reviewable version" as an unspecified host operation; this is that operation.
- After a Re-read, the page shows a **diff against the capture it previously rendered**, so a change is visible rather than buried in a full re-render.
- The page never live-reloads, and the tab's `shown.reviewVersion` is always the capture it rendered (`setShown` on Re-read).

**C5. Pending notes are declared on the decision page.** The listener can't see drafts on the review origin and must not trust that page's word. Approve is two explicit choices:

- **"Approve: I have no unsent notes on this version"**;
- **"I have notes"**, which sends the human to Copy/Send on the review page and offers nothing to approve.

The declaration sets `shown.pendingNotes`. The listener takes no notes, because that would open a listener-to-agent write path.

**Why this answers #66.** APPROVED can name only bytes that the tab drew on the protected origin. It still can't prove the human read them.

**Needs from Sol.**

- Capture under C1, with the scan split or an alternative.
- Content-addressed private storage and the canonical serialization.
- Re-read/recapture as a journaled host operation.
- A read-only, version-addressed capture route.
- A ruling on whether the baselined coverage set is part of what the human approves (today it isn't).

**Unproven.**

- That openat2 or `O_NOFOLLOW` capture is available and correct on each profile's filesystem, including 9p/drvfs on WSL.
- That full-text review is usable for real skeletons.

**#79 tests.**

- **Hostile `.git/config` and hooks:** `core.fsmonitor`, filters and hooks never execute during capture.
- **Links:** a symlink to a host file, a symlink swapped in during capture (TOCTOU), a symlinked parent directory and a hard link to a host file are all refused, and no host bytes enter the capture or the public snapshot.
- **Special and oversized files:** a FIFO, a device node, a huge file and too many files are refused without hanging.
- **Edits between steps:** edit the workspace between capture and click, and between click and commit. The approved record equals the capture shown, and nothing approves a version the tab didn't render.
- **Hostile review page:** the review page shows A and the hash of A while the workspace holds B. The decision page shows B, and approving names B.
- **Collisions:** a pair with equal 12-hex `skeletonVersion` gets distinct strict versions.
- **Perception:** bidi, zero-width and confusable fixtures render visibly flagged.
- **Re-read:** a cross-origin or bindingless Re-read is refused; a valid Re-read shows the diff.
- **Notes:** with "I have notes" selected, nothing can be sent.

## (d) requestId retention and recovery (UX requirements for Sol's journal)

These requirements follow #83 (`docs/strict-authority.md`) and strict-boundary.md. Storage is Sol's choice.

- **R1. Retention.** Committed results and terminal rejections stay findable, as #83 retains them, across listener and authority restarts. Invalid requests, wrong-channel attempts and `unavailable` host facts don't reserve an ID (#83), so a Retry after those is processed normally.
- **R2. Unknown ID with a readable record** is processed as a new request. `expectedRevision` still guards against anything that happened since.
- **R3. A missing or corrupt enrolled record is a refusal.**
  - Every request refuses.
  - A new session refuses too, until a reviewed outside-host recovery runs.
  - State is never re-derived from `.skeleton/` or any public file, and a missing record never means "no skeleton" or "bootstrap".
- **R4. Journal full.** At #83's 1024-entry cap, new transactions refuse without pruning, and existing retries still resolve. The page tells the two apart.
- **R5. Session end.** If the record persists across sessions, the new session's AuthorityState answers whether an old decision landed (`approvedVersion` at or after the revision), and the page says so. Only when no state is readable does it say the outcome is unknown.
- **R6. Kept intents live only in tab memory.** A new or reloaded tab never offers Retry for an old intent; it reads AuthorityState, which settles approve.
- **R7. Listener restart.** The port is per-launch, so an old tab's request fails as a network error. The page treats that as an unknown outcome, tells the human to reopen from the control channel, and holds actions.

Recovery copy, per state:

| State | Copy |
|---|---|
| Retry still unknown | "Still unconfirmed. Retry asks for the original answer; Re-read shows the current state." |
| Record missing or corrupt (R3) | "The strict record for this project can't be read, so every decision is refused, in this session and new ones, until the record is recovered outside this session. Don't edit or delete `.skeleton/` to work around it." |
| Journal full (R4) | "The strict record is full, so new decisions are refused. Earlier decisions still resolve. It needs recovery outside this session." |
| Listener gone (R7) | "This page's decision service has stopped. Reopen the page from the launcher's control window; the new page shows whether the decision landed." |
| Session ended (R5) | "The strict session ended. Open the new session's decision page: its state shows whether the last decision landed." |

**Needs from Sol.** R1 to R5 as journal behaviour, consistent with #83. A rejection code or evidence reason that distinguishes "record unreadable" and "journal full" from transient `unavailable`, because their copy differs: neither is fixed by retrying.

**Unproven.** All of it until durable storage exists. #83's JSON reload tests aren't durable commits.

**#79 tests.**

- **Crash recovery:** commit, kill the authority before the reply, restart, retry the same ID; the original Result comes back.
- **Changed intent:** the same ID with a changed intent gets `request-reused`.
- **Corrupt or delete the record:** every request refuses, a new session also refuses, and deleting `.skeleton/` doesn't change that.
- **Full journal:** fill to 1024 entries; new requests refuse and old retries resolve.
- **Listener restart mid-request:** the old tab shows the R7 copy and the new tab shows the true outcome.
- **Reload after `unavailable`:** no Retry is offered.

## (e) Status and skills integration (#78)

**Status inside the boundary is advice, not a gate.**

- `skel status` and the skills run inside the boundary. The agent can run a copy of skel that prints `active`, or point a verifier at a file it wrote. So agent-side status can't be made unforgeable *to the agent*.
- The human-trusted status is shown on the **control channel and the decision page**, never in the agent's terminal or transcript.
- Inside, status routes: it refuses early, gives recovery copy, and keeps the skills from pretending to approve.

**In-boundary privileged CLI transitions always refuse in strict, even when active.** `skel approve`, `skel reshape` and `skel finalize` inside the boundary are never a strict writer, so in a strict project they refuse whatever status says. The only strict transition path is the decision page.

- **Required code change for integration:** `refusePrivileged` in lib/strict-status.mjs returns `null` (allow) when status is active. Production wiring must not use it as the gate for in-boundary CLI transitions. Those need an unconditional strict refusal, and `refusePrivileged` stays a copy helper for status display.
- The current copy ("refused until status shows active") must change to point at the decision page.

**Who produces evidence.**

- Sol's authority signs RuntimeEvidence and refreshes it into a **read-only** mount the launcher supplies, over a launcher-private Unix socket.
- A production `launcherVerifier` implements the existing `verify({projectId, sessionId}) → RuntimeEvidence`. It reads the mount, checks the signature against a public key pinned in the read-only install, and returns the evidence.
- `classifyEvidence` keeps the freshness caps, binding and profile checks.
- Project and session IDs come from the launcher's read-only context, as opaque authority IDs. They are not the project root, which is what `skel status` passes today.

**How `requested` is set.** Never from a project file, settings or environment.

- **Under the launcher:** from the launcher's read-only context.
- **Outside the launcher:** from a host enrollment registry outside the workspace, written only by the launcher at enrollment. A match gives `requested: true` and `unverified:launcher-absent`, so privileged actions refuse and nothing falls back silently. The registry can only make status stricter, never `active`.
- **Residual:** outside the launcher, the agent has full user access and can delete the registry entry. Private authority is unaffected (R3), and the next strict launch reports the divergence.

**Recovery copy.** The existing reasons in lib/strict-status.mjs stay. Proposed additions:

| Condition | Who detects | Proposed state / reason | Next step |
|---|---|---|---|
| Public `.skeleton/` disagrees with the authority | Authority, at launch or Re-read | `unverified:state-diverged` (new) | "This project's public review state doesn't match the strict record. Decisions go only through the decision page; don't edit `.skeleton/` to match." |
| Record missing, corrupt or full | Authority | `unverified:authority-refusing` (new) | R3 or R4 copy |
| Listener not running while evidence is fresh | Launcher | Not a status state; shown on the control channel | "Reopen the decision page from the control window." |
| Skill asked to approve in strict | Skill | n/a | Tell the human to decide on the decision page, then stop. Never run `skel approve`, never ask for a token (SKILL.md already says this) |

**Needs from Sol.**

- The evidence signature, the pinned key, and the read-only mount with its refresh.
- Liveness, revocation and clock-rollback rules. The caps in strict-status.mjs stay provisional until then.
- Opaque IDs in the launcher context.
- The enrollment registry: its location, and that the launcher alone writes it.
- Whether `state-diverged` and `authority-refusing` are emitted by the authority or derived locally.

**Unproven.** Liveness: a signed record proves origin, not that the authority is alive now.

**#79 tests.**

- **Outside the launcher:** with a registry match, status shows `requested: true` and `unverified:launcher-absent`, and privileged actions refuse.
- **Forged evidence:** an agent-written evidence file, an env var pointing the verifier at it, a replayed record from an earlier session, and a record signed with another key never reach `active`.
- **CLI under active:** with status `active`, `skel approve`, `reshape` and `finalize` inside the boundary still refuse.
- **Deleted public state:** delete `.skeleton/` and relaunch; the result is `state-diverged`, not "no skeleton".
- **Skills:** in a real session, the skills never run a privileged command in strict.
- **Default mode:** status and approve behave as before.

## Questions for Sol

1. (a) Which control channel: a separate launcher-owned terminal or window, or page-only controls? Will it echo every committed transition?
2. (a) Is the listener the only TCP endpoint, with everything internal on launcher-private Unix sockets? Will the launcher add trust-map entries for the inward `skel serve` forward and for browser-side exfiltration?
3. (a) Will egress refuse the full address list, checked on the connected address? Will the launcher refuse to start when interop, a writable `/mnt/*`, a session bus, a browser opener or a debugging port is visible? Will it open the page in a fresh browser profile?
4. (b) Does the listener alone check the tab binding? Is the nonce exchange a POST from page script?
5. (c) Do you accept capture rules C1 (no subprocess or git, no symlinks, regular files only, caps, least privilege) and the scan split? Do you accept a full SHA-256 over the canonical served capture, with the capture as the approved record?
6. (c) Is Re-read/recapture the "refresh reviewable version" host operation #83 leaves open? Is the coverage set part of what the human approves?
7. (d) Do you accept R1 to R5, consistent with #83? Which codes or reasons distinguish an unreadable record and a full journal from `unavailable`?
8. (e) How is evidence signed and refreshed, and what are its lifetime and revocation rules? Who writes the enrollment registry? Are `state-diverged` and `authority-refusing` authority-emitted or local?
