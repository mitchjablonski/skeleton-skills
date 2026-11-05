// Bash commands that change a skeleton's phase (or would erase it) without
// passing through the edit gate. Matched loosely: a false "ask" costs a
// click; a miss lets the agent unfence itself. No imports: the hook checks
// this on every Bash call.

/** "approve" | "reshape" | "init" | "finalize" | "migrate" | "clean" | "stash" | null */
export function isPhaseChange(command) {
  if (typeof command !== "string") return null;
  // `git clean -x/-X` deletes the git-ignored .skeleton/, and the gate with it.
  if (/\bgit\b[^|;&]*\bclean\b[^|;&]*\s-\w*[xX]/.test(command)) return "clean";
  // So does `git stash -a/--all` (bundled `-ka`, abbreviated `--al` too).
  // `-u/--include-untracked` leaves ignored files alone, so it doesn't count.
  if (/\bgit\b[^|;&]*\bstash\b[^|;&]*\s(-[A-Za-z]*a[A-Za-z]*|--a(ll?)?)(?![\w-])/.test(command)) return "stash";
  if (!/skel/i.test(command)) return null;
  const m = /\b(approve|reshape|init|finalize|migrate)\b/i.exec(command);
  if (!m) return null;
  // A plain init refuses to replace a skeleton in progress; only --force can.
  if (m[1].toLowerCase() === "init" && !/--force\b/.test(command)) return null;
  // A preview moves nothing.
  if (m[1].toLowerCase() === "migrate" && /--dry-run\b/.test(command)) return null;
  return m[1].toLowerCase();
}

const STATE_MENTION = /(^|[\s/'"=;&|(<>`])\.skeleton(?=[\\/\s'";&|)<>`]|$)([\\/]+diagrams\b)?/gi;

/** Does the command name a .skeleton/ directory (other than diagrams)? */
export function mentionsState(command) {
  if (typeof command !== "string") return false;
  const mentions = [...command.matchAll(STATE_MENTION)];
  return mentions.length > 0 && !mentions.every((m) => m[2]);
}

/**
 * Does the command name a dir where skel's trusted stores live (the
 * approved-skeleton record, rendered versions, serve sessions, install
 * ownership): its state dir, or the old config dir? A default spelling
 * (`~/.local/state/skel`, `$XDG_STATE_HOME/skel`, `%LOCALAPPDATA%\skel`,
 * `~/.config/skel`, `$XDG_CONFIG_HOME/skel`) or `dir`, the resolved dir itself
 * (one or a list), with either slash and, for a Windows drive path, Git Bash's
 * `/c/...` form. A word match like the .skeleton one: a path built in a
 * variable gets past it.
 */
const STORE_MENTION = /(\.config|\.local[\\/]+state|AppData[\\/]+Local|XDG_CONFIG_HOME|XDG_STATE_HOME|LOCALAPPDATA)%?\}?["']?[\\/]+skel(?![\w.-])/i;
export function mentionsStores(command, dir) {
  if (typeof command !== "string") return false;
  if (STORE_MENTION.test(command)) return true;
  const forms = [dir].flat().filter((d) => typeof d === "string" && d).flatMap((d) => {
    const fwd = d.replace(/\\/g, "/").replace(/\/+$/, "");
    const drive = /^([A-Za-z]):\/(.*)$/.exec(fwd);
    return [fwd, ...(drive ? [`/${drive[1]}/${drive[2]}`] : [])];
  });
  const flat = command.replace(/\\+/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  return forms.some((f) => {
    const needle = f.toLowerCase();
    for (let i = flat.indexOf(needle); i !== -1; i = flat.indexOf(needle, i + 1)) {
      if (!/[\w.-]/.test(flat[i + needle.length] ?? "")) return true;
    }
    return false;
  });
}
