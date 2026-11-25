// Authority for the owned terminal approval fixture only.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {serveHumanAuthorityChild} from '../../lib/strict-authority-child.mjs';
import {captureStrictManifest} from '../../lib/strict-capture.mjs';
import {createCaptureStore} from '../../lib/strict-capture-store.mjs';
import {prepareDurableHistory} from '../../lib/strict-directories.mjs';
import {enumerateStrictManifest} from '../../lib/strict-enumeration.mjs';
import {HUMAN_AUTHORITY_POLICY} from '../../lib/strict-human-authority.mjs';
import {createHumanAuthorityStore} from '../../lib/strict-human-authority-store.mjs';
import {deriveHumanCode} from '../../lib/strict-human-command.mjs';

const [role, root, descriptor] = process.argv.slice(2);
const fd = Number(descriptor);
const context = {projectId: 'terminal-fixture', sessionId: 'terminal-decision'};
const timestamp = '2026-01-01T00:00:00.000Z';

function observeCandidate(candidate) {
  const handle = fs.openSync(candidate, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const {manifest} = enumerateStrictManifest(handle);
    return captureStrictManifest(handle, manifest);
  } finally {
    fs.closeSync(handle);
  }
}

try {
  const stat = fs.lstatSync(root);
  if (fs.realpathSync(root) !== root || path.basename(root) !== 'decision' || !stat.isDirectory()
    || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700
    || !Number.isSafeInteger(fd) || fd <= 2) process.exit(2);
  const history = path.join(root, 'history');
  const candidate = path.join(root, 'candidate');
  const observeUnderLock = () => observeCandidate(candidate);
  if (role === 'prepare') {
    const paths = prepareDurableHistory(history, {firstEnrollment: true});
    fs.mkdirSync(candidate, {mode: 0o700});
    fs.writeFileSync(path.join(candidate, 'plan.js'), '// SKEL[1] fixture\ninitial\n// /SKEL[1]\n',
                     {mode: 0o600, flag: 'wx'});
    const captureStore = createCaptureStore(paths.captures);
    const capture = captureStore.put(observeUnderLock());
    const state = {...context, protocolVersion: 2, reviewRoundId: 'round', phase: 'skeleton', revision: 0,
      reviewVersion: capture.shapeVersion, captureVersion: capture.captureVersion,
      approvedVersion: null, approvedCaptureVersion: null};
    const policy = {policyVersion: HUMAN_AUTHORITY_POLICY, roundMismatchCap: 2,
      sessionMismatchCap: 4, commandCap: 20, authorityCap: 10};
    const key = randomBytes(32);
    try {
      createHumanAuthorityStore(paths.authority, {state, policy}, {captureStore, observeUnderLock, keyBytes: () => key});
      fs.writeFileSync(fd, deriveHumanCode(state, 'approve', key));
    } finally {
      key.fill(0);
      fs.closeSync(fd);
    }
  } else if (role === 'serve') {
    const paths = prepareDurableHistory(history);
    const endpoint = new net.Socket({fd, readable: true, writable: true});
    serveHumanAuthorityChild(endpoint, {authorityDirectory: paths.authority, captureDirectory: paths.captures,
      expectedContext: context}, {observeUnderLock, clock: () => timestamp});
  } else {
    process.exit(2);
  }
} catch {
  process.exit(2);
}
