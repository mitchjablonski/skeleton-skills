#!/usr/bin/env node
// Lean entry for the Stop hook (see lib/stop.mjs): `skel install` points
// Claude Code here. `--block` sends Claude back once on drift instead of only
// telling the human.
import { BLOCK_ON_DRIFT, runStopHook } from "../lib/stop.mjs";

await runStopHook({ block: BLOCK_ON_DRIFT || process.argv.includes("--block") });
