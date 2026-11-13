// #77 persisted-capture DOM renderer. Scoped fake DOM; no network/FS/install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderStrictCaptureView, currentStrictCaptureShown, StrictCaptureViewError } from "../lib/strict-capture-view.mjs";
import { buildStrictCaptureViewModel } from "../lib/strict-capture-view-model.mjs";
import { renderStrictCaptureViewModel, parseStrictCaptureViewModel, STRICT_CAPTURE_VIEW_MODEL_SCHEMA, StrictCaptureViewError as DomViewError } from "../lib/strict-capture-view-dom.mjs";
import { validateStoredCapture } from "../lib/strict-capture.mjs";
import { skelDecisionController, skelShownProtocol } from "../lib/review-decision.mjs";
import { createPlannerAuthority } from "./fixtures/strict-results.mjs";
import { scanText } from "../lib/markers.mjs";

const SOURCE = readFileSync(new URL("../lib/strict-capture-view.mjs", import.meta.url), "utf8");

// ---- scoped fake DOM: text nodes and elements only; innerHTML/listeners/outerHTML throw ----
function fakeDoc() {
  const node = (tag) => {
    const n = {
      tag, attrs: {}, children: [], parent: null,
      setAttribute(k, v) { if (/^on/i.test(k) || ["href", "src", "style"].includes(k)) throw new Error(`attr ${k}`); n.attrs[k] = String(v); },
      append(...kids) { for (const k of kids) { if (!k || typeof k !== "object") throw new Error("append non-node"); k.parent = n; n.children.push(k); } },
      replaceChildren(...kids) { for (const c of n.children) c.parent = null; n.children = []; n.append(...kids); },
      addEventListener() { throw new Error("listeners not allowed"); },
      get textContent() { return n.tag === "#text" ? n.text : n.children.map((c) => c.textContent).join(""); },
      set innerHTML(_) { throw new Error("innerHTML not allowed"); },
      set outerHTML(_) { throw new Error("outerHTML not allowed"); },
      insertAdjacentHTML() { throw new Error("insertAdjacentHTML not allowed"); },
    };
    return n;
  };
  return { createElement: node, createTextNode: (text) => Object.assign(node("#text"), { text: String(text) }) };
}
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.children ?? []) all(c, pred, out); return out; };
const byAttr = (root, k) => all(root, (n) => n.attrs && k in n.attrs);
const byClass = (root, c) => all(root, (n) => n.attrs && (n.attrs.class ?? "").split(" ").includes(c));

