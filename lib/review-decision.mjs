// #77: the strict tier's human decision UI logic, against a DecisionChannel.
//
// MOCK ONLY, and wired into nothing. Per Sol's ruling (#81 cross-review,
// docs/strict-boundary.md), the human decision UI is served by the outside
// human listener on its own protected origin and never runs scripts the
// project supplies. This module is the logic that listener-served page will
// use. It is NOT part of the agent-reachable review page: lib/review.mjs
// doesn't load it, `skel serve` doesn't serve it, and nothing constructs a
// DecisionChannel. It ships in the package (as all of lib/ does), but only
// the tests import it, against test/fixtures/strict-results.mjs.
//
// A DecisionChannel is { getState(): Promise<AuthorityState>,
// submit(intent): Promise<Result> }. In production both go to the human
// listener: the authoritative pre-send read and every re-read come from it,
// never from the public verifier copy. Every shape is checked with
// lib/strict-protocol.mjs, so there is one schema. Having a channel doesn't
// authenticate the human; that is the listener's job. The review server's
// token is a read/feedback capability and is never used here.
//
// Rules the UI keeps (#66, #77):
//   - It shows the exact identity and version a decision names.
//   - Approve is offered only when the page shows the authority's current
//     reviewVersion and no notes on it are pending. Approve with comments
//     stays feedback (#71), never an Intent.
//   - Nothing is shown as approved until a committed Result that matches the
//     intent comes back AND a re-read state at that revision or later shows
//     it in effect; never optimistically, never for a version the human
//     didn't see.
//   - A second click while a request is in flight is the same request.
//     `unavailable` and a lost answer are both unknown outcomes: the intent
//     is kept and Retry resends it with the same requestId, so the
//     authority's durable dedupe returns the original Result.
//   - When the authority state or the shown version changes underneath, the
//     state is re-read and actions stay disabled until the human looks again.

import { parseAuthorityState, parseStrictIntent, parseStrictResult } from "./strict-protocol.mjs";

// The page's phase names to AuthorityState's.
const SKEL_DECISION_PHASE = { scaffold: "skeleton", fill: "fill", done: "finalized" };

// What each rejection tells the human: what happened and the honest next
// step. A definitive rejection says nothing changed; `unavailable` is an
// unknown outcome and never says so. `ctx` = { label, version, done, phase }.
export const SKEL_DECISION_REJECTION = {
  "stale-review": (c) => ({
    title: "The skeleton changed",
    text: `${c.version} is no longer the version under review, so nothing was ${c.done}. The current state has been re-read. Reload the review, read what it shows now, then decide again.`,
  }),
  "revision-conflict": (c) => ({
    title: "Another decision came first",
    text: `Something else changed the review state after this page read it, so nothing was ${c.done} from this tab. The current state has been re-read: check it before deciding again.`,
  }),
  "invalid-transition": (c) => ({
    title: "Not allowed right now",
    text: `${c.label} isn't allowed while the skeleton is in the ${c.phase} phase. Nothing changed. The current state has been re-read.`,
  }),
  "unauthorized-channel": () => ({
    title: "Strict approval isn't available here",
    text: "This decision didn't arrive through the protected human channel, so it was refused and nothing changed. This page can't approve in strict mode. Your notes and Copy/Send feedback still work.",
  }),
  "session-ended": () => ({
    title: "The strict session ended",
    text: "The session this review belongs to has ended, so nothing changed. Decisions from this page are off. Start a new strict session to review again; your notes are kept in this browser.",
  }),
  unavailable: (c) => ({
    title: "Outcome unknown",
    text: `The decision service answered "unavailable", so whether the request for ${c.version} was recorded is unknown, and it is not shown as ${c.done}. Retry sends the same request, so the service returns the original answer instead of deciding twice. Re-read shows the current state.`,
  }),
  "request-reused": () => ({
    title: "Request refused",
    text: "This request's id was already used for a different decision, so nothing new was recorded. The current state has been re-read: check it, then decide again.",
  }),
};

const SKEL_DECISION_ACTIONS = {
  approve: { label: "Approve skeleton", done: "approved" },
  reshape: { label: "Reshape", done: "reshaped" },
};

/**
 * What a Result means for the intent it answers, after lib/strict-protocol.mjs
 * has checked its shape: "committed" only when every echoed field matches; a
 * known rejection code; or "malformed" (fail closed: never shown as approved).
 */
