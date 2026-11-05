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
import fs from "node:fs";
import path from "node:path";
import { findRoot, readState, writeFileAtomic } from "./state.mjs";

/**
 * Drift response. Notify (false): the human sees the report and Claude stops
 * as usual. Block (true): Claude is sent back once to revert or propose a
 * reshape, then the same exterior drift only notifies, across prompts and sessions.
 * A clean fill or new approval re-arms it. Unknown client
 * state and broken approval records only notify. `--notify-only` opts out.
 */
export const BLOCK_ON_DRIFT = true;

export function stopMode(args = []) {
  if (args.includes("--block") && args.includes("--notify-only")) throw new Error("--block and --notify-only are mutually exclusive");
  if (args.some(arg => !["--block", "--notify-only"].includes(arg))) throw new Error("unknown Stop hook flag; use --block or --notify-only");
  return !args.includes("--notify-only");
}

// Delivery is advisory. A broken helper or an unexpected async/truthy contract
// must never hide verified drift, reject asynchronously, or authorize a nudge.
function deliveryAction(action, ...args) {
  try {
    if (typeof action !== "function") return false;
    const result = action(...args);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      return false;
    }
    return result === true;
  } catch { return false; }
}

const MAX_REPORT = 4000; // Claude Code caps hook messages at 10,000 characters

/**
 * Whether to look at where the project's records are this turn: once per session,
 * since this hook runs every turn and that look reads settings. The sessions
 * already looked at are kept in .skeleton/: at worst, a forged list silences a
 * reminder. `skel status` always looks.
 */
function firstLookThisSession(root, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return true;
  const file = path.join(root, ".skeleton", "store-notice.json");
  let seen = [];
  try { seen = JSON.parse(fs.readFileSync(file, "utf-8")).seen; } catch {}
  if (!Array.isArray(seen)) seen = [];
  if (seen.includes(sessionId)) return false;
  try { writeFileAtomic(file, JSON.stringify({ seen: [...seen, sessionId].slice(-32) })); } catch {}
  return true;
}

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
    if (root && firstLookThisSession(root, input.session_id)) {
      const { storeNotice } = await import("./store-notice.mjs");
      const stores = await storeNotice(root);
      if (stores) notices.push(`skel: ${stores}`);
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
    let delivery;
    try { delivery = await import("./stop-notice.mjs"); } catch {}
    if (drift.ok) { deliveryAction(delivery?.clearStopNotice, root); return emitNotice(); }
    let report = formatDrift(drift);
    if (report.length > MAX_REPORT) report = `${report.slice(0, MAX_REPORT)}\n… (run \`skel status\` for the rest)`;
    const notice = `skel: ${report}\n(\`skel done\` and \`skel finalize\` refuse until it's resolved.)`;
    const out = { systemMessage: [configNotice, notice].filter(Boolean).join("\n\n") };
    if (block && !drift.reason && input.stop_hook_active === false && deliveryAction(delivery?.claimStopNotice, root, snap, drift.fingerprint)) {
      Object.assign(out, { decision: "block", reason: `${report}\nResolve this drift before you stop: propose the change so the human can agree to \`skel reshape\`, or restore only the reported exterior lines through Edit. The gate may ask the human or deny that Edit; if denied, ask the human to repair it. Never use whole-file git checkout/restore/reset or equivalent: it can discard uncommitted fence fills. Do not run reshape without the human’s agreement.` });
    }
    process.stdout.write(JSON.stringify(out));
  } catch {
    if (configNotice) process.stdout.write(JSON.stringify({ systemMessage: configNotice }));
  }
}
