import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/skel.mjs", import.meta.url));

test("PreToolUse deduplicates moved and legacy commands while preserving user groups", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-preserve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".claude"));
  const file = path.join(root, ".claude/settings.local.json");
  const old = 'node "/old/clone/bin/skel-hook.mjs"';
  const retainedFields = { timeout: 17, onFailure: "block", if: "permission_mode == default" };
  const legacy = 'node "/legacy/clone/bin/skel.mjs" hook';
  const user = { type: "command", command: "echo user-read-hook", timeout: 7 };
  const chain = { type: "command", command: old + " && echo user" };
  const empty = { matcher: "Read", hooks: [], description: "preexisting empty" };
  const shared = { matcher: "Read", hooks: [user, chain], description: "user metadata" };
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [
    empty,
    { ...shared, hooks: [{ type: "command", command: old, ...retainedFields }, user, chain] },
    { matcher: "Bash", hooks: [{ type: "command", command: legacy }, { type: "command", command: old }] },
  ] } }));
  const run = action => {
    const result = spawnSync(process.execPath, [BIN, action, root], {
      env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state"), LOCALAPPDATA: path.join(root, "localappdata") }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(file, "utf8")).hooks.PreToolUse;
  };
  const installed = run("install");
  assert.deepEqual(installed.slice(0, 2), [empty, shared]);
  assert.equal(installed.length, 3);
  assert.equal(installed[2].matcher, "Write|Edit|MultiEdit|NotebookEdit|Bash");
  assert.equal(installed[2].hooks.length, 1);
  for (const [key, value] of Object.entries(retainedFields)) assert.equal(installed[2].hooks[0][key], value);
  assert.match(installed[2].hooks[0].command, /skel-hook\.mjs"$/);
  assert.doesNotMatch(installed[2].hooks[0].command, /old\/clone|legacy\/clone/);
  assert.deepEqual(run("install"), installed);
  assert.deepEqual(run("uninstall"), [empty, shared]);
  assert.deepEqual(run("uninstall"), [empty, shared]);
});
