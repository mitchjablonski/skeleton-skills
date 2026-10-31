// The Stop hook: at the end of every turn during a fill, check the working
// tree against the approved skeleton. `done` and `finalize` check too, but the
// agent chooses when to run them; this runs whether it does or not, so a
// change made through Bash (sed -i, a script) is reported the turn it happens.
//
// It runs at the end of every turn in every project where it's installed, so
// like the PreToolUse hook the common path loads nothing but state.mjs; the
// snapshot code loads only during a fill, and it reads only the skeleton's own
// files (no repo search: a file that newly gains fences is left to `done`).
// Fails open: a broken check must never wedge the session.

import { findRoot, readState } from "./state.mjs";

/**
 * Drift response. Notify (false): the human sees the report and Claude stops
 * as usual. Block (true): Claude is sent back once to revert or propose a
 * reshape, then it's a notice (`stop_hook_active`, plus Claude Code's cap on
 * consecutive continuations). A maintainer decision (design doc §9 Q3); the
 * hook command's `--block` flag turns it on per project.
 */
export const BLOCK_ON_DRIFT = false;

const MAX_REPORT = 4000; // Claude Code caps hook messages at 10,000 characters

export async function runStopHook({ block = BLOCK_ON_DRIFT } = {}) {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw || "{}");
    const base = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const near = findRoot(base);
    if (!near) return;
    const { outermost } = await import("./hook.mjs");
    const root = outermost(near);
    const state = readState(root);
    if (state?.phase !== "fill") return;
    const { formatDrift, readSnapshot, verifySnapshot } = await import("./snapshot.mjs");
    const drift = verifySnapshot(root, state, Object.keys(readSnapshot(root)?.files ?? {}));
    if (drift.ok) return;
    let report = formatDrift(drift);
    if (report.length > MAX_REPORT) report = `${report.slice(0, MAX_REPORT)}\n… (run \`skel status\` for the rest)`;
    const notice = `skel: ${report}\n(\`skel done\` and \`skel finalize\` refuse until it's resolved.)`;
    const out = { systemMessage: notice };
    if (block && !input.stop_hook_active) {
      Object.assign(out, { decision: "block", reason: `${report}\nResolve this before you stop: put the lines back, or stop and propose the change so the human can \`skel reshape\`.` });
    }
    process.stdout.write(JSON.stringify(out));
  } catch {
    // no opinion
  }
}
