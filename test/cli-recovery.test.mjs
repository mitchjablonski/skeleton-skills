import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-cli-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, CLAUDE_PROJECT_DIR: root, XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config"), LOCALAPPDATA: path.join(root, "localappdata") } };
}

test("ordinary CLI commands diagnose corrupt state without a TypeError stack", t => {
  const { root, env } = fixture(t);
  fs.mkdirSync(path.join(root, ".skeleton"));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), "{");
  for (const args of [["reshape"], ["done"], ["next"], ["finalize"], ["review"], ["approve"], ["start", "1"], ["track", "code.js"], ["serve"]]) {
    const result = spawnSync(process.execPath, [path.join(packageRoot, "bin/skel.mjs"), ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /state\.json/);
    assert.match(result.stderr, /init --force/);
    assert.doesNotMatch(result.stderr, /TypeError|at ModuleJob/);
  }
});

test("a broken gate leaves a human CLI recovery route and asks for phase repair", t => {
  const { root, env } = fixture(t);
  const installation = path.join(root, "installation");
  for (const dir of ["bin", "lib"]) fs.cpSync(path.join(packageRoot, dir), path.join(installation, dir), { recursive: true });
  const bin = path.join(installation, "bin/skel.mjs");
  const run = args => spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: "utf8" });
  assert.equal(run(["init", "recovery"]).status, 0);
  const source = path.join(root, "code.js");
  fs.writeFileSync(source, "// SKEL[1] value\nconst value = 1;\n// /SKEL[1]\n");
  assert.equal(run(["approve"]).status, 0);
  fs.writeFileSync(path.join(installation, "lib/gate.mjs"), "this is a syntax error {\n");
  const hook = input => spawnSync(process.execPath, [path.join(installation, "bin/skel-hook.mjs")], { cwd: root, env, input: JSON.stringify({ cwd: root, ...input }), encoding: "utf8" });
  const ordinary = hook({ tool_name: "Edit", tool_input: { file_path: source, old_string: "1", new_string: "2" } });
  assert.equal(JSON.parse(ordinary.stdout).hookSpecificOutput.permissionDecision, "deny");
  const repair = hook({ tool_name: "Bash", tool_input: { command: "skel reshape" } });
  assert.equal(JSON.parse(repair.stdout).hookSpecificOutput.permissionDecision, "ask");
  const unrelated = hook({ tool_name: "Bash", tool_input: { command: "echo .skeleton/state.json; rm -r src" } });
  assert.equal(JSON.parse(unrelated.stdout).hookSpecificOutput.permissionDecision, "deny", "a state-path mention alone is not a repair fallback");
  const reshaped = run(["reshape"]);
  assert.equal(reshaped.status, 0, reshaped.stderr);
  assert.equal(run(["help"]).status, 0);
  assert.equal(run(["review"]).status, 0);
});