// ---- canonical persisted capture fixture ----
// buildCapture is private and validateStoredCapture only returns its rebuild
// on an exact match, so the fixture follows the documented canonical rules
// and the REAL validator must accept it (any drift fails loudly).
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
function makeCapture(specs) {
  const sorted = [...specs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shapeH = createHash("sha256"), capH = createHash("sha256");
  const atom = (h, v) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8"); const l = Buffer.alloc(8); l.writeBigUInt64BE(BigInt(b.length)); h.update(l); h.update(b); };
  atom(shapeH, "skel-strict-shape-v1"); atom(capH, "skel-strict-capture-v1");
  atom(shapeH, sorted.length); atom(capH, sorted.length);
  let totalBytes = 0;
  const files = sorted.map((f) => {
    const unixMode = f.unixMode ?? 0o644, text = f.text, bytes = Buffer.from(text, "utf8");
    totalBytes += bytes.length;
    const sep = f.mode === "whole" ? /\r\n|[\n\r\v\f\u0085\u2028\u2029]/gu : /\r\n|\n/gu;
    const display = []; let start = 0;
    for (const m of text.matchAll(sep)) { display.push({ line: display.length + 1, text: text.slice(start, m.index), ending: m[0], kind: "exterior" }); start = m.index + m[0].length; }
    display.push({ line: display.length + 1, text: text.slice(start), ending: "", kind: "exterior" });
    let exterior, fences;
    if (f.mode === "whole") { exterior = [text]; fences = []; }
    else {
      const parsed = scanText(text.replace(/\r\n/g, "\n"), f.path);
      for (const p of parsed) { display[p.openLine - 1].kind = "marker"; display[p.closeLine - 1].kind = "marker"; for (let n = p.openLine; n < p.closeLine - 1; n++) display[n].kind = "body"; }
      exterior = display.filter((l) => l.kind !== "body").map((l) => l.text + l.ending);
      fences = parsed.map((p) => ({ id: p.id, title: p.title, openLine: p.openLine, closeLine: p.closeLine }));
    }
    for (const h of [shapeH, capH]) { atom(h, f.path); atom(h, f.mode); atom(h, unixMode); }
    atom(shapeH, exterior.length); for (const l of exterior) atom(shapeH, l);
    atom(shapeH, fences.length); for (const x of fences) { atom(shapeH, x.id); atom(shapeH, x.title); }
    atom(capH, bytes);
    return { path: f.path, mode: f.mode, unixMode, text, byteLength: bytes.length, rawSha256: sha(text), exterior, fences, display };
  });
  const cap = { format: 1, shapeVersion: shapeH.digest("hex"), captureVersion: capH.digest("hex"), totalBytes, files };
  validateStoredCapture(cap); // the real validator must accept the fixture
  return JSON.parse(JSON.stringify(cap)); // plain persisted-looking copy
}

const FENCED = "const a = 1;\r\n// SKEL[1]: <b onclick=x>title</b> & `rm -rf`\nbody();\n// /SKEL[1]\n";
const WHOLE = "line one\rline two\u2028three\u2029four\vfive\ffive2\u0085six\r\nno-end";
const HOSTILE_PATH = "src/<img src=x onerror=alert(1)>.md";
function bindingFor(cap, extra = {}) {
  return { protocolVersion: 2, projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round",
    phase: "scaffold", reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion,
    approvedVersion: null, approvedCaptureVersion: null, pendingNotes: false, ...extra };
}
const mount = () => { const doc = fakeDoc(); return { doc, container: doc.createElement("div") }; };

const src = (f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf8");
// Static edges in any form: import/export ... from, bare import, either quote.
const importsOf = (text) => [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2]).sort();
const SINKS = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /addEventListener\(/, /fetch\(/, /node:fs/, /XMLHttpRequest/, /eval\(/, /new Function/, /setTimeout/, /href/, /mermaid\./i, /localStorage/, /document\.cookie/];
const code = (text) => text.replace(/^\s*\/\/.*$/gm, "");

test("modules are pure: no network/FS/listener/HTML sinks; host/browser imports are fixed", () => {
  assert.deepEqual(importsOf(SOURCE), ["./strict-capture-view-dom.mjs", "./strict-capture-view-model.mjs"]);
  assert.deepEqual(importsOf(src("strict-capture-view-model.mjs")), ["./review-decision.mjs", "./strict-capture-view-dom.mjs", "./strict-capture.mjs"]);
  assert.deepEqual(importsOf(src("strict-capture-view-dom.mjs")), ["./review-decision.mjs"]);
  for (const f of ["strict-capture-view.mjs", "strict-capture-view-model.mjs", "strict-capture-view-dom.mjs"])
    for (const bad of SINKS) assert.doesNotMatch(code(src(f)), bad, `${f} ${bad}`);
});

test("browser module's whole import graph is browser-safe (no node:, Buffer, process, require)", () => {
  const seen = new Set(), queue = ["strict-capture-view-dom.mjs"];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const text = code(src(f));
    for (const bad of [/from "node:/, /import\(/, /\bBuffer\b/, /\bprocess\./, /\brequire\(/, /__dirname/, /import\.meta/])
      assert.doesNotMatch(text, bad, `${f} ${bad}`);
    for (const spec of importsOf(text)) {
      assert.match(spec, /^\.\/[a-z-]+\.mjs$/, `${f} imports ${spec}`);
      queue.push(spec.slice(2));
    }
  }
  assert.deepEqual([...seen].sort(), ["review-decision.mjs", "strict-capture-view-dom.mjs", "strict-protocol.mjs"]);
});

test("no production module imports the renderer", () => {
  const own = new Set(["strict-capture-view.mjs", "strict-capture-view-model.mjs", "strict-capture-view-dom.mjs"]);
  for (const f of readdirSync(new URL("../lib/", import.meta.url)).filter((n) => /\.(m?js|css)$/.test(n) && !own.has(n)))
    assert.doesNotMatch(src(f), /strict-capture-view/, f);
  for (const f of readdirSync(new URL("../bin/", import.meta.url)))
    assert.doesNotMatch(readFileSync(new URL(`../bin/${f}`, import.meta.url), "utf8"), /strict-capture-view/, f);
});

test("fenced + whole capture renders identity, coverage, fences, lines and explicit endings as text", () => {
  const cap = makeCapture([{ path: "a/fenced.js", mode: "fenced", text: FENCED }, { path: "b/ctx.txt", mode: "whole", text: WHOLE }]);
  const { doc, container } = mount();
  const r = renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  assert.equal(container.children.length, 1);
  const id = byAttr(container, "data-capture-identity")[0].textContent;
  assert.ok(id.includes(cap.shapeVersion) && id.includes(cap.captureVersion) && id.includes("example-round"));
  const cov = byAttr(container, "data-capture-coverage")[0].children.map((c) => c.textContent);
  assert.deepEqual(cov, ["a/fenced.js [fenced]", "b/ctx.txt [whole]"]);
  const files = byAttr(container, "data-capture-file");
  assert.ok(files[0].textContent.includes(cap.files[0].rawSha256) && files[1].textContent.includes(cap.files[1].rawSha256));
  assert.match(cap.files[0].fences[0].title, /<b onclick=x>title<\/b> & `rm -rf`$/);
  assert.equal(byAttr(files[0], "data-capture-fences")[0].textContent, `Fence 1 (lines 2–4): ${cap.files[0].fences[0].title}`);
  assert.ok(byClass(files[0], "fence-title")[0].children.every((c) => c.tag === "#text"));
  assert.match(byAttr(files[1], "data-capture-fences")[0].textContent, /Whole-file context/);
  const endings = (f) => byClass(f, "line-ending").map((n) => n.textContent);
  assert.deepEqual(endings(files[0]), ["CRLF", "LF", "LF", "LF", "EOF (no line ending)"]);
  assert.deepEqual(endings(files[1]), ["CR", "LS", "PS", "VT", "FF", "NEL", "CRLF", "EOF (no line ending)"]);
  assert.deepEqual(byClass(files[0], "line-kind").map((n) => n.textContent), ["exterior", "marker", "body", "marker", "exterior"]);
  // No element was created from source: every element tag is from a fixed set.
  const tags = new Set(all(container.children[0], (n) => n.tag !== "#text").map((n) => n.tag));
  for (const t of tags) assert.ok(["section", "h2", "h3", "p", "dl", "dt", "dd", "ol", "li", "span", "code"].includes(t), t);
  assert.equal(all(container, (n) => ["button", "a", "form", "input", "script"].includes(n.tag)).length, 0);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.shown) && Object.isFrozen(r.binding));
});

test("hostile path/title/source stay text nodes; invisible characters are also shown escaped", () => {
  const src = "<script>alert(1)</script>\n// SKEL[2]: </dd><img src=x>\n\u202Eevil\u202C\tx\n// /SKEL[2]\n";
  const cap = makeCapture([{ path: HOSTILE_PATH, mode: "fenced", text: src }]);
  const { doc, container } = mount();
  renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  const texts = all(container, (n) => n.tag === "#text").map((n) => n.text);
  assert.ok(texts.includes(HOSTILE_PATH) && texts.includes("<script>alert(1)</script>") && texts.includes(cap.files[0].fences[0].title));
  assert.match(cap.files[0].fences[0].title, /<\/dd><img src=x>$/);
  assert.equal(all(container, (n) => ["script", "img"].includes(n.tag)).length, 0);
  for (const n of all(container, (x) => x.attrs)) for (const v of Object.values(n.attrs)) assert.ok(!v.includes("<") && !v.includes(HOSTILE_PATH));
  const inv = byAttr(container, "data-line-invisible");
  assert.equal(inv.length, 1);
  assert.match(inv[0].textContent, /escaped: \\u\{202E\}evil\\u\{202C\}\\u\{9\}x/);
});

test("empty-text whole file renders one EOF line", () => {
  const cap = makeCapture([{ path: "empty.txt", mode: "whole", text: "" }]);
  const { doc, container } = mount();
  renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  assert.deepEqual(byClass(container, "line-ending").map((n) => n.textContent), ["EOF (no line ending)"]);
  assert.match(byAttr(container, "data-capture-identity")[0].textContent, /Total bytes0/);
});

test("returned shown is V2, from the rendered capture, and interoperates with the decision adapter", async () => {
  const cap = makeCapture([{ path: "a/fenced.js", mode: "fenced", text: FENCED }]);
  const { doc, container } = mount();
  const r = renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  assert.deepEqual({ ...r.shown }, { phase: "scaffold", reviewVersion: cap.shapeVersion, approvedVersion: null, pendingNotes: false,
    protocolVersion: 2, captureVersion: cap.captureVersion, approvedCaptureVersion: null });
  assert.equal(skelShownProtocol(r.shown), 2);
  assert.equal(currentStrictCaptureShown(container), r.shown);
  const initialState = { projectId: "example-project", sessionId: "example-session", reviewRoundId: "example-round", phase: "skeleton",
    reviewVersion: cap.shapeVersion, approvedVersion: null, revision: 0, protocolVersion: 2, captureVersion: cap.captureVersion, approvedCaptureVersion: null };
  const auth = createPlannerAuthority({ initialState });
  let i = 0;
  const ctl = skelDecisionController({ channel: auth, shown: r.shown, newRequestId: () => `req-${++i}` });
  await ctl.load();
  const approve = ctl.view().actions.find((a) => a.action === "approve");
  assert.ok(approve?.enabled, approve?.reason);
  await ctl.decide("approve");
  assert.equal(auth.commits(), 1);
  assert.equal(auth.calls.submit[0].captureVersion, cap.captureVersion);
  // Fill-phase binding with an explicit approved pair.
  const fill = renderStrictCaptureView({ doc, container, capture: cap,
    binding: bindingFor(cap, { phase: "fill", approvedVersion: cap.shapeVersion, approvedCaptureVersion: cap.captureVersion }) });
  assert.equal(skelShownProtocol(fill.shown), 2);
  assert.equal(fill.shown.approvedCaptureVersion, cap.captureVersion);
});

test("wrong shape, wrong raw digest, or swapped pair refuses and clears", () => {
  const cap = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED }]);
  const other = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED.replace("body();", "body(2);") }]);
  assert.equal(other.shapeVersion, cap.shapeVersion); // same shape, different raw bytes
  for (const b of [bindingFor(cap, { captureVersion: other.captureVersion }), bindingFor(cap, { reviewVersion: "f".repeat(64) }),
    bindingFor(cap, { reviewVersion: cap.captureVersion, captureVersion: cap.shapeVersion })]) {
    const { doc, container } = mount();
    container.append(doc.createTextNode("old"));
    assert.throws(() => renderStrictCaptureView({ doc, container, capture: cap, binding: b }), (e) => e instanceof StrictCaptureViewError && e.code === "VIEW_PAIR");
    assert.equal(container.children.length, 0);
    assert.equal(currentStrictCaptureShown(container), null);
  }
});

