// #66: the review page's Copy/Send content (lib/review-feedback.js, run here
// the way the page runs it) and the server's markdown for a Send.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cleanFeedback, feedbackMarkdown } from "../lib/feedback.mjs";
import { clientScript } from "../lib/review.mjs";

const { skelDraftForVersion, skelVerdictClearedMessage, skelOutgoing, skelFeedbackMarkdown } = new Function(
  fs.readFileSync(new URL("../lib/review-feedback.js", import.meta.url), "utf-8") +
    "\nreturn { skelDraftForVersion, skelVerdictClearedMessage, skelOutgoing, skelFeedbackMarkdown };",
)();

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const page = (phase, skeletonVersion = B) => ({ title: "T", phase, skeletonVersion });
const copy = (draft, p) => skelFeedbackMarkdown(p, skelOutgoing(skelDraftForVersion(draft, p.skeletonVersion, p.phase).draft, p.skeletonVersion));

test("#66: the page inlines the feedback functions ahead of the client", () => {
  const js = clientScript();
  assert.ok(js.indexOf("function skelFeedbackMarkdown") >= 0);
  assert.ok(js.indexOf("function skelFeedbackMarkdown") < js.indexOf("skelFeedbackMarkdown(data, outgoing())"));
});

test("#66: an approval given on version A is cleared when the page shows B; comments stay", () => {
  const draft = { verdict: "approve", verdictVersion: A, general: "ok", comments: [{ file: "a.ts", line: 3, step: "1", text: "nit", version: A }] };
  const { draft: d, changed } = skelDraftForVersion(draft, B);
  assert.equal(changed, true);
  assert.equal(d.verdict, null);
  assert.equal(d.verdictVersion, null);
  assert.deepEqual(d.verdictCleared, { verdict: "approve", from: A, to: B });
  assert.equal(d.comments.length, 1);
  assert.equal(d.general, "ok");
  assert.equal(draft.verdict, "approve", "the input isn't mutated");
  assert.equal(skelVerdictClearedMessage(d.verdictCleared, "scaffold"),
    `The skeleton changed since you approved it (${A} → ${B}). Check the highlighted changes, then approve again.`);
  // Another reload onto a third version: the notice follows the page.
  const again = skelDraftForVersion(d, "cccccccccccc");
  assert.deepEqual(again.draft.verdictCleared, { verdict: "approve", from: A, to: "cccccccccccc" });
  // The same version: nothing to do.
  assert.equal(skelDraftForVersion({ verdict: "approve", verdictVersion: B, general: "", comments: [] }, B).changed, false);
});

test("#66: an old draft's verdict (no verdictVersion) counts as unknown and is cleared", () => {
  const { draft: d, changed } = skelDraftForVersion({ verdict: "changes", general: "", comments: [{ file: "a.ts", line: 1, text: "x" }] }, B);
  assert.equal(changed, true);
  assert.equal(d.verdict, null);
  assert.deepEqual(d.verdictCleared, { verdict: "changes", from: null, to: B });
  assert.match(skelVerdictClearedMessage(d.verdictCleared, "scaffold"), /since you requested changes \(an earlier version → bbbbbbbbbbbb\).*then choose again\./);
  assert.equal(skelDraftForVersion({ general: "", comments: [] }, B).changed, false, "no verdict: nothing to clear");
});

test("#66: an approval from the skeleton phase doesn't carry into the fill phase as \"looks right\"", () => {
  const { draft: d, changed } = skelDraftForVersion({ verdict: "approve", verdictVersion: B, verdictPhase: "scaffold", general: "", comments: [] }, B, "fill");
  assert.equal(changed, true);
  assert.equal(d.verdict, null);
  assert.equal(d.verdictCleared, undefined, "quietly: it answered a different question");
  // A notice from the skeleton phase doesn't follow it into the fill phase either.
  const n = skelDraftForVersion({ verdict: null, general: "", comments: [], verdictCleared: { verdict: "approve", from: A, to: B, phase: "scaffold" } }, B, "fill");
  assert.equal(n.draft.verdictCleared, undefined);
  // The same phase and version: kept.
  assert.equal(skelDraftForVersion({ verdict: "approve", verdictVersion: B, verdictPhase: "fill", general: "", comments: [] }, B, "fill").changed, false);
  // A shape change within the fill phase: cleared with the notice.
  const f = skelDraftForVersion({ verdict: "approve", verdictVersion: A, verdictPhase: "fill", general: "", comments: [] }, B, "fill").draft;
  assert.deepEqual(f.verdictCleared, { verdict: "approve", from: A, to: B, phase: "fill" });
});

