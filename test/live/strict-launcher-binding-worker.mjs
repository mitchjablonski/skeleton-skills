import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {enumerateStrictManifest} from '../../lib/strict-enumeration.mjs';
import {captureStrictManifest} from '../../lib/strict-capture.mjs';
import {createCaptureStore, openCaptureStore} from '../../lib/strict-capture-store.mjs';
import {prepareDurableHistory} from '../../lib/strict-directories.mjs';
import {createHumanAuthorityStore} from '../../lib/strict-human-authority-store.mjs';
import {HUMAN_AUTHORITY_POLICY} from '../../lib/strict-human-authority.mjs';
import {deriveHumanCode} from '../../lib/strict-human-command.mjs';
import {createHumanCommandClient} from '../../lib/strict-human-channel.mjs';
import {recoverHumanAuthorityChild, serveHumanAuthorityChild} from '../../lib/strict-authority-child.mjs';
import {FIXTURE_CONTEXT, FIXTURE_PLAN, materialize} from './strict-candidate-inner.mjs';

const [role, directory, identity, fd, reportFd, extraFd, refreshReportFd, chromePin, controlFd] = process.argv.slice(2);
const authority = path.join(directory, 'authority');
const captures = path.join(directory, 'captures');
const context = {projectId: 'binding-fixture', sessionId: identity};
const enrollment = {authorityDirectory: authority, captureDirectory: captures, expectedContext: context};
const forbidden = () => { throw Error('unexpected protected callback'); };
const policy = {policyVersion: HUMAN_AUTHORITY_POLICY, roundMismatchCap: 2, sessionMismatchCap: 4, commandCap: 20, authorityCap: 10};
const fixtureKey = Buffer.alloc(32, 23);
function endpoint() {
  return new net.Socket({fd: Number(fd), readable: true, writable: true});
}

function boundFixtureLifetime(stream) {
  // An endpoint closing must not end both child processes in a lost-peer case.
  setTimeout(() => { stream.destroy(); process.exitCode = 1; }, 12000);
}

function boundRestartLifetime() {
  // Keep the endpoint owner alive during fixture mutations, even after its link closes.
  setTimeout(() => process.exit(1), 45000);
}

async function runProtectedWindow(listener, binding, origin, scratch) {
  const control = new net.Socket({fd: Number(controlFd), readable: true, writable: true});
  let closing = false;
  let exitStatus = 23;
  function close() {
    if (closing) return;
    closing = true;
    control.destroy();
    setTimeout(() => process.exit(exitStatus), 500);
    void listener.close().finally(() => process.exit(exitStatus));
  }
  control.on('error', close);
  control.on('end', close);
  control.on('close', close);
  // Leave time for the full restart, but also close on a stalled fixture.
  setTimeout(close, 45000);
  let window;
  let busy = false;
  control.on('data', async bytes => {
    if (closing || !window || busy || bytes.length !== 1) {
      close();
      return;
    }
    busy = true;
    try {
      switch (bytes[0]) {
        case 0x76: { // v
          const live = await window.isLive();
          control.write(live ? 'y' : 'n', error => {
            if (error || !live) close();
            else busy = false;
          });
          break;
        }
        case 0x62: // b
          if (!window.stopBrowser()) close();
          break;
        case 0x64: // d
          if (!window.stopDisplay()) close();
          break;
        default:
          close();
      }
    } catch {
      close();
    }
  });
  try {
    privateFixtureDirectory(scratch);
    const {startProtectedWindow} = await import('./strict-protected-window.mjs');
    const selected = listener.mintWindowNavigation(binding);
    const navigation = role === 'protected-window-missing-view'
      ? {url: listener.mintNavigation(), takeView: selected.takeView}
      : selected;
    window = await startProtectedWindow({scratch, chromePin, navigation, onLoss: close});
    if (!closing) writeReport(fd, {port: Number(new URL(origin).port)});
  } catch (error) {
    if (error?.label === 'protected-window-view-missing') exitStatus = 24;
    if (error?.label === 'browser-pin-mismatch') exitStatus = 25;
    close();
  }
}

function writeReport(descriptor, value) {
  try {
    fs.writeFileSync(Number(descriptor), JSON.stringify(value));
  } finally {
    fs.closeSync(Number(descriptor));
  }
}

function privateFixtureDirectory(root) {
  assert.equal(fs.realpathSync(root), root);
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700);
}

function reopenFixtureHistory(history) {
  assert.equal(path.basename(history), 'history');
  privateFixtureDirectory(path.dirname(history));
  return prepareDurableHistory(history);
}

