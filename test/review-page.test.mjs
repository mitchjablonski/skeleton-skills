// #67: the review page's logic (progress, finalized summary, notes across the
// phase change, two tabs, re-anchoring), the CLI's matching words, and the
// page's static guarantees (recovery text, reduced motion, contrast). The
// browser behaviour itself was checked with Playwright; see the PR.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildReviewData } from "../lib/review.mjs";
import { readState } from "../lib/state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");
const BIN = path.join(HERE, "..", "bin", "skel.mjs");
const read = (f) => fs.readFileSync(path.join(LIB, f), "utf-8");

const TEMPS = [];
after(() => { for (const d of TEMPS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch {} } });
const mkTemp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); TEMPS.push(d); return d; };
process.env.XDG_CONFIG_HOME = mkTemp("skel-config-");
process.env.XDG_STATE_HOME = mkTemp("skel-state-");
process.env.LOCALAPPDATA = mkTemp("skel-localappdata-");

const { skelProgress } = new Function(read("review-progress.js") + "\nreturn { skelProgress };")();
const { skelDraftForPhase, skelDraftForVersion, skelMergeVerdict, skelSettle, skelReanchor, skelOutgoing, skelFeedbackMarkdown, skelFromSkeleton, skelVerdictClearedMessage } = new Function(
  read("review-feedback.js") + "\nreturn { skelDraftForPhase, skelDraftForVersion, skelMergeVerdict, skelSettle, skelReanchor, skelOutgoing, skelFeedbackMarkdown, skelFromSkeleton, skelVerdictClearedMessage };",
)();

const V = "aaaaaaaaaaaa";
const W2 = "bbbbbbbbbbbb";

// ---- B5: progress ----

test("#67 B5: the active step counts as filling, not done, even once its stubs are gone", () => {
  const steps = [{ id: "1", status: "filled" }, { id: "2", status: "filled" }, { id: "3", status: "todo" }, { id: "4", status: "todo" }, { id: "5", status: "todo" }];
  assert.deepEqual(skelProgress({ phase: "fill", steps, activeStep: "2" }), { done: 1, total: 5, text: "1/5 done · step 2 filling" });
  assert.equal(skelProgress({ phase: "fill", steps, activeStep: null }).text, "2/5 done");
  assert.equal(skelProgress({ phase: "fill", steps, activeStep: "3" }).text, "2/5 done · step 3 filling");
  assert.equal(skelProgress({ phase: "fill", steps, activeStep: "9" }).text, "2/5 done", "an active step whose fence is gone isn't claimed");
  assert.equal(skelProgress({ phase: "scaffold", steps: [{ id: "1", status: "todo" }], activeStep: null }).text, "0/1 done");
});

test("#67 B4: a finalized skeleton's progress is the count finalize recorded, never 0/0", () => {
  assert.deepEqual(skelProgress({ phase: "done", steps: [], finalized: { steps: 3 } }), { done: 3, total: 3, text: "finalized · 3/3 done" });
  assert.deepEqual(skelProgress({ phase: "done", steps: [], finalized: null }), { done: null, total: null, text: "finalized" });
});

// ---- B4/B5 through the CLI: status and the page data agree ----

const SRC = `export function a(): number {
  // SKEL[1] first
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}

export function b(): number {
  // SKEL[2] second
  throw new Error("SKEL_TODO");
  // /SKEL[2]
}
`;
const STUB = 'throw new Error("SKEL_TODO");';