export function skelDecisionOutcome(result, intent) {
  const r = parseStrictResult(result);
  if (r && r.kind === "committed") {
    const ok = r.requestId === intent.requestId && r.action === intent.action && r.reviewVersion === intent.reviewVersion && r.revision > intent.expectedRevision;
    return ok ? { kind: "committed", revision: r.revision } : { kind: "malformed" };
  }
  if (r && r.kind === "rejected" && (!Object.hasOwn(r, "requestId") || r.requestId === intent.requestId)) return { kind: "rejected", code: r.code };
  return { kind: "malformed" };
}

const skelSameAuthority = (a, b) => !!a && !!b && a.projectId === b.projectId && a.sessionId === b.sessionId && a.reviewRoundId === b.reviewRoundId && a.revision === b.revision && a.phase === b.phase && a.reviewVersion === b.reviewVersion && a.approvedVersion === b.approvedVersion;

/**
 * Does a re-read state show the intent's change in effect, at the committed
 * revision or later? A state older than the commit proves nothing about it.
 * Approve must confirm in the intent's project, session and round. A
 * committed reshape rotates the review round (lib/strict-authority.mjs, #83),
 * so reshape confirms in the same project and session on a different round:
 * phase skeleton with no approved version.
 */
export function skelDecisionConfirms(s, intent, committedRevision) {
  if (!s || s.projectId !== intent.projectId || s.sessionId !== intent.sessionId) return false;
  if (!(s.revision >= committedRevision)) return false;
  if (intent.action === "approve") return s.reviewRoundId === intent.reviewRoundId && s.phase === "fill" && s.approvedVersion === intent.reviewVersion;
  if (intent.action === "reshape") return s.reviewRoundId !== intent.reviewRoundId && s.phase === "skeleton" && s.approvedVersion === null;
  return false;
}

const skelDescribeState = (s) => s ? `phase ${s.phase}, review round ${s.reviewRoundId}, revision ${s.revision}, version under review ${s.reviewVersion}, approved version ${s.approvedVersion ?? "none"}` : "unreadable";

/**
 * The decision UI's logic, without a DOM.
 * channel: a DecisionChannel, or null (production): then it is inert and
 *   view() says the UI is absent.
 * shown: what the human is looking at: { phase (scaffold|fill|done),
 *   reviewVersion, approvedVersion, pendingNotes }. Where the listener-served
 *   page gets these without trusting the agent-reachable review page is
 *   unresolved: open question 3 in docs/strict-transport.md.
 * newRequestId: makes a request id (crypto.randomUUID in a page).
 *
 * Races: everything a decision names (the version, the authority snapshot)
 * is captured synchronously at the click. `pageGen` counts page moves; after
 * every await a decision checks it is still the same page and still
 * submitting, and otherwise stops (before sending) or reports the answer
 * without re-enabling anything (after sending).
 */
