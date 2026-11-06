// skel as a Claude Code plugin (#40): the manifest, hooks.json, the served
// skills and agent, the slimmed `skel install` and its migration of a legacy
// install, and install-status detecting a plugin-enabled project.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "bin", "skel.mjs");

// Keep every run out of the real Claude Code config and skel stores.
const HOMES = fs.mkdtempSync(path.join(os.tmpdir(), "skel-plugin-homes-"));
test.after(() => fs.rmSync(HOMES, { recursive: true, force: true, maxRetries: 5 }));
Object.assign(process.env, {
  XDG_CONFIG_HOME: path.join(HOMES, "config"),
  XDG_STATE_HOME: path.join(HOMES, "state"),
  LOCALAPPDATA: path.join(HOMES, "localappdata"),
  CLAUDE_CONFIG_DIR: path.join(HOMES, "claude"),
});

const { PLUGIN_HOOKS, PLUGIN_ID, installStatus, pluginEvidence, pluginRootProblems, pluginStatus, registrationNotice } = await import("../lib/install-status.mjs");
const { LEGACY_COPY_HASHES } = await import("../lib/legacy-copy-hashes.mjs");
const { copyHash, renderLegacy } = await import("../lib/legacy-copy.mjs");
const { projectStopMode } = await import("../lib/stop.mjs");
const { skelStateDir, storePath } = await import("../lib/state.mjs");

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));

/** A project dir (a git repo, so launch warnings stay quiet) and its own Claude config dir. */
function project(t, name = "proj") {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skel-plugin-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root], { stdio: "ignore", timeout: 30_000 });
  const claude = path.join(base, "claude");
  fs.mkdirSync(claude);
  const env = {
    ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CONFIG_DIR: claude,
    XDG_CONFIG_HOME: path.join(base, "config"), XDG_STATE_HOME: path.join(base, "state"), LOCALAPPDATA: path.join(base, "localappdata"),
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  const skel = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  const ok = (...args) => { const r = skel(...args); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
  const settingsFile = path.join(root, ".claude", "settings.local.json");
  const settings = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const writeSettings = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); };
  const merge = (obj) => writeSettings(settingsFile, { ...(fs.existsSync(settingsFile) ? settings() : {}), ...obj });
  /** Make the plugin look installed and enabled at local scope, from this checkout. */
  const enablePlugin = ({ registry = true } = {}) => {
    merge({ enabledPlugins: { [PLUGIN_ID]: true } });
    if (registry) writeSettings(path.join(claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { [PLUGIN_ID]: [{ scope: "local", projectPath: root, installPath: REPO, version: "0.2.0" }] } });
  };
  const withEnv = (fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try { return fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  };
  return { base, root, claude, env, skel, ok, settingsFile, settings, writeSettings, merge, enablePlugin, withEnv };
}

const hookCommands = (settings, event) => (settings.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));

// ---- the package ----

test("plugin manifest and marketplace name skel@skeleton-skills, with a pinned version", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  const market = readJson(".claude-plugin/marketplace.json");
  assert.equal(manifest.name, "skel");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(`${market.plugins[0].name}@${market.name}`, PLUGIN_ID);
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].source, "./", "the repo root is the plugin root: lib/ must be inside it");
});

test("hooks.json registers the three hooks in exec form, with install's matchers, at files that exist", () => {
  const { hooks } = readJson("hooks/hooks.json");
  assert.deepEqual(Object.keys(hooks).sort(), ["ConfigChange", "PreToolUse", "Stop"]);
  for (const [event, matcher, file] of PLUGIN_HOOKS) {
    assert.equal(hooks[event].length, 1);
    assert.equal(hooks[event][0].matcher, matcher);
    const [h] = hooks[event][0].hooks;
    assert.deepEqual(h, { type: "command", command: "node", args: [`\${CLAUDE_PLUGIN_ROOT}/bin/${file}`] });
    assert.ok(fs.existsSync(path.join(REPO, "bin", file)));
  }
  assert.deepEqual(pluginRootProblems(REPO), []);
  // The legacy install writes the same matchers.
  const src = fs.readFileSync(BIN, "utf8");
  assert.match(src, /const matcher = "Write\|Edit\|MultiEdit\|NotebookEdit\|Bash"/);
  assert.match(src, /matcher: "user_settings\|project_settings\|local_settings"/);
});

