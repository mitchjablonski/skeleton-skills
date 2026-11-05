// The Stop hook: at the end of every turn during a fill, check the working
// tree against the approved skeleton. `done` and `finalize` check too, but the
// agent chooses when to run them; this runs whether it does or not, so a
// change made through Bash (sed -i, a script) is reported the turn it happens.
//
// It runs at the end of every turn in every project where it's installed, so
// the common path loads state and historical settings notices; the
// snapshot code loads only during a fill, and it reads only the skeleton's own
// files (no repo search: a file that newly gains fences is left to `done`).
// Fails open: a broken check must never wedge the session.

import { takeConfigNotice } from "./config-notice.mjs";
import { takeLegacyNotice } from "./stores.mjs";
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
  let configNotice = null;
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw || "{}");
    const base = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const near = findRoot(base);
    const root = near ? (await import("./hook.mjs")).outermost(near) : null;
    const noticeRoots = [...new Set([process.env.CLAUDE_PROJECT_DIR || base, near, root].filter(Boolean))];
    const notices = noticeRoots.map(root => takeConfigNotice(root, input.session_id)).filter(Boolean);
    if (root) {
      const legacy = takeLegacyNotice(root, input.session_id);
      if (legacy) notices.push(`skel: ${legacy}`);
    }
    configNotice = [...new Set(notices)].join("\n\n") || null;
    const emitNotice = () => { if (configNotice) process.stdout.write(JSON.stringify({ systemMessage: configNotice })); };
    if (!near) return emitNotice();
    const state = readState(root);
    if (state?.phase !== "fill") return emitNotice();
    const { RECORD_FORMAT, formatDrift, readSnapshot, verifySnapshot } = await import("./snapshot.mjs");
    // No scan here (it runs every turn): the record's own fenced files stand
    // in for it. A record from before the format marker dropped every file's
    // fence bodies, so all its files count as fenced.
    const snap = readSnapshot(root);
    const drift = verifySnapshot(root, state, snap?.format === RECORD_FORMAT ? snap.fenced ?? [] : Object.keys(snap?.files ?? {}));
    if (drift.ok) return emitNotice();
    let report = formatDrift(drift);
    if (report.length > MAX_REPORT) report = `${report.slice(0, MAX_REPORT)}\n… (run \`skel status\` for the rest)`;
    const notice = `skel: ${report}\n(\`skel done\` and \`skel finalize\` refuse until it's resolved.)`;
    const out = { systemMessage: [configNotice, notice].filter(Boolean).join("\n\n") };
    if (block && !input.stop_hook_active) {
      Object.assign(out, { decision: "block", reason: `${report}\nResolve this before you stop: put the lines back, or stop and propose the change so the human can \`skel reshape\`.` });
    }
    process.stdout.write(JSON.stringify(out));
  } catch {
    if (configNotice) process.stdout.write(JSON.stringify({ systemMessage: configNotice }));
  }
}