test("canonical-tampered captures refuse before rendering", () => {
  const cap = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED }]);
  const tampers = [
    (c) => { c.files[0].display[2].text = "pretend();"; },          // display differs from raw text
    (c) => { c.files[0].fences[0].title = "Benign"; },                 // title differs from source
    (c) => { c.files[0].display[0].ending = "\n"; },                   // hide the CRLF
    (c) => { c.files[0].text = c.files[0].text.replace("body", "evil"); }, // raw text vs digests
    (c) => { c.files[0].rawSha256 = "0".repeat(64); },
    (c) => { c.extra = 1; },
    (c) => { c.files = []; },
  ];
  for (const t of tampers) {
    const bad = structuredClone(cap); t(bad);
    const { doc, container } = mount();
    let created = 0; const orig = doc.createElement; doc.createElement = (x) => { created++; return orig(x); };
    assert.throws(() => renderStrictCaptureView({ doc, container, capture: bad, binding: bindingFor(cap) }), (e) => e.code === "VIEW_CAPTURE");
    assert.equal(created, 0, "nothing rendered before validation");
  }
  const getter = structuredClone(cap); Object.defineProperty(getter, "format", { get: () => 1, enumerable: true });
  assert.throws(() => renderStrictCaptureView({ ...mount(), capture: getter, binding: bindingFor(cap) }), (e) => e.code === "VIEW_CAPTURE");
});

