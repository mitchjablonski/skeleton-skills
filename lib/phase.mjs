// Bash commands that change a skeleton's phase (or would erase it) without
// passing through the edit gate. Matched loosely: a false "ask" costs a
// click; a miss lets the agent unfence itself. No imports: the hook checks
// this on every Bash call.

/** "approve" | "reshape" | "init" | "finalize" | "clean" | "stash" | null */
export function isPhaseChange(command) {
  if (typeof command !== "string") return null;
  // `git clean -x/-X` deletes the git-ignored .skeleton/, and the gate with it.
  if (/\bgit\b[^|;&]*\bclean\b[^|;&]*\s-\w*[xX]/.test(command)) return "clean";
  // So does `git stash -a/--all` (bundled `-ka`, abbreviated `--al` too).
  // `-u/--include-untracked` leaves ignored files alone, so it doesn't count.
  if (/\bgit\b[^|;&]*\bstash\b[^|;&]*\s(-[A-Za-z]*a[A-Za-z]*|--a(ll?)?)(?![\w-])/.test(command)) return "stash";
  if (!/skel/i.test(command)) return null;
  const m = /\b(approve|reshape|init|finalize)\b/i.exec(command);
  if (!m) return null;
  // A plain init refuses to replace a skeleton in progress; only --force can.
  if (m[1].toLowerCase() === "init" && !/--force\b/.test(command)) return null;
  return m[1].toLowerCase();
}

const STATE_MENTION = /(^|[\s/'"=;&|(<>`])\.skeleton(?=[\\/\s'";&|)<>`]|$)([\\/]+diagrams\b)?/gi;

/** Does the command name a .skeleton/ directory (other than diagrams)? */
export function mentionsState(command) {
  if (typeof command !== "string") return false;
  const mentions = [...command.matchAll(STATE_MENTION)];
  return mentions.length > 0 && !mentions.every((m) => m[2]);
}
