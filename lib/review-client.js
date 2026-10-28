(() => {
  const data = JSON.parse(document.getElementById("skeleton-data").textContent);
  const app = document.getElementById("app");
  const KEY = "skeleton:" + data.reviewKey;

  // ---- feedback draft (survives reloads; per-viewer only) ----
  const blank = () => ({ verdict: null, general: "", comments: [] });
  let draft = blank();
  try { draft = { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch {} };

  let served = false;
  let openEditor = null; // "file:line" being commented

  // ---- tiny highlighter: comments, strings, numbers, keywords ----
  const KW = new Set(("abstract as async await break case catch class const continue def default del do elif else enum " +
    "except export extends false finally fn for from func function if impl import in interface is lambda let match " +
    "mut new nil none null of package pass private protected pub public raise readonly return self static struct super " +
    "switch this throw true try type typeof undefined use var void where while with yield None True False").split(" "));
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
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
  const stepAt = (file, line) => {
    const f = data.files.find((x) => x.path === file);
    const fence = f && f.fences.find((x) => line >= x.openLine && line <= x.closeLine);
    return fence ? fence.id : null;
  };
  const commentsFor = (file, line) => draft.comments.filter((c) => c.file === file && c.line === line);
  const stepCommentCount = (id) => draft.comments.filter((c) => c.step === id).length;

  // ---- render ----
  function render() {
    const scrollY = window.scrollY;
    app.replaceChildren(top(), data.errors.length ? errors() : "", layout());
    decorateDiagrams();
    window.scrollTo(0, scrollY);
  }

  function top() {
    const total = data.steps.length;
    const done = data.steps.filter((s) => s.status === "filled").length;
    const phaseLabel = { scaffold: "skeleton review", fill: "filling", done: "finalized" }[data.phase] || data.phase;
    return h("div", { class: "top" },
      h("h1", {}, data.title),
      h("span", { class: "pill" + (data.phase === "fill" ? " fill" : "") },
        phaseLabel + (data.activeStep ? ` · step ${data.activeStep}` : "")),
      h("div", { class: "progress" },
        h("span", {}, `${done}/${total} steps filled`),
        h("div", { class: "bar" }, h("i", { style: `width:${total ? (100 * done) / total : 0}%` }))));
  }

  function errors() {
    return h("div", { class: "errors" }, "Marker problems:\n", ...data.errors.map((e) => h("div", {}, e)));
  }

  function layout() {
    return h("div", { class: "layout" }, sidebar(), filesView(), feedbackPanel());
  }

  function sidebar() {
    return h("nav", { class: "panel side" },
      h("h2", {}, "Steps"),
      data.steps.length === 0 ? h("div", { class: "hint", style: "padding:0 14px 12px" }, "No SKEL[...] fences found.") : "",
      h("ol", { class: "steps" }, data.steps.map((s) => {
        const active = s.id === data.activeStep;
        const n = stepCommentCount(s.id);
        return h("li", { class: active ? "active" : "" },
          h("button", { onclick: () => jump(s.locations[0].file, s.locations[0].line), title: s.locations.map((l) => `${l.file}:${l.line}`).join("\n") },
            h("span", { class: "dot " + (active ? "active" : s.status) }),
            h("span", { class: "sid" }, s.id),
            h("span", { class: "stitle" }, s.title || "(untitled)", n ? h("span", { class: "ccount" }, `· ${n} note${n > 1 ? "s" : ""}`) : "")));
      })));
  }

  function filesView() {
    const files = data.files.length ? data.files.map(fileView) : [h("div", { class: "panel empty" }, "No skeleton files yet.")];
    return h("main", { class: "files" }, data.diagrams.map(diagramView), files);
  }

  // ---- architecture diagrams (Mermaid; step_<id> nodes track step status) ----
  const svgCache = {};
  function diagramView(d) {
    const key = `diagram:${d.name}`;
    const host = h("div", { class: "diagram-host", "data-diagram": d.name });
    if (svgCache[d.name]) host.innerHTML = svgCache[d.name];
    else host.append(h("pre", { class: "diagram-src" }, d.source));
    const notes = commentsFor(key, 0).map((c) => h("table", { class: "diagram-notes" }, h("tbody", {}, noteRow(c))));
    return h("section", { class: "panel file diagram" },
      h("header", {}, `Architecture · ${d.name}`,
        h("button", { onclick: () => { openEditor = `${key}:0`; render(); focusEditor(); } }, "Comment on diagram")),
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
        svgCache[d.name] = `<pre class="diagram-src">${esc(d.source)}</pre><div class="hint">Mermaid error: ${esc(String(err.message || err))}</div>`;
      }
    }
    render();
  }

  function decorateDiagrams() {
    const status = Object.fromEntries(data.steps.map((s) => [s.id, s.id === data.activeStep ? "active" : s.status]));
    for (const node of document.querySelectorAll(".diagram-host g.node")) {
      const m = /^flowchart-step_([A-Za-z0-9_]+)-\d+$/.exec(node.id);
      if (!m) continue;
      const id = m[1].replace(/_/g, ".");
      const step = data.steps.find((s) => s.id === id);
      if (!step) continue;
      node.classList.add("dd-step", "dd-" + status[id]);
      node.addEventListener("click", () => jump(step.locations[0].file, step.locations[0].line));
      node.insertAdjacentHTML("afterbegin", `<title>Step ${esc(id)}: ${esc(step.title)} (${status[id]})</title>`);
    }
  }

  function fileView(file) {
    const lines = file.text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const hash = hashLang(file.path);
    const rows = [];
    lines.forEach((text, i) => {
      const ln = i + 1;
      const fence = file.fences.find((f) => ln >= f.openLine && ln <= f.closeLine);
      const cls = [];
      if (fence) {
        cls.push(fence.id === data.activeStep ? "fence-active" : "fence-" + fence.status);
        if (ln === fence.openLine || ln === fence.closeLine) cls.push("marker");
      }
      rows.push(h("tr", { class: cls.join(" "), id: `L-${file.path}-${ln}` },
        h("td", { class: "ln", title: "Comment on this line", onclick: () => { openEditor = `${file.path}:${ln}`; render(); focusEditor(); } }, String(ln)),
        h("td", { class: "src", html: highlight(text, hash) || " " })));
      for (const c of commentsFor(file.path, ln)) rows.push(noteRow(c));
      if (openEditor === `${file.path}:${ln}`) rows.push(editorRow(file.path, ln));
    });
    return h("section", { class: "panel file" },
      h("header", {}, file.path,
        file.fences.length ? h("span", { class: "hint" }, `${file.fences.length} fence${file.fences.length > 1 ? "s" : ""}`) : ""),
      h("div", { class: "code" }, h("table", {}, h("tbody", {}, rows))));
  }

  function noteRow(c) {
    return h("tr", { class: "note" }, h("td", { colspan: 2 },
      h("div", { class: "note-text" }, c.text),
      h("div", { class: "note-actions" },
        h("button", { class: "linkbtn", onclick: () => { draft.comments = draft.comments.filter((x) => x !== c); save(); render(); } }, "Delete"))));
  }

  function editorRow(file, line) {
    const label = file.startsWith("diagram:") ? `the ${file.slice(8)} diagram` : `${file}:${line}`;
    const ta = h("textarea", { placeholder: `Comment on ${label}${stepAt(file, line) ? ` (step ${stepAt(file, line)})` : ""}…`, id: "note-editor" });
    const submit = () => {
      const text = ta.value.trim();
      if (text) { draft.comments.push({ file, line, step: stepAt(file, line), text }); save(); }
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
    const general = h("textarea", { placeholder: "Overall notes on the shape: files, names, where things live…" });
    general.value = draft.general;
    general.addEventListener("input", () => { draft.general = general.value; save(); });
    const status = h("div", { class: "status", id: "send-status" });
    const verdict = (v, label) =>
      h("button", { class: `btn ${v}` + (draft.verdict === v ? " on" : ""), onclick: () => { draft.verdict = draft.verdict === v ? null : v; save(); render(); } }, label);
    const n = draft.comments.length;
    const reviewing = data.phase === "scaffold";
    return h("aside", { class: "panel feedback" },
      h("h2", {}, reviewing ? "Review the skeleton" : "Feedback"),
      h("div", { class: "inner" },
        h("div", { class: "hint" }, reviewing
          ? "Click a line number to comment. Approve when the structure is right; the fill only happens inside the fences."
          : "Click a line number to comment on a filled step."),
        general,
        h("div", { class: "verdicts" },
          verdict("approve", reviewing ? "Approve skeleton" : "Looks right"),
          verdict("changes", "Request changes")),
        h("div", { class: "hint" }, `${n} line comment${n === 1 ? "" : "s"}`),
        served
          ? h("button", { class: "btn primary", onclick: send }, "Send to Claude")
          : h("button", { class: "btn primary", onclick: copy }, "Copy feedback for Claude"),
        served ? "" : h("div", { class: "hint" }, "Paste it into Claude Code. (Run `skel serve` to send directly.)"),
        status));
  }

  function toMarkdown() {
    const lines = [`# Skeleton review: ${data.title}`, ""];
    lines.push(`Verdict: ${draft.verdict === "approve" ? "APPROVED" : draft.verdict === "changes" ? "CHANGES REQUESTED" : "no verdict (comments only)"}`, "");
    if (draft.general.trim()) lines.push("## Overall", draft.general.trim(), "");
    if (draft.comments.length) {
      lines.push("## Line comments");
      for (const c of [...draft.comments].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
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
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, markdown: toMarkdown(), at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(await res.text());
      draft = blank(); save(); render();
      setStatus("Sent. Claude will pick it up.");
    } catch (err) {
      setStatus("Send failed: " + err.message);
    }
  }

  function setStatus(msg) { const el = document.getElementById("send-status"); if (el) el.textContent = msg; }

  function jump(file, line) {
    const row = document.getElementById(`L-${file}-${line}`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }
  function focusEditor() { const ta = document.getElementById("note-editor"); if (ta) ta.focus(); }

  render();
  renderDiagrams();

  // ---- served mode: send feedback + live reload as steps fill ----
  if (location.protocol.startsWith("http")) {
    fetch("/api/version").then((r) => r.ok ? r.json() : null).then((v) => {
      if (!v) return;
      served = true; render();
      let version = v.version;
      setInterval(async () => {
        try {
          const next = (await (await fetch("/api/version")).json()).version;
          const typing = document.activeElement && document.activeElement.tagName === "TEXTAREA";
          if (next !== version && !typing && !openEditor) location.reload();
        } catch {}
      }, 2000);
    }).catch(() => {});
  }
})();