test("malformed/unsupported bindings refuse; binding carries no auth/token fields", () => {
  const cap = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED }]);
  const b = bindingFor(cap);
  const { reviewRoundId, ...missing } = b;
  const bads = [null, [], "x", missing, { ...b, token: "secret" }, { ...b, humanAuthenticated: true }, { ...b, protocolVersion: 1 },
    { ...b, projectId: "../etc" }, { ...b, projectId: "https://x" }, { ...b, phase: "skeleton" }, { ...b, pendingNotes: "no" },
    { ...b, approvedVersion: cap.shapeVersion }, { ...b, phase: "fill" }, { ...b, phase: "done", approvedVersion: cap.shapeVersion, approvedCaptureVersion: null },
    Object.assign(Object.create({ inherited: 1 }), b), { ...b, reviewVersion: cap.shapeVersion.slice(0, 12) }];
  const getter = { ...b }; Object.defineProperty(getter, "phase", { get: () => "scaffold", enumerable: true }); bads.push(getter);
  for (const bad of bads) {
    const { doc, container } = mount();
    container.append(doc.createTextNode("old"));
    assert.throws(() => renderStrictCaptureView({ doc, container, capture: cap, binding: bad }), (e) => e.code === "VIEW_BINDING");
    assert.equal(container.children.length, 0);
  }
});

