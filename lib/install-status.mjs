// What a project's settings file says about skel. Loaded by the CLI, never by
// the PreToolUse hook.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
 * Our Stop hook (bin/skel-stop.mjs, or `skel.mjs stop-hook`) from
 * any checkout, recognised by its script whatever flags (`--x`) follow; block:
 * one of them is --block or --notify-only. Anything else after it
 * (`&& notify-send done`) makes it the user's.
 */
export const skelStopHook = (cmd) => {
  const m = typeof cmd === "string" && /^node "[^"]*[\\/]bin[\\/](?:skel-stop\.mjs"|skel\.mjs" stop-hook)((?:\s+--\w[\w-]*)*)\s*$/.exec(cmd);
  return m ? { block: m[1].split(/\s+/).includes("--block"), notifyOnly: m[1].split(/\s+/).includes("--notify-only") } : null;
};
/** Exact standalone commands only: a chained command remains the user's. */
export const isSkelConfigHook = (cmd) => typeof cmd === "string" && /^node "[^"]*[\\/]bin[\\/]skel-config-hook\.mjs"$/.test(cmd);

/** Does a parsed settings object hold any of skel's hooks (a `skel install --legacy` or pre-plugin install)? */
export function hasLegacyHooks(settings) {
  const any = (event, test) => {
    const groups = settings?.hooks?.[event];
    return Array.isArray(groups) && groups.some((m) => Array.isArray(m?.hooks) && m.hooks.some((hk) => test(hk?.command)));
  };
  return any("PreToolUse", isSkelHook) || any("Stop", skelStopHook) || any("ConfigChange", isSkelConfigHook);
}

/**
 * The plugin's id in `enabledPlugins`: plugin `skel` from marketplace
 * `skeleton-skills` (.claude-plugin/marketplace.json). One place to change it.
 */
export const PLUGIN_ID = "skel@skeleton-skills";

/** Claude Code's user config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeConfigDir = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude"));

/** Where Claude Code reads managed settings on this platform (best effort; unreadable counts as absent). */
function managedSettingsPath() {
  if (process.platform === "win32") return path.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json");
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A settings file, parsed: { settings } | { missing } | { unreadable }. */
function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch (err) { return err.code === "ENOENT" || err.code === "ENOTDIR" ? { missing: true } : { unreadable: true }; }
  // Settings are a plain JSON object; an array, null or a scalar is malformed, not empty.
  try { const settings = JSON.parse(text); return isPlainObject(settings) ? { settings } : { unreadable: true }; } catch { return { unreadable: true }; }
}

/** This settings object's word on the plugin: true, false, or undefined (silent). */
const pluginWord = (settings) => {
  const v = settings?.enabledPlugins?.[PLUGIN_ID];
  return typeof v === "boolean" ? v : undefined;
};

/**
 * Is skel's plugin enabled for a project whose settings live in `dir`? Merges
 * `enabledPlugins` the way Claude Code ranks the files: managed, then
 * .claude/settings.local.json, then .claude/settings.json, then the user's
 * settings.json. Returns { enabled, scope } where scope names the file that
 * decided ("managed" | "local" | "project" | "user" | null), and `user: true`
 * when the user file enables it (a user-scope install, whatever overrides it).
 * What's on disk only: it says nothing about what a running session loaded.
 */
export function pluginStatus(dir) {
  const files = [
    ["managed", managedSettingsPath()],
    ["local", path.join(dir, ".claude", "settings.local.json")],
    ["project", path.join(dir, ".claude", "settings.json")],
    ["user", path.join(claudeConfigDir(), "settings.json")],
  ];
  let decided = null;
  let user = false;
  for (const [scope, file] of files) {
    const word = pluginWord(readSettings(file).settings);
    if (scope === "user" && word === true) user = true;
    if (word !== undefined && !decided) decided = { enabled: word, scope };
  }
  return { ...(decided ?? { enabled: false, scope: null }), user };
}

/** Does this dir's project or local settings file name skel's plugin at all (true or false)? */
function pluginNamedAt(dir) {
  return ["settings.local.json", "settings.json"].some((f) => pluginWord(readSettings(path.join(dir, ".claude", f)).settings) !== undefined);
}

/**
 * How the settings nearest `root` that load skel treat the rule (at or above
 * it: the settings live at the git root, which may be above the skeleton):
 * { status, where }. skel is loaded there when its .claude/settings.local.json
 * has skel's hook (a legacy install), or when its project or local settings
 * name the plugin and the merged `enabledPlugins` enables it. A user-scope
 * plugin, named by no project file, makes the nearest git root (or `root`)
 * the place to look. Either way the rule must be in that dir's
 * settings.local.json, where `skel install` writes it.
 */
