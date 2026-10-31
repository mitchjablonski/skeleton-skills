// What the review page does with one /api/version answer. A plain function
// (no DOM), inlined into the page ahead of review-client.js and run by the
// tests against the server's real answer, so the page and server can't drift
// apart on the shape again.
//
// built: the page's embedded data ({ version, skeletonVersion }): what it was
//   rendered from. next: /api/version's answer ({ version, skeletonVersion,
//   serverId, ... }; a bare version string is accepted too). busy: a note is
//   being typed, so a reload would lose it.
//
// Returns { reload, stale }:
//   reload: the page content changed and nothing is being typed: reload (live
//     reload, in either phase, so a filled step shows up).
//   stale: the skeleton's SHAPE changed (skeletonVersion: exteriors + fence
//     set) while the page couldn't reload: the "outdated" pill, "reload before
//     approving". A body edit during fill isn't a shape change and never says it.
// eslint-disable-next-line no-unused-vars
function skelPollDecision(built, next, busy) {
  const n = typeof next === "string" ? { version: next } : next && typeof next === "object" ? next : {};
  const contentChanged = typeof n.version === "string" && !!built.version && n.version !== built.version;
  // An answer without skeletonVersion can't tell shape from content: only a
  // content change can then count as one.
  const shapeChanged = typeof n.skeletonVersion === "string"
    ? !!built.skeletonVersion && n.skeletonVersion !== built.skeletonVersion
    : contentChanged;
  if (contentChanged && !busy) return { reload: true, stale: false };
  return { reload: false, stale: shapeChanged };
}