test("unusable DOM refuses with VIEW_DOM", () => {
  const cap = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED }]);
  assert.throws(() => renderStrictCaptureView({ doc: {}, container: {}, capture: cap, binding: bindingFor(cap) }), (e) => e.code === "VIEW_DOM");
  assert.throws(() => renderStrictCaptureView(), (e) => e.code === "VIEW_DOM");
});

test("second render replaces content; old shown is no longer current; a refusal drops the active shown", () => {
  const a = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED }]);
  const b = makeCapture([{ path: "b.txt", mode: "whole", text: "second\n" }]);
  const { doc, container } = mount();
  const first = renderStrictCaptureView({ doc, container, capture: a, binding: bindingFor(a) });
  const second = renderStrictCaptureView({ doc, container, capture: b, binding: bindingFor(b) });
  assert.equal(container.children.length, 1);
  assert.ok(!container.textContent.includes("a.js") && container.textContent.includes("b.txt"));
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  assert.equal(currentStrictCaptureShown(container), second.shown);
  assert.throws(() => renderStrictCaptureView({ doc, container, capture: a, binding: bindingFor(b) }), (e) => e.code === "VIEW_PAIR");
  assert.equal(container.children.length, 0);
  assert.equal(second.isCurrent(), false);
  assert.equal(currentStrictCaptureShown(container), null);
});

test("DOM preflight refusal invalidates a previously rendered capture", () => {
  const cap = makeCapture([{ path: "a.txt", mode: "whole", text: "source" }]);
  const { doc, container } = mount();
  const first = renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  assert.throws(() => renderStrictCaptureView({ doc: {}, container, capture: cap, binding: bindingFor(cap) }), (e) => e.code === "VIEW_DOM");
  assert.equal(first.isCurrent(), false);
  assert.equal(currentStrictCaptureShown(container), null);
  assert.equal(container.children.length, 0);
  const second = renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  container.replaceChildren = null;
  assert.throws(() => renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) }), (e) => e.code === "VIEW_DOM");
  assert.equal(second.isCurrent(), false);
  assert.equal(currentStrictCaptureShown(container), null);
});

test("a DOM failure mid-build leaves the container empty and nothing current", () => {
  const cap = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED }]);
  const { doc, container } = mount();
  renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  let n = 0; const orig = doc.createElement; doc.createElement = (x) => { if (++n > 5) throw new Error("boom"); return orig(x); };
  assert.throws(() => renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) }), (e) => e.code === "VIEW_RENDER");
  assert.equal(container.children.length, 0);
  assert.equal(currentStrictCaptureShown(container), null);
});

