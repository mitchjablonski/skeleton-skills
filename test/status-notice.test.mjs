import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configNoticePath, readConfigNotice, recordConfigNotice } from "../lib/config-notice.mjs";
import { configPath } from "../lib/feedback.mjs";
import { configDecision } from "../lib/config-hook.mjs";

test("status reports blocked reloads even with corrupt state, without a stack trace", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-status-notice-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), "{");
  recordConfigNotice(root, { source: "local_settings", file_path: path.join(root, ".claude/settings.local.json") });
  const bin = fileURLToPath(new URL("../bin/skel.mjs", import.meta.url));
  const run = args => spawnSync(process.execPath, [bin, "status", ...args], { cwd: root, encoding: "utf8" });
  const text = run([]);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /settings change was blocked/);
  assert.match(text.stderr, /state\.json/);
  assert.match(text.stderr, /init --force/);
  assert.doesNotMatch(text.stderr, /TypeError|at ModuleJob/);
  const json = run(["--json"]);
  assert.equal(json.status, 1);
  const report = JSON.parse(json.stdout);
  assert.match(report.error, /state\.json/);
  assert.match(report.configNotice, /historical notice/);
});

test("malformed notices are ignored and notice storage failure cannot permit a reload", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-notice-failure-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), JSON.stringify({ phase: "fill" }));
  const notice = configNoticePath(root);
  fs.mkdirSync(path.dirname(notice), { recursive: true });
  fs.writeFileSync(notice, "{}");
  assert.equal(readConfigNotice(root), null);
  const blockedConfig = path.join(root, "not-a-directory");
  fs.writeFileSync(blockedConfig, "x");
  const entry = fileURLToPath(new URL("../bin/skel-config-hook.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, source: "local_settings" }),
    env: { ...process.env, XDG_CONFIG_HOME: blockedConfig, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "block");
  assert.match(result.stderr, /notice/);
});

test("an approval record protects a skeleton link redirected to a regular file", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-notice-link-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const target = path.join(root, "regular-file");
  fs.writeFileSync(target, "x");
  try { fs.symlinkSync(target, path.join(root, ".skeleton")); }
  catch (err) {
    if (["EPERM", "EACCES"].includes(err.code)) return t.skip("file symlinks require platform privilege");
    throw err;
  }
  const receipt = configPath(root, ".snapshot");
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, "{}");
  assert.equal(configDecision({ cwd: root }, root).decision, "block");
});
