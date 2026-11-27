import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureStrictManifest } from "../../lib/strict-capture.mjs";
import { createCaptureStore } from "../../lib/strict-capture-store.mjs";
import { createControlConsole } from "../../lib/strict-control-console.mjs";
import { prepareDurableHistory } from "../../lib/strict-directories.mjs";
import { enumerateStrictManifest } from "../../lib/strict-enumeration.mjs";
import { HUMAN_AUTHORITY_POLICY } from "../../lib/strict-human-authority.mjs";
import { createHumanAuthorityStore } from "../../lib/strict-human-authority-store.mjs";
import { deriveHumanCode } from "../../lib/strict-human-command.mjs";
import { Fail } from "./strict-browser-fixture.mjs";
import { FIXTURE_CONTEXT, FIXTURE_PLAN } from "./strict-candidate-inner.mjs";
import { readOperatorApproval } from "./strict-operator-terminal-input.mjs";

const DRIVER = fileURLToPath(new URL("./strict-real-seat-restart.py", import.meta.url));
const REFUSED = Object.freeze({ kind: "rejected", code: "unavailable" });
const SUCCESS = "real-seat-contained-restart-passed";
const INTERACTIVE_SUCCESS = "real-seat-interactive-restart-passed";

function prepareReview(scratch) {
  const candidate = path.join(scratch, "candidate");
  fs.mkdirSync(candidate, { mode: 0o700 });
  for (const [name, body] of [["context.txt", FIXTURE_CONTEXT], ["plan.js", FIXTURE_PLAN]]) {
    fs.writeFileSync(path.join(candidate, name), body, { flag: "wx", mode: 0o600 });
  }
  function observe() {
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const { manifest } = enumerateStrictManifest(fd);
      return captureStrictManifest(fd, manifest);
    } finally {
      fs.closeSync(fd);
    }
  }
  const durable = prepareDurableHistory(path.join(scratch, "history"), { firstEnrollment: true });
  const captureStore = createCaptureStore(durable.captures);
  const capture = captureStore.put(observe());
  const state = Object.freeze({
    protocolVersion: 2, projectId: "binding-fixture", sessionId: "selected", reviewRoundId: "round",
    phase: "skeleton", revision: 0, reviewVersion: capture.shapeVersion, captureVersion: capture.captureVersion,
    approvedVersion: null, approvedCaptureVersion: null,
  });
  const { revision, ...viewState } = state;
  const binding = Object.freeze({ ...viewState, phase: "scaffold", pendingNotes: false });
  const policy = { policyVersion: HUMAN_AUTHORITY_POLICY, roundMismatchCap: 2, sessionMismatchCap: 4,
    commandCap: 20, authorityCap: 10 };
  const key = randomBytes(32);
  try {
    const authority = createHumanAuthorityStore(durable.authority, { state, policy }, {
      captureStore, observeUnderLock: observe, keyBytes: () => key,
    });
    const approve = Object.freeze({ code: deriveHumanCode(state, "approve", key),
      revision, reviewVersion: binding.reviewVersion, captureVersion: binding.captureVersion });
    return { binding, capture, authority, approve };
  } finally {
    key.fill(0);
  }
}

