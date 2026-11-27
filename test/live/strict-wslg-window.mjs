import { spawnSync } from "node:child_process";
import os from "node:os";

const TITLE = "Skeleton decision (prototype)";
const XWININFO = "/usr/bin/xwininfo";
const XPROP = "/usr/bin/xprop";
export const WSLG_ENV = Object.freeze({ DISPLAY: ":0", XAUTHORITY: "/dev/null" });

export function parseDecisionWindows(tree) {
  const ids = [];
  for (const [, id, title] of tree.matchAll(/^\s*(0x[0-9a-f]+)\s+"([^"\r\n]*)"/gmi)) {
    if (title.startsWith(TITLE)) ids.push(id);
  }
  return ids;
}

export function matchesWindowClaim(properties, geometry, pid, hostname) {
  const claims = [...properties.matchAll(/^_NET_WM_PID\(CARDINAL\) = ([1-9]\d*)\s*$/gm)];
  const machines = [...properties.matchAll(/^WM_CLIENT_MACHINE\(STRING\) = "([^"\r\n]+)"\s*$/gm)];
  return claims.length === 1 && Number(claims[0][1]) === pid
    && machines.length === 1 && machines[0][1] === hostname
    && /^\s*Map State: IsViewable\s*$/m.test(geometry);
}

// Only the attested launcher calls this, and only with a current seat binding.
// Empty output for a failed connection never counts as proof of absence.
export function bindDecisionWindows(seat, environment) {
  const query = (file, args) => {
    if (seat.recheck() !== "seat-metadata-matched") return null;
    const result = spawnSync(file, args, {
      env: { ...environment, LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 800, maxBuffer: 256 * 1024,
    });
    return result.status === 0 && seat.recheck() === "seat-metadata-matched" ? result.stdout : null;
  };
  const decisionWindows = () => {
    const tree = query(XWININFO, ["-root", "-tree"]);
    return tree && /^\s*Root window id: 0x[0-9a-f]+\b/m.test(tree) ? parseDecisionWindows(tree) : null;
  };
  return Object.freeze({
    decisionWindows,
    find(pid, expected) {
      const ids = decisionWindows();
      if (ids?.length !== 1 || (expected && ids[0] !== expected)) return null;
      const [id] = ids;
      const properties = query(XPROP, ["-id", id, "_NET_WM_PID", "WM_CLIENT_MACHINE"]);
      const geometry = query(XWININFO, ["-id", id]);
      return properties && geometry && matchesWindowClaim(properties, geometry, pid, os.hostname()) ? id : null;
    },
  });
}
