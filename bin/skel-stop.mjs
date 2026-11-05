#!/usr/bin/env node
// One corrective continuation by default; --notify-only opts out.
import { runStopHook, stopMode } from "../lib/stop.mjs";
try { await runStopHook({ block: stopMode(process.argv.slice(2)) }); }
catch (err) { console.error(`skel: ${err.message}`); process.exitCode = 1; }
