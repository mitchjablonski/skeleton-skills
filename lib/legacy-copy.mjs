// The skill and agent copies `skel install` wrote into a project's .claude/
// before the plugin (and `skel install --legacy` still writes), and how to tell
// one apart from a file the user wrote or changed. Loaded by the CLI only.

import crypto from "node:crypto";
import { LEGACY_COPY_HASHES } from "./legacy-copy-hashes.mjs";

/** Plugin-namespaced names (`/skel:skeleton`, `skel:skeleton-filler`) back to the names a project copy is loaded under. */
const unnamespace = (text) => text.replace(/\bskel:(skeleton(?:-fill(?:er)?)?)\b/g, "$1");

/**
 * The shipped text as a project copy: `${CLAUDE_PLUGIN_ROOT}` (substituted by
 * Claude Code in a plugin) becomes this checkout's path, and the plugin's
 * namespaced names become the unprefixed ones.
 */
export function renderLegacy(text, pkgRootFwd) {
  return unnamespace(text.replaceAll("${CLAUDE_PLUGIN_ROOT}", pkgRootFwd));
}

/** A copy with its checkout path taken out, so copies from any clone compare equal. */
export function normalizeCopy(text) {
  // Either slash: a Windows install may have written `node "C:\\...\\bin\\skel.mjs"`.
  return text.replace(/\r\n/g, "\n").replace(/node "[^"\n]*[\\/]bin[\\/]skel\.mjs"/g, "{{SKEL}}");
}

export const copyHash = (text) => crypto.createHash("sha256").update(normalizeCopy(text)).digest("hex");

/**
 * Is `text` (the file at `rel`, e.g. "skills/skeleton/SKILL.md") exactly a copy
 * some release of skel installed, or this checkout would? `currentSource` is
 * the shipped file now.
 */
export function isLegacyCopy(rel, text, currentSource) {
  const h = copyHash(text);
  if (currentSource !== undefined && h === copyHash(renderLegacy(currentSource, "/x"))) return true;
  return (LEGACY_COPY_HASHES[rel] ?? []).includes(h);
}
