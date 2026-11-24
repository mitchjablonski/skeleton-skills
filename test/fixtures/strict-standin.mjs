// The strict-requested stand-in (C9 probe, #229 tests). This release has no
// way to request strict: lib/strict-status.mjs projectStrictStatus passes
// requested: false, and the design reads it only from the launcher's context
// or a host enrollment registry. The stand-in copies the plugin to `dest` and
// flips that one argument in the copy, so the real CLI, classifier and hooks
// report strict as requested. Never a real strict switch.
import fs from "node:fs";
import path from "node:path";

export const STANDIN_SEAM = "strictStatus({ projectId: root, sessionId: null, requested: false })";
export const PLUGIN_PARTS = [".claude-plugin", "bin", "lib", "skills", "agents", "hooks", "package.json"];

/** Copy `parts` of `repo` into `dest` and flip the seam; throws if the seam isn't there exactly once. */
export function makeRequestedStandin(repo, dest, parts = PLUGIN_PARTS) {
  for (const p of parts) fs.cpSync(path.join(repo, p), path.join(dest, p), { recursive: true });
  const file = path.join(dest, "lib", "strict-status.mjs");
  const src = fs.readFileSync(file, "utf8");
  if (src.split(STANDIN_SEAM).length !== 2) throw new Error("lib/strict-status.mjs no longer has the one requested: false call the stand-in replaces");
  fs.writeFileSync(file, src.replace(STANDIN_SEAM, "strictStatus({ projectId: root, sessionId: null, requested: true /* stand-in for the launcher's requested */ })"));
  return dest;
}
