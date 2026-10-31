(() => {
  const data = JSON.parse(document.getElementById("skeleton-data").textContent);
  const app = document.getElementById("app");
  const KEY = "skeleton:" + data.reviewKey;
  const SEEN_KEY = KEY + ":seen";
  const store = {
    get(k, fallback) { try { return JSON.parse(localStorage.getItem(k) || "null") ?? fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const fileLines = Object.fromEntries(data.files.map((f) => {
    const lines = f.text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return [f.path, lines];
  }));

  // ---- feedback draft (survives reloads; per-viewer only) ----
  const blank = () => ({ verdict: null, general: "", comments: [] });
  let draft = { ...blank(), ...store.get(KEY, {}) };
  const save = () => store.set(KEY, draft);

  // Comments remember the line they were made on (its text and neighbours), so
  // when the agent's edits shift the file they follow their code instead of
  // silently landing on whatever now sits at that line number.
  const anchorOf = (file, line) => {
    const lines = fileLines[file];
    if (!lines) return null;
    return { text: lines[line - 1] ?? "", before: lines[line - 2] ?? null, after: lines[line] ?? null };
  };
  function reanchor() {
    let changed = false;
    for (const c of draft.comments) {
      if (c.file.startsWith("diagram:") || !c.anchor) continue;
      const lines = fileLines[c.file];
      if (!lines) { if (!c.outdated) { c.outdated = true; changed = true; } continue; }
      if (lines[c.line - 1] === c.anchor.text) { if (c.outdated) { c.outdated = false; changed = true; } continue; }
      let best = null;
      lines.forEach((l, i) => {
        if (l !== c.anchor.text) return;
        const score = (lines[i - 1] === c.anchor.before ? 2 : 0) + (lines[i + 1] === c.anchor.after ? 2 : 0) - Math.abs(i + 1 - c.line) / 10000;
        if (!best || score > best.score) best = { line: i + 1, score };
      });
      // A blank or very common line only counts when a neighbour matches too.
      // Short or punctuation-only lines (`}`, `);`) recur everywhere: they
      // only re-anchor when a neighbour matches too.
      const distinctive = /[A-Za-z0-9_$]{3,}/.test(c.anchor.text);
      if (best && (distinctive || best.score >= 2)) {
        c.line = best.line; c.step = stepAt(c.file, best.line); c.outdated = false;
      } else {
        c.outdated = true;
      }
      changed = true;
    }
    if (changed) save();
  }

  // ---- what changed since you last looked ----
  const seen = store.get(SEEN_KEY, {});
  const changedLines = {};
  for (const [file, lines] of Object.entries(fileLines)) {
    const before = seen[file];
    if (!before || lines.length > 5000) continue;
    const counts = new Map();
    for (const l of before) counts.set(l, (counts.get(l) || 0) + 1);
    const marks = new Set();
    lines.forEach((l, i) => {
      const n = counts.get(l) || 0;
      if (n > 0) counts.set(l, n - 1);
      else if (l.trim()) marks.add(i + 1);
    });
    if (marks.size) changedLines[file] = marks;
  }
  store.set(SEEN_KEY, Object.fromEntries(Object.entries(fileLines).filter(([, l]) => l.length <= 5000)));

  // ---- drift from the approved skeleton (computed by skel; fill phase only) ----
  const driftLines = {};
  for (const it of data.drift?.items ?? []) {
    if (!it.line) continue;
    const marks = (driftLines[it.file] ??= new Set());
    // Exactly the drifted lines: a change can straddle a fence body, so they
    // needn't be consecutive. A pure removal marks where it was.
    for (const n of it.lines?.length ? it.lines : [it.line]) marks.add(n);
  }

  // Served pages can send; the first poll confirms it, but deciding up front
  // saves a full re-render on load.
  let served = location.protocol.startsWith("http");
  let openEditor = null; // "file:line" being commented
  const expanded = new Set(); // "file:start" of collapsed runs the viewer opened

  // ---- tiny highlighter: comments, strings, numbers, keywords ----
  const KW = new Set(("abstract as async await break case catch class const continue def default del do elif else enum " +
    "except export extends false finally fn for from func function if impl import in interface is lambda let match " +
    "mut new nil none null of package pass private protected pub public raise readonly return self static struct super " +
    "switch this throw true try type typeof undefined use var void where while with yield None True False").split(" "));
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function highlight(line, hashComments) {
    const re = hashComments
      ? /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d[\d_.]*\b)|([A-Za-z_]\w*)/g
      : /(\/\/.*$|\/\*.*?\*\/|<!--.*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;
    let out = "", last = 0, m;
    while ((m = re.exec(line))) {
      out += esc(line.slice(last, m.index));
      const [tok, com, str, num, word] = m;
      if (com) out += `<span class="c">${esc(tok)}</span>`;
      else if (str) out += `<span class="s">${esc(tok)}</span>`;
      else if (num) out += `<span class="n">${esc(tok)}</span>`;
      else if (word && KW.has(word)) out += `<span class="k">${esc(tok)}</span>`;
      else out += esc(tok);
      last = m.index + tok.length;
    }
    return out + esc(line.slice(last));
  }
  const hashLang = (p) => /\.(py|rb|sh|bash|zsh|ya?ml|toml|r|pl|ex|exs|nim|cr)$/i.test(p) || /(^|\/)(Dockerfile|Makefile)$/.test(p);

  // ---- helpers ----
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };
  function stepAt(file, line) {
    const f = data.files.find((x) => x.path === file);
    const fence = f && f.fences.find((x) => line >= x.openLine && line <= x.closeLine);
    return fence ? fence.id : null;
  }
  const liveComments = () => draft.comments.filter((c) => !c.outdated);
  const commentsFor = (file, line) => liveComments().filter((c) => c.file === file && c.line === line);
  const stepCommentCount = (id) => liveComments().filter((c) => c.step === id).length;
  const openComment = (file, line) => { openEditor = `${file}:${line}`; render(); focusEditor(); };

  reanchor();

  // ---- render ----
  function render() {
    const scrollY = window.scrollY;
    // A deferred render (Mermaid arriving, served mode) must not steal the
    // caret from a comment being typed.
    const active = document.activeElement;
    const keep = active && active.tagName === "TEXTAREA" ? { id: active.id, ph: active.placeholder, start: active.selectionStart, end: active.selectionEnd } : null;
    app.replaceChildren(top(), data.errors.length ? errors() : "", data.drift ? driftPanel() : "", layout(), mobileJump());
    decorateDiagrams();
    window.scrollTo(0, scrollY);
    if (keep) {
      const el = keep.id ? document.getElementById(keep.id) : [...document.querySelectorAll("textarea")].find((t) => t.placeholder === keep.ph);
      if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.start, keep.end); } catch {} }
    }
  }

  function top() {
    const total = data.steps.length;
    const done = data.steps.filter((s) => s.status === "filled").length;
    const phaseLabel = { scaffold: "skeleton review", fill: "filling", done: "finalized" }[data.phase] || data.phase;
    return h("div", { class: "top" },
      h("h1", {}, data.title),
      h("span", { class: "pill" + (data.phase === "fill" ? " fill" : "") },
        phaseLabel + (data.activeStep ? ` · step ${data.activeStep}` : "")),
      h("span", { class: "pill", "aria-label": "Review delivery mode" },
        location.protocol.startsWith("http") ? (data.feedbackEnabled ? "Send enabled" : "Read-only") : "Static review"),
      h("div", { class: "progress" },
        h("span", {}, `${done}/${total} steps filled`),
        h("div", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done },
          h("i", { style: `width:${total ? (100 * done) / total : 0}%` }))));
  }

  function errors() {
    return h("div", { class: "errors" }, "Marker problems:\n", ...data.errors.map((e) => h("div", {}, e)));
  }

  /** "4", "4-6", or "4, 6" when the lines aren't consecutive. */
  function lineSpan(lines) {
    const runs = [];
    for (const n of lines) {
      const last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else runs.push([n, n]);
    }
    return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
  }

  function driftPanel() {
    const d = data.drift;
    const clip = (lines, mark, ws = []) => lines.slice(0, 12).map((l, k) => h("div", { class: mark === "+" ? "add" : "del" }, `${mark} ${l}${ws.includes(k) ? "   (whitespace only)" : ""}`))
      .concat(lines.length > 12 ? [h("div", { class: "hint" }, `… ${lines.length - 12} more`)] : []);
    return h("section", { class: "drift-panel", role: "alert" },
      h("h2", {}, "Drift from the approved skeleton"),
      h("div", { class: "hint" }, d.reason
        ? `${d.reason}. Reopen the skeleton and approve it again to re-record it.`
        : "These changes sit outside the fences. skel done and skel finalize refuse until they are undone, or until you reopen the skeleton and approve the new shape."),
      d.items.map((it) => h("div", { class: "drift-item" },
        it.note
          ? h("div", {}, h("code", {}, it.file), " ", it.note)
          : [
              h("button", { class: "linkbtn", onclick: () => jump(it.file, it.line) }, `${it.file}:${lineSpan(it.lines?.length ? it.lines : [it.line])}`),
              h("pre", {}, clip(it.removed, "-", it.whitespace?.removed), clip(it.added, "+", it.whitespace?.added)),
            ])));
  }

  function layout() {
    return h("div", { class: "layout" }, sidebar(), filesView(), feedbackPanel());
  }

  function sidebar() {
    return h("nav", { class: "panel side", "aria-label": "Steps" },
      h("h2", {}, "Steps"),
      data.steps.length === 0 ? h("div", { class: "hint", style: "padding:0 14px 12px" }, "No SKEL[...] fences found.") : "",
      h("ol", { class: "steps" }, data.steps.map((s) => {
        const active = s.id === data.activeStep;
        const n = stepCommentCount(s.id);
        const state = active ? "active" : s.status;
        return h("li", { class: active ? "active" : "" },
          h("button", { onclick: () => jump(s.locations[0].file, s.locations[0].line), title: s.locations.map((l) => `${l.file}:${l.line}`).join("\n") },
            h("span", { class: "dot " + state, "aria-label": state === "todo" ? "pending" : state }),
            h("span", { class: "sid" }, s.id),
            h("span", { class: "stitle" }, s.title || "(untitled)", n ? h("span", { class: "ccount" }, `· ${n} note${n > 1 ? "s" : ""}`) : "")));
      })),
      data.steps.length ? h("div", { class: "legend" },
        h("span", {}, h("span", { class: "dot todo" }), "pending"),
        h("span", {}, h("span", { class: "dot active" }), "filling"),
        h("span", {}, h("span", { class: "dot filled" }), "filled")) : "");
  }

  function filesView() {
    const files = data.files.length ? data.files.map(fileView) : [h("div", { class: "panel empty" }, "No skeleton files yet.")];
    return h("main", { class: "files" }, data.diagrams.map(diagramView), files);
  }

  // ---- architecture diagrams (Mermaid; step_<id> nodes track step status) ----
  const svgCache = {};
  let mermaidMissing = false;
  function diagramView(d) {
    const key = `diagram:${d.name}`;
    const host = h("div", { class: "diagram-host", "data-diagram": d.name });
    if (svgCache[d.name]) host.innerHTML = svgCache[d.name];
    else host.append(
      mermaidMissing ? h("div", { class: "hint diagram-hint" }, "Showing the diagram's source: Mermaid didn't load (offline or blocked).") : "",
      h("pre", { class: "diagram-src" }, d.source));
    const notes = commentsFor(key, 0).map((c) => h("table", { class: "diagram-notes" }, h("tbody", {}, noteRow(c))));
    return h("details", { class: "panel file diagram", open: true },
      h("summary", {}, h("span", {}, `Architecture · ${d.name}`),
        h("button", { onclick: (e) => { e.preventDefault(); openComment(key, 0); } }, "Comment on diagram")),
      host,
      notes,
      openEditor === `${key}:0` ? h("table", { class: "diagram-notes" }, h("tbody", {}, editorRow(key, 0))) : "");
  }

  let mermaidReady = false;
  async function renderDiagrams() {
    if (!window.mermaid || !data.diagrams.length) return;
    if (!mermaidReady) {
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict" });
      mermaidReady = true;
    }
    for (const [i, d] of data.diagrams.entries()) {
      if (svgCache[d.name]) continue;
      try {
        const { svg } = await window.mermaid.render(`dd-diagram-${i}`, d.source);
        svgCache[d.name] = svg;
      } catch (err) {
        svgCache[d.name] = `<div class="hint diagram-hint">Mermaid couldn't parse this diagram: ${esc(String(err.message || err))}</div><pre class="diagram-src">${esc(d.source)}</pre>`;
      }
    }
    render();
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    mermaidReady = false;
    for (const k of Object.keys(svgCache)) delete svgCache[k];
    renderDiagrams();
  });

  function decorateDiagrams() {
    const status = Object.fromEntries(data.steps.map((s) => [s.id, s.id === data.activeStep ? "active" : s.status]));
    for (const node of document.querySelectorAll(".diagram-host g.node")) {
      const m = /^flowchart-step_([A-Za-z0-9_]+)-\d+$/.exec(node.id);
      if (!m) continue;
      const id = m[1].replace(/_/g, ".");
      const step = data.steps.find((s) => s.id === id);
      if (!step) continue;
      const go = () => jump(step.locations[0].file, step.locations[0].line);
      node.classList.add("dd-step", "dd-" + status[id]);
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `Step ${id}: ${step.title} (${status[id] === "todo" ? "pending" : status[id]})`);
      node.addEventListener("click", go);
      node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      node.insertAdjacentHTML("afterbegin", `<title>Step ${esc(id)}: ${esc(step.title)} (${status[id]})</title>`);
    }
  }

  // Runs of unfenced, uncommented, unchanged code longer than this collapse.
  const COLLAPSE_AT = 24;
  const KEEP = 4;

  // Each file's DOM is cached against the inputs that shape it, so a click
  // anywhere rebuilds only the file it touched (or nothing but the panels).
  const fileCache = new Map();
  const CHUNK = 200;

  function fileView(file) {
    const changes = changedLines[file.path] || new Set();
    const mine = (k) => k.startsWith(file.path + ":");
    const key = JSON.stringify([
      liveComments().filter((c) => c.file === file.path).map((c) => [c.line, c.text]),
      openEditor && mine(openEditor) ? openEditor : null,
      [...expanded].filter(mine),
    ]);
    const hit = fileCache.get(file.path);
    if (hit && hit.key === key) return hit.el;
    const el = buildFile(file, changes);
    fileCache.set(file.path, { key, el });
    return el;
  }

  function buildFile(file, changes) {
    const lines = fileLines[file.path];
    const hash = hashLang(file.path);
    const interesting = (ln) =>
      file.fences.some((f) => ln >= f.openLine && ln <= f.closeLine) || changes.has(ln) || driftLines[file.path]?.has(ln) ||
      commentsFor(file.path, ln).length > 0 || openEditor === `${file.path}:${ln}`;
    const slots = []; // live rows (notes, editor, fold buttons) dropped into placeholders
    const rows = [];
    const row = (ln) => {
      const fence = file.fences.find((f) => ln >= f.openLine && ln <= f.closeLine);
      const cls = [];
      if (fence) {
        cls.push(fence.id === data.activeStep ? "fence-active" : "fence-" + fence.status);
        if (ln === fence.openLine || ln === fence.closeLine) cls.push("marker");
      }
      if (changes.has(ln)) cls.push("changed");
      if (driftLines[file.path]?.has(ln)) cls.push("drift");
      rows.push(`<tr class="${cls.join(" ")}" id="L-${esc(file.path)}-${ln}"><td class="ln"><button class="lnbtn" data-line="${ln}" aria-label="Comment on line ${ln}" title="Comment on this line">${ln}</button></td><td class="src">${highlight(lines[ln - 1], hash) || " "}</td></tr>`);
      for (const c of commentsFor(file.path, ln)) { slots.push(noteRow(c)); rows.push(`<tr data-slot="${slots.length - 1}"></tr>`); }
      if (openEditor === `${file.path}:${ln}`) { slots.push(editorRow(file.path, ln)); rows.push(`<tr data-slot="${slots.length - 1}"></tr>`); }
    };
    let ln = 1;
    while (ln <= lines.length) {
      if (interesting(ln)) { row(ln); ln++; continue; }
      let end = ln;
      while (end + 1 <= lines.length && !interesting(end + 1)) end++;
      const key = `${file.path}:${ln}`;
      if (end - ln + 1 >= COLLAPSE_AT && !expanded.has(key)) {
        for (let i = ln; i < ln + KEEP; i++) row(i);
        const hidden = end - ln + 1 - 2 * KEEP;
        slots.push(h("tr", { class: "fold" }, h("td", { colspan: 2 },
          h("button", { class: "linkbtn", onclick: () => { expanded.add(key); render(); } }, `… ${hidden} unchanged lines outside the fences — show`))));
        rows.push(`<tr data-slot="${slots.length - 1}"></tr>`);
        for (let i = end - KEEP + 1; i <= end; i++) row(i);
      } else {
        for (let i = ln; i <= end; i++) row(i);
      }
      ln = end + 1;
    }
    const table = h("table", {});
    for (let i = 0; i < rows.length; i += CHUNK) {
      table.append(h("tbody", { class: "chunk", html: rows.slice(i, i + CHUNK).join("") }));
    }
    for (const ph of table.querySelectorAll("tr[data-slot]")) ph.replaceWith(slots[Number(ph.dataset.slot)]);
    table.addEventListener("click", (e) => {
      const b = e.target.closest?.("button.lnbtn");
      if (b) openComment(file.path, Number(b.dataset.line));
    });
    return h("section", { class: "panel file" },
      h("header", {}, file.path,
        file.fences.length ? h("span", { class: "hint" }, `${file.fences.length} fence${file.fences.length > 1 ? "s" : ""}`) : "",
        changes.size ? h("span", { class: "hint changed-count" }, `${changes.size} changed since you last looked`) : "",
        lines.length > 5000 ? h("span", { class: "hint" }, "(changes aren't highlighted in files over 5,000 lines)") : ""),
      h("div", { class: "code" }, table));
  }

  function noteRow(c) {
    return h("tr", { class: "note" }, h("td", { colspan: 2 },
      h("div", { class: "note-text" }, c.text),
      h("div", { class: "note-actions" },
        h("button", { class: "linkbtn", onclick: () => { draft.comments = draft.comments.filter((x) => x !== c); save(); render(); } }, "Delete"))));
  }

  function editorRow(file, line) {
    const label = file.startsWith("diagram:") ? `the ${file.slice(8)} diagram` : `${file}:${line}`;
    const ta = h("textarea", { placeholder: `Comment on ${label}${stepAt(file, line) ? ` (step ${stepAt(file, line)})` : ""}…`, id: "note-editor", "aria-label": `Comment on ${label}` });
    const submit = () => {
      const text = ta.value.trim();
      if (text) { draft.comments.push({ file, line, step: stepAt(file, line), text, anchor: file.startsWith("diagram:") ? null : anchorOf(file, line) }); save(); }
      openEditor = null; render();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      if (e.key === "Escape") { openEditor = null; render(); }
    });
    return h("tr", { class: "note" }, h("td", { colspan: 2 },
      h("div", { class: "note-box" }, ta,
        h("div", { class: "note-actions" },
          h("button", { class: "btn primary", onclick: submit }, "Add comment"),
          h("button", { class: "btn", onclick: () => { openEditor = null; render(); } }, "Cancel"),
          h("span", { class: "hint" }, "Ctrl/⌘+Enter")))));
  }

  function feedbackPanel() {
    const general = h("textarea", { placeholder: "Overall notes on the shape: files, names, where things live…", "aria-label": "Overall notes" });
    general.value = draft.general;
    general.addEventListener("input", () => { draft.general = general.value; save(); });
    const status = h("div", { class: "status", id: "send-status", role: "status" });
    const verdict = (v, label) =>
      h("button", { class: `btn ${v}` + (draft.verdict === v ? " on" : ""), "aria-pressed": String(draft.verdict === v), onclick: () => { draft.verdict = draft.verdict === v ? null : v; save(); render(); } }, label);
    const n = liveComments().length;
    const outdated = draft.comments.filter((c) => c.outdated);
    const reviewing = data.phase === "scaffold";
    const canSend = served && data.feedbackEnabled === true;
    const filled = data.steps.filter((s) => s.status === "filled").length;
    const hint = reviewing
      ? "Click a line number to comment. Approve when the structure is right; the fill only happens inside the fences."
      : data.phase === "fill"
        ? `${filled ? "Comment on filled code" : "Comment on the code"}; ${canSend ? "Claude reads sent feedback after each step" : "copy feedback and paste it into chat"}. "Request changes" asks to reopen the skeleton for structural edits.`
        : "This skeleton is finalized.";
    return h("aside", { class: "panel feedback", id: "review-panel" },
      h("h2", {}, reviewing ? "Review the skeleton" : "Feedback"),
      h("div", { class: "inner" },
        h("div", { class: "hint" }, hint),
        general,
        h("div", { class: "verdicts" },
          verdict("approve", reviewing ? "Approve skeleton" : "Looks right"),
          verdict("changes", reviewing ? "Request changes" : "Reopen skeleton")),
        h("div", { class: "hint" }, `${n} line comment${n === 1 ? "" : "s"}`),
        outdated.length ? h("div", { class: "outdated" },
          h("div", { class: "hint" }, `${outdated.length} comment${outdated.length > 1 ? "s" : ""} lost ${outdated.length > 1 ? "their" : "its"} line after an edit (still included in feedback):`),
          outdated.map((c) => h("div", { class: "outdated-item" },
            h("code", {}, `${c.file}:${c.line}`), " ", c.text, " ",
            h("button", { class: "linkbtn", onclick: () => { draft.comments = draft.comments.filter((x) => x !== c); save(); render(); } }, "Delete")))) : "",
        canSend
          ? h("button", { class: "btn primary", "data-feedback-send": true, onclick: send }, "Send to Claude")
          : h("button", { class: "btn primary", onclick: copy }, "Copy feedback for Claude"),
        canSend ? "" : h("div", { class: "hint" }, served
          ? "Live view · copy feedback and paste it into Claude Code. Direct Send requires skel serve --send."
          : "Paste feedback into Claude Code. Run skel serve for a live view."),
        status));
  }

  function mobileJump() {
    const n = liveComments().length;
    return h("a", { class: "mobile-jump", href: "#review-panel" }, `Review${n ? ` · ${n}` : ""} ↓`);
  }

  const outgoing = () => draft.comments.map((c) => ({
    file: c.file, line: c.line, step: c.step,
    text: c.outdated ? `${c.text}\n(outdated: was on "${(c.anchor?.text ?? "").trim().slice(0, 80)}")` : c.text,
  }));

  function toMarkdown() {
    const lines = [`# Skeleton review: ${data.title}`, ""];
    lines.push(`Verdict: ${draft.verdict === "approve" ? "APPROVED" : draft.verdict === "changes" ? "CHANGES REQUESTED" : "no verdict (comments only)"}`, "");
    if (draft.general.trim()) lines.push("## Overall", draft.general.trim(), "");
    const cs = outgoing();
    if (cs.length) {
      lines.push("## Line comments");
      for (const c of [...cs].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
        const where = c.file.startsWith("diagram:") ? `diagram "${c.file.slice(8)}"` : `${c.file}:${c.line}`;
        lines.push(`- ${where}${c.step ? ` (step ${c.step})` : ""}: ${c.text.replace(/\n/g, "\n  ")}`);
      }
    }
    return lines.join("\n");
  }

  async function copy() {
    const md = toMarkdown();
    try { await navigator.clipboard.writeText(md); setStatus("Copied. Paste it into Claude Code."); }
    catch { window.prompt("Copy this feedback:", md); }
  }

  async function send() {
    if (!served || data.feedbackEnabled !== true) return;
    try {
      // The server rebuilds the markdown from these fields itself; the token
      // proves this page (not some other site) is sending.
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-skeleton-token": data.token || "" },
        body: JSON.stringify({ verdict: draft.verdict, general: draft.general, comments: outgoing() }),
      });
      if (!res.ok) throw new Error(await res.text());
      draft = blank(); save(); render();
      setStatus("Sent. Claude reads it the next time it checks for feedback.");
    } catch (err) {
      setStatus("Send failed: " + err.message);
    }
  }

  function setStatus(msg) { const el = document.getElementById("send-status"); if (el) el.textContent = msg; }

  function toast(msg) {
    const el = h("div", { class: "toast", role: "status" }, msg);
    document.body.append(el);
    setTimeout(() => el.remove(), 3500);
  }

  function jump(file, line) {
    const row = document.getElementById(`L-${file}-${line}`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }
  function focusEditor() { const ta = document.getElementById("note-editor"); if (ta) ta.focus(); }

  render();

  // Mermaid loads async (a hung CDN must never blank the page).
  if (data.diagrams.length) {
    if (window.mermaid) renderDiagrams();
    else {
      window.addEventListener("skel-mermaid", renderDiagrams, { once: true });
      setTimeout(() => { if (!window.mermaid) { mermaidMissing = true; render(); } }, 4000);
    }
  }

  // After a live reload, take the viewer to what just changed.
  let arrivedFromUpdate = false;
  try { arrivedFromUpdate = sessionStorage.getItem(KEY + ":updated") === "1"; sessionStorage.removeItem(KEY + ":updated"); } catch {}
  if (arrivedFromUpdate) {
    const first = Object.entries(changedLines).map(([f, s]) => [f, Math.min(...s)])[0];
    const total = Object.values(changedLines).reduce((n, s) => n + s.size, 0);
    if (first) jump(first[0], first[1]);
    else if (data.activeStep) {
      const s = data.steps.find((x) => x.id === data.activeStep);
      if (s) jump(s.locations[0].file, s.locations[0].line);
    }
    toast(total ? `${total} line${total > 1 ? "s" : ""} changed${data.activeStep ? ` · step ${data.activeStep}` : ""}` : "Updated");
  }

  // ---- served mode: send feedback + live reload as steps fill ----
  if (location.protocol.startsWith("http")) {
    fetch("/api/version").then((r) => r.ok ? r.json() : null).then((v) => {
      if (!v) { served = false; render(); return; }
      const serverChanged = (next) => next.serverId !== data.serverId || next.feedbackEnabled !== data.feedbackEnabled;
      // A restart may change the token or remove Send without changing code.
      // Disable stale Send immediately; defer reload only while an inline note
      // is being typed, so an unsubmitted note isn't discarded.
      const refreshServer = () => {
        served = false;
        if (openEditor) return false;
        location.reload();
        return true;
      };
      if (serverChanged(v) && refreshServer()) return;
      // Baseline = the version this page was BUILT at, so a change between the
      // build and this first poll still reloads.
      const version = data.version || v.version;
      // A chain, not an interval: a slow poll never stacks up behind another.
      const poll = async () => {
        try {
          const next = await (await fetch("/api/version")).json();
          if (serverChanged(next)) {
            // Update just the Send control while an inline editor is open.
            if (openEditor) {
              served = false;
              const sendButton = document.querySelector('[data-feedback-send]');
              if (sendButton) { sendButton.disabled = true; sendButton.textContent = "Review mode changed · finish your note to reload"; }
            } else if (refreshServer()) return;
          }
          const typing = document.activeElement && document.activeElement.tagName === "TEXTAREA";
          if (next.version !== version && !typing && !openEditor) {
            try { sessionStorage.setItem(KEY + ":updated", "1"); } catch {}
            location.reload();
            return;
          }
        } catch {}
        setTimeout(poll, 2000);
      };
      setTimeout(poll, 2000);
    }).catch(() => { served = false; render(); });
  }
})();
