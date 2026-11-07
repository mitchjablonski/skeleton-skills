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
    const hash = text => crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
    // #55: on WSL's drvfs (/mnt/c) a record written from a case variant or 8.3
    // alias of a path has another key. Mirrors receiptAliases in lib/state.mjs:
    // roots from each store's receipt index where it lists the record, else the
    // record's own head; a root that looks like this path counts only if,
    // resolved now, it hashes to the record's name and is this dir (nonzero
    // BigInt dev/ino).
    let mounts = null, aliasRecords = null;
    const onDrvfs = real => {
      if (process.platform !== "linux") return false;
      if (!mounts) {
        mounts = [];
        try {
          for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
            const [pre, post] = line.split(" - ");
            const point = pre?.split(" ")[4];
            if (!post || !point) continue;
            const [fstype, , opts = ""] = post.split(" ");
            mounts.push({ at: point.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))), drvfs: fstype === "drvfs" || (fstype === "9p" && /(^|[,;])aname=drvfs([,;]|$)/.test(opts)) });
          }
        } catch {}
        mounts.sort((a, b) => b.at.length - a.at.length);
      }
      const m = mounts.find(({ at }) => real === at || real.startsWith(at.endsWith("/") ? at : at + "/"));
      return !!m?.drvfs && real !== m.at;
    };
    const shortNameOf = (short, long) => {
      const m = /^([^~]+)~\d+(\.[^.~]*)?$/.exec(short);
      if (!m) return false;
      const stem = m[1].toUpperCase(), squashed = long.toUpperCase().replace(/[\s.]/g, "");
      const hashed = /^(.{1,2})[0-9A-F]{4}$/.exec(stem);
      return squashed.startsWith(stem) || (!!hashed && squashed.startsWith(hashed[1]));
    };
    const lookalike = (stored, real) => {
      const a = stored.split("/"), b = real.split("/");
      return stored === real || (a.length === b.length && a.every((x, i) => x === b[i] || x.toLowerCase() === b[i].toLowerCase() || shortNameOf(x, b[i]) || shortNameOf(b[i], x)));
    };
    const headRoot = file => {
      let fd;
      try {
        fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(4096);
        const m = /^\{\s*"root"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0)));
        const root = m && JSON.parse(m[1]);
        return typeof root === "string" ? root : null;
      } catch { return null; }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    };
    const aliasPresent = real => {
      if (!onDrvfs(real)) return false;
      if (!aliasRecords) {
        aliasRecords = [];
        for (const store of names) {
          if (!store.listed) continue;
          let index = null;
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(store.dir, "receipt-roots.json"), "utf8"));
            if (parsed?.format === 1 && parsed.records && typeof parsed.records === "object" && !Array.isArray(parsed.records)) index = parsed.records;
          } catch {}
          for (const name of store.listed) {
            if (!/^[0-9a-f]{24}\.snapshot\.json$/.test(name)) continue;
            const key = name.slice(0, 24);
            const listed = index && Object.hasOwn(index, key) && (index[key] === null || typeof index[key] === "string");
            aliasRecords.push({ key, root: listed ? index[key] : headRoot(path.join(store.dir, name)) });
          }
        }
      }
      let here = null;
      for (const r of aliasRecords) {
        if (typeof r.root !== "string" || !path.posix.isAbsolute(r.root) || !lookalike(path.posix.normalize(r.root), real)) continue;
        try {
          const resolved = fs.realpathSync.native(r.root);
          if (hash(resolved) !== r.key) continue;
          here ??= fs.statSync(real, { bigint: true });
          const there = fs.statSync(resolved, { bigint: true });
          if (here.ino !== 0n && there.ino === here.ino && there.dev === here.dev) return true;
        } catch {} // unprovable: not enrollment
      }
      return false;
    };
    const receiptCache = new Map();
    const receipt = root => {
      if (receiptCache.has(root)) return receiptCache.get(root);
      let real = root, resolved = false;
      try { real = fs.realpathSync.native(root); resolved = true; } catch {}
      const file = hash(process.platform === "win32" ? real.toLowerCase() : real) + ".snapshot.json";
      let result = "absent";
      for (const store of names) {
        if (store.listed) { if (store.listed.has(file)) { result = "present"; break; } continue; }
        if (!store.unknown) continue;
        result = "unreadable";
        try { if (fs.lstatSync(path.join(store.dir, file), { throwIfNoEntry: false })) { result = "present"; break; } }
        catch {} // lookup uncertainty is not positive enrollment for a new project
      }
      if (result !== "present" && resolved && aliasPresent(real)) result = "present";
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