function settingsVerdict(root, rule) {
  const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  let dir = path.resolve(root);
  try { dir = fs.realpathSync.native(dir); } catch {}
  const start = dir;
  const verdictAt = (at, settings) => {
    const deny = settings?.permissions?.deny;
    return { status: Array.isArray(deny) && deny.some((r) => typeof r === "string" && fold(r) === fold(rule)) ? "covered" : "stale", where: at };
  };
  for (;;) {
    const local = readSettings(path.join(dir, ".claude", "settings.local.json"));
    if (local.unreadable) return { status: "stale", where: dir, wiring: "unknown" };
    if (local.settings && hasLegacyHooks({ hooks: { PreToolUse: local.settings.hooks?.PreToolUse } })) return { ...verdictAt(dir, local.settings), wiring: "legacy" };
    if (pluginNamedAt(dir) && pluginStatus(dir).enabled) return { ...verdictAt(dir, local.settings), wiring: "plugin" };
    // `skel install` ran here (its store-dir rule is written) with no hook in
    // these settings: a rules-only install, the plugin elsewhere or not yet.
    const deny = local.settings?.permissions?.deny;
    if (Array.isArray(deny) && deny.some((r) => typeof r === "string" && STORE_SHAPED.test(r))) return { ...verdictAt(dir, local.settings), wiring: pluginStatus(dir).enabled ? "plugin" : "rules" };
    if (pluginNamedAt(dir)) return { status: "none", where: null, wiring: "none" };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No project file names skel. A user-scope (or managed) plugin still loads it.
  const top = gitTop(start) ?? start;
  if (!pluginStatus(top).enabled) return { status: "none", where: null, wiring: "none" };
  return { ...verdictAt(top, readSettings(path.join(top, ".claude", "settings.local.json")).settings), wiring: "plugin" };
}

/** A store-dir deny rule's shape, any dir (as bin/skel.mjs writes it). */
const STORE_SHAPED = /^Edit\(\/\/.*\/skel\/\*\*\)$/;

/** The nearest dir at or above `dir` with a `.git` entry, or null. */
function gitTop(dir) {
  for (;;) {
    if (fs.lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false })) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The main checkout of the linked git worktree `root` is in: { main }, null when
 * it isn't in one (or Claude Code doesn't load from there), or { failed } when
 * git can't say. `.git` being a directory, or absent all the way up, answers
 * without running git; only a `.git` file (a linked worktree or a submodule)
 * needs it. Native Windows loads settings from the directory you start in.
 */
function linkedMain(root) {
  if (process.platform === "win32") return null;
  let dir = path.resolve(root);
  try { dir = fs.realpathSync.native(dir); } catch {}
  for (;;) {
    const dotGit = fs.lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false });
    if (dotGit?.isDirectory()) return null;
    if (dotGit) break;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  try {
    const env = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
    const [gitDir, common] = execFileSync("git", ["-C", dir, "rev-parse", "--git-dir", "--git-common-dir"], { encoding: "utf-8", env, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/).map((p) => path.resolve(dir, p));
    if (!common) return { failed: true };
    if (path.relative(gitDir, common) === "") return null; // a submodule: its settings are found by walking up
    return path.basename(common) === ".git" ? { main: path.dirname(common) } : null; // a bare repo has no settings of its own
  } catch {
    return { failed: true };
  }
}

/**
 * What the settings file Claude Code would load says about `stateDir`:
 * { status, where, why }.
 *   "none":    neither skel's hook (a legacy install) nor its enabled plugin.
 *   "covered": the rule for the state dir is there, or no rule can spell it.
 *   "stale":   skel loaded without that rule, settings we can't read, or a
 *              linked worktree with skel only in its own settings, which aren't
 *              loaded.
 * `wiring` says what loads skel there: "legacy" (its hooks in
 * settings.local.json), "plugin" (enabledPlugins), "rules" (a rules-only
 * install: skel's deny rules but neither) or "none".
 *
 * This is what's WRITTEN (`written`: the rule is on disk where Claude Code
 * would load it). Whether a running session has it in effect is another
 * matter (`effective`: always "unknown" from here): a session started before
 * the rule was written, or one holding settings reloads during a fill, keeps
 * enforcing what it loaded until it restarts. It can rule a migration out, but
 * says nothing about settings loaded from elsewhere.
 */