export function skelDecisionController({ channel, shown, newRequestId }) {
  let page = { ...shown };
  let pageGen = 0; // bumped on every page move
  let authority = null; // the AuthorityState decisions are built from
  let status = channel ? "loading" : "absent"; // loading|ready|stale|submitting|ended|refused|absent
  let message = null; // { tone, title, text, code? }
  let approved = null; // { reviewVersion, revision } after a confirmed approve the human saw
  let inflight = null; // { action, promise }
  let retry = null; // the intent to resend unchanged after an unknown outcome (unavailable or a lost answer)
  const terminal = () => status === "ended" || status === "refused";

  async function read() {
    let s;
    try { s = parseAuthorityState(await channel.getState()); } catch { s = null; }
    return s;
  }

  /**
   * Something underneath moved: hold actions until the human re-reads. The
   * status, retry and message change synchronously, so an answer arriving
   * later can't undo them; the await only refreshes what is displayed.
   */
  async function markStale(msg) {
    retry = null;
    approved = null;
    if (!terminal()) status = "stale";
    message = msg;
    const s = await read();
    if (s) authority = s;
  }

  /** The first read, and the human's "Re-read". Never while a decision is in flight. */
  async function load() {
    if (!channel || terminal() || inflight) return;
    const gen = pageGen;
    const s = await read();
    if (terminal() || inflight || gen !== pageGen) return; // moved again meanwhile: stays stale
    if (!s) {
      authority = null;
      status = "stale";
      message = { tone: "warn", title: "Can't read the review state", text: "The decision service didn't answer with a usable state, so decisions are off. Nothing changed. Try Re-read in a moment." };
      return;
    }
    authority = s;
    status = "ready";
    message = retry
      ? { tone: "warn", title: "Still unconfirmed", text: `Current review state: ${skelDescribeState(s)}. Whether the request for ${retry.reviewVersion} landed is still unconfirmed, so nothing is shown as ${SKEL_DECISION_ACTIONS[retry.action].done}. Retry asks the service for its original answer.` }
      : null;
  }

  /** The page reloaded onto new content, or its notes changed. */
  async function setShown(next) {
    const moved = next.reviewVersion !== page.reviewVersion || next.phase !== page.phase || next.approvedVersion !== page.approvedVersion;
    page = { ...next };
    // Notes alone aren't a move: they hold a kept approve (retryHold), and
    // never drop it, since its outcome is unknown.
    if (!moved) return;
    pageGen++;
    if (channel && status !== "absent") {
      await markStale({ tone: "warn", title: "The page now shows a different version", text: `The review now shows ${page.reviewVersion}. Read it, then press Re-read before deciding.` });
    }
  }

  function versionFor(action) {
    return action === "approve" ? page.reviewVersion : authority?.approvedVersion ?? null;
  }

  /** Why a retained request can't be resent now, or null. Notes hold an approve, as they hold a new one. */
  function retryHold() {
    if (inflight) return "A decision is being sent.";
    if (retry && retry.action === "approve" && page.pendingNotes) return "You have notes on this version: send or copy them first. Approve with comments stays feedback.";
    return null;
  }

  function why(action) {
    if (status !== "ready" || !authority) return "unavailable";
    const a = authority;
    if (SKEL_DECISION_PHASE[page.phase] !== a.phase) return "The page and the review state disagree on the phase: reload the review.";
    if (action === "approve") {
      if (a.phase !== "skeleton") return "There is no skeleton awaiting approval.";
      if (typeof page.reviewVersion !== "string" || !page.reviewVersion) return "The page doesn't name the version it shows.";
      if (page.reviewVersion !== a.reviewVersion) return `The page shows ${page.reviewVersion}, but the version under review is ${a.reviewVersion}: reload the review.`;
      if (page.pendingNotes) return "You have notes on this version: send or copy them first. Approve with comments stays feedback.";
      return null;
    }
    if (action === "reshape") {
      if (a.phase !== "fill") return "Reshape is for a skeleton that is being filled.";
      if (page.approvedVersion !== a.approvedVersion) return "The page's approved version doesn't match the review state: reload the review.";
      return null;
    }
    return "Not offered on this page.";
  }

  /** Sends one intent. `still()` is true while the page and this decision are unchanged. */
  async function submit(intent, still) {
    const words = SKEL_DECISION_ACTIONS[intent.action];
    // The page moved while this was in flight: report, never re-enable. setShown already held actions.
    const movedAnswer = (what) => {
      retry = null;
      approved = null;
      if (!terminal()) status = "stale";
      message = { tone: "warn", title: "The page changed while sending", text: `The page moved to ${page.reviewVersion} while the decision on ${intent.reviewVersion} was being sent. ${what} Nothing is shown as ${words.done}. Read the page, then press Re-read before deciding.` };
    };
    // An unknown outcome (a lost answer, or `unavailable`): it may or may not
    // have been recorded. Keep it to resend unchanged, and re-read for display.
    const unknown = async (msg, out) => {
      const gone = "The service didn't confirm it, so it may or may not have been recorded.";
      if (!still()) { movedAnswer(gone); return out; }
      const s = await read();
      if (s) authority = s;
      if (!still()) { movedAnswer(gone); return out; }
      retry = intent;
      status = "ready";
      message = msg;
      return out;
    };
    let result;
    try {
      result = await channel.submit(intent);
    } catch {
      return unknown({ tone: "warn", title: "No answer from the decision service", text: `Couldn't confirm whether the decision was recorded, so ${intent.reviewVersion} is not shown as ${words.done}. Retry sends the same request, so the service returns the original answer instead of deciding twice. Re-read shows the current state.` }, { kind: "unknown" });
    }
    const out = skelDecisionOutcome(result, intent);
    if (out.kind === "rejected" && (out.code === "session-ended" || out.code === "unauthorized-channel")) {
      // These end decisions on this page whatever the page did meanwhile.
      retry = null;
      approved = null;
      status = out.code === "session-ended" ? "ended" : "refused";
      message = { tone: "warn", code: out.code, ...SKEL_DECISION_REJECTION[out.code]({}) };
      return out;
    }
    if (!still()) {
      movedAnswer(out.kind === "committed" ? `The service recorded it (revision ${out.revision}).` : out.kind === "rejected" ? `The service answered ${out.code}.` : "The service's answer wasn't recognised.");
      return out;
    }
    if (out.kind === "committed") {
      retry = null;
      const s = await read();
      if (s) authority = s;
      if (!still()) { movedAnswer(`The service recorded it (revision ${out.revision}).`); return out; }
      if (!skelDecisionConfirms(s, intent, out.revision)) {
        // Recorded, but the state now says otherwise (or can't be read): show the state, claim nothing.
        approved = null;
        status = "stale";
        message = { tone: "warn", title: "Recorded, but the state differs", text: `The service recorded the request (revision ${out.revision}), but the current review state doesn't show it in effect: ${skelDescribeState(s)}. Nothing is shown as ${words.done}. Press Re-read, then check the page.` };
        return out;
      }
      status = "ready";
      if (intent.action === "approve") {
        approved = { reviewVersion: intent.reviewVersion, revision: out.revision };
        message = { tone: "ok", title: "Approved", text: `Skeleton ${intent.reviewVersion} was approved (revision ${out.revision}).` };
      } else {
        message = { tone: "ok", title: "Reshape recorded", text: `Reshape from approved version ${intent.reviewVersion} was recorded (revision ${out.revision}). Reload the review to see the skeleton phase.` };
      }
      return out;
    }
    if (out.kind === "malformed") {
      await markStale({ tone: "warn", title: "Unrecognised answer", text: `The decision service answered in a form this page doesn't recognise, so ${intent.reviewVersion} is not shown as ${words.done}. The state has been re-read; press Re-read before deciding again.` });
      return out;
    }
    const ctx = { version: intent.reviewVersion, label: words.label, done: words.done, phase: authority?.phase ?? "unknown" };
    const msg = { tone: "warn", code: out.code, ...SKEL_DECISION_REJECTION[out.code](ctx) };
    if (out.code === "unavailable") return unknown(msg, out);
    await markStale(msg);
    return out;
  }

  /** The human pressed approve, reshape or retry. A second press while one is in flight is the same request. */
  function decide(action) {
    if (inflight) return inflight.promise;
    const refused = Promise.resolve({ kind: "refused-locally" });
    if (!channel || status !== "ready") return refused;
    // Captured at the click: what the human is deciding on.
    const gen = pageGen;
    const resend = retry && retry.action === action ? retry : null;
    if (resend ? retryHold() !== null : why(action) !== null) return refused;
    const version = versionFor(action);
    const snapshot = authority;
    status = "submitting";
    message = null;
    const still = () => gen === pageGen && status === "submitting";
    const run = async () => {
      // A retained request goes out unchanged: if the first try landed, the
      // authority answers with its original result.
      if (resend) return submit(resend, still);
      // Otherwise check nothing moved since the human last read the state.
      const now = await read();
      if (!still()) return { kind: "stale" }; // the page moved: setShown already held actions
      if (!now || !skelSameAuthority(now, snapshot)) {
        await markStale({ tone: "warn", title: "The review state changed", text: "The review state changed since this page read it, so nothing was sent. It has been re-read: check it, then press Re-read before deciding." });
        return { kind: "stale" };
      }
      const intent = parseStrictIntent({
        protocolVersion: 1,
        requestId: newRequestId(),
        action,
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        reviewRoundId: snapshot.reviewRoundId,
        reviewVersion: version,
        expectedRevision: snapshot.revision,
      });
      if (!intent) {
        // The page's version or the new id isn't a valid opaque id: nothing is sent.
        await markStale({ tone: "warn", title: "Can't build a valid request", text: "This decision couldn't be expressed as a valid request, so nothing was sent. Reload the review, then press Re-read." });
        return { kind: "stale" };
      }
      return submit(intent, still);
    };
    const promise = run().finally(() => { inflight = null; });
    inflight = { action, promise };
    return promise;
  }

  /** What to draw. Pure: the same inputs give the same view. */
  function view() {
    if (!channel) return { present: false };
    const actions = [];
    if (retry && status === "ready") {
      // Only the retained request may go out: a retry resends it unchanged.
      const hold = retryHold();
      actions.push({ action: retry.action, label: SKEL_DECISION_ACTIONS[retry.action].label, enabled: hold === null, reason: hold, retry: true });
    } else if (authority) {
      for (const action of Object.keys(SKEL_DECISION_ACTIONS)) {
        const offered = action === "approve" ? authority.phase === "skeleton" : authority.phase === "fill";
        if (!offered) continue;
        const reason = inflight ? "A decision is being sent." : why(action);
        actions.push({ action, label: SKEL_DECISION_ACTIONS[action].label, enabled: reason === null, reason: reason === "unavailable" ? null : reason, retry: false });
      }
    }
    return {
      present: true,
      status,
      identity: authority && {
        projectId: authority.projectId,
        sessionId: authority.sessionId,
        reviewRoundId: authority.reviewRoundId,
        phase: authority.phase,
        revision: authority.revision,
        approvedVersion: authority.approvedVersion,
        reviewVersion: authority.reviewVersion,
        shownVersion: page.reviewVersion ?? null,
      },
      approved,
      message,
      actions,
      // After an unknown outcome, Re-read sits beside Retry so the human can check whether it landed.
      canReread: !inflight && (status === "stale" || (status === "ready" && !!retry)),
    };
  }

  return { load, setShown, decide, view, get requestRetained() { return retry && retry.requestId; } };
}

