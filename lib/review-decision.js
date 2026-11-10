// #77: the strict tier's human decision UI, against a DecisionChannel.
//
// MOCK ONLY. This file is NOT part of the review page today: lib/review.mjs
// doesn't load it, `skel serve` doesn't serve it, and nothing in production
// constructs a DecisionChannel. The default page is byte-for-byte what it was
// (test/strict-transport.test.mjs checks that). It is written in the page's
// plain-script style (no imports or exports) so it can be inlined once Sol's
// private human channel (#76) exists and is verified; until then only tests
// run it, against test/fixtures/strict-results.mjs.
//
// A DecisionChannel is { getState(): Promise<AuthorityState>,
// submit(intent): Promise<Result> } (contract v1 plus the #76 review
// changes; see docs/strict-transport.md). Having one doesn't authenticate the
// human: that is the channel's job, outside this page. The review server's
// token is a read/feedback capability and is never used here.
//
// Rules the UI keeps (#66, #77):
//   - It shows the exact identity and version a decision names.
//   - Approve is offered only when no notes on the shown version are pending.
//     Approve with comments stays feedback (#71), never an Intent.
//   - Nothing is shown as approved until a committed Result that matches the
//     intent comes back; never optimistically, never for a version the human
//     didn't see.
//   - A second click while a request is in flight is the same request. A
//     retry after `unavailable` or a lost answer reuses the requestId, so the
//     authority returns the original Result instead of deciding twice.
//   - When the authority state or the shown version changes underneath, the
//     state is re-read and actions stay disabled until the human looks again.

// The page's phase names to AuthorityState's.
// eslint-disable-next-line no-unused-vars
const SKEL_DECISION_PHASE = { scaffold: "skeleton", fill: "fill", done: "finalized" };

const SKEL_DECISION_CODES = ["stale-review", "revision-conflict", "invalid-transition", "unauthorized-channel", "session-ended", "unavailable", "request-reused"];