test("limits are bounded by the validator (lower limits refuse larger captures)", () => {
  const cap = makeCapture([{ path: "a.js", mode: "fenced", text: FENCED }]);
  assert.throws(() => renderStrictCaptureView({ ...mount(), capture: cap, binding: bindingFor(cap), limits: { maxFileLines: 2 } }), (e) => e.code === "VIEW_CAPTURE");
  assert.throws(() => renderStrictCaptureView({ ...mount(), capture: cap, binding: bindingFor(cap), limits: { maxFileBytes: 10 ** 9 } }), (e) => e.code === "VIEW_CAPTURE");
});

// ---- host/browser split ----
const BOTH = () => makeCapture([{ path: "a/fenced.js", mode: "fenced", text: FENCED }, { path: "b/ctx.txt", mode: "whole", text: WHOLE }]);
const wire = (m) => JSON.parse(JSON.stringify(m)); // what the browser receives
const isModel = (code) => (e) => e instanceof DomViewError && e.code === code;

test("one error class across host, browser and convenience modules", () => {
  assert.equal(StrictCaptureViewError, DomViewError);
});

test("host model is deeply frozen, JSON-stable and carries no raw text/exterior", () => {
  const cap = BOTH();
  const m = buildStrictCaptureViewModel({ capture: cap, binding: bindingFor(cap) });
  assert.equal(m.schema, STRICT_CAPTURE_VIEW_MODEL_SCHEMA);
  const frozenDeep = (v) => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v).every(frozenDeep));
  assert.ok(frozenDeep(m));
  assert.deepEqual(wire(m), m);
  for (const f of m.files) { assert.ok(!("text" in f)); assert.ok(!("exterior" in f)); }
  assert.deepEqual(Object.keys(m.files[0]).sort(), ["byteLength", "display", "fences", "mode", "path", "rawSha256", "unixMode"]);
  assert.equal(m.shown.reviewVersion, cap.shapeVersion);
  assert.equal(m.shown.captureVersion, cap.captureVersion);
});

test("host model refuses in order: binding, capture, pair", () => {
  const cap = BOTH();
  assert.throws(() => buildStrictCaptureViewModel({ capture: { junk: 1 }, binding: { junk: 1 } }), isModel("VIEW_BINDING"));
  assert.throws(() => buildStrictCaptureViewModel({ capture: { junk: 1 }, binding: bindingFor(cap) }), isModel("VIEW_CAPTURE"));
  assert.throws(() => buildStrictCaptureViewModel({ capture: cap, binding: bindingFor(cap, { captureVersion: "0".repeat(64) }) }), isModel("VIEW_PAIR"));
});

test("browser renders the JSON-wired model identically to the host convenience renderer", () => {
  const cap = BOTH();
  const a = mount(), b = mount();
  const host = renderStrictCaptureView({ ...a, capture: cap, binding: bindingFor(cap) });
  const browser = renderStrictCaptureViewModel({ ...b, model: wire(buildStrictCaptureViewModel({ capture: cap, binding: bindingFor(cap) })) });
  assert.equal(a.container.textContent, b.container.textContent);
  assert.deepEqual(browser.shown, host.shown);
  assert.equal(skelShownProtocol(browser.shown), 2);
  assert.ok(browser.isCurrent());
  assert.equal(currentStrictCaptureShown(b.container), browser.shown);
});

function tampered(edit) {
  const cap = BOTH();
  const m = wire(buildStrictCaptureViewModel({ capture: cap, binding: bindingFor(cap) }));
  edit(m);
  return m;
}

