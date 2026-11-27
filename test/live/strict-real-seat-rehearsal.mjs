import fs from "node:fs";
import { bindRealSeat } from "./strict-real-seat-preflight.mjs";

const INVOCATION_REFUSED = "real-desktop-invocation-invalid";
const EVIDENCE_UNAVAILABLE = "seat-rehearsal-evidence-unavailable";
const SEAT_MATCHED = "seat-metadata-matched";
const RESTART_REFUSED = "operator-restart-not-attested";
const ATTESTATIONS = [
  ["Did you personally start this command in a fresh dedicated terminal tab with no other jobs?", "operator-initiation-not-attested"],
  ["Are all other unsandboxed agents and automation for your user stopped on Windows and WSL?", "unsandboxed-agent-not-excluded"],
  ["Are terminal broadcast input and pane synchronization off?", "terminal-broadcast-unconfirmed"],
  ["Are screen capture, recording, sharing and remote viewing off?", "windows-capture-not-excluded"],
  ["Are other tools that read the desktop through Windows UI Automation stopped?", "windows-ui-automation-not-excluded"],
  ["Are clipboard managers, history and cloud clipboard off?", "windows-clipboard-observer-not-excluded"],
  ["Are third-party input methods that record or predict input off?", "ime-not-excluded"],
];

export function bindControlTerminal(input, output, stat = fs.fstatSync) {
  const identity = () => {
    if (!input.isTTY || !output.isTTY) return null;
    try {
      const left = stat(input.fd, { bigint: true });
      const right = stat(output.fd, { bigint: true });
      if (!left.isCharacterDevice() || !right.isCharacterDevice()
          || left.dev !== right.dev || left.ino !== right.ino || left.rdev !== right.rdev) return null;
      return `${left.dev}:${left.ino}:${left.rdev}`;
    } catch {
      return null;
    }
  };
  const initial = identity();
  return () => initial !== null && identity() === initial;
}

// Only a single short, literal answer is accepted. Never echo input or put
// stdin in raw mode. Cooked terminal echo remains under the operator's control.
export function confirmAtTerminal(input, output, prompt, timeout = 120_000) {
  return new Promise((resolve) => {
    if (input.readableEnded || input.destroyed || output.destroyed) {
      resolve(false);
      return;
    }
    const answer = Buffer.alloc(5); // "yes" plus CRLF
    let total = 0;
    const finish = (confirmed) => {
      clearTimeout(timer);
      input.off("data", read);
      input.off("end", refused);
      input.off("close", refused);
      input.off("error", refused);
      output.off("error", refused);
      input.pause();
      resolve(confirmed);
    };
    const refused = () => finish(false);
    const read = (chunk) => {
      if (!Buffer.isBuffer(chunk) || total + chunk.length > answer.length) return refused();
      chunk.copy(answer, total);
      total += chunk.length;
      const end = answer.indexOf(10);
      if (end === -1) return;
      const line = answer.subarray(0, end).toString("latin1");
      finish(end === total - 1 && (line === "yes" || line === "yes\r"));
    };
    const timer = setTimeout(refused, timeout);
    input.once("end", refused);
    input.once("close", refused);
    input.once("error", refused);
    output.once("error", refused);
    input.pause();
    input.on("data", read);
    try {
      output.write(`${prompt} Type yes to continue.\n`);
      input.resume();
    } catch {
      refused();
    }
  });
}

// Keep the terminal and seat checks together so readiness and restart use the
// same evidence captured after the operator confirmed the session conditions.
export async function bindOperatorSeat({ interactive, confirm, bind = bindRealSeat }) {
  try {
    for (const [prompt, refusal] of ATTESTATIONS) {
      if (interactive() !== true) return { code: INVOCATION_REFUSED };
      if (await confirm(prompt) !== true) return { code: refusal };
    }
    if (interactive() !== true) return { code: INVOCATION_REFUSED };
    const binding = bind();
    if (binding.code !== "real-seat-preflight-passed") return { code: binding.code };
    if (interactive() !== true) return { code: INVOCATION_REFUSED };
    let refusal;
    let confirmingRestart = false;
    const sample = () => {
      if (interactive() !== true) return INVOCATION_REFUSED;
      const code = binding.recheck();
      if (interactive() !== true) return INVOCATION_REFUSED;
      return typeof code === "string" && code ? code : EVIDENCE_UNAVAILABLE;
    };
    const recheck = () => {
      if (refusal) return refusal;
      try {
        const code = sample();
        if (code === SEAT_MATCHED) return code;
        refusal = code;
      } catch {
        refusal = EVIDENCE_UNAVAILABLE;
      }
      return refusal;
    };
    async function confirmRestart() {
      if (refusal) return refusal;
      if (confirmingRestart) {
        refusal = RESTART_REFUSED;
        return refusal;
      }
      const ready = recheck();
      if (ready !== SEAT_MATCHED) return ready;
      confirmingRestart = true;
      try {
        const confirmed = await confirm("The seat check passed. Do all of your attestations still hold for this restart?");
        if (confirmed === true) return recheck();
        refusal ??= RESTART_REFUSED;
      } catch {
        refusal ??= EVIDENCE_UNAVAILABLE;
      } finally {
        confirmingRestart = false;
      }
      return refusal;
    }
    return Object.freeze({ code: binding.code, recheck, confirmRestart });
  } catch {
    return { code: EVIDENCE_UNAVAILABLE };
  }
}

export async function rehearseRealSeat(options) {
  try {
    const binding = await bindOperatorSeat(options);
    if (binding.code !== "real-seat-preflight-passed") return binding.code;
    const restart = await binding.confirmRestart();
    return restart === SEAT_MATCHED ? "real-seat-rehearsal-passed" : restart;
  } catch {
    return EVIDENCE_UNAVAILABLE;
  }
}