async function waitForExit(exited, ms) {
  let timer;
  try {
    return await Promise.race([exited, new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function runNamespace({ scratch, receipt, terminalPin, review, output, control, client, terminal, confirmAgent }) {
  const { signal, windowCurrent, confirmRestart, confirmRetained } = control;
  const { reviewVersion, captureVersion } = review.binding;
  const clientArgs = client ? [client.path, client.pin, terminal] : [];
  const child = spawn("/usr/bin/python3", ["-I", DRIVER, scratch, process.execPath, receipt,
    terminalPin, reviewVersion, captureVersion, ...clientArgs], { detached: true, env: {}, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1 }));
    child.once("close", (code) => resolve({ code }));
  });
  const stop = () => child.stdin.destroy();
  child.stdin.on("error", stop);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const steps = ["1", "R", "2"];
  let phase = 0;
  let permitted = 0;
  let status;
  try {
    for await (const data of child.stdout) {
      const step = data.toString("latin1");
      if (signal.aborted || !windowCurrent()) throw new Fail("wslg-owned-window-lost");
      if (step === "W" && ++permitted <= 12) {
        child.stdin.write("y");
        continue;
      }
      if (step !== steps[phase] || phase >= steps.length) throw new Fail("contained-restart-protocol-refused");
      phase++;
      if (step === "1") output.write("First contained worker is running from the approved capture.\n");
      if (step === "R") {
        output.write("The first worker stopped. Confirm the retained review before restart.\n");
        await confirmRestart();
      }
      if (step === "2") {
        output.write("A new contained worker is running from the same approved capture.\n");
        await confirmRetained();
      }
      if (client && (step === "1" || step === "2")) {
        output.write(`In a separate WSL tab run: node test/live/strict-real-seat-agent-pane.mjs ${scratch}/agent.sock\n`);
        if (!await confirmAgent("Did the separate agent pane show Local fixture response complete.?", signal))
          throw new Fail("interactive-agent-witness-refused");
      }
      if (signal.aborted || !windowCurrent()) throw new Fail("wslg-owned-window-lost");
      child.stdin.write("y");
    }
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    status = await waitForExit(exited, 25_000);
    if (!status || status.code === 125 || status.code === null)
      throw new Fail("real-seat-cleanup-unproven");
  }
  if (status.code !== 0 || phase !== steps.length) throw new Fail("contained-restart-refused");
}

export function configureContainedRun(workspace, receipt, terminalPin, client = null) {
  if (!/^\/tmp\/skel-wslg-state-[a-z0-9_]{8}$/.test(workspace ?? "")
      || !path.isAbsolute(receipt ?? "") || !/^[0-9a-f]{64}$/.test(terminalPin ?? "")
      || (client && (!path.isAbsolute(client.path ?? "") || !/^[0-9a-f]{64}$/.test(client.pin ?? ""))))
    throw new Fail("contained-runtime-selection-invalid");
  return {
    success: client ? INTERACTIVE_SUCCESS : SUCCESS,
    prepare({ input, output, interactive, confirmAgent }) {
      const entry = fs.lstatSync(workspace);
      if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o7777) !== 0o700
          || fs.realpathSync(workspace) !== workspace || fs.readdirSync(workspace).length !== 0)
        throw new Fail("contained-workspace-untrusted");
      const review = prepareReview(workspace);
      const { authority, binding, capture, approve } = review;
      let terminal;
      if (client) {
        const fd = fs.fstatSync(input.fd, { bigint: true });
        terminal = `${fd.dev}:${fd.ino}:${fd.rdev}`;
      }
      let committed = false;
      return {
        review: { binding, read: () => ({ binding, capture, codes: committed ? {} : { approve } }) },
        async exercise(control) {
          const console = createControlConsole({
            newRequestId: randomUUID,
            authority: {
              state: authority.state,
              verifyAndCommit(request) {
                if (control.signal.aborted || !control.windowCurrent() || committed || request.action !== "approve")
                  return REFUSED;
                const result = authority.verifyAndCommit(request);
                committed = result.kind === "committed" && result.action === "approve" && result.revision === 1
                  && result.reviewVersion === binding.reviewVersion && result.captureVersion === binding.captureVersion;
                return result;
              },
              recapture: () => REFUSED,
              endSession: () => REFUSED,
            },
          });
          output.write("Reveal the approval command on the page. Type it in this terminal, then press Enter.\n");
          const accepted = await readOperatorApproval({
            input, output, interactive, console, signal: control.signal, committed: () => committed,
          });
          if (!accepted) throw new Fail("protected-operator-approval-refused");
          output.write("Approval recorded for the selected capture.\n");
          await runNamespace({ scratch: workspace, receipt, terminalPin, review, output, control,
            client, terminal, confirmAgent });
        },
      };
    },
  };
}
