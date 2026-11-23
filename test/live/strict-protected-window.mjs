import fs from "node:fs";
import path from "node:path";
import { createFixture, Fail, live, sha256File, sleep, stat } from "./strict-browser-fixture.mjs";
import { displayToolsAvailable, findMappedBrowserWindow, PrivateDisplayError, startPrivateDisplay,
  waitForPrivateDisplay } from "./strict-private-display.mjs";

function ownedChild(child) {
  const status = child.pid && stat(child.pid);
  return live(status) && status.ppid === process.pid && child.exitCode === null && child.signalCode === null;
}

function stopChild(child, signal) {
  return Boolean(ownedChild(child) && child.kill(signal));
}

// The outer subreaper owns scratch and reaps both children and their descendants.
export async function startProtectedWindow({ scratch, chromePin, navigation, onLoss }) {
  if (!/^[0-9a-f]{64}$/i.test(chromePin ?? "")) throw new Fail("browser-pin-required", true);
  const fixture = createFixture({ prefix: "strict-protected-window-" });
  const { state, failures } = fixture;
  const { binary } = fixture.pinBrowser(chromePin.toLowerCase());
  if (!displayToolsAvailable()) throw new Fail("private-display-tools-unavailable", true, "display-unavailable");
  state.scratch = scratch;

  let display;
  try {
    display = startPrivateDisplay(scratch, { beforeSpawn(number) {
      fs.writeFileSync(path.join(scratch, "display-slot"), `${number}\n`, { flag: "wx", mode: 0o600 });
    } });
    state.display = display;
    await waitForPrivateDisplay(display);
  } catch (error) {
    if (error instanceof PrivateDisplayError) throw new Fail(error.message, true, "display-unavailable");
    throw new Fail("private-display-start-failed");
  }

  const browser = fixture.launch("browser-data", ["--new-window", navigation.url], { display });
  let ready = false;
  const lost = () => {
    if (!ready) return;
    ready = false;
    onLoss();
  };
  browser.exited.then(lost);
  display.server.once("exit", lost);

  const sampled = await fixture.sampleRun(browser, { window: 4000 });
  const assessed = fixture.assessPrimary(browser, sampled);
  if (assessed.unavailable) throw new Fail("browser-sandbox-unavailable", true, "browser-sandbox-unavailable");
  if (!assessed.ranClean || failures.length || !sampled.privateDisplayMatched)
    throw new Fail("protected-browser-verification-failed");

  let selected = false;
  let window;
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline && ownedChild(browser.proc) && ownedChild(display.server)) {
    selected ||= navigation.takeView();
    window = findMappedBrowserWindow(display, browser.pid);
    if (window && selected) break;
    await sleep(50);
  }
  if (!window) throw new Fail("protected-window-not-mapped");
  if (!selected) throw new Fail("protected-window-view-missing");
  if (navigation.takeView()) throw new Fail("protected-window-view-reusable");
  const executable = `/proc/${browser.pid}/exe`;
  const pinnedExecutable = fs.statSync(executable, { bigint: true });
  if (sha256File(executable) !== chromePin.toLowerCase()) throw new Fail("running-browser-pin-mismatch");

  const isLive = () => {
    try {
      if (!ownedChild(browser.proc) || !ownedChild(display.server) || fs.readlinkSync(executable) !== binary) return false;
      const current = fs.statSync(executable, { bigint: true });
      if (current.dev !== pinnedExecutable.dev || current.ino !== pinnedExecutable.ino) return false;
      if (!findMappedBrowserWindow(display, browser.pid, window)) return false;
      return Boolean(ownedChild(browser.proc) && ownedChild(display.server));
    } catch {
      return false;
    }
  };
  if (!isLive()) throw new Fail("protected-window-lost-during-startup");
  ready = true;
  return {
    isLive,
    stopBrowser: () => stopChild(browser.proc, "SIGKILL"),
    stopDisplay: () => stopChild(display.server, "SIGTERM"),
  };
}
