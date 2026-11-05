// What a project's settings file says about skel. Loaded by the CLI, never by
// the PreToolUse hook.

import fs from "node:fs";
import path from "node:path";
import { realish } from "./state.mjs";

/**
 * An absolute real path as a rule spells it (`/home/you/proj`, `/c/proj` on
 * Windows), or a reason it can't be. The rule path is a gitignore pattern:
 * `[ ] * ?` are backslash-escaped so they match literally (`( ) { }` aren't
 * pattern characters and match as they are). A path a rule can't spell (a
 * newline, a literal backslash on POSIX, a Windows path without a drive
 * letter) gets no rule rather than one that guards something else.
 */
export function rulePath(real) {
  if (process.platform === "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(real);
    if (!m) return { path: null, why: "only drive-letter paths can be written as rules on Windows" };
    real = `/${m[1].toLowerCase()}/${m[2].split("\\").join("/")}`;
  }
  real = real.replace(/\/+$/, "");
  if (/[\n\r\\]/.test(real)) return { path: null, why: "the path contains a newline or a backslash, which a rule can't spell" };
  return { path: real.replace(/[[\]*?]/g, (c) => `\\${c}`), why: null };
}

/** The scope-gate hook command from any skel checkout (current or legacy form). */
export const isSkelHook = (cmd) => typeof cmd === "string" && /^node "[^"]*[\\/]bin[\\/](skel-hook\.mjs"|skel\.mjs" hook)$/.test(cmd);

/**
 * How the settings file nearest `root` that has skel's hook treats the rule (at
 * or above it: the settings live at the git root, which may be above the
 * skeleton): { status, where }.
 */
function settingsVerdict(root, rule) {
  const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  let dir = path.resolve(root);
  try { dir = fs.realpathSync.native(dir); } catch {}
  for (;;) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") return { status: "stale", where: dir };
    }
    if (text !== null) {
      let settings;
      try { settings = JSON.parse(text); } catch { return { status: "stale", where: dir }; }
      const groups = settings?.hooks?.PreToolUse;
      if (Array.isArray(groups) && groups.some((m) => Array.isArray(m?.hooks) && m.hooks.some((hk) => isSkelHook(hk?.command)))) {
        const deny = settings.permissions?.deny;
        return { status: Array.isArray(deny) && deny.some((r) => typeof r === "string" && fold(r) === fold(rule)) ? "covered" : "stale", where: dir };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { status: "none", where: null };
    dir = parent;
  }
}

/**
 * What the project's settings file says about `stateDir`: { status, where }.
 *   "none":    no skel hook in it.
 *   "covered": the rule for the state dir is there, or no rule can spell it.
 *   "stale":   a hook without that rule, or settings we can't read.
 * This is what's on disk: it can rule a migration out, but says nothing about
 * what a running session has loaded, or about settings loaded from elsewhere.
 */
export function installStatus(root, stateDir) {
  const { path: p } = rulePath(realish(path.resolve(stateDir)));
  if (!p) return { status: "covered", where: null };
  return settingsVerdict(root, `Edit(/${p}/**)`);
}
