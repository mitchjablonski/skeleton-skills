// The review page's progress line: a plain function (no DOM), inlined into
// the page ahead of review-client.js (like review-poll.js) and run by the
// tests directly. `skel status` prints the same words (bin/skel.mjs).
//
// page: { phase, steps: [{ id, status }], activeStep, finalized }.
// The active step counts as filling, not done, even once its stubs are gone:
// it is done when `skel done` accepts it. A finalized skeleton has no markers
// left to count, so its count is the one `skel finalize` recorded.
//
// Returns { done, total, text }; done and total are null when unknown.
// eslint-disable-next-line no-unused-vars
function skelProgress(page) {
  if (page.phase === "done") {
    const n = page.finalized && Number.isInteger(page.finalized.steps) ? page.finalized.steps : null;
    return { done: n, total: n, text: n === null ? "finalized" : `finalized · ${n}/${n} done` };
  }
  const steps = page.steps ?? [];
  const active = page.activeStep && steps.some((s) => s.id === page.activeStep) ? page.activeStep : null;
  const done = steps.filter((s) => s.status === "filled" && s.id !== active).length;
  return { done, total: steps.length, text: `${done}/${steps.length} done${active ? ` · step ${active} filling` : ""}` };
}
