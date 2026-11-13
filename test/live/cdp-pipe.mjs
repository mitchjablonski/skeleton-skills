// Minimal zero-dependency Chrome DevTools Protocol client over
// --remote-debugging-pipe (fd 3 = to Chrome, fd 4 = from Chrome, NUL-framed
// JSON). For opt-in live probes only; not part of `npm test`.
//
// The pipe opens no network-reachable debugging endpoint (unlike
// --remote-debugging-port), so web pages and other users can't attach.
// Same-user processes with ptrace rights could still take the descriptors;
// they are out of scope for these fixture probes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SEND_TIMEOUT_MS = 30000;

function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { /* Chrome helpers may still be exiting */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return !fs.existsSync(dir);
}

/**
 * Launch Chrome with a fresh private profile. `sandbox: false` adds
 * --no-sandbox (needed where user namespaces are unavailable); callers record
 * it in their evidence. The profile is removed on close or launch failure.
 */
export async function launchChrome(chrome, { sandbox = true, extraArgs = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "skel-cdp-"));
  let proc;
  try {
    proc = spawn(chrome, ["--headless=new", ...(sandbox ? [] : ["--no-sandbox"]), "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", `--user-data-dir=${profile}`,
      "--remote-debugging-pipe", ...extraArgs, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  } catch (e) { removeDir(profile); throw e; }
  const out = proc.stdio[3], inp = proc.stdio[4];
  let id = 0, buf = Buffer.alloc(0), dead = null;
  const pending = new Map(), listeners = new Set();
  const failAll = (err) => { dead = err; for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(err); } pending.clear(); };
  proc.on("error", (e) => failAll(new Error(`chrome failed: ${e.message}`)));
  proc.on("exit", (code, sig) => failAll(new Error(`chrome exited (${code ?? sig})`)));
  inp.on("error", () => {}); out.on("error", () => {});
  inp.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      let msg;
      try { msg = JSON.parse(buf.subarray(0, i).toString("utf8")); } catch { msg = null; }
      buf = buf.subarray(i + 1);
      if (!msg) continue;
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id); pending.delete(msg.id); clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    const timer = setTimeout(() => { pending.delete(msg.id); reject(new Error(`CDP ${method} timed out`)); }, SEND_TIMEOUT_MS);
    pending.set(msg.id, { resolve, reject, timer });
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
    await s("Page.enable"); await s("Runtime.enable"); await s("Log.enable"); await s("Network.enable");
    const csp = [], documents = [];
    const offs = [on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Network.responseReceived" && m.params.type === "Document")
        documents.push({ url: m.params.response.url, status: m.params.response.status, headers: m.params.response.headers });
      const text = m.params?.entry?.text ?? m.params?.args?.map((a) => a.value).join(" ") ?? "";
      if (/Content.Security.Policy|Trusted Type/i.test(text)) csp.push(text);
    })];
    const loaded = () => waitFor((m) => m.sessionId === sessionId && m.method === "Page.loadEventFired");
    return {
      targetId, sessionId, send: s, csp, documents,
      async goto(url) { const l = loaded(); await s("Page.navigate", { url }); await l; },
      async reload() { const l = loaded(); await s("Page.reload", { ignoreCache: true }); await l; },
      async eval(expression) {
        const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async waitUntil(expression, ms = 10000) {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await this.eval(expression).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 100)); }
        return false;
      },
      async close() { for (const off of offs) off(); try { await send("Target.closeTarget", { targetId }); } catch {} },
    };
  }

  async function close() {
    if (!dead) { try { await send("Browser.close"); } catch {} }
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise((r) => {
        const t = setTimeout(() => { proc.kill("SIGKILL"); r(); }, 5000);
        proc.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    if (!removeDir(profile)) console.error(`warning: could not remove ${profile}`);
  }

  try {
    const { product } = await send("Browser.getVersion");
    return { send, on, waitFor, newPage, close, product, profile, sandbox };
  } catch (e) { await close(); throw e; }
}
