// `skel pr`: Markdown PR body from the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrBody, text, code, fence } from "../lib/pr-body.mjs";

const ZW = "&#8203;";
const steps = [
  { id: "1", title: "parse input", status: "filled", fences: [{ file: "src/a.js", openLine: 3 }] },
  { id: "2", title: "write | output", status: "todo", fences: [{ file: "src/b.js", openLine: 10 }, { file: "src/c.js", openLine: 1 }] },
];

test("fill phase: step table with status and locations, active step, approved version, no drift", () => {
  const md = renderPrBody({ title: "Add exporter", phase: "fill", steps, activeStep: "2", approvedVersion: "abc123", drift: { ok: true }, coverage: { id: "cov1" } });
  assert.match(md, /^## Add exporter\n/);
  assert.match(md, /\| 1 \| parse input \| filled \| `src\/a.js:3` \|/);
  assert.match(md, /\| 2 \| write \\\| output \| being filled \| `src\/b.js:10`, `src\/c.js:1` \|/);
  assert.match(md, /Approved skeleton version: `abc123`/);
  assert.match(md, /Drift from the approved skeleton \(its own files\): none\./);
  assert.match(md, /Source baseline `cov1`, recorded at approval/);
});

test("real drift is called out; an unusable record is not called drift and shows no version", () => {
  assert.match(renderPrBody({ title: "T", phase: "fill", steps, drift: { ok: false } }), /\*\*Drift from the approved skeleton: yes\.\*\*/);
  const stale = renderPrBody({ title: "T", phase: "fill", steps, drift: { ok: false, reason: "the approval record is from another approval" }, approvedVersion: "old", coverage: { id: "old" } });
  assert.match(stale, /\*\*The approval record can't be used\*\* \(the approval record is from another approval\)/);
  assert.doesNotMatch(stale, /Drift from the approved skeleton: yes|Approved skeleton version|Source baseline/);
  assert.match(renderPrBody({ title: "T", phase: "fill", steps, drift: null }), /The drift check didn't run\./);
});

test("scaffold says not approved", () => {
  const s = renderPrBody({ title: "T", phase: "scaffold", steps });
  assert.match(s, /hasn't been approved yet/);
  assert.match(s, /- Not approved yet\./);
  assert.doesNotMatch(s, /Approved skeleton version/);
});

test("done phase uses the finalized record, escaped; without one it doesn't claim the full check", () => {
  const md = renderPrBody({ title: "T", phase: "done", finalized: { steps: [{ id: "1", title: "a *b*" }, { id: "2", title: "@team" }], files: ["src/a.js"] } });
  assert.match(md, /\| Step \| Title \|\n\|---\|---\|\n\| 1 \| a \\\*b\\\* \|\n\| 2 \| @&#8203;team \|/);
  assert.match(md, /Files: `src\/a.js`/);
  assert.match(md, /Finalized: skel finalize ran/);
  const old = renderPrBody({ title: "T", phase: "done", finalized: null });
  assert.match(old, /isn't recorded for this skeleton/);
  assert.match(old, /- Finalized: the markers were removed\./);
  assert.doesNotMatch(old, /No steps found|requires every step/);
});

test("marker errors are listed, escaped", () => {
  const md = renderPrBody({ title: "T", phase: "fill", steps: [], errors: ["src/x.js:3: SKEL[3] <b>never</b> closed"], drift: { ok: true } });
  assert.match(md, /\*\*Marker problems\*\*/);
  assert.match(md, /- src\/x.js:3: SKEL\\\[3\\\] &lt;b&gt;never&lt;\/b&gt; closed/);
});

test("text(): no HTML, images, links, emphasis, mentions, issue links or table breaks", () => {
  assert.equal(text("<img src=x> & <details>"), "&lt;img src=x&gt; &amp; &lt;details&gt;");
  assert.equal(text("![t](https://e.example/p.png)"), "\\!\\[t\\]\\(https://e.example/p.png\\)");
  assert.equal(text("**b** _i_ ~s~ `c`"), "\\*\\*b\\*\\* \\_i\\_ \\~s\\~ \\`c\\`");
  assert.equal(text("ping @octocat about #1"), `ping @${ZW}octocat about #${ZW}1`);
  assert.equal(text("a|b\n## h\\"), "a\\|b #&#8203;#&#8203; h\\\\");
});

test("code() and fence(): spans and blocks can't be broken out of", () => {
  assert.equal(code("x|y.js:1", { inTable: true }), "`x\\|y.js:1`");
  assert.equal(code("x|y.js:1"), "`x|y.js:1`");
  assert.equal(code("we`ird"), "``we`ird``");
  assert.equal(code("`lead"), "`` `lead ``");
  assert.equal(code("a\nb"), "`a b`");
  assert.equal(fence("mermaid", "A\n```\nB\n"), "````mermaid\nA\n```\nB\n````");
  assert.equal(fence("mermaid", "A\n~~~~~\nB"), "``````mermaid\nA\n~~~~~\nB\n``````");
  assert.equal(fence("mermaid", "A"), "```mermaid\nA\n```");
});

test("agent-written diagram names and titles are escaped in headings and cells", () => {
  const md = renderPrBody({ title: "x\n## injected <b>", phase: "fill", steps: [{ id: "1", title: "a|b\n| fake |", status: "todo", fences: [{ file: "p|q.js", openLine: 1 }] }],
    diagrams: [{ name: "d<b> @x", source: "flowchart TD\n  A --> B\n" }], drift: { ok: true } });
  assert.doesNotMatch(md, /^## injected/m);
  assert.match(md, /^## x #&#8203;#&#8203; injected &lt;b&gt;$/m);
  assert.match(md, /\| 1 \| a\\\|b \\\| fake \\\| \| to do \| `p\\\|q.js:1` \|/);
  assert.match(md, /### Architecture: d&lt;b&gt; @&#8203;x/);
});
