// #68: review-page and fill-flow polish. The page's Copy/Send content and the
// server's Send markdown (approve with comments, the quoted line, counts, the
// sent summary), the page data behind the sidebar (each fence's title, the
// "may escape its block" note), the WSL path for `skel review`, and the
// client's and skills' words. Browser behaviour was checked with Playwright;
// see the PR.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanFeedback, feedbackMarkdown } from "../lib/feedback.mjs";
import { buildReviewData, loadEscapeCheck, windowsReviewPath } from "../lib/review.mjs";
import { readState } from "../lib/state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");
const BIN = path.join(HERE, "..", "bin", "skel.mjs");
const read = (f) => fs.readFileSync(path.join(LIB, f), "utf-8");
const client = read("review-client.js");
const css = read("review.css");

const TEMPS = [];
after(() => { for (const d of TEMPS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch {} } });
const mkTemp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); TEMPS.push(d); return d; };
process.env.XDG_CONFIG_HOME = mkTemp("skel-config-");
process.env.XDG_STATE_HOME = mkTemp("skel-state-");
process.env.LOCALAPPDATA = mkTemp("skel-localappdata-");

const F = new Function(read("review-feedback.js") + "\nreturn { skelDraftForVersion, skelOutgoing, skelFeedbackMarkdown, skelQuote, skelCommentCounts, skelCountText, skelSentSummary, skelVerdictWords };")();

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const page = (phase, skeletonVersion = B) => ({ title: "T", phase, skeletonVersion });
const copy = (draft, p) => F.skelFeedbackMarkdown(p, F.skelOutgoing(F.skelDraftForVersion(draft, p.skeletonVersion, p.phase).draft, p.skeletonVersion, p.phase));
const comment = (over = {}) => ({ file: "a.ts", line: 3, step: "1", text: "rename it", version: B, anchor: { text: "  export function take(b: Bucket): boolean {", before: null, after: null }, ...over });

// ---- P2: approve with comments ----

test("#68 P2: an approval with comments reads APPROVED WITH COMMENTS and gets no approve hint", () => {
  const md = copy({ verdict: "approve", verdictVersion: B, general: "", comments: [comment()] }, page("scaffold"));
  assert.match(md, /\nVerdict: APPROVED WITH COMMENTS \(apply these, then ask me to approve the new version\)\n/);
  assert.match(md, new RegExp(`\\nReviewed skeleton version: ${B}\\n`));
  assert.doesNotMatch(md, /approve with: skel approve/, "applying the comments makes a new version: no --reviewed hint for this one");
  // Overall notes alone count as comments too.
  assert.match(copy({ verdict: "approve", verdictVersion: B, general: "one nit", comments: [] }, page("scaffold")), /Verdict: APPROVED WITH COMMENTS/);
  // A plain approval keeps #66's hint.
  assert.match(copy({ verdict: "approve", verdictVersion: B, general: " ", comments: [] }, page("scaffold")), new RegExp(`Verdict: APPROVED\\nReviewed skeleton version: ${B} \\(approve with: skel approve --reviewed ${B}\\)`));
});

test("#68 P2: #66's version rule still holds: an approval from another version is dropped, comments or not", () => {
  const md = copy({ verdict: "approve", verdictVersion: A, general: "x", comments: [comment()] }, page("scaffold"));
  assert.match(md, /\nVerdict: no verdict \(comments only\)\n/);
  assert.doesNotMatch(md, /APPROVED|approve with/);
});

test("#68 P2: the fill phase never says approved; the server's Send words match the page's Copy", () => {
  assert.match(copy({ verdict: "approve", verdictVersion: B, general: "", comments: [comment()] }, page("fill")), /Verdict: LOOKS RIGHT \(keep filling\)\n/);
  for (const phase of ["scaffold", "fill"]) {
    for (const [general, comments] of [["", []], ["g", []], ["", [comment()]]]) {
      for (const verdict of ["approve", "changes", null]) {
        const out = F.skelOutgoing({ verdict, verdictVersion: B, general, comments }, B, phase);
        const pageWords = /\nVerdict: (.*)\n/.exec(F.skelFeedbackMarkdown(page(phase), out))[1];
        const serverWords = /\nVerdict: (.*)\n/.exec(feedbackMarkdown("T", cleanFeedback(out), phase))[1];
        assert.equal(serverWords, pageWords, `${phase} ${verdict} ${general ? "general" : ""}${comments.length ? "comments" : ""}`);
      }
    }
  }
});

test("#68 P2: the skeleton skill applies the comments first and needs a fresh approval", () => {
  const skill = fs.readFileSync(path.join(HERE, "..", "skills", "skeleton", "SKILL.md"), "utf-8");
  const at = skill.indexOf("**APPROVED WITH COMMENTS**");
  assert.ok(at > 0);
  const para = skill.slice(at, skill.indexOf("\n- ", at));
  assert.match(para, /not an approval yet/);
  assert.match(para, /apply the comments first/);
  assert.match(para, /ask them to approve the new version/);
  assert.match(para, /Run `skel approve` only after they approve again/);
  assert.match(client, /"Approve with comments"/);
});

