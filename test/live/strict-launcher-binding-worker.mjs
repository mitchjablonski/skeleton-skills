import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {enumerateStrictManifest} from '../../lib/strict-enumeration.mjs';
import {captureStrictManifest} from '../../lib/strict-capture.mjs';
import {createCaptureStore, openCaptureStore} from '../../lib/strict-capture-store.mjs';
import {createHumanAuthorityStore, openHumanAuthorityStore} from '../../lib/strict-human-authority-store.mjs';
import {HUMAN_AUTHORITY_POLICY} from '../../lib/strict-human-authority.mjs';
import {createHumanCommandServer, createHumanCommandClient} from '../../lib/strict-human-channel.mjs';

const [role, directory, identity, fd, reportFd] = process.argv.slice(2);
const authority = path.join(directory, 'authority');
const captures = path.join(directory, 'captures');
const context = {projectId: 'binding-fixture', sessionId: identity};
const forbidden = () => { throw Error('unexpected protected callback'); };
function endpoint() {
  return new net.Socket({fd: Number(fd), readable: true, writable: true});
}

function boundFixtureLifetime(stream) {
  // An endpoint closing must not end both child processes in a lost-peer case.
  setTimeout(() => { stream.destroy(); process.exitCode = 1; }, 12000);
}

if (role === 'prepare') {
  const candidate = path.join(directory, 'candidate');
  fs.mkdirSync(candidate, {mode: 0o700});
  const body = fd === 'different' ? 'different' : 'initial';
  fs.writeFileSync(path.join(candidate, 'plan.js'), `// SKEL[1] fixture\n${body}\n// /SKEL[1]\n`, {mode: 0o600});
  const handle = fs.openSync(candidate, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let capture;
  try {
    const {manifest} = enumerateStrictManifest(handle);
    capture = captureStrictManifest(handle, manifest);
  } finally {
    fs.closeSync(handle);
  }
  const captureStore = createCaptureStore(captures);
  captureStore.put(capture);
  const expected = {phase: 'skeleton', revision: 0, reviewVersion: capture.shapeVersion, captureVersion: capture.captureVersion};
  const state = {...context, ...expected, protocolVersion: 2, reviewRoundId: 'round', approvedVersion: null, approvedCaptureVersion: null};
  const policy = {policyVersion: HUMAN_AUTHORITY_POLICY, roundMismatchCap: 2, sessionMismatchCap: 4, commandCap: 20, authorityCap: 10};
  const store = createHumanAuthorityStore(authority, {state, policy}, {captureStore, observeUnderLock: forbidden});
  if (identity === 'revoked') assert.equal(store.endSession({requestId: 'fixture-end'}).kind, 'admissions-revoked');
  fs.writeFileSync(path.join(directory, 'expected.json'), JSON.stringify({...expected, admissions: 'live'}), {mode: 0o600, flag: 'wx'});
} else if (role === 'authority') {
  let store;
  try {
    store = openHumanAuthorityStore(authority, context, {captureStore: openCaptureStore(captures), observeUnderLock: forbidden});
  } catch {
    process.exit(23);
  }
  const stream = endpoint();
  boundFixtureLifetime(stream);
  createHumanCommandServer(stream, store);
} else if (role === 'console') {
  const stream = endpoint();
  boundFixtureLifetime(stream);
  const client = createHumanCommandClient(stream);
  const state = await client.state();
  fs.writeFileSync(Number(reportFd), JSON.stringify(state));
  fs.closeSync(Number(reportFd));
} else {
  throw Error('unknown worker role');
}