test("browser refuses a malformed or inconsistent model and leaves nothing current", () => {
  const cases = {
    schema: (m) => { m.schema = "skel-strict-capture-view/2"; },
    extraTop: (m) => { m.token = "x"; },
    shownDrift: (m) => { m.shown.captureVersion = "0".repeat(64); },
    shownPhase: (m) => { m.shown.phase = "fill"; },
    shownExtra: (m) => { m.shown.authenticated = true; },
    totalBytes: (m) => { m.totalBytes += 1; },
    noFiles: (m) => { m.files = []; },
    order: (m) => { m.files.reverse(); },
    duplicate: (m) => { m.files[1] = m.files[0]; m.totalBytes = m.files[0].byteLength * 2; },
    fileExtra: (m) => { m.files[0].text = "raw"; },
    mode: (m) => { m.files[0].mode = "partial"; },
    digest: (m) => { m.files[0].rawSha256 = "ABC"; },
    lineNumber: (m) => { m.files[0].display[1].line = 7; },
    ending: (m) => { m.files[0].display[0].ending = "\u2028"; }, // fenced files split on CRLF/LF only
    midEof: (m) => { m.files[0].display[0].ending = ""; },
    lastEnding: (m) => { m.files[0].display.at(-1).ending = "\n"; },
    kindDrift: (m) => { m.files[0].display.find((l) => l.kind === "body").kind = "exterior"; },
    markerDrift: (m) => { m.files[0].display.find((l) => l.kind === "marker").kind = "body"; },
    fenceRange: (m) => { m.files[0].fences[0].closeLine = 999; },
    wholeFence: (m) => { m.files[1].fences = [{ id: "1", title: "t", openLine: 1, closeLine: 2 }]; },
    fencedNoFence: (m) => { m.files[0].fences = []; for (const l of m.files[0].display) l.kind = "exterior"; },
    oversizeLine: (m) => { m.files[1].display[0].text = "x".repeat(m.files[1].byteLength + 1); },
    sparse: (m) => { m.files[0].display.length += 1; },
    getter: (m) => { Object.defineProperty(m.files[0], "path", { get: () => "a", enumerable: true }); },
    truncatedText: (m) => { for (const l of m.files[1].display) l.text = ""; },
    rloPath: (m) => { m.files[0].path = "a/\u202Esj.txt"; },
    absolutePath: (m) => { m.files[0].path = "/etc/passwd"; },
    dotdotPath: (m) => { m.files[0].path = "../../etc/passwd"; },
    hiddenBreak: (m) => { const l = m.files[1].display[0]; l.text = l.text.slice(0, 2) + "\n" + l.text.slice(3); },
    nulText: (m) => { const l = m.files[1].display[0]; l.text = "\0" + l.text.slice(1); },
    loneSurrogate: (m) => { const l = m.files[1].display[0]; l.text = "\uD800" + l.text.slice(3); },
    titleDrift: (m) => { m.files[0].fences[0].title = "harmless"; },
    markerRewritten: (m) => { const l = m.files[0].display[m.files[0].fences[0].openLine - 1]; l.text = "harmless".padEnd(l.text.length, " ").slice(0, l.text.length); },
    idDrift: (m) => { m.files[0].fences[0].id = "2"; },
    inheritedEnding: (m) => { m.files[1].display[0].ending = "toString"; },
    bom: (m) => { const l = m.files[1].display[0]; l.text = "\uFEFF" + l.text.slice(3); },
    hiddenMarker: (m) => { const l = m.files[0].display[0]; l.text = "// SKEL[9" + "x".repeat(Math.max(0, l.text.length - 9)); },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const { doc, container } = mount();
    const cap = BOTH();
    renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
    assert.throws(() => renderStrictCaptureViewModel({ doc, container, model: tampered(edit) }), isModel("VIEW_MODEL"), name);
    assert.equal(container.children.length, 0, name);
    assert.equal(currentStrictCaptureShown(container), null, name);
  }
});

test("browser refuses a bad binding with VIEW_BINDING and unusable DOM with VIEW_DOM", () => {
  assert.throws(() => renderStrictCaptureViewModel({ ...mount(), model: tampered((m) => { m.binding.secret = "s"; }) }), isModel("VIEW_BINDING"));
  assert.throws(() => renderStrictCaptureViewModel({ ...mount(), model: tampered((m) => { m.binding.phase = "fill"; }) }), isModel("VIEW_BINDING"));
  assert.throws(() => renderStrictCaptureViewModel({ doc: {}, container: mount().container, model: tampered(() => {}) }), isModel("VIEW_DOM"));
});

test("browser limits can only be lowered", () => {
  const m = tampered(() => {});
  assert.throws(() => parseStrictCaptureViewModel(m, { maxFiles: 1 }), isModel("VIEW_MODEL"));
  assert.throws(() => parseStrictCaptureViewModel(m, { maxFileLines: 2 }), isModel("VIEW_MODEL"));
  assert.throws(() => parseStrictCaptureViewModel(m, { maxFiles: 10 ** 6 }), isModel("VIEW_MODEL"));
  assert.throws(() => parseStrictCaptureViewModel(m, { bogus: 1 }), isModel("VIEW_MODEL"));
  assert.equal(parseStrictCaptureViewModel(m, { maxFiles: 2 }).files.length, 2);
});