// ---- P3: the quoted line ----

test("#68 P3: Copy quotes the code line a comment is on, truncated to about 80 characters", () => {
  assert.equal(F.skelQuote("   a   b\tc  "), "a b c");
  const long = "x".repeat(200);
  const q = F.skelQuote(long);
  assert.equal(q.length, 80);
  assert.ok(q.endsWith("…"));
  const md = copy({ verdict: null, general: "", comments: [comment()] }, page("scaffold"));
  assert.match(md, /\n- a\.ts:3 \(step 1\): rename it\n  > export function take\(b: Bucket\): boolean \{$/);
  // A diagram comment has no line to quote, and an outdated one already says what it was on.
  const out = F.skelOutgoing({ verdict: null, general: "", comments: [comment({ file: "diagram:flow", line: 0, step: null, anchor: null }), comment({ outdated: true })] }, B, "scaffold");
  assert.deepEqual(out.comments.map((c) => c.quote), [undefined, undefined]);
  assert.match(out.comments[1].text, /\(outdated: was on "export function take/);
});

test("#68 P3: the server keeps the quote as one short line and prints it the same way", () => {
  const fb = cleanFeedback({ verdict: null, general: "", version: B, comments: [{ file: "a.ts", line: 3, text: "t", version: B, quote: "line one\n> injected\n" + "y".repeat(300) }] });
  assert.ok(!fb.comments[0].quote.includes("\n"));
  assert.ok(fb.comments[0].quote.length <= 120);
  assert.match(feedbackMarkdown("T", fb), /\n- a\.ts:3: t\n  > line one > injected y+$/);
  assert.equal(cleanFeedback({ comments: [{ file: "a.ts", line: 1, text: "t", quote: 7 }] }).comments[0].quote, undefined);
});

// ---- P4 and P6: counts and the sent summary ----

test("#68 P4: line and diagram comments are counted apart", () => {
  const cs = [comment(), comment({ line: 4 }), comment({ file: "diagram:flow", line: 0 })];
  assert.deepEqual(F.skelCommentCounts(cs), { line: 2, diagram: 1 });
  assert.equal(F.skelCountText(cs), "2 line comments · 1 diagram comment");
  assert.equal(F.skelCountText([comment({ file: "diagram:flow" })]), "1 diagram comment");
  assert.equal(F.skelCountText([]), "0 line comments");
  assert.match(client, /skelCountText\(liveComments\(\)\)/);
});

test("#68 P6: the sent summary names the verdict and what came with it", () => {
  const sum = (draft, phase = "scaffold") => F.skelSentSummary(page(phase), F.skelOutgoing(draft, B, phase));
  assert.equal(sum({ verdict: "approve", verdictVersion: B, general: "", comments: [] }), "APPROVED");
  assert.equal(sum({ verdict: "approve", verdictVersion: B, general: "g", comments: [comment()] }), "APPROVED WITH COMMENTS, 1 line comment, Overall notes");
  assert.equal(sum({ verdict: null, general: "", comments: [comment({ file: "diagram:flow", line: 0 })] }), "no verdict, 1 diagram comment");
  assert.equal(sum({ verdict: "approve", verdictVersion: B, general: "", comments: [] }, "fill"), "LOOKS RIGHT");
  assert.match(client, /Sent at \$\{when\(lastSent\.at\)\}: \$\{lastSent\.summary\}\./);
  assert.match(client, /h\("summary", \{\}, `Last sent at /);
});

// ---- P4, P11: page data ----

const SRC = `export function a(): number {
  // SKEL[1] first
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}
`;
const TEST = `test("a", () => {
  // SKEL[1] first, tested
  throw new Error("SKEL_TODO");
  // /SKEL[1]
});
`;

function project() {
  const dir = mkTemp("skel-polish-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), SRC);
  fs.writeFileSync(path.join(dir, "src", "a.test.ts"), TEST);
  const run = (...args) => execFileSync("node", [BIN, ...args], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return { dir, run };
}

test("#68 P4 P11: each fence's title reaches the page, and a fill that may leave its block is noted by its step", async () => {
  const { dir, run } = project();
  run("init", "T");
  let data = buildReviewData(dir, readState(dir));
  const step = data.steps.find((s) => s.id === "1");
  assert.deepEqual(step.locations.map((l) => l.title).sort(), ["first", "first, tested"]);
  run("approve");
  run("next");
  const file = path.join(dir, "src", "a.ts");
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace('throw new Error("SKEL_TODO");', "return 1;\n}\nexport function sneak(): number {\n  return 2;"));
  const check = await loadEscapeCheck();
  assert.equal(typeof check, "function");
  data = buildReviewData(dir, readState(dir), undefined, undefined, check);
  const fence = data.files.find((f) => f.path === "src/a.ts").fences[0];
  assert.equal(fence.status, "filled");
  assert.match(fence.escape, /\S/, "the same heuristic skel done's note uses");
  // skel done prints the same note.
  const t = path.join(dir, "src", "a.test.ts");
  fs.writeFileSync(t, fs.readFileSync(t, "utf-8").replace('throw new Error("SKEL_TODO");', "expect(1).toBe(1);"));
  assert.ok(run("done").includes(`note: in src/a.ts:${fence.openLine}-${fence.closeLine}, ${fence.escape} (a heuristic`));
  // Without the gate (it failed to load), the page just has no notes.
  data = buildReviewData(dir, readState(dir));
  assert.equal(data.files.find((f) => f.path === "src/a.ts").fences[0].escape, undefined);
  assert.match(client, /data-escape/);
});

// ---- P8: the WSL path ----

test("#68 P8: on WSL, skel review names a path a Windows browser can open", () => {
  const mountOf = (p) => (p.startsWith("/mnt/c/") ? "/mnt/c" : null);
  assert.equal(windowsReviewPath("/tmp/p/.skeleton/review.html", { platform: "linux", distro: "Ubuntu", mountOf }), "\\\\wsl.localhost\\Ubuntu\\tmp\\p\\.skeleton\\review.html");
  assert.equal(windowsReviewPath("/mnt/c/Users/me/p/.skeleton/review.html", { platform: "linux", distro: "Ubuntu", mountOf }), "C:\\Users\\me\\p\\.skeleton\\review.html");
  assert.equal(windowsReviewPath("/tmp/x", { platform: "linux", distro: "", mountOf }), null, "plain Linux: no WSL distro");
  assert.equal(windowsReviewPath("C:\\x", { platform: "win32", distro: "Ubuntu", mountOf }), null);
  assert.match(client, /`Generated \$\{when\(data\.generatedAt\)\}`/);
});

test("#68 P8: skel review prints the Windows path under WSL only", { skip: process.platform !== "linux" }, () => {
  const { dir, run } = project();
  run("init", "T");
  const env = { ...process.env, WSL_DISTRO_NAME: "TestDistro" };
  const out = execFileSync("node", [BIN, "review"], { cwd: dir, encoding: "utf-8", env });
  const html = path.join(dir, ".skeleton", "review.html");
  assert.ok(out.includes(`file://${html}\n`));
  assert.match(out, /\nfrom Windows: (\\\\wsl\.localhost\\TestDistro\\|[A-Z]:\\)\S*review\.html\n$/);
  const plain = { ...process.env };
  delete plain.WSL_DISTRO_NAME;
  assert.doesNotMatch(execFileSync("node", [BIN, "review"], { cwd: dir, encoding: "utf-8", env: plain }), /from Windows/);
});

// ---- P1, P5, P7, P13, P15: the page's words and controls ----

test("#68 P1 P13: the pills say what they mean in words", () => {
  assert.doesNotMatch(client, /"Read-only"/, "the mode pill never reads as 'can't comment'");
  assert.match(client, /data\.feedbackEnabled \? "Send mode" : "Copy mode"/);
  assert.match(client, /if \(lockedOut\) return "Link expired";/);
  assert.match(client, /`Diagram: \$\{d\.name\}`/);
  assert.doesNotMatch(client, /Architecture ·/);
  assert.match(client, /"Shape changed since approval"/);
  assert.doesNotMatch(client.slice(client.indexOf("function versionLabel"), client.indexOf("function versionIds")), /skeletonVersion\}/, "no version ids in the pill's text");
  assert.match(client, /Skeleton version \$\{data\.skeletonVersion\}/, "the ids stay in its title");
});

test("#68 P5 P7 P15: notes can be edited, an outage says so in the sticky header, and long lines can wrap", () => {
  assert.match(client, /"aria-label": `Edit comment on \$\{where\(c\)\}`/);
  assert.match(client, /existing \? "Save" : "Add comment"/);
  assert.match(client, /"Server not responding; retrying…"/);
  assert.match(client, /\+\+missed >= 2/);
  assert.match(css, /\.top \{\s*position: sticky;/);
  assert.match(css, /\.top-alert \{ flex-basis: 100%;/);
  assert.match(client, /const WRAP_KEY = "skeleton:wrap";/);
  assert.match(css, /body\.wrap \.src \{ white-space: pre-wrap;/);
});

// ---- P12: the opinion waits for the human ----

test("#68 P12: in step-by-step mode the fill skill stops after the opinion", () => {
  const skill = fs.readFileSync(path.join(HERE, "..", "skills", "skeleton-fill", "SKILL.md"), "utf-8");
  const two = skill.slice(skill.indexOf("2. **State your opinion first"), skill.indexOf("3. **Delegate the edit.**"));
  assert.match(two, /\*\*In step-by-step mode, stop here\*\* and end your turn with the opinion/);
  assert.match(two, /Delegate \(step 3\) only after they reply/);
  assert.match(two, /"go"/);
  assert.match(two, /In `all` mode, state the opinion and carry on\./);
});
