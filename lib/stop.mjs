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
import { drvfsMountOf, findRoot, readState, receiptAliases, refreshReceiptIndex, skelStateDir, storePath, writeFileAtomic } from "./state.mjs";

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

/**
 * The project's Stop mode from `skel install --notify-only|--block`, kept in
 * install's ownership record in the state dir (where a deny rule keeps the
 * agent's file tools out): "notify-only", "block", or null for the default.
 * Install's target is the settings dir, at or above the skeleton, so look up
 * from each start. Unreadable means the default.
 */
export function projectStopMode(starts) {
  for (const start of starts) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      let mode;
      try { mode = JSON.parse(fs.readFileSync(storePath(dir, "-install"), "utf-8")).stopMode; } catch {}
      if (mode === "notify-only" || mode === "block") return mode;
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
}

/**
 * Did this hook's command line choose a mode? A legacy settings entry can carry
 * `--block` or `--notify-only`; the plugin's hooks.json passes neither, and
 * then the project's recorded mode applies.
 */
const explicitMode = (argv = process.argv.slice(2)) => argv.some((a) => a === "--block" || a === "--notify-only");

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
function firstLookThisSession(root, sessionId, name = "store-notice.json") {
  if (typeof sessionId !== "string" || !sessionId) return true;
  const file = path.join(root, ".skeleton", name);
  let seen = [];
  try { seen = JSON.parse(fs.readFileSync(file, "utf-8")).seen; } catch {}
  if (!Array.isArray(seen)) seen = [];
  if (seen.includes(sessionId)) return false;
  try { writeFileAtomic(file, JSON.stringify({ seen: [...seen, sessionId].slice(-32) })); } catch {}
  return true;
}

/** Once a session per project, recorded in the state dir (advisory, like the Stop delivery cache). */
function firstAliasNotice(project, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return true;
  const file = path.join(skelStateDir(), "alias-notice.json");
  const id = `${sessionId}:${path.resolve(project)}`;
  let seen = [];
  try { seen = JSON.parse(fs.readFileSync(file, "utf-8")).seen; } catch {}
  if (!Array.isArray(seen)) seen = [];
  if (seen.includes(id)) return false;
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileAtomic(file, JSON.stringify({ seen: [...seen, id].slice(-32) })); } catch {}
  return true;
}

export async function runStopHook({ block = BLOCK_ON_DRIFT, explicit = explicitMode() } = {}) {
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
      refreshReceiptIndex(); // #55: keep the hooks' index of record roots in step
      const { storeNotice } = await import("./store-notice.mjs");
      const stores = await storeNotice(root);
      if (stores) notices.push(`skel: ${stores}`);
    }
    // #55: no skeleton here, but maybe a deleted one: a record whose root looks
    // like the session's project and can't be proven its is for the human to
    // judge. Said once a session; the sessions told are kept in the state dir
    // (the project's .skeleton, where they'd go otherwise, is what's missing).
    // Read only on WSL's /mnt/c, and from the receipt index where it's current.
    const session = process.env.CLAUDE_PROJECT_DIR || base;
    if (!near && process.platform === "linux" && drvfsMountOf(path.resolve(session)) && receiptAliases(session).unverified.length) {
      const { aliasNotice } = await import("./store-notice.mjs");
      const note = aliasNotice(session, { deleted: true });
      if (note && firstAliasNotice(session, input.session_id)) notices.push(`skel: ${note}`);
    }
    // How skel's hooks are registered. With both a settings copy and the plugin
    // copy, the two run in parallel, and each says only its own part (the
    // settings copy: registered twice; the plugin copy: user scope), so each
    // keeps its own once-per-session record: neither can use up the other's.
    const from = process.env.CLAUDE_PLUGIN_ROOT ? "plugin" : "settings";
    if (root && firstLookThisSession(root, input.session_id, `registration-notice-${from}.json`)) {
      try {
        const { registrationNotice } = await import("./install-status.mjs");
        const reg = registrationNotice(root, from);
        if (reg) notices.push(`skel: ${reg}`);
      } catch {}
    }
    configNotice = [...new Set(notices)].join("\n\n") || null;
    const emitNotice = () => { if (configNotice) process.stdout.write(JSON.stringify({ systemMessage: configNotice })); };
    if (!near) return emitNotice();
    const state = readState(root);
    if (state?.phase !== "fill") return emitNotice();
    const { formatDrift, readSnapshot, verifySnapshot } = await import("./snapshot.mjs");
    // No scan or discovery here (it runs every turn): the record's own fenced
    // files stand in for it, and drift in the wider source baseline surfaces at
    // `done` and `finalize`, not here. A record from before the format marker dropped every file's
    // fence bodies, so all its files count as fenced.
    const snap = readSnapshot(root);
    const drift = verifySnapshot(root, state, snap?.format >= 2 ? snap.fenced ?? [] : Object.keys(snap?.files ?? {}));
    let delivery;
    try { delivery = await import("./stop-notice.mjs"); } catch {}
    if (drift.ok) { deliveryAction(delivery?.clearStopNotice, root); return emitNotice(); }
    let report = formatDrift(drift);
    if (report.length > MAX_REPORT) report = `${report.slice(0, MAX_REPORT)}\n… (run \`skel status\` for the rest)`;
    const notice = `skel: ${report}\n(\`skel done\` and \`skel finalize\` refuse until it's resolved.)`;
    const out = { systemMessage: [configNotice, notice].filter(Boolean).join("\n\n") };
    if (!explicit) {
      const mode = projectStopMode([root, process.env.CLAUDE_PROJECT_DIR].filter(Boolean));
      if (mode) block = mode === "block";
    }
    if (block && !drift.reason && input.stop_hook_active === false && deliveryAction(delivery?.claimStopNotice, root, snap, drift.fingerprint)) {
      Object.assign(out, { decision: "block", reason: `${report}\nResolve this drift before you stop: propose the change so the human can agree to \`skel reshape\`, or restore only the reported exterior lines through Edit. The gate may ask the human or deny that Edit; if denied, ask the human to repair it. Never use whole-file git checkout/restore/reset or equivalent: it can discard uncommitted fence fills. Do not run reshape without the human’s agreement.` });
    }
    process.stdout.write(JSON.stringify(out));
  } catch {
    if (configNotice) process.stdout.write(JSON.stringify({ systemMessage: configNotice }));
  }
}
