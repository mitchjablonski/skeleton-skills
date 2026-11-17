// N11 (docs/strict-protected-bootstrap.md): enrollment and session metadata
// hold no keys or codes. Drives the real human authority store through every
// channel method and scans everything that leaves the authority: each result,
// state(), and every byte in the shared capture store. The authority's own
// durable record keeps its key and the command ledger by design (same-id
// replay); that file is private history, not metadata, and is not scanned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureStrictManifest} from '../lib/strict-capture.mjs';
import {createCaptureStore} from '../lib/strict-capture-store.mjs';
import {createHumanAuthorityStore} from '../lib/strict-human-authority-store.mjs';
import {HUMAN_AUTHORITY_POLICY} from '../lib/strict-human-authority.mjs';
import {deriveHumanCode} from '../lib/strict-human-command.mjs';

const linux = (name, fn) => test(name, {skip: process.platform !== 'linux'}, fn);

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-n11-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const file = path.join(work, 'file');
  fs.writeFileSync(file, '// SKEL[1] body\nreturn 1;\n// /SKEL[1]\n');
  const fd = fs.openSync(work, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  t.after(() => fs.closeSync(fd));
  const observe = () => captureStrictManifest(fd, [{path: 'file', mode: 'fenced'}]);
  const capture = observe();
  const capturesDir = path.join(base, 'captures');
  const captures = createCaptureStore(capturesDir);
  captures.put(capture);
  const state = {protocolVersion: 2, projectId: 'p', sessionId: 's', reviewRoundId: 'r1', phase: 'skeleton', revision: 0,
    reviewVersion: capture.shapeVersion, captureVersion: capture.captureVersion, approvedVersion: null, approvedCaptureVersion: null};
  const policy = {policyVersion: HUMAN_AUTHORITY_POLICY, roundMismatchCap: 2, sessionMismatchCap: 4, commandCap: 20, authorityCap: 10};
  const deps = {captureStore: captures, observeUnderLock: observe};
  const dir = path.join(base, 'authority');
  const store = createHumanAuthorityStore(dir, {state, policy}, deps);
  const record = () => JSON.parse(fs.readFileSync(path.join(dir, 'human-authority.json'), 'utf8'));
  return {base, dir, file, capturesDir, store, record, state, policy, deps};
}

/** Every encoding of a secret that could plausibly leak. */
function encodings(secret) {
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
  const out = new Set([bytes.toString('hex'), bytes.toString('hex').toUpperCase(), bytes.toString('base64'),
    bytes.toString('base64url'), bytes.toString('latin1')]);
  if (!Buffer.isBuffer(secret)) out.add(String(secret).replace('-', ''));
  return [...out].filter((s) => s.length >= 8);
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function keysDeep(value, out = []) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); keysDeep(v, out); }
  }
  return out;
}

linux('N11: channel results, state() and the capture store never carry keys or codes', (t) => {
  const f = fixture(t);
  const seen = [];          // everything that leaves the authority
  const secrets = [];       // keys and codes, raw
  const call = (value) => { seen.push(value); return value; };
  const codeFor = (action) => {
    const r = f.record();
    const key = Buffer.from(r.epochs.at(-1).keyHex, 'hex');
    secrets.push(key);
    const code = deriveHumanCode(r.authority.state, action, key);
    secrets.push(code);
    return code;
  };

  call(f.store.state());
  // A wrong code (mismatch), then the right one (commit).
  const approveCode = codeFor('approve');
  const wrong = approveCode === '0000-0000' ? '1111-1111' : '0000-0000';
  assert.equal(call(f.store.verifyAndCommit({requestId: 'w', action: 'approve', code: wrong})).kind, 'mismatch');
  assert.equal(call(f.store.verifyAndCommit({requestId: 'a', action: 'approve', code: approveCode})).kind, 'committed');
  call(f.store.verifyAndCommit({requestId: 'a', action: 'approve', code: approveCode})); // same-id replay
  call(f.store.state());
  // Reshape rotates the epoch key; a changed workspace makes recapture publish.
  assert.equal(call(f.store.verifyAndCommit({requestId: 'r', action: 'reshape', code: codeFor('reshape')})).kind, 'committed');
  fs.writeFileSync(f.file, '// SKEL[1] body\nreturn 2;\n// /SKEL[1]\n');
  call(f.store.recapture({requestId: 'c'}));
  // The current epoch's codes, never submitted (only actions valid in this phase derive).
  for (const action of ['approve', 'reshape']) {
    try { codeFor(action); } catch (error) { if (error.code !== 'HUMAN_ACTION') throw error; }
  }
  call(f.store.state());
  assert.equal(call(f.store.endSession({requestId: 'e'})).kind, 'admissions-revoked');
  call(f.store.state());
  call(f.store.verifyAndCommit({requestId: 'x', action: 'approve', code: 'not-a-code'})); // malformed

  assert.ok(f.record().epochs.length >= 2, 'the key rotated at least once');
  const needles = [...new Set(secrets.flatMap(encodings))];
  assert.ok(needles.length > 0);

  // Results and state(): no secret in any encoding, and no key-material field names.
  const surface = JSON.stringify(seen);
  for (const needle of needles) assert.equal(surface.includes(needle), false, 'a key or code left the authority');
  for (const name of keysDeep(seen)) assert.doesNotMatch(name, /key|token|secret|binding|epoch/i, `field ${name}`);

  // The capture store is read by other components: no secret in any file.
  const files = filesUnder(f.capturesDir);
  assert.ok(files.length >= 2, 'recapture published a second capture');
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    for (const secret of secrets) {
      const raw = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
      assert.equal(bytes.includes(raw), false, 'raw secret in the capture store');
    }
    const text = bytes.toString('latin1');
    for (const needle of needles) assert.equal(text.includes(needle), false, 'encoded secret in the capture store');
  }

  // Positive control: the scan finds secrets where they are known to live.
  const durable = fs.readFileSync(path.join(f.dir, 'human-authority.json'), 'latin1');
  assert.ok(needles.some((needle) => durable.includes(needle)), 'scan positive control: the private record holds key material');
});

linux('N11: enrollment carries only state and policy, never key material', (t) => {
  const f = fixture(t);
  const keyHex = 'ab'.repeat(32);
  const attempts = [
    {state: f.state, policy: f.policy, keyHex},
    {state: f.state, policy: f.policy, code: 'K7M2-QX9D'},
    {state: {...f.state, keyHex}, policy: f.policy},
    {state: f.state, policy: {...f.policy, token: 't'}},
  ];
  attempts.forEach((enrollment, i) => {
    const dir = path.join(f.base, 'enroll-' + i);
    assert.throws(() => createHumanAuthorityStore(dir, enrollment, f.deps), undefined, `attempt ${i} was accepted`);
    assert.equal(fs.existsSync(path.join(dir, 'human-authority.json')), false);
  });
});