test("#66: Copy after the shape changed has no verdict and no approve hint", () => {
  const md = copy({ verdict: "approve", verdictVersion: A, general: "", comments: [] }, page("scaffold"));
  assert.match(md, /^# Skeleton review: T\n/);
  assert.match(md, /\nVerdict: no verdict \(comments only\)\n/);
  assert.match(md, new RegExp(`\\nReviewed skeleton version: ${B}\\n`));
  assert.doesNotMatch(md, /APPROVED|approve with/);
});

test("#66: the approve hint only for an approval given on the version shown", () => {
  const md = copy({ verdict: "approve", verdictVersion: B, general: "", comments: [] }, page("scaffold"));
  assert.match(md, new RegExp(`\\nVerdict: APPROVED\\nReviewed skeleton version: ${B} \\(approve with: skel approve --reviewed ${B}\\)\\n`));
  const changes = copy({ verdict: "changes", verdictVersion: B, general: "", comments: [] }, page("scaffold"));
  assert.match(changes, /Verdict: CHANGES REQUESTED/);
  assert.doesNotMatch(changes, /approve with/);
  assert.doesNotMatch(copy({ verdict: null, general: "", comments: [] }, page("scaffold")), /approve with/);
  // Defensive: skelOutgoing alone (without the load-time check) still drops a verdict from another version.
  const out = skelOutgoing({ verdict: "approve", verdictVersion: A, general: "", comments: [] }, B);
  assert.deepEqual([out.verdict, out.version], [null, B]);
});

test("#66: the reviewed version a Send records is the verdict's", () => {
  const out = skelOutgoing({ verdict: "approve", verdictVersion: B, general: " g ", comments: [{ file: "a.ts", line: 2, step: null, text: "t", version: A, anchor: { text: "x" } }] }, B);
  assert.equal(out.version, B);
  assert.equal(out.verdict, "approve");
  assert.deepEqual(out.comments, [{ file: "a.ts", line: 2, step: null, version: A, quote: "x", text: "t" }], "no anchor/outdated internals leave the page (only the quoted line, #68 P3)");
  // What the server keeps of it.
  const fb = cleanFeedback(out);
  assert.equal(fb.version, B);
  assert.equal(fb.comments[0].version, A);
});

test("#66: comments carry the version they were written on, and Copy says when they span versions", () => {
  const draft = {
    verdict: null, general: "", comments: [
      { file: "b.ts", line: 4, step: "2", text: "on B", version: B },
      { file: "a.ts", line: 1, step: "1", text: "on A", version: A },
      { file: "a.ts", line: 9, step: null, text: "old draft" },
    ],
  };
  const md = copy(draft, page("scaffold"));
  assert.match(md, new RegExp(`Note: 2 of these 3 comments were written on an earlier skeleton version \\(${A}\\), not the current one \\(${B}\\)\\..*not a review of it\\.`));
  assert.match(md, new RegExp(`- a\\.ts:1 \\(step 1\\) \\[written on version ${A}\\]: on A`));
  assert.match(md, /- a\.ts:9 \[written on an unknown earlier version\]: old draft/);
  assert.match(md, /- b\.ts:4 \(step 2\): on B/);
  // All on the current version: no note, no tags.
  const clean = copy({ verdict: null, general: "", comments: [{ file: "a.ts", line: 1, step: null, text: "x", version: B }] }, page("scaffold"));
  assert.doesNotMatch(clean, /Note:|\[written on/);
  assert.match(clean, /- a\.ts:1: x/);
});

test("#66: a fill-phase Copy reads as a fill review, never an approval request", () => {
  const looks = copy({ verdict: "approve", verdictVersion: B, general: "", comments: [] }, page("fill"));
  assert.match(looks, /^# Fill review: T\n/);
  assert.match(looks, /\nVerdict: LOOKS RIGHT \(keep filling\)\n/);
  assert.doesNotMatch(looks, /APPROVED|approve with|Skeleton review/);
  const reopen = copy({ verdict: "changes", verdictVersion: B, general: "", comments: [] }, page("fill"));
  assert.match(reopen, /\nVerdict: REOPEN SKELETON \(structural change requested\)\n/);
  assert.doesNotMatch(reopen, /CHANGES REQUESTED|approve with/);
  assert.match(skelVerdictClearedMessage({ verdict: "approve", from: A, to: B }, "fill"), /since you said it looks right .*then choose again\./);
  assert.match(skelVerdictClearedMessage({ verdict: "changes", from: A, to: B }, "fill"), /since you asked to reopen it/);
});

test("#66: the server's Send markdown matches: fill-phase words, and comments from another version are marked", () => {
  const fb = cleanFeedback({ verdict: "approve", general: "", version: B, comments: [{ file: "a.ts", line: 1, text: "old", version: A }, { file: "b.ts", line: 1, text: "new", version: B }, { file: "c.ts", line: 1, text: "bad", version: "nope" }] });
  assert.equal(fb.comments[2].version, undefined, "a malformed version is dropped");
  const scaffold = feedbackMarkdown("T", fb);
  assert.match(scaffold, /^# Skeleton review: T\n/);
  // #68 P2: an approval that comes with comments says so.
  assert.match(scaffold, /Verdict: APPROVED WITH COMMENTS \(apply these, then ask me to approve the new version\)\n/);
  assert.match(feedbackMarkdown("T", { ...fb, comments: [] }), /Verdict: APPROVED\n/);
  assert.match(scaffold, new RegExp(`Note: 1 of these 3 comments was written on another skeleton version \\(${A}\\) than the reviewed one \\(${B}\\)`));
  assert.match(scaffold, new RegExp(`- a\\.ts:1 \\[written on version ${A}\\]: old`));
  assert.match(scaffold, /- b\.ts:1: new/);
  assert.match(scaffold, /- c\.ts:1: bad/);
  const fill = feedbackMarkdown("T", fb, "fill");
  assert.match(fill, /^# Fill review: T\n/);
  assert.match(fill, /Verdict: LOOKS RIGHT \(keep filling\)\n/);
  assert.match(feedbackMarkdown("T", { ...fb, verdict: "changes" }, "fill"), /Verdict: REOPEN SKELETON \(structural change requested\)\n/);
  assert.doesNotMatch(fill, /APPROVED/);
});