/**
 * Draws a controller's view into `doc` elements, as text nodes only
 * (never parsed as markup: identity strings come from outside the page). Returns null without a
 * channel, so production draws nothing.
 */
export function skelDecisionRender(doc, v, on) {
  if (!v.present) return null;
  const el = (tag, attrs, ...kids) => {
    const e = doc.createElement(tag);
    for (const [k, val] of Object.entries(attrs || {})) {
      if (k === "onclick") e.addEventListener("click", val);
      else if (val !== false && val != null) e.setAttribute(k, val === true ? "" : String(val));
    }
    for (const kid of kids) if (kid != null && kid !== false) e.append(typeof kid === "string" ? doc.createTextNode(kid) : kid);
    return e;
  };
  const id = v.identity;
  const rows = id ? [
    ["Project", id.projectId], ["Session", id.sessionId], ["Review round", id.reviewRoundId],
    ["Phase", id.phase], ["Revision", String(id.revision)],
    ["Version shown", id.shownVersion ?? "none"], ["Version under review", id.reviewVersion], ["Approved version", id.approvedVersion ?? "none"],
  ] : [];
  return el("section", { class: "panel decision", "data-decision": "", "aria-label": "Strict decision" },
    el("h2", {}, "Strict decision (mock)"),
    el("dl", { "data-decision-identity": "" }, ...rows.flatMap(([k, val]) => [el("dt", {}, k), el("dd", {}, val)])),
    v.approved ? el("p", { class: "status", role: "status", "data-decision-approved": v.approved.reviewVersion }, `Approved ${v.approved.reviewVersion} at revision ${v.approved.revision}`) : null,
    v.message ? el("div", { class: "errors lock", role: "alert", "data-decision-message": v.message.code || v.message.tone }, el("strong", {}, v.message.title), " ", v.message.text) : null,
    ...v.actions.map((a) => el("button", {
      class: `btn ${a.action}`, "data-decision-action": a.action, disabled: !a.enabled, "aria-disabled": String(!a.enabled),
      title: a.reason, onclick: () => on.decide(a.action),
    }, a.retry ? `Retry ${a.label.toLowerCase()}` : a.label)),
    v.canReread ? el("button", { class: "btn", "data-decision-reread": "", onclick: () => on.reread() }, "Re-read") : null,
  );
}