export function installStatus(root, stateDir) {
  const withWritten = (v) => ({ ...v, written: v.status === "covered", effective: "unknown" });
  const { path: p } = rulePath(realish(path.resolve(stateDir)));
  if (!p) return withWritten({ status: "covered", where: null, wiring: "unknown" });
  const rule = `Edit(/${p}/**)`;
  const here = settingsVerdict(root, rule);
  const linked = linkedMain(root);
  if (!linked) return withWritten(here);
  if (linked.failed) return withWritten({ status: "stale", where: null, wiring: "unknown", why: "git couldn't name this worktree's main checkout, where Claude Code loads its settings" });
  const main = settingsVerdict(linked.main, rule);
  return withWritten(main.status === "none" && here.status !== "none" ? { status: "stale", where: linked.main, wiring: here.wiring } : main);
}

/**
 * Where skel is wired up for `root` and how: { dir, legacy, plugin }. `dir` is
 * the nearest dir at or above `root` whose .claude/settings.local.json has
 * skel's hooks or whose project/local settings name the plugin, else the
 * nearest git root (or `root`). `legacy`: that settings.local.json has skel's
 * hooks. `plugin`: pluginStatus(dir).
 */
export function skelWiring(root) {
  let dir = path.resolve(root);
  try { dir = fs.realpathSync.native(dir); } catch {}
  const start = dir;
  for (;;) {
    const local = readSettings(path.join(dir, ".claude", "settings.local.json")).settings;
    const legacy = hasLegacyHooks(local);
    if (legacy || pluginNamedAt(dir)) return { dir, legacy, plugin: pluginStatus(dir) };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const top = gitTop(start) ?? start;
  return { dir: top, legacy: false, plugin: pluginStatus(top) };
}

/**
 * What to tell the human about how skel's hooks are registered, or null.
 * `from` says who asks: "settings" (a hook run from a settings entry), "plugin"
 * (the plugin's own hook) or "cli". The double-registration notice comes from
 * the settings copy and the CLI only, so a session hears it once.
 */
export function registrationNotice(root, from = "cli") {
  const { dir, legacy, plugin } = skelWiring(root);
  const notes = [];
  if (legacy && plugin.enabled && from !== "plugin") {
    const evidence = pluginEvidence(dir);
    notes.push(evidence.ok
      ? `skel's hooks are registered twice for ${dir}: by the ${PLUGIN_ID} plugin and by an older install in .claude/settings.local.json, so each runs twice. Run \`skel install\` there (outside a fill) to remove the old hooks and skill copies, then restart Claude Code.`
      : `skel's hooks may be registered twice for ${dir}: the ${PLUGIN_ID} plugin is enabled and an older install's hooks are in .claude/settings.local.json. \`skel install\` keeps the old hooks until it can confirm the plugin's own would load, which it can't yet:\n${evidence.problems.map((p) => `  - ${p}`).join("\n")}\nFix those (or disable the plugin and keep the old install), then run \`skel install\` there.`);
  }
  if (plugin.user && from !== "settings") {
    notes.push(`the ${PLUGIN_ID} plugin is enabled in your user settings (${path.join(claudeConfigDir(), "settings.json")}), so its hooks run in every project that doesn't disable it${plugin.enabled ? "" : " (this one does)"}. skel recommends project or local scope: \`claude plugin uninstall ${PLUGIN_ID} --scope user\`, then install it with \`--scope local\` or \`--scope project\` in the projects that use it.`);
  }
  return notes.length ? notes.join("\n") : null;
}

/** The hooks the plugin's hooks/hooks.json must register: event, matcher, entry file under bin/. */
export const PLUGIN_HOOKS = [
  ["PreToolUse", "Write|Edit|MultiEdit|NotebookEdit|Bash", "skel-hook.mjs"],
  ["Stop", undefined, "skel-stop.mjs"],
  ["ConfigChange", "user_settings|project_settings|local_settings", "skel-config-hook.mjs"],
];

/** Problems with a plugin root's manifest and hooks.json, [] when it carries skel's three hooks. */
export function pluginRootProblems(root) {
  const problems = [];
  const json = (rel) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf-8")); } catch (err) { problems.push(`${path.join(root, rel)} ${err.code === "ENOENT" ? "is missing" : "can't be read as JSON"}`); return null; }
  };
  const manifest = json(path.join(".claude-plugin", "plugin.json"));
  if (manifest && manifest.name !== PLUGIN_ID.split("@")[0]) problems.push(`${path.join(root, ".claude-plugin", "plugin.json")} names plugin "${manifest.name}", not "${PLUGIN_ID.split("@")[0]}"`);
  const hooks = json(path.join("hooks", "hooks.json"))?.hooks;
  if (hooks !== undefined || !problems.length) {
    for (const [event, matcher, file] of PLUGIN_HOOKS) {
      const ok = Array.isArray(hooks?.[event]) && hooks[event].some((g) => g?.matcher === matcher && Array.isArray(g?.hooks) && g.hooks.some((h) => h?.type === "command" && h.command === "node" && Array.isArray(h.args) && h.args[0] === `\${CLAUDE_PLUGIN_ROOT}/bin/${file}`));
      if (!ok) problems.push(`hooks/hooks.json in ${root} doesn't register skel's ${event} hook`);
      else if (!fs.existsSync(path.join(root, "bin", file))) problems.push(`${path.join(root, "bin", file)} is missing`);
    }
  }
  return problems;
}

