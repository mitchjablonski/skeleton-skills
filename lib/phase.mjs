// Does a Bash command look like running `skel approve` / `skel reshape`?
// Matched loosely (quoted, in a variable, via xargs, from any directory): a
// false "ask" costs a click; a miss lets the agent approve its own skeleton.
// No imports: the hook checks this on every Bash call.

export function isPhaseChange(command) {
  if (typeof command !== "string" || !/skel/i.test(command)) return null;
  const m = /\b(approve|reshape)\b/i.exec(command);
  return m ? m[1].toLowerCase() : null;
}
