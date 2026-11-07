(async () => {
  const app = document.getElementById("app");
  // A static `skel review` file embeds its data. A live page's shell holds
  // nothing: the data comes from the server, with the token.
  const embedded = document.getElementById("skeleton-data");
  const live = !embedded;

  // ---- the live page's token ----
  // It arrives in the URL's fragment, which is never sent in a request line, a
  // log or a Referer. It is tried first, leaves the address bar, and stays in
  // this tab's sessionStorage for reloads only if the server accepted it, so a
  // stale link can't cost a tab the token it has. The drafts below are kept by origin and
  // reviewKey, not by token, so a new token finds them again.
  const TOKEN_KEY = "skeleton:token";
  let token = null;
  let lockedOut = false; // the server refused our token: it restarted, so this tab's link expired
  let pendingToken = null; // a working token from another tab, kept for if this tab's stops working
  let onToken = () => location.reload(); // no data yet: load it (replaced once the page is up)
  const auth = () => ({ "x-skeleton-token": token ?? "" });
  const keepToken = (t) => {
    token = t;
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch {}
  };
  let onRefused = () => {}; // a link's token was refused while this tab has its own (set once the page is up)
  let channel = null;
  /**
   * Try the token in the URL's fragment. "none": no token there. "ok": kept,
   * and other tabs told. "refused": dropped. "unreachable": it stays in the
   * address bar, to try again, since nothing else holds it.
   */
  const tryFragment = async () => {
    const t = skelTokenFromHash(location.hash);
    if (!t) return "none";
    let res;
    try { res = await fetch("/api/version", { headers: { "x-skeleton-token": t } }); } catch { return "unreachable"; }
    // Only an authentication refusal proves the link expired; keep it for retry otherwise.
    if (!res.ok && res.status !== 401) return "unreachable";
    history.replaceState(null, "", location.pathname + location.search);
    if (!res.ok) return "refused";
    keepToken(t);
    channel?.postMessage(t);
    return "ok";
  };
  /** A refused token: move to the one another tab confirmed, if there is one. */
  const tryPendingToken = () => {
    if (!pendingToken || pendingToken === token) return false;
    keepToken(pendingToken);
    pendingToken = null;
    return true;
  };
  // A full-page message in place of the review: a heading and readable text.
  const gate = (title, message) => {
    const el = document.createElement("main");
    el.className = "panel gate";
    const h = document.createElement("h1");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = message;
    el.append(h, p);
    app.replaceChildren(el);
  };
  // The human may have no `skel` on PATH (the plugin runs it for Claude), so
  // the way back is to ask Claude for the link.
  const OPEN_LINK = "Ask Claude for the current review link and open the whole link, including the part after #, in this tab or another. Your unsent notes are kept in this browser.";
  const EXPIRED = `This link has expired because the review server restarted. ${OPEN_LINK}`;
  async function loadLive(arrived) {
    if (arrived === "unreachable") {
      gate("Reconnecting", "Can't reach the review server. Trying again…");
      setTimeout(() => location.reload(), 2000);
      return null;
    }
    if (!token) {
      lockedOut = true;
      if (arrived === "refused") gate("Review link expired", EXPIRED);
      else gate("Review link needed", `This review page needs its full link. ${OPEN_LINK}`);
      return null;
    }
    let res;
    try {
      res = await fetch("/api/data", { headers: auth() });
    } catch {
      gate("Reconnecting", "Can't reach the review server. Trying again…");
      setTimeout(() => location.reload(), 2000);
      return null;
    }
    if (res.status === 401) {
      if (tryPendingToken()) { location.reload(); return null; }
      lockedOut = true;
      gate("Review link expired", EXPIRED);
      return null;
    }
    if (!res.ok) {
      gate("Review unavailable", `The review server couldn't build the page (${res.status}). Reload to try again.`);
      return null;
    }
    return res.json();
  }
  if (live) {
    try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
    // Pasting the new URL into this tab changes only the fragment: no reload.
    const onHash = async () => {
      const result = await tryFragment();
      if (result === "ok") onToken();
      else if (result === "refused") onRefused();
      else if (result === "unreachable") setTimeout(onHash, 2000);
    };
    window.addEventListener("hashchange", onHash);
    // A tab locked out by a restart recovers when another tab opens the new
    // URL, keeping any note it has open.
    if ("BroadcastChannel" in window) {
      channel = new BroadcastChannel("skeleton-review");
      channel.addEventListener("message", (e) => {
        if (skelTokenFromHash(`#t=${e.data}`) === null || e.data === token) return;
        if (!lockedOut) { pendingToken = e.data; return; }
        keepToken(e.data);
        onToken();
      });
    }
  }
  const data = live ? await loadLive(await tryFragment()) : JSON.parse(embedded.textContent);
  if (!data) return;
  if (live) document.title = `${data.title} · skeleton`;

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
  // A Send empties the draft: that is a choice, so its verdictAt is now.
  const blank = () => ({ verdict: null, verdictVersion: null, verdictAt: Date.now(), general: "", comments: [], phase: data.phase });
  // Another tab may have saved since this one read the draft: its newer
  // verdict is kept (lib/review-feedback.js), so a stale tab can't erase it.
  const save = () => store.set(KEY, skelMergeVerdict(draft, store.get(KEY, null)));
  // lib/review-feedback.js: a verdict holds only for the skeleton version it
  // was given on. After a reload onto another shape (or for an older draft,
  // with no version recorded) it is cleared, comments kept, and the panel says
  // why. Notes from the skeleton review are marked once filling starts.
  const loadDraft = (stored) => {
    const phased = skelDraftForPhase({ verdict: null, verdictVersion: null, general: "", comments: [], ...stored }, data.phase);
    const checked = skelDraftForVersion(phased.draft, data.skeletonVersion, data.phase);
    return { draft: checked.draft, changed: phased.changed || checked.changed };
  };
  let draft;
  {
    const stored = store.get(KEY, {});
    const loaded = loadDraft(stored);
    draft = loaded.draft;
    // This page was just built from the current skeleton, so a verdict it
    // clears (another version, or the other phase) is cleared for good, and
    // saved: it can't come back if the shape or phase later returns to it.
    // A clear that arrives with another tab's save isn't settled, since that
    // tab may be the current one (lib/review-feedback.js skelMergeVerdict).
    if (stored && stored.verdict && !draft.verdict) draft.verdictSettled = skelSettle(stored);
    if (loaded.changed) save();
  }

  // Comments remember the line they were made on (its text and neighbours) and
  // its step, so when the agent's edits shift the file they follow their code
  // instead of silently landing on whatever now sits at that line number, or
  // on the same stub line in another step (lib/review-feedback.js).
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
      const at = skelReanchor(c, lines, (n) => stepAt(c.file, n));
      if (at.line === c.line && at.step === c.step && !!at.outdated === !!c.outdated) continue;
      Object.assign(c, at);
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

  // Set when the server restarted in another mode while a note was being
  // typed: Send is off until the page reloads, but the page is still live, so
  // it never shows the static page's hints.
  let modeChanged = false;
  let nextFeedbackEnabled = null; // the restarted server's mode, while modeChanged
  let openEditor = null; // "file:line" being commented
  let editing = null; // #68 P5: the comment whose text is being edited
  let outage = false; // #68 P7: two polls in a row got no answer
  // #68 P6: what the last Send carried, and when ({ at, summary, markdown }).
  const SENT_KEY = KEY + ":sent";
  let lastSent = store.get(SENT_KEY, null);
  // #68 P15: wrap long lines, remembered per viewer (every project).
  const WRAP_KEY = "skeleton:wrap";
  let wrap = store.get(WRAP_KEY, false) === true;
  document.body.classList.toggle("wrap", wrap);
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
  // A finalized page takes no feedback, so it shows none.
  const liveComments = () => (data.phase === "done" ? [] : draft.comments.filter((c) => !c.outdated));
  const commentsFor = (file, line) => liveComments().filter((c) => c.file === file && c.line === line);
  const stepCommentCount = (id) => liveComments().filter((c) => c.step === id).length;
  const openComment = (file, line) => { editing = null; openEditor = `${file}:${line}`; render(); focusEditor(); };
  const editComment = (c) => { openEditor = null; editing = c; render(); focusEditor(); };

  reanchor();

  // ---- render ----
  function render() {
    const scrollY = window.scrollY;
    // A deferred render (Mermaid arriving, served mode) must not steal the
    // caret from a comment being typed.
    const active = document.activeElement;
    const keep = active && active.tagName === "TEXTAREA" ? { id: active.id, ph: active.placeholder, start: active.selectionStart, end: active.selectionEnd } : null;
    // A control that rebuilt itself (a verdict, a step, a fold) keeps focus:
    // each carries a data-fk naming it across renders. focusAfter names one
    // to move to instead (the line an editor was opened from).
    const fk = focusAfter ?? (active && active !== document.body ? active.getAttribute?.("data-fk") : null);
    focusAfter = null;
    const notices = [lockedOut ? lockBanner() : "", data.errors.length ? errors() : "", data.drift ? driftPanel() : ""].filter(Boolean);
    app.replaceChildren(
      h("a", { class: "skip", "data-fk": "skip", href: data.phase === "done" ? "#finalized" : "#review-panel", onclick: toPanel }, data.phase === "done" ? "Skip to summary" : "Skip to review panel"),
      top(),
      notices.length ? h("div", { class: "notices", role: "region", "aria-label": "Notices" }, notices) : "",
      layout(),
      data.phase === "done" ? "" : mobileJump());
    decorateDiagrams();
    window.scrollTo(0, scrollY);
    const kept = keep && (keep.id ? document.getElementById(keep.id) : [...document.querySelectorAll("textarea")].find((t) => t.placeholder === keep.ph));
    if (kept) {
      kept.focus({ preventScroll: true });
      try { kept.setSelectionRange(keep.start, keep.end); } catch {}
    } else if (fk) {
      const el = [...document.querySelectorAll("[data-fk]")].find((e) => e.getAttribute("data-fk") === fk);
      if (el) { if (el.classList.contains("lnbtn")) rove(el); el.focus({ preventScroll: true }); }
    }
  }
  let focusAfter = null;
  // The skip link and Review ↓: scroll to the panel and move focus into it,
  // without putting a fragment in the address bar (it holds the token's place).
  function toPanel(e) {
    const panel = document.getElementById(data.phase === "done" ? "finalized" : "review-panel");
    if (!panel) return;
    e.preventDefault();
    panel.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    panel.focus({ preventScroll: true });
  }

  // Viewers who ask for less motion get no smooth scrolling and no flash.
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function top() {
    // lib/review-progress.js: the active step is filling, not done.
    const progress = skelProgress(data);
    const phaseLabel = { scaffold: "skeleton review", fill: "filling", done: "finalized" }[data.phase] || data.phase;
    const done = data.phase === "done";
    return h("header", { class: "top" },
      h("h1", {}, data.title),
      h("span", { class: "pill" + (data.phase === "fill" ? " fill" : "") },
        phaseLabel + (data.activeStep ? ` · step ${data.activeStep}` : "")),
      // The skeleton version this page shows (exteriors + fence set): feedback
      // carries it, and `skel approve` checks it is still the current one.
      // #68 P13: the pill says it in words; the version ids are in its title
      // and spelled out in the review panel (#version-help).
      done ? "" : h("span", { class: "pill version" + (staleVersion || shapeChanged() ? " stale" : ""), title: versionTitle(), "aria-describedby": "version-help" },
        versionLabel()),
      done ? "" : h("span", { class: "pill", "aria-label": "Review delivery mode", title: modeTitle() },
        modePill()),
      // #68 P8: a static file shows when it was made.
      live ? "" : h("span", { class: "hint generated" }, `Generated ${when(data.generatedAt)}`),
      h("button", { class: "pill toggle", "data-fk": "wrap", "aria-pressed": String(wrap), onclick: () => {
        wrap = !wrap;
        store.set(WRAP_KEY, wrap);
        document.body.classList.toggle("wrap", wrap);
        render();
      } }, "Wrap long lines"),
      h("div", { class: "progress" },
        h("span", { id: "progress-text" }, progress.text),
        progress.total ? h("div", { class: "bar", role: "progressbar", "aria-label": "Steps done", "aria-valuemin": 0, "aria-valuemax": progress.total, "aria-valuenow": progress.done, "aria-valuetext": progress.text },
          h("i", { style: `width:${(100 * progress.done) / progress.total}%` })) : ""),
      // #68 P7: kept in the sticky header, so it shows however far down the
      // page the viewer is. A live region: updated in place (setTopAlert).
      h("div", { class: "top-alert", id: "top-alert", role: "status" }, topAlertText()));
  }

  function topAlertText() {
    if (lockedOut) return "Link expired: this page has stopped updating. Ask Claude for the current review link. Copy still works.";
    if (outage) return "Server not responding; retrying…";
    return "";
  }
  function setTopAlert() {
    const el = document.getElementById("top-alert");
    if (el) { el.textContent = topAlertText(); el.classList.toggle("lock", lockedOut); }
  }

  /** A time for people: "14:03", or "7 Nov, 14:03" when it isn't today. */
  function when(at) {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return "";
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
  }

  // Set when a poll sees the skeleton change but the page can't reload yet
  // (a comment is being typed): this page no longer shows the current version.
  let staleVersion = false;
  // The shape on this page isn't the approved one (fill phase: drift).
  const shapeChanged = () => data.phase === "fill" && !!data.approvedVersion && data.approvedVersion !== data.skeletonVersion;
  function versionLabel() {
    if (staleVersion) return "Outdated: reload before approving";
    if (shapeChanged()) return "Shape changed since approval";
    if (data.phase === "fill") return data.approvedVersion ? "Shape as approved" : "Filling";
    return "Shape under review";
  }
  function versionIds() {
    return `Skeleton version ${data.skeletonVersion}${data.approvedVersion ? `; approved version ${data.approvedVersion}` : ""}.`;
  }
  function versionTitle() {
    return `${versionIds()} ` + (staleVersion
      ? "The skeleton (its shape outside the fence bodies) changed after this page loaded. Reload before approving: skel approve checks the version you reviewed."
      : "Your feedback names the version, and skel approve refuses if the skeleton changed after you reviewed it.");
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
    return h("div", { class: "layout" }, sidebar(), filesView(), data.phase === "done" ? finalizedPanel() : feedbackPanel());
  }

  // A dot's colour is for sighted viewers; its state is read out as text.
  const STATE_WORDS = { todo: "pending", active: "filling", filled: "filled" };
  const dot = (state) => [h("span", { class: "dot " + state, "aria-hidden": "true" }), h("span", { class: "sr-only" }, `${STATE_WORDS[state] ?? state}: `)];

  function sidebar() {
    // A finalized skeleton has no fences: list the steps finalize recorded.
    if (data.phase === "done") {
      const titles = data.finalized?.titles ?? [];
      return h("nav", { class: "panel side", "aria-label": "Steps" },
        h("h2", {}, "Steps"),
        titles.length
          ? h("ol", { class: "steps" }, titles.map((s) => h("li", {}, h("div", { class: "step-row" }, dot("filled"), h("span", { class: "sid" }, s.id), h("span", { class: "stitle" }, s.title || "(untitled)")))))
          : h("div", { class: "hint", style: "padding:0 14px 12px" }, "The markers were removed at finalize."));
    }
    return h("nav", { class: "panel side", "aria-label": "Steps" },
      h("h2", {}, "Steps"),
      data.steps.length === 0 ? h("div", { class: "hint", style: "padding:0 14px 12px" }, "No SKEL[...] fences found.") : "",
      h("ol", { class: "steps" }, data.steps.map((s) => {
        const active = s.id === data.activeStep;
        const n = stepCommentCount(s.id);
        const state = active ? "active" : s.status;
        // #68 P4: a step fenced in several places lists each place, with its
        // fence's title when that differs from the step's.
        const places = s.locations.length > 1 ? s.locations.map((l) => h("span", { class: "splace" },
          `${l.file.split("/").pop()}:${l.line}${l.title && l.title !== s.title ? ` · ${l.title}` : ""}`)) : [];
        // #68 P11: the note skel done prints when a fill may leave its block.
        const escapes = data.files.flatMap((f) => f.fences.filter((x) => x.id === s.id && x.escape).map((x) => `${f.path}:${x.openLine}-${x.closeLine}: ${x.escape}`));
        return h("li", { class: active ? "active" : "" },
          h("button", { "data-fk": `step:${s.id}`, onclick: () => jump(s.locations[0].file, s.locations[0].line, true), title: s.locations.map((l) => `${l.file}:${l.line}`).join("\n") },
            dot(state),
            h("span", { class: "sid" }, s.id),
            h("span", { class: "stitle" }, s.title || "(untitled)", n ? h("span", { class: "ccount" }, `· ${n} note${n > 1 ? "s" : ""}`) : "",
              places.length ? h("span", { class: "splaces" }, places) : "")),
          escapes.length ? h("div", { class: "step-warn", "data-escape": s.id },
            h("strong", {}, "Check the block: "),
            escapes.map((e) => h("div", {}, e)),
            h("div", {}, "This is a heuristic: check the fill stays inside the function its fence sits in.")) : "");
      })),
      data.steps.length ? h("div", { class: "legend", "aria-hidden": "true" },
        h("span", {}, h("span", { class: "dot todo" }), "pending"),
        h("span", {}, h("span", { class: "dot active" }), "filling"),
        h("span", {}, h("span", { class: "dot filled" }), "filled")) : "",
      // #67 B6: the page's drift check reads only the skeleton's files; finding
      // new or deleted files means rediscovering the whole source set, which
      // is too slow to repeat every 2 seconds. Say so.
      data.phase === "fill" ? h("div", { class: "hint side-note" }, "Drift is checked here for the skeleton's own files. New, deleted or changed files elsewhere in the project are checked when Claude runs skel done and skel finalize.") : "");
  }

  function finalizedPanel() {
    const n = data.finalized?.steps;
    return h("aside", { class: "panel feedback finalized", id: "finalized", "data-fk": "panel", tabindex: "-1", "aria-label": "Finalized" },
      h("h2", {}, "Finalized"),
      h("div", { class: "inner" },
        h("p", { class: "finalized-text", role: "status" }, typeof n === "number"
          ? `Finalized: all ${n} step${n === 1 ? "" : "s"} filled and markers removed. You can close this page.`
          : "Finalized: all steps filled and markers removed. You can close this page.")));
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
    const notes = commentsFor(key, 0).map((c) => h("table", { class: "diagram-notes" }, h("tbody", {}, editing === c ? editorRow(key, 0, c) : noteRow(c))));
    // A header with two buttons, not a <summary> holding a button: an
    // interactive control nested in another can't be reached or named.
    const open = !collapsedDiagrams.has(d.name);
    const bodyId = `diagram-body-${d.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    return h("section", { class: "panel file diagram", "aria-label": `Diagram ${d.name}` },
      h("div", { class: "diagram-head" },
        h("button", { class: "diagram-toggle", "aria-expanded": String(open), "aria-controls": bodyId, "data-fk": `${key}:toggle`, onclick: () => { if (open) collapsedDiagrams.add(d.name); else collapsedDiagrams.delete(d.name); render(); } },
          h("span", { class: "chev", "aria-hidden": "true" }, open ? "▾" : "▸"), `Diagram: ${d.name}`),
        data.phase === "done" ? "" : h("button", { class: "diagram-comment", "data-fk": `${key}:0`, onclick: () => openComment(key, 0) }, "Comment on diagram")),
      h("div", { id: bodyId, hidden: !open }, host, notes,
        openEditor === `${key}:0` ? h("table", { class: "diagram-notes" }, h("tbody", {}, editorRow(key, 0))) : ""));
  }
  const collapsedDiagrams = new Set();

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
    if (restoreY) { window.scrollTo(0, restoreY); restoreY = 0; }
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    mermaidReady = false;
    for (const k of Object.keys(svgCache)) delete svgCache[k];
    renderDiagrams();
  });

  function decorateDiagrams() {
    // A finalized skeleton has no fences left: its recorded steps are all
    // filled, and there is nothing to jump to.
    const finalized = data.phase === "done";
    const steps = finalized ? (data.finalized?.titles ?? []).map((s) => ({ ...s, status: "filled" })) : data.steps;
    const status = Object.fromEntries(steps.map((s) => [s.id, s.id === data.activeStep ? "active" : s.status]));
    const order = new Map(steps.map((s, i) => [s.id, i]));
    const decorated = [];
    for (const node of document.querySelectorAll(".diagram-host g.node")) {
      const m = /^flowchart-step_([A-Za-z0-9_]+)-\d+$/.exec(node.id);
      if (!m) continue;
      const id = m[1].replace(/_/g, ".");
      const step = steps.find((s) => s.id === id);
      if (!step) continue;
      if (finalized) {
        node.classList.add("dd-step", "dd-filled", "dd-static");
        node.insertAdjacentHTML("afterbegin", `<title>Step ${esc(id)}: ${esc(step.title)} (filled)</title>`);
        continue;
      }
      const go = () => jump(step.locations[0].file, step.locations[0].line, true);
      node.classList.add("dd-step", "dd-" + status[id]);
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `Step ${id}: ${step.title} (${STATE_WORDS[status[id]] ?? status[id]})`);
      node.addEventListener("click", go);
      node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      node.insertAdjacentHTML("afterbegin", `<title>Step ${esc(id)}: ${esc(step.title)} (${status[id]})</title>`);
      decorated.push({ node, at: order.get(id) });
    }
    // Tab order follows the document, and Mermaid writes nodes in no useful
    // order (often reversed): put the step nodes in step order. Nodes don't
    // overlap, so their paint order doesn't show.
    const byParent = new Map();
    for (const d of decorated) { const p = d.node.parentNode; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(d); }
    for (const [parent, list] of byParent) for (const d of list.sort((a, b) => a.at - b.at)) parent.append(d.node);
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
      editing && editing.file === file.path ? [editing.line, editing.text] : null,
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
    const commentable = data.phase !== "done";
    // The line that holds this file's tab stop: the last one focused, if it
    // is still shown, else the first line shown.
    const shown = (n) => n >= 1 && n <= lines.length && (interesting(n) || !hiddenIn(n));
    const stop = shown(roving.get(file.path)) ? roving.get(file.path) : 1;
    const row = (ln) => {
      const fence = file.fences.find((f) => ln >= f.openLine && ln <= f.closeLine);
      const cls = [];
      if (fence) {
        cls.push(fence.id === data.activeStep ? "fence-active" : "fence-" + fence.status);
        if (ln === fence.openLine || ln === fence.closeLine) cls.push("marker");
      }
      if (changes.has(ln)) cls.push("changed");
      if (driftLines[file.path]?.has(ln)) cls.push("drift");
      // One tab stop per file (roving tabindex): Up/Down move between lines.
      // A finalized page takes no comments, so its numbers are plain text.
      const num = commentable
        ? `<button class="lnbtn" data-line="${ln}" data-fk="${esc(file.path)}:${ln}" tabindex="${ln === stop ? 0 : -1}" aria-label="Comment on ${esc(file.path)} line ${ln}" title="Comment on this line">${ln}</button>`
        : `<span class="lnnum">${ln}</span>`;
      rows.push(`<tr class="${cls.join(" ")}" id="L-${esc(file.path)}-${ln}"><td class="ln">${num}</td><td class="src">${highlight(lines[ln - 1], hash) || " "}</td></tr>`);
      for (const c of commentsFor(file.path, ln)) { slots.push(editing === c ? editorRow(file.path, ln, c) : noteRow(c)); rows.push(`<tr data-slot="${slots.length - 1}"></tr>`); }
      if (openEditor === `${file.path}:${ln}`) { slots.push(editorRow(file.path, ln)); rows.push(`<tr data-slot="${slots.length - 1}"></tr>`); }
    };
    // Which lines a collapsed run hides: the same walk as the loop below.
    function hiddenIn(n) {
      let a = 1;
      while (a <= lines.length) {
        if (interesting(a)) { a++; continue; }
        let end = a;
        while (end + 1 <= lines.length && !interesting(end + 1)) end++;
        if (n >= a && n <= end) return end - a + 1 >= COLLAPSE_AT && !expanded.has(`${file.path}:${a}`) && n >= a + KEEP && n <= end - KEEP;
        a = end + 1;
      }
      return false;
    }
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
          h("button", { class: "linkbtn", "data-fk": `fold:${key}`, onclick: () => { expanded.add(key); focusAfter = `${file.path}:${ln + KEEP}`; roving.set(file.path, ln + KEEP); render(); } }, `… ${hidden} unchanged lines outside the fences — show`))));
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
      if (b) { rove(b); openComment(file.path, Number(b.dataset.line)); }
    });
    table.addEventListener("keydown", (e) => {
      const b = e.target.closest?.("button.lnbtn");
      if (!b || !["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) return;
      const all = [...table.querySelectorAll("button.lnbtn")];
      const i = all.indexOf(b);
      const j = { ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: all.length - 1, PageUp: i - 20, PageDown: i + 20 }[e.key];
      const next = all[Math.max(0, Math.min(all.length - 1, j))];
      e.preventDefault();
      if (next && next !== b) { rove(next); next.focus(); }
    });
    return h("section", { class: "panel file", "data-file": file.path, "aria-label": file.path },
      h("header", {}, file.path,
        file.fences.length ? h("span", { class: "hint" }, `${file.fences.length} fence${file.fences.length > 1 ? "s" : ""}`) : "",
        changes.size ? h("span", { class: "hint changed-count" }, `${changes.size} changed since you last looked`) : "",
        lines.length > 5000 ? h("span", { class: "hint" }, "(changes aren't highlighted in files over 5,000 lines)") : ""),
      // Without line buttons (finalized), a wide file's scroll area takes focus itself.
      h("div", { class: "code", ...(commentable ? {} : { tabindex: "0", role: "region", "aria-label": `${file.path} source` }) }, table));
  }

  // The roving tab stop of each file's line numbers, by line.
  const roving = new Map();
  function rove(btn) {
    const table = btn.closest("table");
    for (const o of table.querySelectorAll('button.lnbtn[tabindex="0"]')) if (o !== btn) o.setAttribute("tabindex", "-1");
    btn.setAttribute("tabindex", "0");
    const file = btn.closest("section.file")?.getAttribute("data-file");
    if (file) roving.set(file, Number(btn.dataset.line));
  }

  // Where focus goes back to when an editor closes: the line (or diagram
  // button) it was opened from.
  const openerKey = (file, line) => `${file}:${line}`;

  function noteRow(c) {
    const fromSkeleton = skelFromSkeleton(c, data.phase);
    return h("tr", { class: "note" }, h("td", { colspan: 2 },
      // Pinned to the visible part of the code column: a long line widens
      // the table, and the note must not scroll away with it.
      h("div", { class: "note-inner" },
        fromSkeleton ? h("div", { class: "note-tag" }, "From the skeleton review") : "",
        h("div", { class: "note-text" }, c.text),
        data.phase === "done" ? "" : h("div", { class: "note-actions" },
          h("button", { class: "linkbtn", "aria-label": `Edit comment on ${where(c)}`, onclick: () => editComment(c) }, "Edit"),
          h("button", { class: "linkbtn", "aria-label": `Delete comment on ${where(c)}`, onclick: () => { draft.comments = draft.comments.filter((x) => x !== c); save(); focusAfter = openerKey(c.file, c.line); render(); } }, "Delete")))));
  }
  const where = (c) => (c.file.startsWith("diagram:") ? `the ${c.file.slice(8)} diagram` : `${c.file} line ${c.line}`);

  /** A new comment's editor, or (#68 P5) an existing comment's, holding its text. */
  function editorRow(file, line, existing = null) {
    const label = file.startsWith("diagram:") ? `the ${file.slice(8)} diagram` : `${file}:${line}`;
    const ta = h("textarea", { placeholder: `Comment on ${label}${stepAt(file, line) ? ` (step ${stepAt(file, line)})` : ""}…`, id: "note-editor", "aria-label": `${existing ? "Edit comment" : "Comment"} on ${label}` });
    if (existing) ta.value = existing.text;
    // Closing the editor (add, save, Esc or Cancel) puts focus back on its opener.
    const close = () => { openEditor = null; editing = null; focusAfter = openerKey(file, line); render(); };
    const submit = () => {
      const text = ta.value.trim();
      if (existing) {
        // Saved empty: the comment goes, as with Delete.
        if (text) existing.text = text;
        else draft.comments = draft.comments.filter((x) => x !== existing);
        save();
      } else if (text) { draft.comments.push({ file, line, step: stepAt(file, line), text, version: data.skeletonVersion, phase: data.phase, anchor: file.startsWith("diagram:") ? null : anchorOf(file, line) }); save(); }
      close();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    return h("tr", { class: "note" }, h("td", { colspan: 2 },
      h("div", { class: "note-box note-inner" }, ta,
        h("div", { class: "note-actions" },
          h("button", { class: "btn primary", onclick: submit }, existing ? "Save" : "Add comment"),
          h("button", { class: "btn", onclick: close }, "Cancel"),
          h("span", { class: "hint" }, "Ctrl/⌘+Enter")))));
  }

  // #68 P1: either way the human comments here; what differs is how the
  // feedback reaches Claude (copied into chat, or sent).
  function modePill() {
    if (!live) return "Static review";
    if (lockedOut) return "Link expired";
    if (modeChanged) return `${nextFeedbackEnabled ? "Send mode" : "Copy mode"} · reload pending`;
    return data.feedbackEnabled ? "Send mode" : "Copy mode";
  }
  function modeTitle() {
    if (!live) return "A file made by skel review: comment here, then copy your feedback into chat.";
    return data.feedbackEnabled ? "Comment here, then send your feedback to Claude." : "Comment here, then copy your feedback and paste it into chat.";
  }

  const MODE_CHANGED_SEND = "Review mode changed · finish your note to reload";
  const MODE_CHANGED_HINT = "Live view · the review server restarted in a different mode; this page reloads when you finish your note.";
  const LOCKED_HINT = "Not live: this link has expired. Copy still works, for the version shown here.";

  function lockBanner() {
    return h("div", { class: "errors lock", role: "alert", id: "lock-banner" }, `${EXPIRED} Until then this page has stopped updating, and Copy still works for the version shown.`);
  }

  function feedbackPanel() {
    const general = h("textarea", { id: "overall-notes", placeholder: data.phase === "scaffold" ? "Overall notes on the shape: files, names, where things live…" : "Overall notes on the fill so far…", "aria-label": "Overall notes" });
    general.value = draft.general;
    // The approve button's words follow the notes (#68 P2), updated in place:
    // a render would rebuild this textarea under the caret.
    general.addEventListener("input", () => {
      // The version it was edited on: an Overall note from an earlier
      // version doesn't make an approval "with comments" (skelFreshNotes).
      draft.general = general.value; draft.generalVersion = data.skeletonVersion; save();
      const b = document.querySelector('[data-fk="verdict:approve"]');
      if (b) b.textContent = approveLabel();
    });
    const status = h("div", { class: "status", id: "send-status", role: "status" });
    const verdict = (v, label) =>
      h("button", { class: `btn ${v}` + (draft.verdict === v ? " on" : ""), "data-fk": `verdict:${v}`, "aria-pressed": String(draft.verdict === v), onclick: () => {
        draft.verdict = draft.verdict === v ? null : v;
        draft.verdictVersion = draft.verdict ? data.skeletonVersion : null;
        draft.verdictPhase = draft.verdict ? data.phase : null;
        // A choice, so it outranks a verdict another tab set earlier.
        draft.verdictAt = Date.now();
        delete draft.verdictCleared;
        save(); render();
      } }, label);
    const n = liveComments().length;
    const outdated = draft.comments.filter((c) => c.outdated);
    const reviewing = data.phase === "scaffold";
    const canSend = live && data.feedbackEnabled === true && !modeChanged && !lockedOut;
    const filled = data.steps.filter((s) => s.status === "filled").length;
    const hint = reviewing
      ? "Click a line number to comment. Approve when the structure is right; the fill only happens inside the fences."
      : data.phase === "fill"
        ? `${filled ? "Comment on filled code" : "Comment on the code"}; ${canSend ? "Claude reads sent feedback after each step" : "copy feedback and paste it into chat"}. "Reopen skeleton" asks Claude to reopen the skeleton for structural edits.`
        : "This skeleton is finalized.";
    const earlier = (draft.skeletonGeneral ?? "").trim();
    const fromSkeleton = draft.comments.filter((c) => !c.outdated && skelFromSkeleton(c, data.phase)).length;
    return h("aside", { class: "panel feedback", id: "review-panel", "data-fk": "panel", tabindex: "-1", "aria-labelledby": "review-panel-title" },
      h("h2", { id: "review-panel-title" }, reviewing ? "Review the skeleton" : "Feedback"),
      h("div", { class: "inner" },
        h("div", { class: "hint" }, hint),
        // #69 review: notes from the skeleton review stay, marked, so Claude
        // doesn't apply them a second time; the human can delete them.
        earlier || fromSkeleton ? h("div", { class: "from-skeleton" },
          h("div", { class: "hint" }, `From the skeleton review. Claude has likely applied ${earlier || fromSkeleton > 1 ? "these" : "this"} already; Copy and Send mark ${earlier || fromSkeleton > 1 ? "them" : "it"} ${SKEL_FROM_SKELETON}.`),
          earlier ? h("div", { class: "note-text earlier" }, earlier) : "",
          fromSkeleton ? h("div", { class: "hint" }, `${fromSkeleton} line comment${fromSkeleton === 1 ? "" : "s"}, marked in the code.`) : "",
          h("button", { class: "linkbtn", onclick: () => { delete draft.skeletonGeneral; draft.comments = draft.comments.filter((c) => !skelFromSkeleton(c, data.phase)); save(); render(); } }, "Delete the skeleton review's notes")) : "",
        general,
        draft.verdictCleared ? h("div", { class: "verdict-cleared", role: "status", "data-verdict-cleared": true }, skelVerdictClearedMessage(draft.verdictCleared, data.phase)) : "",
        h("div", { class: "verdicts" },
          verdict("approve", approveLabel()),
          verdict("changes", reviewing ? "Request changes" : "Reopen skeleton")),
        reviewing && draft.verdict === "approve" && hasNotes() ? h("div", { class: "hint", "data-approve-note": true }, "With comments, Claude applies them first, then asks you to approve the new version.") : "",
        olderNotes() ? h("div", { class: "older-notes", "data-older-notes": true },
          h("div", { class: "hint" }, `${olderNotes()} note${olderNotes() === 1 ? "" : "s"} from an earlier version of the skeleton, most likely applied already. ${olderNotes() === 1 ? "It doesn't" : "They don't"} count as comments on this version, and Copy${canSend ? " and Send" : ""} mark${canSend ? "" : "s"} ${olderNotes() === 1 ? "it" : "them"} as earlier.`),
          h("button", { class: "linkbtn", "data-fk": "clear-older", onclick: () => {
            draft.comments = draft.comments.filter((c) => !isOlder(c));
            if (olderGeneral()) { draft.general = ""; delete draft.generalVersion; }
            save(); focusAfter = "panel"; render();
          } }, "Delete notes from earlier versions")) : "",
        // #68 P4: line and diagram comments, counted apart.
        h("div", { class: "hint", id: "comment-count" }, skelCountText(liveComments())),
        h("div", { class: "hint", id: "version-help" }, staleVersion
          ? `This page shows skeleton version ${data.skeletonVersion}, and the skeleton has changed since it loaded. Reload before approving: skel approve checks the version you reviewed.`
          : shapeChanged()
            ? `This page shows skeleton version ${data.skeletonVersion}; the approved version is ${data.approvedVersion}. The shape outside the fences changed since approval (see Drift above).`
            : `This page shows skeleton version ${data.skeletonVersion}${data.phase === "fill" && data.approvedVersion ? ", the approved version" : ""}. Your feedback names it, and skel approve refuses if the skeleton changed after you reviewed it.`),
        outdated.length ? h("div", { class: "outdated" },
          h("div", { class: "hint" }, `${outdated.length} comment${outdated.length > 1 ? "s" : ""} lost ${outdated.length > 1 ? "their" : "its"} line after an edit (still included in feedback):`),
          outdated.map((c) => h("div", { class: "outdated-item" },
            h("code", {}, `${c.file}:${c.line}`), " ", c.text, " ",
            h("button", { class: "linkbtn", onclick: () => { draft.comments = draft.comments.filter((x) => x !== c); save(); render(); } }, "Delete")))) : "",
        modeChanged && !lockedOut && data.feedbackEnabled === true
          ? h("button", { class: "btn primary", "data-feedback-send": true, disabled: true }, MODE_CHANGED_SEND)
          : canSend
            ? h("button", { class: "btn primary", "data-feedback-send": true, "data-fk": "send", onclick: send }, "Send to Claude")
            : h("button", { class: "btn primary", "data-fk": "copy", onclick: copy }, "Copy feedback for Claude"),
        canSend ? "" : h("div", { class: "hint", "data-send-hint": true }, lockedOut
          ? LOCKED_HINT
          : modeChanged
          ? MODE_CHANGED_HINT
          : live
            ? "Live view · copy feedback and paste it into Claude Code. Direct Send requires skel serve --send."
            : "Paste feedback into Claude Code. For a live view, ask Claude for a review link."),
        status,
        // #68 P6: what the last Send carried, kept across reloads.
        lastSent ? h("details", { class: "last-sent" },
          h("summary", {}, `Last sent at ${when(lastSent.at)}: ${lastSent.summary}`),
          h("pre", { tabindex: "0", role: "region", "aria-label": "Feedback last sent" }, lastSent.markdown)) : ""));
  }

  // #68 P2: notes left from an earlier version of the skeleton review.
  const isOlder = (c) => c.version !== data.skeletonVersion && !skelFromSkeleton(c, data.phase);
  const olderNotes = () => (data.phase !== "scaffold" ? 0
    : draft.comments.filter(isOlder).length + (olderGeneral() ? 1 : 0));
  // An Overall note last edited on an earlier version (a draft from before
  // versions were recorded has none, and is left as it is).
  const olderGeneral = () => !!(draft.general ?? "").trim() && typeof draft.generalVersion === "string" && draft.generalVersion !== data.skeletonVersion;
  // Comments or Overall notes to go with a verdict.
  // Only notes written on the version shown count (lib/review-feedback.js
  // skelFreshNotes): ones from an earlier version were most likely applied.
  const hasNotes = () => skelFreshNotes(outgoing());
  // #68 P2: an approval with notes says so, as Copy and Send do.
  const approveLabel = () => (data.phase !== "scaffold" ? "Looks right" : hasNotes() ? "Approve with comments" : "Approve skeleton");

  // Below 1100px the review panel sits under all the code: a jump to it.
  function mobileJump() {
    const n = liveComments().length;
    return h("a", { class: "mobile-jump", "data-fk": "jump", href: "#review-panel", onclick: toPanel, "aria-label": `Jump to the review panel${n ? ` (${skelCountText(liveComments(), ", ")})` : ""}` }, `Review${n ? ` · ${n}` : ""} ↓`);
  }

  // lib/review-feedback.js: the verdict only with the version it was given
  // on, and each comment with the version it was written on.
  const outgoing = () => skelOutgoing(draft, data.skeletonVersion, data.phase);
  const toMarkdown = () => skelFeedbackMarkdown(data, outgoing());

  async function copy() {
    const md = toMarkdown();
    try { await navigator.clipboard.writeText(md); setStatus("Copied. Paste it into Claude Code."); }
    catch { window.prompt("Copy this feedback:", md); }
  }

  async function send() {
    if (!live || data.feedbackEnabled !== true || modeChanged || lockedOut) return;
    try {
      const out = outgoing();
      // The server rebuilds the markdown from these fields itself; the token
      // proves this page (not some other site) is sending.
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth() },
        // The reviewed version is the verdict's (lib/review-feedback.js), so
        // the server records what the human judged, not what loaded since.
        body: JSON.stringify(outgoing()),
      });
      if (!res.ok) throw new Error(await res.text());
      const reply = res.status === 200 ? await res.json().catch(() => null) : null;
      // #68 P6: the Send empties the draft, so keep a record of what it carried.
      lastSent = { at: Date.now(), summary: skelSentSummary(data, out), markdown: skelFeedbackMarkdown(data, out) };
      store.set(SENT_KEY, lastSent);
      draft = blank(); save(); render();
      const sent = `Sent at ${when(lastSent.at)}: ${lastSent.summary}.`;
      setStatus(reply?.stale
        ? `${sent} But the skeleton changed after this page loaded (you reviewed ${reply.reviewed}; it is now ${reply.current}). Reload and review it again: skel approve refuses a stale review.`
        : `${sent} Claude reads it the next time it checks for feedback.`);
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

  // Scroll to a line and flash it; `focus` (a step or diagram node was used)
  // also moves focus there, so the keyboard carries on from that line.
  function jump(file, line, focus = false) {
    const row = document.getElementById(`L-${file}-${line}`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    if (!reducedMotion()) { row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash"); }
    const btn = focus && row.querySelector("button.lnbtn");
    if (btn) { rove(btn); btn.focus({ preventScroll: true }); }
  }
  function focusEditor() { const ta = document.getElementById("note-editor"); if (ta) ta.focus(); }

  // Another tab saved the draft: take its notes, and the newer verdict of the
  // two (lib/review-feedback.js). Not saved back, so two tabs never ping-pong.
  // An Overall note being typed here stays this tab's, and an open comment
  // editor isn't rebuilt under the caret: the render waits for it to close.
  window.addEventListener("storage", (e) => {
    if (e.key === SENT_KEY) { lastSent = store.get(SENT_KEY, null); if (!openEditor && !editing) render(); return; }
    if (e.key !== KEY) return;
    let stored = null;
    try { stored = JSON.parse(e.newValue || "null"); } catch { return; }
    const typingGeneral = document.activeElement?.id === "overall-notes";
    const theirs = { ...(stored ?? blank()), ...(typingGeneral ? { general: draft.general, generalVersion: draft.generalVersion } : {}) };
    draft = loadDraft(skelMergeVerdict(theirs, draft)).draft;
    reanchor();
    if (!openEditor && !editing) render();
  });

  // A live page's content arrives after the document loads, too late for the
  // browser's own scroll restoration: keep the place across a reload here.
  if (live) history.scrollRestoration = "manual";
  let restoreY = 0; // again once the diagrams are in: they change the page's height

  render();

  if (live) {
    const SCROLL_KEY = KEY + ":scroll";
    try {
      const y = Number(sessionStorage.getItem(SCROLL_KEY));
      sessionStorage.removeItem(SCROLL_KEY);
      if (y) { window.scrollTo(0, y); restoreY = y; }
    } catch {}
    window.addEventListener("pagehide", () => { try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch {} });
  }

  // Mermaid loads async (a hung CDN must never blank the page), and only when
  // a diagram needs it. An inline onload wouldn't pass the CSP.
  if (data.diagrams.length) {
    if (window.mermaid) renderDiagrams();
    else {
      const script = document.createElement("script");
      script.src = data.mermaid.src;
      script.integrity = data.mermaid.integrity;
      script.crossOrigin = "anonymous";
      script.async = true;
      script.addEventListener("load", renderDiagrams, { once: true });
      document.head.append(script);
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

  // ---- live page: send feedback + live reload as steps fill ----
  if (live) {
    const typing = () => (!!document.activeElement && document.activeElement.tagName === "TEXTAREA") || !!editing;
    // A restart may remove Send without changing code.
    // lib/review-poll.js: disable stale Send at once; reload unless a note
    // is being typed (inline editor or Overall notes), so a note in progress
    // is neither discarded nor loses focus. The controls are updated in
    // place: a full render would rebuild the textarea being typed in.
    const serverChanged = (next) => {
      const mode = skelModeDecision(data, next, typing() || !!openEditor);
      if (!mode.changed) return false;
      if (mode.reload) { location.reload(); return true; }
      if (!modeChanged || nextFeedbackEnabled !== (next.feedbackEnabled === true)) {
        modeChanged = true;
        nextFeedbackEnabled = next.feedbackEnabled === true;
        const sendButton = document.querySelector("[data-feedback-send]");
        if (sendButton) { sendButton.disabled = true; sendButton.textContent = MODE_CHANGED_SEND; }
        // A Send page has no hint under its button yet: add one.
        let hint = document.querySelector("[data-send-hint]");
        if (!hint && sendButton) { hint = h("div", { class: "hint", "data-send-hint": true }); sendButton.after(hint); }
        if (hint) hint.textContent = MODE_CHANGED_HINT;
        updatePill();
      }
      return false;
    };
    const updatePill = () => {
      const pill = document.querySelector('[aria-label="Review delivery mode"]');
      if (pill) pill.textContent = modePill();
    };
    // Baseline = the version this page was BUILT at, so a change between the
    // build and this first poll still reloads.
    const built = { version: data.version, skeletonVersion: data.skeletonVersion };
    let polling = false;
    // The server refused our token: it isn't the server this link was for. A
    // new token can't be worked out from here, so stop asking and keep the page
    // usable: what is on screen, Copy, and every note, until a token arrives
    // (hashchange or another tab; see the top of this file). In place, for the
    // same reason as serverChanged.
    const lockOut = () => {
      lockedOut = true;
      const sendButton = document.querySelector("[data-feedback-send]");
      if (sendButton) {
        const copyButton = h("button", { class: "btn primary", onclick: copy }, "Copy feedback for Claude");
        sendButton.replaceWith(copyButton);
        if (!document.querySelector("[data-send-hint]")) copyButton.after(h("div", { class: "hint", "data-send-hint": true }));
      }
      const hint = document.querySelector("[data-send-hint]");
      if (hint) hint.textContent = LOCKED_HINT;
      updatePill();
      setTopAlert();
      if (!document.getElementById("lock-banner")) {
        let notices = app.querySelector(".notices");
        if (!notices) { notices = h("div", { class: "notices", role: "region", "aria-label": "Notices" }); app.querySelector("header.top")?.after(notices); }
        notices.prepend(lockBanner());
      }
    };
    // #68 P7: polls that get no answer (the server stopped or hangs). Two in
    // a row say so; the next answer clears it.
    let missed = 0;
    const answered = () => { missed = 0; if (outage) { outage = false; setTopAlert(); } };
    // A chain, not an interval: a slow poll never stacks up behind another.
    const poll = async () => {
      try {
        const requestToken = token;
        // A server that hangs counts as one that doesn't answer.
        const res = await fetch("/api/version", { headers: auth(), ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {}) });
        if (res.status !== 401 && !res.ok) throw new Error(`HTTP ${res.status}`);
        answered();
        if (res.status === 401) {
          // A new fragment may have been accepted while this old request was in flight.
          if (token !== requestToken) { setTimeout(poll, 2000); return; }
          if (!tryPendingToken()) { polling = false; lockOut(); return; }
        } else {
          const next = await res.json();
          if (serverChanged(next)) return;
          // lib/review-poll.js: reload on a content change unless a note is
          // being typed; "outdated" only when the skeleton's shape changed.
          const decision = skelPollDecision(built, next, typing() || !!openEditor);
          if (decision.reload) {
            try { sessionStorage.setItem(KEY + ":updated", "1"); } catch {}
            location.reload();
            return;
          }
          if (decision.stale !== staleVersion) { staleVersion = decision.stale; render(); }
        }
      } catch {
        if (++missed >= 2 && !outage) { outage = true; setTopAlert(); }
      }
      setTimeout(poll, 2000);
    };
    const startPolling = () => {
      if (polling) return;
      polling = true;
      poll();
    };
    onToken = () => {
      if (lockedOut) {
        lockedOut = false;
        document.getElementById("lock-banner")?.remove();
        updatePill();
        setTopAlert();
        // A note in progress keeps its textarea; Send comes back on the reload
        // the new server's first answer brings (serverChanged).
        if (!typing() && !openEditor) render();
      }
      startPolling();
    };
    onRefused = () => toast(lockedOut ? "That link has expired too. Ask Claude for the current review link." : "That link has expired. This tab is still connected.");
    startPolling();
  }
})();