function project() {
  const dir = mkTemp("skel-page-");
  fs.mkdirSync(path.join(dir, "src"));
  const a = path.join(dir, "src", "a.ts");
  fs.writeFileSync(a, SRC);
  const run = (...args) => execFileSync("node", [BIN, ...args], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return { dir, a, run };
}
const pageProgress = (dir) => skelProgress(buildReviewData(dir, readState(dir))).text;

test("#67 B4 B5: skel status and the page say the same progress, and a finalized skeleton is summarised", () => {
  const { dir, a, run } = project();
  run("init", "T");
  fs.mkdirSync(path.join(dir, ".skeleton", "diagrams"));
  fs.writeFileSync(path.join(dir, ".skeleton", "diagrams", "flow.mmd"), "flowchart LR\n  step_1 --> step_2\n");
  run("approve");
  run("next");
  fs.writeFileSync(a, fs.readFileSync(a, "utf-8").replace(STUB, "return 1;"));
  // Step 1 has no stub left, but `skel done` hasn't accepted it: filling.
  assert.match(run("status"), /— 0\/2 done · step 1 filling\n/);
  assert.equal(pageProgress(dir), "0/2 done · step 1 filling");
  run("done");
  assert.match(run("status"), /— 1\/2 done\n/);
  assert.equal(pageProgress(dir), "1/2 done");
  run("next");
  assert.match(run("status"), /— 1\/2 done · step 2 filling\n/);
  assert.equal(pageProgress(dir), "1/2 done · step 2 filling");
  fs.writeFileSync(a, fs.readFileSync(a, "utf-8").replace(STUB, "return 2;"));
  run("done");
  run("finalize");
  const status = run("status");
  assert.match(status, /^T — phase: done — finalized: all 2 steps filled and markers removed\n/);
  assert.doesNotMatch(status, /match no step/, "the diagram check is skipped once the markers are gone");
  const data = buildReviewData(dir, readState(dir));
  assert.deepEqual(data.finalized, { steps: 2, titles: [{ id: "1", title: "first" }, { id: "2", title: "second" }] });
  assert.ok(data.files.some((f) => f.path === "src/a.ts"), "the built files are still shown");
  assert.equal(skelProgress(data).text, "finalized · 2/2 done");
});

test("#67 B4: a hand-edited finalized record is read defensively", () => {
  const { dir, run } = project();
  run("init", "T");
  const file = path.join(dir, ".skeleton", "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf-8"));
  fs.writeFileSync(file, JSON.stringify({ ...state, phase: "done", finalized: { steps: [{ id: 1 }, { id: "2", title: "ok" }], files: ["../outside.ts", 7] } }));
  const data = buildReviewData(dir, readState(dir));
  assert.deepEqual(data.finalized, { steps: 1, titles: [{ id: "2", title: "ok" }] });
  assert.ok(!data.files.some((f) => f.path.includes("outside")), "a path outside the project is never read");
  assert.match(run("status"), /finalized: all 1 step filled and markers removed/);
});