// What each rejection tells the human: what happened, that nothing was
// approved, and the honest next step. `ctx` = { action, version, phase }.
// eslint-disable-next-line no-unused-vars
const SKEL_DECISION_REJECTION = {
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
    title: "Approval service unavailable",
    text: `The decision service couldn't take the request, so nothing was ${c.done}. You can retry: a retry sends the same request, so it can't be recorded twice.`,
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

/** A well-formed AuthorityState, or null. Shapes from the channel are data, checked. */
function skelDecisionState(s) {
  const str = (v) => typeof v === "string" && v.length > 0;
  if (!s || typeof s !== "object") return null;
  if (!str(s.projectId) || !str(s.sessionId) || !str(s.reviewRoundId)) return null;
  if (!Object.values(SKEL_DECISION_PHASE).includes(s.phase)) return null;
  if (!(s.approvedVersion === null || str(s.approvedVersion))) return null;
  if (!Number.isSafeInteger(s.revision) || s.revision < 0) return null;
  return { projectId: s.projectId, sessionId: s.sessionId, reviewRoundId: s.reviewRoundId, phase: s.phase, approvedVersion: s.approvedVersion, revision: s.revision };
}

/**
 * What a Result means for the intent it answers: "committed" only when every
 * echoed field matches; a known rejection code; or "malformed" (fail closed:
 * never shown as approved).
 */
function skelDecisionOutcome(result, intent) {
  if (result && result.kind === "committed") {
    const ok = result.requestId === intent.requestId && result.action === intent.action && result.reviewVersion === intent.reviewVersion &&
      Number.isSafeInteger(result.revision) && result.revision > intent.expectedRevision;
    return ok ? { kind: "committed", revision: result.revision } : { kind: "malformed" };
  }
  if (result && result.kind === "rejected" && SKEL_DECISION_CODES.includes(result.code) && (result.requestId === undefined || result.requestId === intent.requestId)) {
    return { kind: "rejected", code: result.code };
  }
  return { kind: "malformed" };
}

const skelSameAuthority = (a, b) => !!a && !!b && a.projectId === b.projectId && a.sessionId === b.sessionId && a.reviewRoundId === b.reviewRoundId && a.revision === b.revision && a.phase === b.phase && a.approvedVersion === b.approvedVersion;

/**
 * The decision UI's logic, without a DOM.
 * channel: a DecisionChannel, or null (production): then it is inert and
 *   view() says the UI is absent.
 * shown: what the page shows: { phase (page phase), reviewVersion
 *   (data.skeletonVersion), approvedVersion (data.approvedVersion),
 *   pendingNotes (skelFreshNotes(outgoing())) }.
 * newRequestId: makes a request id (crypto.randomUUID in a page).
 */
// eslint-disable-next-line no-unused-vars
function skelDecisionController({ channel, shown, newRequestId }) {
  let page = { ...shown };
  let authority = null; // the AuthorityState decisions are built from
  let status = channel ? "loading" : "absent"; // loading|ready|stale|submitting|ended|refused|absent
  let message = null; // { tone, title, text }
  let approved = null; // { reviewVersion, revision } after a committed approve the human saw
  let inflight = null; // { action, promise }
  let retry = null; // the intent to resend after unavailable or a lost answer
  const changed = () => { retry = null; };

  async function read() {
    let s;
    try { s = skelDecisionState(await channel.getState()); } catch { s = null; }
    return s;
  }

  /** The first read, and the human's "Re-read" after a change. */
  async function load() {
    if (!channel || status === "ended" || status === "refused") return;
    const s = await read();
    if (!s) {
      authority = null;
      status = "stale";
      message = { tone: "warn", title: "Can't read the review state", text: "The decision service didn't answer with a usable state, so decisions are off. Nothing changed. Try Re-read in a moment." };
      return;
    }
    authority = s;
    status = "ready";
    message = null;
  }

  /** Something underneath moved: re-read for display, and hold actions until the human re-reads. */
  async function markStale(msg) {
    changed();
    approved = null;
    const s = await read();
    if (s) authority = s;
    if (status !== "ended" && status !== "refused") status = "stale";
    message = msg;
  }

  /** The page reloaded onto new content, or its notes changed. */
  async function setShown(next) {
    const moved = next.reviewVersion !== page.reviewVersion || next.phase !== page.phase || next.approvedVersion !== page.approvedVersion;
    page = { ...next };
    if (moved && channel && authority) {
      await markStale({ tone: "warn", title: "The page now shows a different version", text: `The review now shows ${page.reviewVersion}. Read it, then press Re-read before deciding.` });
    }
  }

  function versionFor(action) {
    return action === "approve" ? page.reviewVersion : authority?.approvedVersion ?? null;
  }

  function why(action) {
    if (status !== "ready") return "unavailable";
    const a = authority;
    if (SKEL_DECISION_PHASE[page.phase] !== a.phase) return "The page and the review state disagree on the phase: reload the review.";
    if (action === "approve") {
      if (a.phase !== "skeleton") return "There is no skeleton awaiting approval.";
      if (typeof page.reviewVersion !== "string" || !page.reviewVersion) return "The page doesn't name the version it shows.";
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

  async function submit(intent) {
    status = "submitting";
    message = null;
    let result;
    try {
      result = await channel.submit(intent);
    } catch {
      // The request may or may not have been recorded: keep it to resend unchanged.
      retry = intent;
      status = "ready";
      message = { tone: "warn", title: "No answer from the decision service", text: `Couldn't confirm whether the decision was recorded, so ${intent.reviewVersion} is not shown as ${SKEL_DECISION_ACTIONS[intent.action].done}. Retry sends the same request, so the service returns the original answer instead of deciding twice.` };
      return { kind: "unknown" };
    }
    const out = skelDecisionOutcome(result, intent);
    const ctx = { version: intent.reviewVersion, label: SKEL_DECISION_ACTIONS[intent.action].label, done: SKEL_DECISION_ACTIONS[intent.action].done, phase: authority?.phase ?? "unknown" };
    if (out.kind === "committed") {
      retry = null;
      // #66: approved is shown only for the version the human still sees.
      const stillShown = versionFor(intent.action) === intent.reviewVersion;
      const s = await read();
      if (s) authority = s;
      status = s ? "ready" : "stale";
      if (intent.action === "approve" && stillShown) {
        approved = { reviewVersion: intent.reviewVersion, revision: out.revision };
        message = { tone: "ok", title: "Approved", text: `Skeleton ${intent.reviewVersion} was approved (revision ${out.revision}).` };
      } else if (intent.action === "approve") {
        message = { tone: "warn", title: "Recorded for an earlier version", text: `The service recorded approval of ${intent.reviewVersion} (revision ${out.revision}), but this page now shows ${page.reviewVersion}, which is not approved.` };
      } else {
        message = { tone: "ok", title: "Reshape recorded", text: `Reshape from approved version ${intent.reviewVersion} was recorded (revision ${out.revision}). Reload the review to see the skeleton phase.` };
      }
      return out;
    }
    if (out.kind === "malformed") {
      await markStale({ tone: "warn", title: "Unrecognised answer", text: `The decision service answered in a form this page doesn't recognise, so ${intent.reviewVersion} is not shown as ${ctx.done}. The state has been re-read; press Re-read before deciding again.` });
      return out;
    }
    const copy = SKEL_DECISION_REJECTION[out.code](ctx);
    const msg = { tone: "warn", code: out.code, ...copy };
    if (out.code === "unavailable") {
      retry = intent;
      status = "ready";
      message = msg;
    } else if (out.code === "session-ended") {
      changed();
      status = "ended";
      message = msg;
    } else if (out.code === "unauthorized-channel") {
      changed();
      status = "refused";
      message = msg;
    } else {
      await markStale(msg);
    }
    return out;
  }

  /** The human pressed approve or reshape. A second press while one is in flight is the same request. */
  function decide(action) {
    if (inflight) return inflight.promise;
    if (!channel || why(action) !== null) return Promise.resolve({ kind: "refused-locally" });
    const run = async () => {
      // A retained request goes out unchanged: if the first try landed, the
      // authority answers with its original result.
      if (retry && retry.action === action && retry.reviewVersion === versionFor(action)) return submit(retry);
      // Otherwise check nothing moved since the human last read the state.
      const now = await read();
      if (!now || !skelSameAuthority(now, authority)) {
        await markStale({ tone: "warn", title: "The review state changed", text: "The review state changed since this page read it, so nothing was sent. It has been re-read: check it, then press Re-read before deciding." });
        return { kind: "stale" };
      }
      const intent = {
        protocolVersion: 1,
        requestId: newRequestId(),
        action,
        projectId: authority.projectId,
        sessionId: authority.sessionId,
        reviewRoundId: authority.reviewRoundId,
        reviewVersion: versionFor(action),
        expectedRevision: authority.revision,
      };
      return submit(intent);
    };
    const promise = run().finally(() => { inflight = null; });
    inflight = { action, promise };
    return promise;
  }

  /** What to draw. Pure: the same inputs give the same view. */
  function view() {
    if (!channel) return { present: false };
    const actions = [];
    if (authority) {
      for (const action of Object.keys(SKEL_DECISION_ACTIONS)) {
        const offered = action === "approve" ? authority.phase === "skeleton" : authority.phase === "fill";
        if (!offered) continue;
        const reason = inflight ? "A decision is being sent." : why(action);
        actions.push({ action, label: SKEL_DECISION_ACTIONS[action].label, enabled: reason === null, reason: reason === "unavailable" ? null : reason, retry: !!retry && retry.action === action });
      }
    }
    return {
      present: true,
      status: inflight ? "submitting" : status,
      identity: authority && {
        projectId: authority.projectId,
        sessionId: authority.sessionId,
        reviewRoundId: authority.reviewRoundId,
        phase: authority.phase,
        revision: authority.revision,
        approvedVersion: authority.approvedVersion,
        shownVersion: page.reviewVersion ?? null,
      },
      approved,
      message,
      actions,
      canReread: status === "stale",
    };
  }

  return { load, setShown, decide, view, get requestRetained() { return retry && retry.requestId; } };
}

/**
 * Draws a controller's view into `doc` elements, as text nodes only
 * (never parsed as markup: identity strings come from outside the page). Returns null without a
 * channel, so production draws nothing.
 */
// eslint-disable-next-line no-unused-vars
function skelDecisionRender(doc, v, on) {
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
    ["Version shown", id.shownVersion ?? "none"], ["Approved version", id.approvedVersion ?? "none"],
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

/**
 * Mounts the UI in `container`. Without a channel (production), it mounts
 * nothing and returns null. Returns { controller, redraw }.
 */
// eslint-disable-next-line no-unused-vars
async function skelMountDecision({ doc, container, channel, shown, newRequestId }) {
  if (!channel) return null;
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
  await controller.load();
  redraw();
  return { controller, redraw };
}