function captureCandidate(candidate) {
  const handle = fs.openSync(candidate, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const {manifest} = enumerateStrictManifest(handle);
    return captureStrictManifest(handle, manifest);
  } finally {
    fs.closeSync(handle);
  }
}

if (role === 'prepare-approved') {
  privateFixtureDirectory(directory);
  const paths = prepareDurableHistory(path.join(directory, 'history'), {firstEnrollment: true});
  const candidate = path.join(directory, 'candidate');
  fs.mkdirSync(candidate, {mode: 0o700});
  fs.writeFileSync(path.join(candidate, 'context.txt'), FIXTURE_CONTEXT, {mode: 0o600, flag: 'wx'});
  fs.writeFileSync(path.join(candidate, 'plan.js'), FIXTURE_PLAN, {mode: 0o600, flag: 'wx'});
  const capture = captureCandidate(candidate);
  const captureStore = createCaptureStore(paths.captures);
  captureStore.put(capture);
  const state = {...context, protocolVersion: 2, reviewRoundId: 'round', phase: 'skeleton', revision: 0,
    reviewVersion: capture.shapeVersion, captureVersion: capture.captureVersion, approvedVersion: null, approvedCaptureVersion: null};
  const store = createHumanAuthorityStore(paths.authority, {state, policy}, {
    captureStore,
    observeUnderLock: () => captureCandidate(candidate),
    keyBytes: () => fixtureKey,
  });
  const args = {action: 'approve', code: deriveHumanCode(state, 'approve', fixtureKey), requestId: 'fixture-approval'};
  const committed = store.verifyAndCommit(args);
  assert.equal(committed.kind, 'committed');
  assert.equal(committed.action, 'approve');
  assert.equal(committed.revision, 1);
  assert.equal(committed.reviewVersion, capture.shapeVersion);
  assert.equal(committed.captureVersion, capture.captureVersion);
  const expected = store.state();
  assert.deepEqual(expected, {phase: 'fill', revision: committed.revision, reviewVersion: committed.reviewVersion,
    captureVersion: committed.captureVersion, admissions: 'live'});
  reopenFixtureHistory(paths.root);
  const request = {operation: 'verifyAndCommit', args};
  fs.writeFileSync(path.join(directory, 'recovery.json'), JSON.stringify({request, result: committed}), {mode: 0o600, flag: 'wx'});
  fs.writeFileSync(path.join(directory, 'expected.json'), JSON.stringify(expected), {mode: 0o600, flag: 'wx'});
} else if (role === 'materialize-approved') {
  try {
    const [destination, reviewVersion, captureVersion] = [fd, reportFd, extraFd];
    const paths = reopenFixtureHistory(directory);
    assert.equal(path.dirname(destination), path.dirname(paths.root));
    assert.match(path.basename(destination), /^stage-[A-Za-z0-9_-]+$/);
    materialize(openCaptureStore(paths.captures), {reviewVersion, captureVersion}, destination);
  } catch {
    process.exit(23);
  }
} else if (['decision-listener', 'listener-missing-selected-view',
            'protected-window-listener', 'protected-window-missing-view'].includes(role)) {
  const [{createDecisionListener}, {buildStrictCaptureViewModel}] = await Promise.all([
    import('../../lib/strict-decision-listener.mjs'), import('../../lib/strict-capture-view-model.mjs'),
  ]);
  const [reviewVersion, captureVersion] = [reportFd, extraFd];
  const binding = {...context, protocolVersion: 2, reviewRoundId: 'round', phase: 'fill',
    reviewVersion, captureVersion, approvedVersion: reviewVersion, approvedCaptureVersion: captureVersion,
    pendingNotes: false};
  const capture = openCaptureStore(directory).get(captureVersion);
  const model = buildStrictCaptureViewModel({binding, capture});
  const listener = createDecisionListener({provider: {read: () => ({binding, capture})}});
  const {origin} = await listener.start();
  const startupView = listener.mintWindowNavigation(binding);
  const navigationUrl = role === 'listener-missing-selected-view' ? listener.mintNavigation() : startupView.url;
  const nonce = new URL(navigationUrl).hash.slice(3);
  const bind = await fetch(`${origin}/api/bind`, {method: 'POST', signal: AbortSignal.timeout(1000),
    headers: {origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json'},
    body: JSON.stringify({nonce})});
  assert.equal(bind.status, 200);
  const {tab} = await bind.json();
  const view = await fetch(`${origin}/api/view`, {signal: AbortSignal.timeout(1000),
    headers: {'sec-fetch-site': 'same-origin', 'x-skel-tab': tab}});
  assert.equal(view.status, 200);
  assert.deepEqual(await view.json(), {view: model, codes: {}, codesDropped: false});
  if (!startupView.takeView()) {
    await listener.close();
    process.exit(23);
  }
  listener.mintNavigation(); // Revoke the private startup tab.
  if (role === 'protected-window-listener' || role === 'protected-window-missing-view') {
    await runProtectedWindow(listener, binding, origin, refreshReportFd);
  } else {
    writeReport(fd, {port: Number(new URL(origin).port)});
    boundRestartLifetime();
  }
} else if (role === 'invalid-listener-ready') {
  writeReport(fd, {port: '1234'});
} else if (role === 'listener-crashed-with-detached-child') {
  const [{spawn}, {once}] = await Promise.all([import('node:child_process'), import('node:events')]);
  const script = 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setTimeout(() => {}, 30000);';
  const child = spawn(process.execPath, ['--eval', script], {detached: true, stdio: ['ignore', 'pipe', 'ignore']});
  assert.equal((await once(child.stdout, 'data'))[0].toString(), 'ready');
  fs.writeFileSync('listener-scope-test-child', String(child.pid), {mode: 0o600, flag: 'wx'});
  process.kill(process.pid, 'SIGKILL');
} else if (role === 'prepare') {
  const candidate = path.join(directory, 'candidate');
  fs.mkdirSync(candidate, {mode: 0o700});
  const body = fd === 'different' ? 'different' : 'initial';
  fs.writeFileSync(path.join(candidate, 'plan.js'), `// SKEL[1] fixture\n${body}\n// /SKEL[1]\n`, {mode: 0o600});
  const capture = captureCandidate(candidate);
  const captureStore = createCaptureStore(captures);
  captureStore.put(capture);
  const expected = {phase: 'skeleton', revision: 0, reviewVersion: capture.shapeVersion, captureVersion: capture.captureVersion};
  const state = {...context, ...expected, protocolVersion: 2, reviewRoundId: 'round', approvedVersion: null, approvedCaptureVersion: null};
  const store = createHumanAuthorityStore(authority, {state, policy}, {
    captureStore,
    observeUnderLock: () => captureCandidate(candidate),
    keyBytes: () => fixtureKey,
  });
  if (identity === 'revoked') assert.equal(store.endSession({requestId: 'fixture-end'}).kind, 'admissions-revoked');
  if (identity === 'recovery') {
    const args = {action: 'approve', code: deriveHumanCode(state, 'approve', fixtureKey), requestId: 'fixture-approval'};
    const result = store.verifyAndCommit(args);
    assert.equal(result.kind, 'committed');
    assert.equal(store.endSession({requestId: 'fixture-end'}).kind, 'admissions-revoked');
    const request = {operation: 'verifyAndCommit', args};
    fs.writeFileSync(path.join(directory, 'recovery.json'), JSON.stringify({request, result}), {mode: 0o600, flag: 'wx'});
  }
  fs.writeFileSync(path.join(directory, 'expected.json'), JSON.stringify({...expected, admissions: 'live'}), {mode: 0o600, flag: 'wx'});
} else if (role === 'authority' || role === 'managed-authority') {
  const stream = endpoint();
  try {
    let selected = enrollment;
    if (role === 'managed-authority') {
      const paths = reopenFixtureHistory(directory);
      selected = {authorityDirectory: paths.authority, captureDirectory: paths.captures, expectedContext: context};
    }
    serveHumanAuthorityChild(stream, selected, {observeUnderLock: forbidden});
  } catch {
    process.exit(23);
  }
  if (role === 'managed-authority') boundRestartLifetime();
  else boundFixtureLifetime(stream);
} else if (role === 'recover') {
  const result = await recoverHumanAuthorityChild(endpoint(), enrollment);
  fs.writeFileSync(Number(reportFd), JSON.stringify(result));
  fs.closeSync(Number(reportFd));
} else if (role === 'console') {
  const stream = endpoint();
  boundFixtureLifetime(stream);
  const client = createHumanCommandClient(stream);
  const state = await client.state();
  fs.writeFileSync(Number(reportFd), JSON.stringify(state));
  fs.closeSync(Number(reportFd));
} else if (role === 'restart-console') {
  const stream = endpoint();
  boundRestartLifetime();
  const client = createHumanCommandClient(stream);
  writeReport(reportFd, await client.state());
  let requested = false;
  const refresh = fs.createReadStream(null, {fd: Number(extraFd), highWaterMark: 2});
  for await (const bytes of refresh) {
    assert.ok(!requested && bytes.equals(Buffer.from('R')));
    requested = true;
  }
  assert.ok(requested);
  writeReport(refreshReportFd, await client.state());
} else {
  throw Error('unknown worker role');
}