/** The first symlink on the way from `base` down `rel` (base itself may be one), or null. Unreadable counts as a link. */
function linkBetween(base, rel) {
  let p = base;
  for (const seg of rel.split(/[\\/]+/).filter((x) => x && x !== ".")) {
    p = path.join(p, seg);
    try { if (fs.lstatSync(p).isSymbolicLink()) return p; } catch (err) { if (err.code !== "ENOENT") return p; }
  }
  return null;
}

const sameDir = (a, b) => {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  return fold(real(a)) === fold(real(b));
};

/**
 * The plugin copies that would load for a project whose settings live in
 * `dir`: { roots, scope, problems }. The install record for this project (a
 * local/project entry for `dir`, else a user entry; more than one match is
 * ambiguous) names the installed copy. A marketplace added from a local path
 * loads its plugins in place, from the source its marketplace.json declares for
 * skel, so that declared folder is checked too; any mapping that's missing,
 * unreadable, ambiguous or leaves the marketplace is a problem. Every root
 * returned must then pass pluginRootProblems.
 */
function pluginCopies(config, dir, mkt) {
  const problems = [];
  const roots = [];
  const registryFile = path.join(config, "plugins", "installed_plugins.json");
  const registry = readSettings(registryFile);
  if (registry.unreadable) return { roots, scope: null, problems: [`${registryFile} can't be read as JSON`] };
  const entries = registry.settings?.plugins?.[PLUGIN_ID];
  if (entries !== undefined && !Array.isArray(entries)) return { roots, scope: null, problems: [`${registryFile} has an unexpected entry for ${PLUGIN_ID}`] };
  const scoped = (entries ?? []).filter((e) => isPlainObject(e) && (e.scope === "local" || e.scope === "project") && typeof e.projectPath === "string");
  // Installed from a linked git worktree, the record names the worktree, while
  // the enabledPlugins entry lands in the main checkout's settings (`dir`).
  const exact = scoped.filter((e) => sameDir(e.projectPath, dir));
  const mine = exact.length ? exact : scoped.filter((e) => { const l = linkedMain(e.projectPath); return !!l?.main && sameDir(l.main, dir); });
  const users = (entries ?? []).filter((e) => isPlainObject(e) && e.scope === "user");
  const candidates = mine.length ? mine : users;
  if (!candidates.length) return { roots, scope: null, problems: [`no install of ${PLUGIN_ID} for this project is recorded in ${registryFile}`] };
  if (candidates.length > 1) return { roots, scope: null, problems: [`${registryFile} records ${candidates.length} installs of ${PLUGIN_ID} for this project${exact.length ? "" : " (from its linked worktrees)"}, so skel can't tell which loads`] };
  const entry = candidates[0];
  if (typeof entry.installPath !== "string" || !entry.installPath) problems.push(`the install record for ${PLUGIN_ID} has no install path`);
  else roots.push(path.resolve(entry.installPath));
  const knownFile = path.join(config, "plugins", "known_marketplaces.json");
  const known = readSettings(knownFile);
  const src = known.settings?.[mkt]?.source;
  if (known.unreadable) problems.push(`${knownFile} can't be read as JSON`);
  else if (!isPlainObject(src)) problems.push(`marketplace ${mkt} isn't recorded in ${knownFile}`);
  else if (src.source === "directory" && typeof src.path === "string") {
    // In place: the folder the marketplace declares for skel is what loads.
    const marketDir = path.resolve(src.path);
    const manifestFile = path.join(marketDir, ".claude-plugin", "marketplace.json");
    const manifest = readSettings(manifestFile).settings;
    const named = Array.isArray(manifest?.plugins) ? manifest.plugins.filter((pl) => isPlainObject(pl) && pl.name === PLUGIN_ID.split("@")[0]) : [];
    if (!manifest || manifest.name !== mkt) problems.push(`${manifestFile} is missing, unreadable or names another marketplace`);
    else if (named.length !== 1) problems.push(`${manifestFile} lists ${named.length} plugins named ${PLUGIN_ID.split("@")[0]}`);
    else if (typeof named[0].source !== "string") problems.push(`${manifestFile} declares a source for ${PLUGIN_ID.split("@")[0]} that skel can't check`);
    else {
      const declared = path.resolve(marketDir, named[0].source);
      const rel = path.relative(marketDir, declared);
      if (rel.startsWith("..") || path.isAbsolute(rel)) problems.push(`${manifestFile} declares ${PLUGIN_ID.split("@")[0]}'s source outside the marketplace`);
      else if (linkBetween(marketDir, rel)) problems.push(`${PLUGIN_ID.split("@")[0]}'s declared source in ${marketDir} goes through a link (${linkBetween(marketDir, rel)}), which Claude Code won't load`);
      else if (!roots.some((r) => sameDir(r, declared))) roots.unshift(declared);
    }
  } else if (!["github", "git", "url"].includes(src.source)) {
    problems.push(`marketplace ${mkt} has a source type (${String(src.source)}) skel doesn't know how to check`);
  }
  return { roots, scope: entry.scope, problems };
}

