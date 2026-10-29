#!/usr/bin/env node
// Lean entry for the PreToolUse hook (see lib/hook.mjs): `skel install` points
// Claude Code here so each tool call doesn't load the whole CLI.
import { runHook } from "../lib/hook.mjs";

await runHook();
