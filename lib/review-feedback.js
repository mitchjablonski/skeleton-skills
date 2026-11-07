// What the review page copies and sends: plain functions (no DOM), inlined
// into the page ahead of review-client.js (like review-poll.js) and run by
// the tests directly.
//
// A draft (kept per viewer in localStorage) is
//   { verdict: "approve" | "changes" | null, verdictVersion, verdictPhase, verdictAt,
//     general, skeletonGeneral, phase,
//     comments: [{ file, line, step, text, version, phase, outdated, anchor }],
//     verdictCleared: { verdict, from, to, phase } | undefined }
// verdictVersion is the skeleton version the verdict was given on (and
// verdictPhase the phase: "scaffold" or "fill"), and each
// comment's version the one it was written on. A draft saved before either
// existed has neither: its verdict counts as given on an unknown version and
// its comments as written on one. verdictAt is when the human last chose (or
// unchose) a verdict, so two tabs can tell whose choice is newer. phase is
// the phase the draft was last saved in, and a comment's phase the one it was
// written in: notes from the skeleton review are marked as such once filling
// starts (skeletonGeneral holds that review's Overall notes).

// eslint-disable-next-line no-unused-vars
const SKEL_VERDICTS = {
  scaffold: { approve: "APPROVED", changes: "CHANGES REQUESTED" },
  fill: { approve: "LOOKS RIGHT (keep filling)", changes: "REOPEN SKELETON (structural change requested)" },
};

/**
 * The draft as it stands against the page: the skeleton version it shows
 * (current) and its phase. A verdict given on another version (or an unknown
 * one: an older draft) is dropped, and verdictCleared records that, so the
 * page can say so until the human gives a verdict again. A verdict from the
 * other phase (an approval, once filling starts) is dropped quietly: it
 * answered a different question. Comments are kept: they are stamped, and
 * say which version they were written on.
 *
 * Returns { draft, changed }: a new draft, and whether it differs (to save).
 */
// eslint-disable-next-line no-unused-vars
function skelDraftForVersion(draft, current, phase) {
  const d = { ...draft };
  let changed = false;
  const clear = () => { d.verdict = null; d.verdictVersion = null; delete d.verdictPhase; changed = true; };
  if (phase && d.verdictCleared && d.verdictCleared.phase && d.verdictCleared.phase !== phase) { delete d.verdictCleared; changed = true; }
  if (d.verdict && phase && d.verdictPhase && d.verdictPhase !== phase) clear();
  else if (d.verdict && d.verdictVersion !== current) {
    d.verdictCleared = { verdict: d.verdict, from: typeof d.verdictVersion === "string" ? d.verdictVersion : null, to: current, ...(phase ? { phase } : {}) };
    clear();
  } else if (!d.verdict && (d.verdictVersion != null || d.verdictPhase != null)) clear();
  // A notice from an earlier reload follows the page to the version it shows now.
  if (d.verdictCleared && d.verdictCleared.to !== current) {
    d.verdictCleared = { ...d.verdictCleared, to: current };
    changed = true;
  }
  return { draft: d, changed };
}

/** The feedback panel's message for a cleared verdict, or null. */
// eslint-disable-next-line no-unused-vars
function skelVerdictClearedMessage(cleared, phase) {
  if (!cleared) return null;
  const fill = phase !== "scaffold";
  const did = cleared.verdict === "approve"
    ? (fill ? "said it looks right" : "approved it")
    : (fill ? "asked to reopen it" : "requested changes");
  const again = cleared.verdict === "approve" && !fill ? "approve again" : "choose again";
  const from = cleared.from ?? "an earlier version";
  return `The skeleton changed since you ${did} (${from} → ${cleared.to}). Check the highlighted changes, then ${again}.`;
}

// eslint-disable-next-line no-unused-vars
const SKEL_FROM_SKELETON = "[from the skeleton review]";

/**
 * The draft as it stands in the page's phase. Comments without a phase get
 * the draft's (the phase it was last saved in), and once the skeleton review
 * is over (the page shows the fill, or a finalized skeleton) its Overall notes
 * move to skeletonGeneral, so the fill review's Overall box starts empty. Both
 * stay, marked: Claude has most likely applied them already, but the human
 * may not have copied them, so they aren't dropped.
 *
 * Returns { draft, changed }.
 */
// eslint-disable-next-line no-unused-vars
function skelDraftForPhase(draft, phase) {
  const d = { ...draft, comments: (draft.comments ?? []).map((c) => (c.phase || !draft.phase ? c : { ...c, phase: draft.phase })) };
  let changed = d.comments.some((c, i) => c !== draft.comments[i]);
  if (draft.phase === "scaffold" && phase && phase !== "scaffold" && (d.general ?? "").trim()) {
    d.skeletonGeneral = [d.skeletonGeneral, d.general.trim()].filter(Boolean).join("\n\n");
    d.general = "";
    changed = true;
  }
  if (phase && d.phase !== phase) { d.phase = phase; changed = true; }
  return { draft: d, changed };
}

/** Is this comment from an earlier skeleton review, as the page in `phase` sees it? */
// eslint-disable-next-line no-unused-vars
function skelFromSkeleton(c, phase) {
  return phase !== "scaffold" && c.phase === "scaffold";
}

const VERDICT_FIELDS = ["verdict", "verdictVersion", "verdictPhase", "verdictAt", "verdictCleared"];

/**
 * Two tabs share one draft. The verdict kept is the newer choice (verdictAt):
 * a tab that cleared a verdict only because it shows another version, which
 * isn't a choice, never wins over a fresh verdict from another tab. On a tie,
 * a verdict beats none. Everything else is `mine`'s.
 */
