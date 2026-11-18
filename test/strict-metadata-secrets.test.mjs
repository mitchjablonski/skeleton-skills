// N11 (docs/strict-protected-bootstrap.md): enrollment and session metadata
// hold no keys or codes. Drives the real human authority store through every
// channel method and checks everything that leaves the authority:
//   1. a static schema: each result kind and state() has exactly its allowed
//      own keys, a plain prototype, and only primitive values pinned to known
//      values (versions, request ids, enums), so nothing can hide a secret;
//   2. a backstop scan of results, state() and every capture-store byte for
//      each epoch key and code in several encodings.
// The authority's own durable record keeps its keys and the command ledger by
// design (same-id replay). It is authority-private history, not metadata; the
// contract says so, and the scan's positive control runs against it.
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
const SKEL = (body) => `// SKEL[1] body\n${body}\n// /SKEL[1]\n`;

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-n11-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const file = path.join(work, 'file');
  fs.writeFileSync(file, SKEL('return 1;'));
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
  const issued = [];  // every timestamp the authority was handed; `at` must be one of them
  const clock = () => { const at = new Date(Date.UTC(2026, 10, 17, 0, 0, issued.length)).toISOString(); issued.push(at); return at; };
  const deps = {captureStore: captures, observeUnderLock: observe, clock};
  const dir = path.join(base, 'authority');
  const store = createHumanAuthorityStore(dir, {state, policy}, deps);
  const record = () => JSON.parse(fs.readFileSync(path.join(dir, 'human-authority.json'), 'utf8'));
  return {base, dir, file, capturesDir, store, record, state, policy, deps, issued};
}

/** Encodings a secret could plausibly leak in. Codes also in case-folded and undashed forms. */
function encodings(secret) {
  if (Buffer.isBuffer(secret)) {
    return [secret.toString('hex'), secret.toString('hex').toUpperCase(), secret.toString('base64'),
      secret.toString('base64url'), secret.toString('latin1')];
  }
  const s = String(secret), bare = s.replace('-', '');
  return [s, s.toLowerCase(), bare, bare.toLowerCase()];
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

// Exact metadata schema: allowed own keys per kind; every value a primitive.
const SCHEMA = {
  state: ['phase', 'revision', 'reviewVersion', 'captureVersion', 'admissions'],
  mismatch: ['kind', 'requestId', 'revision', 'reviewVersion', 'captureVersion', 'attemptsLeft'],
  committed: ['kind', 'requestId', 'action', 'reviewVersion', 'revision', 'captureVersion', 'at'],
  recaptured: ['kind', 'requestId', 'reviewVersion', 'captureVersion', 'revision', 'changed'],
  'admissions-revoked': ['kind', 'requestId', 'at'],
  rejected: ['kind', 'code', 'requestId'],
};

function checkSchema(value, kind, known) {
  assert.ok(value && typeof value === 'object', `${kind}: not an object`);
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), `${kind}: non-plain prototype`);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...SCHEMA[kind]].sort(), `${kind}: own keys`);
  for (const key of SCHEMA[kind]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(d.enumerable && 'value' in d, `${kind}.${key}: not a data property`);
    const v = d.value;
    switch (key) {
      case 'kind': assert.equal(v, kind); break;
      case 'requestId': assert.ok(known.requestIds.has(v), `${kind}.requestId not one we sent`); break;
      case 'action': assert.ok(['approve', 'reshape'].includes(v)); break;
      case 'reviewVersion': assert.ok(known.shapes.has(v), `${kind}.reviewVersion not a stored capture`); break;
      case 'captureVersion': assert.ok(known.captures.has(v), `${kind}.captureVersion not a stored capture`); break;
      // Numbers and times are pinned to exact expected values: a number field
      // could otherwise carry up to 53 bits of a key or code.
      case 'revision': assert.equal(v, known.expect.revision, `${kind}.revision`); break;
      case 'attemptsLeft': assert.equal(v, known.expect.attemptsLeft, `${kind}.attemptsLeft`); break;
      case 'at': assert.ok(known.issued.includes(v), `${kind}.at not a timestamp the authority was given`); break;
      case 'changed': assert.equal(typeof v, 'boolean'); break;
      case 'phase': assert.ok(['skeleton', 'fill', 'done'].includes(v), `phase ${v}`); break;
      case 'admissions': assert.ok(['live', 'revoked'].includes(v), `admissions ${v}`); break;
      case 'code': assert.ok(['unavailable', 'invalid-transition', 'request-reused', 'session-ended'].includes(v), `code ${v}`); break;
      default: assert.fail(`${kind}.${key}: no rule`);
    }
  }
}

