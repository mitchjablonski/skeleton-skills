import fs from "node:fs";

const WSLG = "/mnt/wslg";
const WSLG_X11 = `${WSLG}/.X11-unix`;
const LOCAL_X11 = "/tmp/.X11-unix";
const NAMESPACES = ["mnt", "net", "pid", "user"];

function sameEntry(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.ctimeNs === second.ctimeNs;
}

function sameSample(first, second) {
  return first.every((value, index) => value === second[index]);
}

function metadata(stat) {
  return [stat.dev, stat.ino, stat.ctimeNs];
}

function seatMounts(mountInfo) {
  const mounts = new Map();
  for (const line of mountInfo.split("\n")) {
    const fields = line.split(" ");
    const [id, , device, root, mountpoint, options] = fields;
    if (mountpoint !== WSLG && mountpoint !== LOCAL_X11) continue;
    const separator = fields.indexOf("-", 6);
    if (mounts.has(mountpoint) || !/^[1-9]\d*$/.test(id) || !/^\d+:\d+$/.test(device)
        || separator < 6 || fields[separator + 1] !== "tmpfs") return null;
    mounts.set(mountpoint, { id, device, root, options: options.split(",") });
  }
  const wslg = mounts.get(WSLG);
  const local = mounts.get(LOCAL_X11);
  if (!wslg || !local || wslg.id === local.id || wslg.device !== local.device
      || wslg.root !== "/" || local.root !== "/.X11-unix"
      || !local.options.includes("ro") || local.options.includes("rw")) return null;
  return [wslg.id, local.id, wslg.device];
}

// A passive, launcher-side observation. It neither opens a desktop socket nor
// identifies a server, window, or human.
function observeSeatMetadata({
  display = () => process.env.DISPLAY,
  mountInfo = () => fs.readFileSync("/proc/self/mountinfo", "utf8"),
  lstat = (path) => fs.lstatSync(path, { bigint: true }),
  readlink = fs.readlinkSync,
} = {}) {
  try {
    if (display() !== ":0") return { code: "seat-display-unsupported" };
    const mounts = seatMounts(mountInfo());
    if (!mounts) return { code: "seat-anchor-mismatch" };
    const mount = lstat(WSLG);
    const anchorDir = lstat(WSLG_X11);
    const aliasDir = lstat(LOCAL_X11);
    if (!mount.isDirectory() || !anchorDir.isDirectory() || !aliasDir.isDirectory()
        || !sameEntry(anchorDir, aliasDir)) {
      return { code: "seat-anchor-mismatch" };
    }
    const anchor = lstat(`${WSLG_X11}/X0`);
    const alias = lstat(`${LOCAL_X11}/X0`);
    if (!anchor.isSocket() || !alias.isSocket() || !sameEntry(anchor, alias)) {
      return { code: "seat-anchor-mismatch" };
    }
    const namespaces = NAMESPACES.map((kind) => readlink(`/proc/self/ns/${kind}`));
    if (!namespaces.every((id, index) => new RegExp(`^${NAMESPACES[index]}:\\[[1-9]\\d*\\]$`).test(id))) {
      return { code: "seat-evidence-unavailable" };
    }
    const sample = [...mounts, ...metadata(mount), ...metadata(anchorDir), ...metadata(anchor), ...namespaces];
    return { code: "seat-metadata-observed", sample };
  } catch {
    return { code: "seat-evidence-unavailable" };
  }
}

// Capture once in the host launcher before starting the browser. Recheck in
// that same launcher before trusting readiness and on every protected restart.
// A failed recheck invalidates this binding for the rest of its lifetime.
export function bindSeatMetadata(sources) {
  const initial = observeSeatMetadata(sources);
  if (!initial.sample) return Object.freeze({ code: initial.code });
  let failure;
  return Object.freeze({
    code: initial.code,
    recheck() {
      if (failure) return failure;
      const current = observeSeatMetadata(sources);
      if (!current.sample) failure = current.code;
      else if (!sameSample(initial.sample, current.sample)) failure = "seat-changed";
      return failure ?? "seat-metadata-matched";
    },
  });
}