// eslint-disable-next-line no-unused-vars
function skelMergeVerdict(mine, other) {
  const a = Number(mine.verdictAt) || 0;
  const b = Number(other?.verdictAt) || 0;
  const theirs = !!other && (b > a || (b === a && !!other.verdict && !mine.verdict));
  if (!theirs) return mine;
  const out = { ...mine };
  for (const k of VERDICT_FIELDS) { if (k in other) out[k] = other[k]; else delete out[k]; }
  return out;
}

/**
 * Where a comment belongs now that the file changed. It remembered its line's
 * text and neighbours, and the step (fence) it was in: a candidate line must
 * be in that same fence (or outside every fence, for a comment that was), so a
 * note on one step's stub never moves to an identical stub in another step.
 *
 * c: { line, step, anchor: { text, before, after } }. lines: the file now.
 * stepAt(line): the fence id at a line, or null.
 * Returns { line, step, outdated }.
 */
// eslint-disable-next-line no-unused-vars
function skelReanchor(c, lines, stepAt) {
  const want = c.step ?? null;
  const here = (n) => (stepAt(n) ?? null) === want;
  if (lines[c.line - 1] === c.anchor.text && here(c.line)) return { line: c.line, step: want, outdated: false };
  let best = null;
  lines.forEach((l, i) => {
    if (l !== c.anchor.text || !here(i + 1)) return;
    const score = (lines[i - 1] === c.anchor.before ? 2 : 0) + (lines[i + 1] === c.anchor.after ? 2 : 0) - Math.abs(i + 1 - c.line) / 10000;
    if (!best || score > best.score) best = { line: i + 1, score };
  });
  // Short or punctuation-only lines (`}`, `);`) recur everywhere: they only
  // re-anchor when a neighbour matches too.
  const distinctive = /[A-Za-z0-9_$]{3,}/.test(c.anchor.text);
  if (best && (distinctive || best.score >= 2)) return { line: best.line, step: want, outdated: false };
  return { line: c.line, step: c.step, outdated: true };
}

/**
 * What goes to Claude, by Copy or Send: the verdict only when it was given on
 * the version shown, and the version that review is of (the verdict's; with
 * no verdict, the version on screen). Comments keep their own versions. Once
 * filling, notes from the skeleton review are marked, so Claude doesn't apply
 * them twice.
 */
// eslint-disable-next-line no-unused-vars
function skelOutgoing(draft, current, phase) {
  const verdict = draft.verdict && draft.verdictVersion === current ? draft.verdict : null;
  const comments = (draft.comments ?? []).map((c) => {
    const text = c.outdated ? `${c.text}\n(outdated: was on "${(c.anchor?.text ?? "").trim().slice(0, 80)}")` : c.text;
    return {
      file: c.file, line: c.line, step: c.step,
      ...(typeof c.version === "string" ? { version: c.version } : {}),
      text: skelFromSkeleton(c, phase) ? `${SKEL_FROM_SKELETON} ${text}` : text,
    };
  });
  const earlier = (draft.skeletonGeneral ?? "").trim();
  const general = [earlier ? `${SKEL_FROM_SKELETON} ${earlier}` : "", (draft.general ?? "").trim()].filter(Boolean).join("\n\n");
  return { verdict, general, comments, version: verdict ? draft.verdictVersion : current };
}

/** How a comment's version reads next to it, when it isn't the current one ("" when it is). */
// eslint-disable-next-line no-unused-vars
function skelCommentVersionTag(c, current) {
  if (c.version === current) return "";
  return typeof c.version === "string" ? ` [written on version ${c.version}]` : " [written on an unknown earlier version]";
}

/**
 * Copy's markdown. page: { title, phase, skeletonVersion }. out: skelOutgoing's
 * answer. The skeleton phase asks for approval (with the `--reviewed` hint
 * only for an approval given on the version shown); the fill phase is a fill
 * review and never an approval request.
 */
// eslint-disable-next-line no-unused-vars
function skelFeedbackMarkdown(page, out) {
  const current = page.skeletonVersion;
  const reviewing = page.phase === "scaffold";
  const words = SKEL_VERDICTS[reviewing ? "scaffold" : "fill"];
  const lines = [reviewing ? `# Skeleton review: ${page.title}` : `# Fill review: ${page.title}`, ""];
  lines.push(`Verdict: ${out.verdict ? words[out.verdict] : "no verdict (comments only)"}`);
  const hint = reviewing && out.verdict === "approve" && out.version === current ? ` (approve with: skel approve --reviewed ${current})` : "";
  lines.push(`Reviewed skeleton version: ${out.version}${hint}`, "");
  if (out.general.trim()) lines.push("## Overall", out.general.trim(), "");
  const cs = out.comments;
  if (cs.length) {
    lines.push("## Line comments");
    const older = cs.filter((c) => c.version !== current);
    if (older.length) {
      const named = [...new Set(older.map((c) => c.version).filter((v) => typeof v === "string"))];
      lines.push(`Note: ${older.length === cs.length ? "these comments were" : `${older.length} of these ${cs.length} comments ${older.length === 1 ? "was" : "were"}`} written on an earlier skeleton version (${named.length ? named.join(", ") : "unknown"}), not the current one (${current}). They are marked below; they may not apply to the current version, and they are not a review of it.`);
    }
    for (const c of [...cs].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      const where = c.file.startsWith("diagram:") ? `diagram "${c.file.slice(8)}"` : `${c.file}:${c.line}`;
      lines.push(`- ${where}${c.step ? ` (step ${c.step})` : ""}${skelCommentVersionTag(c, current)}: ${c.text.replace(/\n/g, "\n  ")}`);
    }
  }
  return lines.join("\n");
}