test("browser marker grammar is identical to lib/markers.mjs and lib/strict-capture.mjs", async () => {
  const { STRICT_MARKER_SOURCES: M } = await import("../lib/strict-capture-view-dom.mjs");
  const dom = src("strict-capture-view-dom.mjs"), markers = src("markers.mjs"), capture = src("strict-capture.mjs");
  // Compare the declaration text itself, line for line, in both files.
  const decl = (text, name) => {
    const m = new RegExp(`^const ${name} = (.*);$`, "m").exec(text);
    assert.ok(m, `${name} declared`);
    return m[1];
  };
  for (const name of ["COMMENT", "ID", "OPEN_RE", "CLOSE_RE"]) assert.equal(decl(dom, name), decl(markers, name), name);
  assert.ok(capture.includes(`const markerCandidate = /${M.CANDIDATE}/;`));
});

test("host-valid fenced files in every comment style and line ending render through host and browser", () => {
  const styles = [["// ", ""], ["# ", ""], ["-- ", ""], ["; ", ""], ["/* ", " */"], ["/*", "*/"], ["<!-- ", " -->"], ["{/* ", " */}"], ["\t; ", ""]];
  for (const [o, c] of styles) for (const eol of ["\n", "\r\n"]) {
    const text = `x${eol}${o}SKEL[a.1] title ${c}${eol}body${eol}${o}/SKEL[a.1]${c}${eol}tail`;
    const cap = makeCapture([{ path: "s.txt", mode: "fenced", text }]);
    const a = mount(), b = mount();
    renderStrictCaptureView({ ...a, capture: cap, binding: bindingFor(cap) });
    renderStrictCaptureViewModel({ ...b, model: wire(buildStrictCaptureViewModel({ capture: cap, binding: bindingFor(cap) })) });
    assert.equal(a.container.textContent, b.container.textContent, JSON.stringify([o, c, eol]));
  }
});

test("host-valid long fence ids and titles still render through the wrapper and the browser", () => {
  const title = "t".repeat(5000), id = "a" + "b".repeat(299);
  const cap = makeCapture([{ path: "long.js", mode: "fenced", text: `// SKEL[${id}] ${title}\nbody\n// /SKEL[${id}]\n` }]);
  const a = mount();
  renderStrictCaptureView({ ...a, capture: cap, binding: bindingFor(cap) });
  assert.ok(byClass(a.container, "fence-title")[0].textContent === title);
  const b = mount();
  renderStrictCaptureViewModel({ ...b, model: wire(buildStrictCaptureViewModel({ capture: cap, binding: bindingFor(cap) })) });
  assert.equal(a.container.textContent, b.container.textContent);
});

test("a fence title with invisible or reordering characters is also shown escaped", () => {
  const cap = makeCapture([{ path: "t.js", mode: "fenced", text: "// SKEL[1] safe \u202Etxt.exe\nbody\n// /SKEL[1]\n" }]);
  const { doc, container } = mount();
  renderStrictCaptureView({ doc, container, capture: cap, binding: bindingFor(cap) });
  assert.match(byClass(container, "fence-title-escaped")[0].textContent, /\\u\{202E\}/);
});

test("a Proxy array is copied at its checked length; a growing length is never re-read", () => {
  const cap = BOTH();
  const m = wire(buildStrictCaptureViewModel({ capture: cap, binding: bindingFor(cap) }));
  let reads = 0;
  const real = m.files;
  m.files = new Proxy(real, { get(t, k, r) { if (k === "length") { reads++; return reads > 2 ? 1e9 : t.length; } return Reflect.get(t, k, r); },
    getPrototypeOf: () => Array.prototype });
  const parsed = parseStrictCaptureViewModel(m); // copied once at the checked length
  assert.equal(parsed.files.length, 2);
  assert.ok(Array.isArray(parsed.files) && !Object.isExtensible(parsed.files));
  assert.ok(reads <= 2, `length read ${reads} times`);
});