test("bin/skel is an executable sh wrapper committed with LF", (t) => {
  const text = fs.readFileSync(path.join(REPO, "bin", "skel"), "utf8");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.ok(!text.includes("\r"));
  let mode;
  // A worktree made by WSL git isn't readable by Windows git (and an npm copy isn't a checkout).
  try { mode = execFileSync("git", ["-C", REPO, "ls-files", "-s", "bin/skel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }); }
  catch { return t.skip("git can't read this checkout"); }
  assert.match(mode, /^100755 /);
});

test("skills and agent resolve under the plugin's names: no {{SKEL}}, the namespaced filler, plugin-supported agent fields", () => {
  for (const name of ["skeleton", "skeleton-fill"]) {
    const text = fs.readFileSync(path.join(REPO, "skills", name, "SKILL.md"), "utf8");
    assert.ok(!text.includes("{{SKEL}}"));
    assert.match(text, new RegExp(`^name: ${name}$`, "m"));
    assert.ok(text.includes('CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/skel.mjs"`'));
    assert.doesNotMatch(text.replace(/\/skel:skeleton(-fill)?\b/g, ""), /(^|[\s`(])\/skeleton(-fill)?\b/, "slash commands are namespaced");
  }
  const fill = fs.readFileSync(path.join(REPO, "skills", "skeleton-fill", "SKILL.md"), "utf8");
  assert.ok(fill.includes('subagent_type: "skel:skeleton-filler"'));
  assert.doesNotMatch(fill, /subagent_type: "skeleton-filler"/);
  const agent = fs.readFileSync(path.join(REPO, "agents", "skeleton-filler.md"), "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(agent)[1];
  const fields = front.split("\n").map((l) => l.split(":")[0]);
  assert.deepEqual(fields, ["name", "description", "tools", "disallowedTools", "model"], "plugin agents ignore permissionMode, hooks, mcpServers, initialPrompt");
  assert.match(front, /^tools: Read, Grep, Glob, Edit, MultiEdit$/m);
  assert.match(front, /^disallowedTools: Bash, PowerShell, Monitor, Write, NotebookEdit, Agent$/m);
});

test("the legacy copy list includes what this checkout would install, so a later migration can recognize it", () => {
  for (const rel of ["skills/skeleton/SKILL.md", "skills/skeleton-fill/SKILL.md", "agents/skeleton-filler.md"]) {
    const h = copyHash(renderLegacy(fs.readFileSync(path.join(REPO, rel), "utf8"), "/any/clone"));
    assert.ok(LEGACY_COPY_HASHES[rel].includes(h), `${rel}: regenerate lib/legacy-copy-hashes.mjs (node scripts/dev/legacy-copy-hashes.mjs)`);
  }
  const legacy = renderLegacy(fs.readFileSync(path.join(REPO, "skills", "skeleton-fill", "SKILL.md"), "utf8"), "/c/clone");
  assert.ok(legacy.includes('CLI: `node "/c/clone/bin/skel.mjs"`'));
  assert.ok(legacy.includes('subagent_type: "skeleton-filler"'));
  assert.ok(!legacy.includes("skel:skeleton"));
});

// ---- hooks run from ${CLAUDE_PLUGIN_ROOT} ----

test("each hooks.json entry runs, shell-free, from a plugin root whose path has spaces", (t) => {
  const p = project(t);
  const pluginRoot = path.join(p.base, "plugin cache", "skel's 0.2.0");
  for (const d of ["bin", "lib", "hooks", ".claude-plugin"]) fs.cpSync(path.join(REPO, d), path.join(pluginRoot, d), { recursive: true });
  assert.deepEqual(pluginRootProblems(pluginRoot), []);
  const { hooks } = readJson("hooks/hooks.json");
  const runEntry = (event, input) => {
    const [h] = hooks[event][0].hooks;
    const sub = (s) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
    // As Claude Code's exec form does: no shell, placeholders substituted as plain strings.
    const command = h.command === "node" ? process.execPath : h.command;
    return spawnSync(command, h.args.map(sub), { cwd: p.root, input: JSON.stringify({ cwd: p.root, ...input }), env: { ...p.env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: "utf8", timeout: 60_000, shell: false });
  };
  p.ok("init", "plugin hooks");
  const fileOut = path.join(p.root, "a.js");
  fs.writeFileSync(fileOut, "// outside\n// SKEL[1] v\nconst v = 1;\n// /SKEL[1]\n");
  const pre = runEntry("PreToolUse", { tool_name: "Bash", tool_input: { command: "skel approve" } });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision, "ask", "a phase change asks the human");
  p.ok("approve");
  p.ok("next");
  const edit = runEntry("PreToolUse", { tool_name: "Edit", tool_input: { file_path: fileOut, old_string: "// outside", new_string: "// moved" } });
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(JSON.parse(edit.stdout).hookSpecificOutput.permissionDecision, /^(ask|deny)$/, "an out-of-fence edit is gated");
  const cfg = runEntry("ConfigChange", { source: "local_settings", file_path: p.settingsFile });
  assert.equal(JSON.parse(cfg.stdout).decision, "block", "settings reloads are held during a fill");
  fs.writeFileSync(fileOut, "// drift\n// SKEL[1] v\nconst v = 1;\n// /SKEL[1]\n");
  const stop = runEntry("Stop", { stop_hook_active: false, session_id: "s1" });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(JSON.parse(stop.stdout).decision, "block", "the default mode sends Claude back once");
});

// ---- install and migration ----

test("plugin install on a fresh project writes only the deny rules and ownership record, and a re-run is byte-identical", (t) => {
  const p = project(t);
  const out = p.ok("install");
  const s = p.settings();
  assert.equal(s.hooks, undefined, "no hooks in settings: the plugin brings them");
  assert.ok(s.permissions.deny.length >= 6);
  assert.equal(fs.existsSync(path.join(p.root, ".claude", "skills")), false);
  assert.equal(fs.existsSync(path.join(p.root, ".claude", "agents")), false);
  assert.match(out, /plugin isn't enabled for this project/);
  assert.match(out, new RegExp(`claude plugin install ${PLUGIN_ID.replace(/[.@]/g, "\\$&")} --scope local`));
  assert.match(out, /use this checkout: node ".*skel\.mjs"/);
  const owned = JSON.parse(fs.readFileSync(p.withEnv(() => storePath(p.root, "-install")), "utf8"));
  assert.deepEqual([...owned.ownedDeny].sort(), [...s.permissions.deny].sort());
  const before = fs.readFileSync(p.settingsFile);
  const gi = fs.readFileSync(path.join(p.root, ".gitignore"));
  const mtime = fs.statSync(p.settingsFile).mtimeMs;
  p.ok("install");
  assert.ok(fs.readFileSync(p.settingsFile).equals(before));
  assert.ok(fs.readFileSync(path.join(p.root, ".gitignore")).equals(gi));
  assert.equal(fs.statSync(p.settingsFile).mtimeMs, mtime, "an unchanged file isn't rewritten");
  // Rules-only: install-status sees the rule as written, with no hook anywhere.
  const st = p.withEnv(() => installStatus(p.root, skelStateDir()));
  assert.deepEqual([st.status, st.wiring, st.written, st.effective], ["covered", "rules", true, "unknown"]);
  p.ok("uninstall");
  assert.deepEqual(p.settings(), {});
  assert.equal(fs.existsSync(p.withEnv(() => storePath(p.root, "-install"))), false);
});

test("legacy → plugin: removes skel's hooks and exact copies, keeps user hooks and customized copies, carries notify-only; re-run changes nothing", (t) => {
  const p = project(t);
  p.ok("install", "--legacy");
  const s = p.settings();
  const user = { type: "command", command: 'node "/user/own.mjs"', timeout: 7 };
  s.hooks.PreToolUse[0].hooks.push(user);
  s.hooks.PreToolUse[0].description = "shared";
  s.hooks.Stop[0].hooks[0].command += " --notify-only";
  s.hooks.Stop.push({ hooks: [{ type: "command", command: 'node "/old/clone/bin/skel-stop.mjs" --notify-only && echo mine' }] });
  s.hooks.ConfigChange.push({ matcher: "skills", hooks: [{ type: "command", command: "echo user-config" }] });
  // An older clone's hook, and a copy installed from another clone (same text, other path).
  s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: 'node "/old/clone/bin/skel.mjs" hook' }] });
  fs.writeFileSync(p.settingsFile, JSON.stringify(s, null, 2));
  const skillFile = path.join(p.root, ".claude", "skills", "skeleton", "SKILL.md");
  fs.writeFileSync(skillFile, fs.readFileSync(skillFile, "utf8").replaceAll(BIN.split(path.sep).join("/"), "/elsewhere/clone/bin/skel.mjs"));
  const fillFile = path.join(p.root, ".claude", "skills", "skeleton-fill", "SKILL.md");
  fs.appendFileSync(fillFile, "\nMy own note.\n");
  fs.writeFileSync(path.join(p.root, ".claude", "skills", "skeleton", "notes.md"), "mine");
  // Without the plugin, nothing legacy is touched.
  let out = p.ok("install");
  assert.match(out, /keeping the older install's hooks and skill copies/);
  assert.ok(hookCommands(p.settings(), "PreToolUse").some((c) => /skel-hook\.mjs"$/.test(c)));
  p.enablePlugin();
  out = p.ok("install");
  const after = p.settings();
  assert.deepEqual(hookCommands(after, "PreToolUse"), [user.command]);
  assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [user], description: "shared" }]);
  assert.deepEqual(hookCommands(after, "Stop"), ['node "/old/clone/bin/skel-stop.mjs" --notify-only && echo mine'], "a chained command stays the user's");
  assert.deepEqual(hookCommands(after, "ConfigChange"), ["echo user-config"]);
  assert.equal(after.enabledPlugins[PLUGIN_ID], true);
  assert.equal(fs.existsSync(skillFile), false, "an exact copy from another clone goes");
  assert.equal(fs.existsSync(path.join(p.root, ".claude", "agents", "skeleton-filler.md")), false);
  assert.ok(fs.existsSync(path.join(p.root, ".claude", "skills", "skeleton", "notes.md")), "the user's file in the skill dir stays");
  assert.ok(fs.existsSync(fillFile), "a customized copy stays");
  assert.match(out, new RegExp(`left in place: ${fillFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} isn't a copy skel shipped`));
  assert.match(out, /removed 4 hook\(s\)/);
  assert.match(out, /Stop mode for this project: notify only/);
  assert.match(out, /can't show what a running session loaded[\s\S]*\/hooks/);
  assert.equal(p.withEnv(() => projectStopMode([p.root])), "notify-only");
  const bytes = fs.readFileSync(p.settingsFile);
  out = p.ok("install");
  assert.ok(fs.readFileSync(p.settingsFile).equals(bytes), "re-run is byte-identical");
  assert.doesNotMatch(out, /removed \d+ hook/);
  assert.equal(p.withEnv(() => projectStopMode([p.root])), "notify-only", "the mode survives a re-run");
  p.ok("install", "--block");
  assert.equal(p.withEnv(() => projectStopMode([p.root])), "block");
  out = p.ok("uninstall");
  assert.match(out, /plugin is still enabled/);
  assert.deepEqual(hookCommands(p.settings(), "PreToolUse"), [user.command]);
  assert.equal(p.settings().permissions, undefined);
});

test("migration keeps legacy hooks without positive plugin evidence: no registry, explicit false, malformed settings, a same-name plugin", (t) => {
  const cases = {
    "not installed": (p) => p.enablePlugin({ registry: false }),
    "explicit false wins": (p) => { p.enablePlugin(); p.writeSettings(path.join(p.claude, "settings.json"), { enabledPlugins: { [PLUGIN_ID]: true } }); p.merge({ enabledPlugins: { [PLUGIN_ID]: false } }); },
    "malformed user settings": (p) => { p.enablePlugin(); p.writeSettings(path.join(p.claude, "settings.json"), "{ not json"); },
    "same-name collision": (p) => { p.enablePlugin(); p.merge({ enabledPlugins: { [PLUGIN_ID]: true, "skel@someone-else": true } }); },
    "disableAllHooks": (p) => { p.enablePlugin(); p.writeSettings(path.join(p.root, ".claude", "settings.json"), { disableAllHooks: true }); },
    "broken plugin root": (p) => { p.enablePlugin(); p.writeSettings(path.join(p.claude, "plugins", "installed_plugins.json"), { plugins: { [PLUGIN_ID]: [{ scope: "local", projectPath: p.root, installPath: path.join(p.base, "nowhere") }] } }); },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const p = project(t, name.replace(/\W+/g, "-"));
    p.ok("install", "--legacy");
    setup(p);
    const before = hookCommands(p.settings(), "PreToolUse");
    const out = p.ok("install");
    assert.match(out, /keeping the older install's hooks and skill copies/, name);
    assert.deepEqual(hookCommands(p.settings(), "PreToolUse"), before, name);
    assert.ok(fs.existsSync(path.join(p.root, ".claude", "agents", "skeleton-filler.md")), name);
    assert.equal(p.withEnv(() => pluginEvidence(p.root)).ok, false, name);
  }
});

test("migration never removes protection during a fill, and refuses to pick between conflicting Stop modes", (t) => {
  const p = project(t);
  p.ok("install", "--legacy");
  p.enablePlugin();
  fs.mkdirSync(path.join(p.root, ".skeleton"));
  fs.writeFileSync(path.join(p.root, ".skeleton", "state.json"), JSON.stringify({ title: "x", phase: "fill", activeStep: null }));
  const before = fs.readFileSync(p.settingsFile, "utf8");
  let out = p.ok("install");
  assert.match(out, /not removing the older install's hooks or skill copies: a skeleton fill is active/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.settingsFile, "utf8")).hooks, JSON.parse(before).hooks);
  fs.rmSync(path.join(p.root, ".skeleton"), { recursive: true });
  const s = p.settings();
  s.hooks.Stop.push({ hooks: [{ type: "command", command: 'node "/a/bin/skel-stop.mjs" --block' }, { type: "command", command: 'node "/b/bin/skel-stop.mjs" --notify-only' }] });
  fs.writeFileSync(p.settingsFile, JSON.stringify(s, null, 2));
  out = p.ok("install");
  assert.match(out, /carry both --block and --notify-only/);
  assert.ok(hookCommands(p.settings(), "Stop").length >= 3, "hooks kept");
  assert.equal(fs.existsSync(path.join(p.root, ".claude", "agents", "skeleton-filler.md")), false, "exact copies still go");
  out = p.ok("install", "--notify-only");
  assert.deepEqual(hookCommands(p.settings(), "Stop"), []);
  assert.equal(p.withEnv(() => projectStopMode([p.root])), "notify-only");
});

test("install reports skel hooks in files it doesn't edit, and warns on a user-scope plugin without refusing", (t) => {
  const p = project(t);
  p.writeSettings(path.join(p.claude, "settings.json"), { enabledPlugins: { [PLUGIN_ID]: true }, hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "/x/bin/skel-stop.mjs"' }] }] } });
  p.writeSettings(path.join(p.claude, "plugins", "installed_plugins.json"), { plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: REPO }] } });
  const out = p.ok("install");
  assert.match(out, /settings\.json also has skel's hooks, so with the plugin they run twice/);
  assert.match(out, /enabled in your user settings[\s\S]*--scope local/);
  assert.ok(p.settings().permissions.deny.length, "rules are still written");
  const st = p.withEnv(() => installStatus(p.root, skelStateDir()));
  assert.deepEqual([st.status, st.wiring], ["covered", "plugin"]);
});

// ---- install-status ----

test("install-status detects a plugin-enabled project, so migrate's refusal and the reminders still work", (t) => {
  const p = project(t);
  const st = () => p.withEnv(() => installStatus(p.root, skelStateDir()));
  assert.equal(st().status, "none");
  p.merge({ enabledPlugins: { [PLUGIN_ID]: true } });
  assert.deepEqual([st().status, st().wiring, st().written], ["stale", "plugin", false], "plugin on, rule missing");
  // A skeleton in a subdirectory finds the settings at the root.
  const sub = path.join(p.root, "pkg");
  fs.mkdirSync(sub);
  assert.equal(p.withEnv(() => installStatus(sub, skelStateDir())).status, "stale");
  p.ok("install");
  assert.deepEqual([st().status, st().wiring], ["covered", "plugin"]);
  p.merge({ enabledPlugins: { [PLUGIN_ID]: false } });
  p.writeSettings(path.join(p.root, ".claude", "settings.json"), { enabledPlugins: { [PLUGIN_ID]: true } });
  assert.equal(p.withEnv(() => pluginStatus(p.root)).enabled, false, "local false beats project true");
  assert.equal(p.withEnv(() => pluginStatus(p.root)).scope, "local");
  // migrate refuses while the plugin's project lacks the rule for the new dir.
  const q = project(t, "mig");
  q.merge({ enabledPlugins: { [PLUGIN_ID]: true } });
  const legacyDir = path.join(q.env.XDG_CONFIG_HOME, "skel");
  fs.mkdirSync(legacyDir, { recursive: true });
  const key = q.withEnv(() => path.basename(storePath(q.root)).replace(/\.json$/, ""));
  fs.writeFileSync(path.join(legacyDir, `${key}.json`), JSON.stringify({ sessions: [] }));
  const r = q.skel("migrate");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /not migrating: the settings in .* have no deny rule/);
});

test("double registration is reported by the settings copy and the CLI, not the plugin copy", (t) => {
  const p = project(t);
  p.ok("install", "--legacy");
  p.enablePlugin();
  const note = (from) => p.withEnv(() => registrationNotice(p.root, from));
  assert.match(note("cli"), /registered twice/);
  assert.match(note("settings"), /registered twice/);
  assert.equal(note("plugin"), null);
  p.ok("init", "dup");
  assert.match(p.ok("status"), /registered twice/);
  const legacy = p.ok("install", "--legacy");
  assert.match(legacy, /hooks now run twice/);
});

test("the plugin's Stop hook (no flag) follows the project's recorded mode; a legacy flag still wins", (t) => {
  const p = project(t);
  p.ok("install", "--notify-only");
  p.ok("init", "mode");
  const file = path.join(p.root, "code.js");
  fs.writeFileSync(file, "// outside\n// SKEL[1] v\nconst v = 1;\n// /SKEL[1]\n");
  p.ok("approve");
  fs.writeFileSync(file, "// drift\n// SKEL[1] v\nconst v = 1;\n// /SKEL[1]\n");
  const stop = (args = []) => {
    const r = spawnSync(process.execPath, [path.join(REPO, "bin", "skel-stop.mjs"), ...args], { cwd: p.root, env: { ...p.env, CLAUDE_PLUGIN_ROOT: REPO }, input: JSON.stringify({ cwd: p.root, stop_hook_active: false, session_id: "x" }), encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const quiet = stop();
  assert.ok(quiet.systemMessage);
  assert.equal(quiet.decision, undefined, "notify-only recorded for the project");
  assert.equal(stop(["--block"]).decision, "block", "an explicit legacy flag wins");
});