test("#67 B6: skel status says plainly what it didn't check", () => {
  const { dir, run } = project();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  run("init", "T");
  run("approve");
  assert.match(run("status"), /\(this checked only the skeleton's own files: new, deleted or changed files elsewhere are checked against source baseline [0-9a-f]{12} at skel done and skel finalize\)/);
});

// ---- #69 review (a): notes from the skeleton review are marked once filling ----

test("#69 (a): skeleton-phase comments and Overall notes are marked in the fill review, not dropped", () => {
  const saved = { verdict: null, general: "rename take", phase: "scaffold", comments: [{ file: "a.ts", line: 2, step: "1", text: "nit", version: V }] };
  const { draft, changed } = skelDraftForPhase(saved, "fill");
  assert.equal(changed, true);
  assert.equal(draft.general, "", "the fill review's Overall box starts empty");
  assert.equal(draft.skeletonGeneral, "rename take");
  assert.equal(draft.comments[0].phase, "scaffold");
  assert.equal(draft.phase, "fill");
  assert.equal(skelDraftForPhase(draft, "fill").changed, false, "idempotent");
  // A note written during the fill isn't marked.
  draft.comments.push({ file: "a.ts", line: 5, step: "2", text: "fill note", version: V, phase: "fill" });
  draft.general = "looks fine";
  const out = skelOutgoing(draft, V, "fill");
  assert.equal(out.general, "[from the skeleton review] rename take\n\nlooks fine");
  assert.deepEqual(out.comments.map((c) => c.text), ["[from the skeleton review] nit", "fill note"]);
  const md = skelFeedbackMarkdown({ title: "T", phase: "fill", skeletonVersion: V }, out);
  assert.match(md, /## Overall\n\[from the skeleton review\] rename take\n\nlooks fine\n/);
  assert.match(md, /- a\.ts:2 \(step 1\): \[from the skeleton review\] nit/);
  // In the skeleton phase nothing is marked.
  const scaffold = skelOutgoing({ general: "g", comments: [{ file: "a.ts", line: 1, text: "x", phase: "scaffold" }] }, V, "scaffold");
  assert.deepEqual([scaffold.general, scaffold.comments[0].text], ["g", "x"]);
  assert.equal(skelFromSkeleton({ phase: "scaffold" }, "done"), true);
  // A draft from before phases were recorded is left as it was.
  assert.equal(skelDraftForPhase({ general: "old", comments: [{ text: "c" }] }, "fill").draft.general, "old");
});

// ---- #69 review (b): two tabs, one draft ----

test("#69 (b): a stale tab's save keeps another tab's newer verdict", () => {
  // Tab B approved version W2 just now; tab A still shows V, so its load-time
  // check cleared that verdict (not a choice: verdictAt unchanged).
  const stored = { verdict: "approve", verdictVersion: W2, verdictPhase: "scaffold", verdictAt: 2000, general: "", comments: [] };
  const tabA = skelDraftForVersion({ ...stored, comments: [{ file: "a.ts", line: 1, text: "typed in A" }] }, V, "scaffold").draft;
  assert.equal(tabA.verdict, null);
  const saved = skelMergeVerdict(tabA, stored);
  assert.deepEqual([saved.verdict, saved.verdictVersion, saved.verdictAt], ["approve", W2, 2000]);
  assert.equal(saved.comments[0].text, "typed in A", "A's own notes are saved");
  assert.equal(saved.verdictCleared, undefined, "A's notice isn't written over B's verdict");
  // An older verdict in another tab loses to a newer choice here, including a newer "no verdict".
  assert.equal(skelMergeVerdict({ verdict: "changes", verdictAt: 3000 }, stored).verdict, "changes");
  assert.equal(skelMergeVerdict({ verdict: null, verdictAt: 3000 }, stored).verdict, null);
  // A draft with no verdictAt (an older page) never outranks a stamped verdict.
  assert.equal(skelMergeVerdict({ verdict: null }, stored).verdict, "approve");
  assert.equal(skelMergeVerdict({ verdict: "changes", verdictAt: 1 }, null).verdict, "changes", "nothing stored: mine");
});

// The client's draft handling (lib/review-client.js), on a localStorage stand-in.
function tab(storage, version, phase) {
  const load = (stored) => skelDraftForVersion(skelDraftForPhase({ verdict: null, verdictVersion: null, general: "", comments: [], ...stored }, phase).draft, version, phase).draft;
  const stored = storage.value ?? {};
  let draft = load(stored);
  if (stored.verdict && !draft.verdict) draft.verdictSettled = skelSettle(stored);
  const t = {
    get draft() { return draft; },
    save() { storage.value = skelMergeVerdict(draft, storage.value ?? null); },
    choose(v, at) { draft = { ...draft, verdict: v, verdictVersion: version, verdictPhase: phase, verdictAt: at }; delete draft.verdictCleared; t.save(); },
    storageEvent() { draft = load(skelMergeVerdict(storage.value, draft)); },
    copy() { return skelFeedbackMarkdown({ title: "T", phase, skeletonVersion: version }, skelOutgoing(draft, version, phase)); },
  };
  t.save();
  return t;
}

test("#70 review: a cleared approval stays cleared when the shape returns to the approved version", () => {
  const storage = {};
  tab(storage, V, "scaffold").choose("approve", 1000);
  // An edit outside the fences: the page reloads onto W2 and clears the approval.
  const changed = tab(storage, W2, "scaffold");
  assert.equal(changed.draft.verdict, null);
  assert.equal(storage.value.verdict, null, "the clear is saved, not only shown");
  // The edit is reverted: back on V, nothing pressed, and Copy isn't an approval.
  const back = tab(storage, V, "scaffold");
  assert.equal(back.draft.verdict, null);
  assert.doesNotMatch(back.copy(), /APPROVED|approve with/);
  assert.match(skelVerdictClearedMessage(back.draft.verdictCleared, "scaffold"), /changed after you approved it, then changed back to aaaaaaaaaaaa\. Check it, then approve again\./);
  // The same for the phase: a skeleton approval dropped in the fill doesn't return after a reshape.
  const s2 = {};
  tab(s2, V, "scaffold").choose("approve", 1000);
  tab(s2, V, "fill");
  assert.equal(tab(s2, V, "scaffold").draft.verdict, null);
});

test("#70 review: a newer approval in another tab still survives a stale tab, settled clear or not", () => {
  const storage = {};
  tab(storage, V, "scaffold").choose("approve", 1000);
  const stale = tab(storage, W2, "scaffold"); // settled the clear of the V approval
  const fresh = tab(storage, V, "scaffold");
  fresh.choose("approve", 2000);
  stale.storageEvent();
  stale.save();
  assert.deepEqual([storage.value.verdict, storage.value.verdictVersion, storage.value.verdictAt], ["approve", V, 2000]);
  assert.equal(tab(storage, V, "scaffold").draft.verdict, "approve");
});

// ---- #69 review (c): re-anchoring stays in its step ----

test("#69 (c): a note on one step's stub never moves to an identical stub in another step", () => {
  const before = SRC.split("\n").slice(0, -1);
  const fences = (lines) => {
    const at = [];
    let open = null;
    lines.forEach((l, i) => { const o = /SKEL\[(\d+)\]/.exec(l); if (o && !l.includes("/SKEL")) open = o[1]; at[i + 1] = open; if (l.includes("/SKEL")) open = null; });
    return (n) => at[n] ?? null;
  };
  const c = { line: 3, step: "1", anchor: { text: before[2], before: before[1], after: before[3] } };
  // Step 1 filled: its stub is gone, step 2's identical stub remains.
  const filled = SRC.replace(STUB, "const x = 1;\n  return x;").split("\n").slice(0, -1);
  assert.deepEqual(skelReanchor(c, filled, fences(filled)), { line: 3, step: "1", outdated: true });
  // Lines inserted above: the note follows its line within step 1.
  const shifted = ["// header", "", ...before];
  assert.deepEqual(skelReanchor(c, shifted, fences(shifted)), { line: 5, step: "1", outdated: false });
  // Step 2's stub landing on the note's old line number doesn't hold it either.
  const moved = before.slice(6);
  assert.equal(moved[2], before[8], "step 2's stub is now line 3");
  assert.equal(skelReanchor(c, moved, fences(moved)).outdated, true);
  // A note outside every fence follows code outside the fences only.
  const out = { line: 1, step: null, anchor: { text: before[0], before: null, after: before[1] } };
  assert.deepEqual(skelReanchor(out, shifted, fences(shifted)), { line: 3, step: null, outdated: false });
});

// ---- the page's static guarantees ----

const client = read("review-client.js");
const css = read("review.css");

test("#67 B7: recovery text asks Claude for the link; it never says to run skel serve", () => {
  assert.ok(client.includes('const OPEN_LINK = "Ask Claude for the current review link and open the whole link, including the part after #, in this tab or another. Your unsent notes are kept in this browser.";'));
  assert.ok(client.includes("const EXPIRED = `This link has expired because the review server restarted. ${OPEN_LINK}`;"));
  for (const m of client.matchAll(/(?:gate|toast)\(([^;]*)\)/g)) assert.doesNotMatch(m[1], /skel serve/, m[0]);
  assert.doesNotMatch(client.slice(client.indexOf("function lockBanner"), client.indexOf("function feedbackPanel")), /skel serve/);
  assert.match(css, /\.gate \{[^}]*max-width/);
});

test("#67 B8 B11: the review jump reaches 1100px; reduced motion turns off smooth scroll and the flash", () => {
  assert.match(css, /@media \(max-width: 1100px\) \{\s*\.layout \{ padding-bottom: 72px; \}\s*\.mobile-jump \{\s*display: block;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\}\s*tr\.flash td \{ animation: none; \}/);
  assert.match(client, /behavior: reducedMotion\(\) \? "auto" : "smooth"/);
});

// WCAG contrast of the page's text colours on every background they sit on.
function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}
const lum = (hex) => {
  const [r, g, b] = hex.match(/\w\w/g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("#67 B10: text colours hold 4.5:1 on every row and panel background, light and dark", () => {
  const light = tokens(css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")));
  const dark = { ...light, ...tokens(css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("* { box-sizing"))) };
  const rows = ["surface", "surface-2", "accent-soft", "todo-soft", "filled-soft", "comment", "changed", "drift-soft"];
  const pairs = [
    ...["tok-kw", "tok-str", "tok-com", "tok-num", "text", "muted"].flatMap((fg) => rows.map((bg) => [fg, bg])),
    ["todo-ink", "todo-soft"], ["todo-ink", "surface-2"], ["filled-ink", "filled-soft"], ["filled-ink", "surface"],
    ["accent", "accent-soft"], ["drift", "drift-soft"], ["on-accent", "accent"],
  ];
  for (const [name, t] of [["light", light], ["dark", dark]]) {
    for (const [fg, bg] of pairs) {
      const r = contrast(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${name}: --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
    }
  }
  // The text uses: the pressed verdicts, the changed-lines header, the stale pill.
  assert.match(css, /\.btn\.on\.changes \{[^}]*color: var\(--todo-ink\)/);
  assert.match(css, /\.btn\.on\.approve \{[^}]*color: var\(--filled-ink\)/);
  assert.match(css, /\.changed-count \{ color: var\(--todo-ink\); \}/);
});

test("#67 B4: the fill skill stops the review server after finalize", () => {
  const skill = fs.readFileSync(path.join(HERE, "..", "skills", "skeleton-fill", "SKILL.md"), "utf-8");
  const at = skill.indexOf("skel finalize    #");
  assert.ok(at > 0 && skill.indexOf("skel serve --stop", at) > at);
});