/**
 * Positive evidence, from files on disk, that skel's plugin hooks would load
 * for a project whose settings live in `dir`: { ok, root, scope, problems }.
 * Anything that would keep them from loading, or that skel can't read, is a
 * problem: settings that don't parse, the plugin not enabled (an explicit
 * false wins by precedence), managed policy (allowManagedHooksOnly without a
 * managed enable, a blocked marketplace), disableAllHooks, another enabled
 * plugin named skel, no install record for this project, or a plugin root
 * whose manifest or hooks.json doesn't carry skel's three hooks. A clean
 * result still isn't proof that a running session loaded them: that takes a
 * restart (or /reload-plugins) and a look at /hooks.
 */
export function pluginEvidence(dir) {
  const problems = [];
  const config = claudeConfigDir();
  const layers = [
    ["managed", managedSettingsPath()],
    ["local", path.join(dir, ".claude", "settings.local.json")],
    ["project", path.join(dir, ".claude", "settings.json")],
    ["user", path.join(config, "settings.json")],
  ].map(([scope, file]) => {
    const r = readSettings(file);
    if (r.unreadable) problems.push(`${file} can't be read as JSON settings`);
    return { scope, file, settings: r.settings ?? {} };
  });
  const status = pluginStatus(dir);
  if (!status.enabled) problems.push(status.scope ? `${PLUGIN_ID} is disabled by your ${status.scope} settings (enabledPlugins: false)` : `${PLUGIN_ID} isn't enabled for this project (no enabledPlugins entry in its settings or yours)`);
  const managed = layers[0].settings;
  if (managed.allowManagedHooksOnly === true && managed.enabledPlugins?.[PLUGIN_ID] !== true) problems.push("managed policy sets allowManagedHooksOnly, which blocks plugin hooks the policy doesn't enable");
  const mkt = PLUGIN_ID.split("@")[1];
  if (Array.isArray(managed.blockedMarketplaces) && JSON.stringify(managed.blockedMarketplaces).includes(mkt)) problems.push(`managed policy's blockedMarketplaces names ${mkt}`);
  const disableAll = layers.find((l) => typeof l.settings.disableAllHooks === "boolean");
  if (disableAll?.settings.disableAllHooks) problems.push(`disableAllHooks is true in ${disableAll.file}`);
  const others = new Set();
  for (const l of layers) for (const [id, on] of Object.entries(l.settings.enabledPlugins ?? {})) if (on === true && id !== PLUGIN_ID && id.split("@")[0] === PLUGIN_ID.split("@")[0]) others.add(id);
  for (const id of others) if (layers.find((l) => typeof l.settings.enabledPlugins?.[id] === "boolean")?.settings.enabledPlugins[id]) problems.push(`another plugin named skel (${id}) is enabled; only one copy's hooks would run`);
  for (const l of layers) {
    if (l.settings.enabledPlugins !== undefined && !isPlainObject(l.settings.enabledPlugins)) problems.push(`enabledPlugins in ${l.file} isn't an object`);
  }
  let root = null;
  let scope = null;
  if (status.enabled) {
    const resolved = pluginCopies(config, dir, mkt);
    problems.push(...resolved.problems);
    scope = resolved.scope;
    root = resolved.roots[0] ?? null;
    for (const r of resolved.roots) problems.push(...pluginRootProblems(r));
  }
  return { ok: !problems.length, root, scope, problems };
}