// Containers already holding a decision UI, with what they were mounted with.
const SKEL_DECISION_MOUNTS = new WeakMap();

/**
 * Mounts the UI in `container`. Without a channel, it mounts nothing and
 * returns null. Mounting again in one container with the same channel and id
 * maker returns the first mount, and a changed `shown` is applied to it with
 * setShown (a page move holds actions as usual). A different channel or id
 * maker throws: there is never a second controller or set of buttons.
 * Returns { controller, redraw }.
 */
export async function skelMountDecision({ doc, container, channel, shown, newRequestId }) {
  if (!channel) return null;
  const existing = SKEL_DECISION_MOUNTS.get(container);
  if (existing) {
    if (existing.channel !== channel || existing.newRequestId !== newRequestId) {
      throw new Error("a decision UI is already mounted in this container with a different channel");
    }
    const m = await existing.mount;
    await m.controller.setShown(shown);
    m.redraw();
    return m;
  }
  const controller = skelDecisionController({ channel, shown, newRequestId });
  let node = null;
  const redraw = () => {
    const next = skelDecisionRender(doc, controller.view(), {
      decide: async (a) => { const p = controller.decide(a); redraw(); await p; redraw(); },
      reread: async () => { await controller.load(); redraw(); },
    });
    if (node) node.replaceWith(next); else container.append(next);
    node = next;
  };
  const mount = (async () => {
    await controller.load();
    redraw();
    return { controller, redraw };
  })();
  SKEL_DECISION_MOUNTS.set(container, { channel, newRequestId, mount });
  return mount;
}
