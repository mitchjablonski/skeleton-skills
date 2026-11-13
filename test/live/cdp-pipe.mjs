// Minimal zero-dependency Chrome DevTools Protocol client over
// --remote-debugging-pipe (fd 3 = to Chrome, fd 4 = from Chrome, NUL-framed
// JSON). For opt-in live probes only; not part of `npm test`.
//
// The pipe is private to this process: nothing else on the host can attach,
// unlike --remote-debugging-port. That matters for #79, whose browser rows
// must not themselves open a debugging port another process could use.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function launchChrome(chrome, { extraArgs = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "skel-cdp-"));
  const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-pipe", ...extraArgs, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const out = proc.stdio[3], inp = proc.stdio[4];
  let id = 0, buf = Buffer.alloc(0);
  const pending = new Map(), listeners = new Set();
  inp.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
      buf = buf.subarray(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    pending.set(msg.id, { resolve, reject });
    out.write(JSON.stringify(msg) + "\0");
  });
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const waitFor = (pred, ms = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error("timeout waiting for CDP event")); }, ms);
    const off = on((m) => { if (pred(m)) { clearTimeout(t); off(); resolve(m); } });
  });

  /** Open a page target; returns helpers bound to its session. */
  async function newPage() {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (method, params) => send(method, params, sessionId);
    await s("Page.enable"); await s("Runtime.enable"); await s("Log.enable");
    const csp = [];
    on((m) => {
      if (m.sessionId !== sessionId) return;
      const text = m.params?.entry?.text ?? m.params?.args?.map((a) => a.value).join(" ") ?? "";
      if (/Content.Security.Policy|Trusted Type/i.test(text)) csp.push(text);
    });
    const loaded = () => waitFor((m) => m.sessionId === sessionId && m.method === "Page.loadEventFired");
    return {
      targetId, sessionId, send: s, csp,
      async goto(url) { const l = loaded(); await s("Page.navigate", { url }); await l; },
      async reload() { const l = loaded(); await s("Page.reload", { ignoreCache: true }); await l; },
      async eval(expression) {
        const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      },
      async waitUntil(expression, ms = 10000) {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await this.eval(expression).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 100)); }
        return false;
      },
      close: () => send("Target.closeTarget", { targetId }),
    };
  }

  async function close() {
    try { await send("Browser.close"); } catch {}
    await new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once("exit", r); setTimeout(() => { proc.kill("SIGKILL"); r(); }, 5000); } });
    for (let i = 0; i < 20; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
  const { product } = await send("Browser.getVersion");
  return { send, on, waitFor, newPage, close, product, profile };
}