linux('N11: channel results, state() and the capture store never carry keys or codes', (t) => {
  const f = fixture(t);
  const seen = [];          // [kind, value] for everything that leaves the authority
  const keys = [];          // epoch keys, raw
  const codes = [];         // codes, as derived
  const submitted = [];     // codes actually typed
  const requestIds = new Set();
  // Expected numbers per output, from the private record right after the call
  // (the core state's revision, which a result leak would not change).
  const call = (value, kind = value.kind, expect = {}) => {
    seen.push([kind, value, {revision: f.record().authority.state.revision, ...expect}]);
    return value;
  };
  const codeFor = (action) => {
    const r = f.record();
    const key = Buffer.from(r.epochs.at(-1).keyHex, 'hex');
    keys.push(key);
    const code = deriveHumanCode(r.authority.state, action, key);
    codes.push(code);
    return code;
  };
  const send = (method, args, expect) => {
    requestIds.add(args.requestId); if (args.code) submitted.push(args.code);
    const value = f.store[method](args);
    return call(value, value.kind, expect);
  };

  call(f.store.state(), 'state');
  const approveCode = codeFor('approve');
  const wrong = approveCode === '0000-0000' ? '1111-1111' : '0000-0000';
  // roundMismatchCap 2: one wrong guess leaves exactly one attempt.
  assert.equal(send('verifyAndCommit', {requestId: 'w', action: 'approve', code: wrong}, {attemptsLeft: 1}).kind, 'mismatch');
  assert.equal(send('verifyAndCommit', {requestId: 'a', action: 'approve', code: approveCode}).kind, 'committed');
  const approvedAt = f.record().authority.state.revision;
  send('verifyAndCommit', {requestId: 'a', action: 'approve', code: approveCode}, {revision: approvedAt}); // same-id replay
  call(f.store.state(), 'state');
  assert.equal(send('verifyAndCommit', {requestId: 'r', action: 'reshape', code: codeFor('reshape')}).kind, 'committed');
  fs.writeFileSync(f.file, SKEL('return 2;'));
  assert.equal(send('recapture', {requestId: 'c'}).kind, 'recaptured');
  for (const action of ['approve', 'reshape']) { // current epoch's codes, never submitted
    try { codeFor(action); } catch (error) { if (error.code !== 'HUMAN_ACTION') throw error; }
  }
  call(f.store.state(), 'state');
  assert.equal(send('endSession', {requestId: 'e'}).kind, 'admissions-revoked');
  call(f.store.state(), 'state');
  send('verifyAndCommit', {requestId: 'x', action: 'approve', code: 'not-a-code'}); // malformed
  assert.ok(f.record().epochs.length >= 2, 'the key rotated at least once');

  // 1. Static schema over every output.
  const stored = filesUnder(f.capturesDir).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const known = {requestIds, shapes: new Set(stored.map((c) => c.shapeVersion)), captures: new Set(stored.map((c) => c.captureVersion))};
  assert.ok(known.captures.size >= 2, 'recapture published a second capture');
  assert.deepEqual(new Set(seen.map(([kind]) => kind)), new Set(Object.keys(SCHEMA)), 'every metadata kind was exercised');
  for (const [kind, value, expect] of seen) checkSchema(value, kind, {...known, expect, issued: f.issued});

  // 2. Backstop scan: results, state() and every capture-store byte.
  const needles = [...new Set([...keys, ...codes].flatMap(encodings))];
  const surface = JSON.stringify(seen.map(([, v]) => v));
  // Backstop: every number that left the authority is small.
  for (const [, value] of seen) for (const v of Object.values(value)) if (typeof v === 'number') assert.ok(v < 1000, 'large number in metadata');
  for (const needle of needles) assert.equal(surface.includes(needle), false, 'a key or code left the authority');
  const captureFiles = filesUnder(f.capturesDir);
  for (const file of captureFiles) {
    const bytes = fs.readFileSync(file);
    for (const key of keys) assert.equal(bytes.includes(key), false, 'raw key in the capture store');
    const text = bytes.toString('latin1');
    for (const needle of needles) assert.equal(text.includes(needle), false, 'encoded secret in the capture store');
  }

  // Positive controls. The private record holds every epoch key and every typed code.
  const durable = fs.readFileSync(path.join(f.dir, 'human-authority.json'), 'latin1');
  for (const epoch of f.record().epochs) assert.ok(durable.includes(epoch.keyHex), 'private record keeps each epoch key');
  for (const code of submitted.filter((c) => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c))) {
    assert.ok(durable.includes(code), 'private record keeps each typed code');
  }
  // The capture-store scan detects a needle that really is there.
  const canary = 'ca'.repeat(16) + 'fe'.repeat(16);
  fs.writeFileSync(f.file, SKEL(`return "${canary}";`));
  const canaryFd = fs.openSync(path.dirname(f.file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    f.deps.captureStore.put(captureStrictManifest(canaryFd, [{path: 'file', mode: 'fenced'}]));
  } finally { fs.closeSync(canaryFd); }
  assert.ok(filesUnder(f.capturesDir).some((file) => fs.readFileSync(file, 'latin1').includes(canary)),
    'capture-store scan positive control');
});

linux('N11: enrollment carries only state and policy, never key material', (t) => {
  const f = fixture(t);
  // A valid copy enrolls, so each refusal below is due to its one extra field.
  const valid = path.join(f.base, 'enroll-valid');
  createHumanAuthorityStore(valid, {state: {...f.state}, policy: {...f.policy}}, f.deps);
  assert.equal(fs.existsSync(path.join(valid, 'human-authority.json')), true);
  const keyHex = 'ab'.repeat(32);
  const attempts = [
    [{state: {...f.state}, policy: {...f.policy}, keyHex}, /invalid own keys/],
    [{state: {...f.state}, policy: {...f.policy}, code: 'K7M2-QX9D'}, /invalid own keys/],
    [{state: {...f.state, keyHex}, policy: {...f.policy}}, /invalid enrollment/],
    [{state: {...f.state, approvalCode: 'K7M2-QX9D'}, policy: {...f.policy}}, /invalid enrollment/],
    [{state: {...f.state}, policy: {...f.policy, token: 't'}}, /invalid enrollment/],
    [{state: {...f.state}, policy: {...f.policy, tabBinding: 'b'}}, /invalid enrollment/],
  ];
  attempts.forEach(([enrollment, reason], i) => {
    const dir = path.join(f.base, 'enroll-' + i);
    assert.throws(() => createHumanAuthorityStore(dir, enrollment, f.deps), reason, `attempt ${i}`);
    assert.equal(fs.existsSync(path.join(dir, 'human-authority.json')), false);
  });
});
