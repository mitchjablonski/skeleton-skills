#!/usr/bin/env node
// STARTUP FALLBACK: intentionally duplicated in the two standalone launchers.
// Keep this stdlib-only block identical (startup-fault.test.mjs checks parity).
// It does not choose an authority store: receipts in either location add protection.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

async function startupFailure(kind, cause) {
  let protectedContext = false;
  let emitted = false;
  let reason = "the enrolled skeleton could not be checked";
  const diagnostic = message => process.stderr.write(`skel ${kind} startup: ${message}\n`);
  const emit = () => {
    emitted = true;
    const text = `skel: hook startup failed; ${reason}. Repair the trusted skel checkout or named state from an external terminal, then retry.`;
    process.stdout.write(JSON.stringify(kind === "PreToolUse"
      ? { hookSpecificOutput: { hookEventName: kind, permissionDecision: "deny", permissionDecisionReason: text } }
      : { decision: "block", reason: text }));
  };
  try {
    diagnostic(cause?.message ?? String(cause));
    let raw = "";
    try { for await (const chunk of process.stdin) raw += chunk; }
    catch (err) { diagnostic(`could not read event: ${err.message}`); }
    let input = {};
    try { input = JSON.parse(raw || "{}"); } catch (err) { diagnostic(`invalid event JSON: ${err.message}`); }
    if (kind === "ConfigChange" && input?.source === "policy_settings") return;
    const session = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const base = typeof input?.cwd === "string" && input.cwd ? path.resolve(input.cwd) : session;
    const home = os.homedir();
    const absolute = value => typeof value === "string" && (process.platform === "win32" ? /^([A-Za-z]:[\\/]|[\\/]{2})/.test(value) : path.isAbsolute(value));
    const legacy = path.resolve(absolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : path.join(home, ".config"), "skel");
    const stateBase = absolute(process.env.XDG_STATE_HOME) ? process.env.XDG_STATE_HOME
      : process.platform === "win32" ? (absolute(process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : path.join(home, "AppData", "Local")) : path.join(home, ".local", "state");
    const stores = [...new Set([legacy, path.resolve(stateBase, "skel")])];
    const names = stores.map(dir => {
      try { return { dir, listed: new Set(fs.readdirSync(dir).map(n => n.toLowerCase())) }; }
      catch (err) { return { dir, unknown: !["ENOENT", "ENOTDIR"].includes(err.code) }; }
    });
    const receiptCache = new Map();
    const receipt = root => {
      if (receiptCache.has(root)) return receiptCache.get(root);
      let real = root;
      try { real = fs.realpathSync.native(root); } catch {}
      if (process.platform === "win32") real = real.toLowerCase();
      const file = crypto.createHash("sha256").update(real).digest("hex").slice(0, 24) + ".snapshot.json";
      let result = "absent";
      for (const store of names) {
        if (store.listed) { if (store.listed.has(file)) { result = "present"; break; } continue; }
        if (!store.unknown) continue;
        result = "unreadable";
        try { if (fs.lstatSync(path.join(store.dir, file), { throwIfNoEntry: false })) { result = "present"; break; } }
        catch {} // lookup uncertainty is not positive enrollment for a new project
      }
      receiptCache.set(root, result);
      return result;
    };
    const leaves = rel => rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || path.isAbsolute(rel);
    const seen = new Map();
    const inspect = start => {
      let nearest = null;
      for (let dir = start; ; dir = path.dirname(dir)) {
        const file = path.join(dir, ".skeleton", "state.json");
        const inScope = dir === start || !leaves(path.relative(session, dir));
        let entry = seen.get(dir);
        if (!entry) {
          try {
            const parent = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
            if (!parent || (!parent.isDirectory() && !parent.isSymbolicLink())) {
              entry = { missing: true, notDir: !!parent };
            } else {
              try { entry = { state: JSON.parse(fs.readFileSync(file, "utf8")) }; }
              catch (error) {
                const existing = error.code === "ENOENT" ? fs.lstatSync(file, { throwIfNoEntry: false }) : true;
                entry = existing ? { error } : { missing: true, stateMissing: true };
              }
            }
          } catch (error) { entry = { error }; }
          seen.set(dir, entry);
        }
        const protect = why => { protectedContext = true; reason = `${why}: ${file}`; };
        if (entry.missing) {
          if ((dir === start || dir === session || entry.notDir || entry.stateMissing) && receipt(dir) === "present") protect("an approval receipt exists but skeleton state is missing");
        } else if (entry.error) {
          if ((inScope && entry.error.code !== "ENOTDIR") || receipt(dir) === "present") protect("skeleton state is unreadable or malformed");
        } else {
          const state = entry.state;
          if (state && typeof state === "object" && !("phase" in state)) {
            if (receipt(dir) === "present") protect("approved skeleton state has no phase");
          } else if (!state || !["scaffold", "fill", "done"].includes(state.phase)) {
            if (inScope || receipt(dir) === "present") protect("skeleton state has an invalid phase");
          } else {
            nearest ??= dir;
            if (state.phase === "fill") protect("a skeleton fill is active");
          }
        }
        if (path.dirname(dir) === dir) break;
      }
      return nearest;
    };
    inspect(session);
    const owner = inspect(base);
    const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
    if (kind === "PreToolUse" && typeof target === "string" && target) {
      const abs = path.resolve(base, target);
      // Match normal ownership: a cwd skeleton owns targets within its root.
      if (!owner || leaves(path.relative(owner, abs))) inspect(path.dirname(abs));
    }
    if (names.some(store => store.unknown)) diagnostic("receipt-store lookup was incomplete; no enrollment is inferred from that alone");
    if (protectedContext) emit();
  } catch (err) {
    diagnostic(`fallback lookup incomplete: ${err.message}`);
    if (protectedContext) emit();
  } finally {
    // No decision: keep the import fault visible as a failed hook (as without the
    // fallback), so a broken checkout isn't silent and onFailure:"block" still applies.
    if (!emitted) process.exitCode = 1;
  }
}
// END STARTUP FALLBACK

let implementation;
try { implementation = await import("../lib/config-hook.mjs"); }
catch (error) { await startupFailure("ConfigChange", error); }
// Keep execution outside the load catch: runtime faults belong to the implementation.
if (implementation) await implementation.runConfigHook();
