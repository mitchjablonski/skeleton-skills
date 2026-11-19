import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PHASES = ['preflight', 'directories', 'capture-authority', 'control', 'readiness', 'listener', 'agent'];
const DEADLINE = 3000;
const NO_REPLY_DEADLINE = 150;
const STUBBORN_EXIT_DEADLINE = 250;
const WORKER = `
  const [role, startupLog, behavior] = process.argv.slice(1);
  require('node:fs').appendFileSync(startupLog, JSON.stringify({role, pid: process.pid}) + '\\n');
  setTimeout(() => process.exit(2), 10000);
  process.on('disconnect', () => {
    if (behavior !== 'stubborn') process.exit(0);
  });
  process.on('message', (message) => {
    if (role === 'console' && message.type === 'state' && behavior !== 'no-reply') {
      process.send('state answered ' + message.nonce);
    }
  });
  process.send('ready');
`;

function withinDeadline(promise, label, deadline = DEADLINE) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), deadline);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function expectMessage(child, message, {request, onMatch, deadline, label = message} = {}) {
  let receive;
  let sendError;
  const reply = new Promise((resolve, reject) => {
    receive = (value) => {
      if (value === message) {
        onMatch?.();
        resolve();
      }
    };
    sendError = (error) => {
      if (error) reject(error);
    };
    child.on('message', receive);
  });
  const exited = child.exited.then(() => {
    throw new Error(`${child.role} exited while waiting for ${label}`);
  });
  const result = withinDeadline(Promise.race([reply, exited]), `${child.role} ${label}`, deadline);
  if (request !== undefined) child.send(request, sendError);
  return result.finally(() => child.off('message', receive));
}

function makeFixture(t, {existingScratch = false, consoleNeverReplies = false, stubbornRole} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-n10-bootstrap-'));
  const durable = path.join(base, 'durable');
  const history = path.join(durable, 'history');
  const scratch = path.join(base, 'scratch');
  // The harness reads this after launch, even when the launcher removed scratch.
  const startupLog = path.join(base, 'worker-starts');
  fs.writeFileSync(startupLog, '');
  fs.mkdirSync(durable);
  fs.writeFileSync(history, 'prior enrollment\n');
  if (existingScratch) {
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, 'foreign'), 'prior launch\n');
  }

  const children = [];
  const harnessChildren = [];
  const trace = [];

  async function forceTeardown() {
    for (const child of harnessChildren) {
      if (!child.exitObserved) child.kill();
    }
    await Promise.all(harnessChildren.map((child) => withinDeadline(child.exited, `${child.role} harness exit`)));
  }

  t.after(async () => {
    await forceTeardown();
    fs.rmSync(base, {recursive: true, force: true});
  });

  let ownsScratch = false;
  let receipt;
  let control;
  const readinessNonce = randomUUID();
  let observedNonce;

  function spawnWorker(role) {
    const behavior = role === stubbornRole ? 'stubborn' : role === 'console' && consoleNeverReplies ? 'no-reply' : 'normal';
    const child = spawn(process.execPath, ['--eval', WORKER, role, startupLog, behavior], {
      env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    harnessChildren.push(child);
    child.role = role;
    child.exitObserved = false;
    child.on('error', () => {}); // A failed spawn closes without a proven exit.
    child.exited = new Promise((resolve) => child.once('exit', () => {
      child.exitObserved = true;
      resolve();
    }));
    child.started = expectMessage(child, 'ready');
    child.started.catch(() => {});
    return child;
  }

  async function start(role) {
    trace.push(`start:${role}`);
    const child = spawnWorker(role);
    children.push(child);
    await child.started;
    trace.push(`ready:${role}`);
    return child;
  }

  const effects = {
    preflight() {
      receipt = 'fixture receipt';
    },
    directories() {
      assert.equal(receipt, 'fixture receipt');
      assert.equal(fs.readFileSync(history, 'utf8'), 'prior enrollment\n');
      fs.mkdirSync(scratch);
      ownsScratch = true;
    },
    async 'capture-authority'() {
      fs.writeFileSync(path.join(scratch, 'initial-capture'), 'fixture capture\n');
      await start('authority');
    },
    async control() {
      control = await start('console');
    },
    async readiness() {
      await expectMessage(control, `state answered ${readinessNonce}`, {
        request: {type: 'state', nonce: readinessNonce},
        onMatch() {
          observedNonce = readinessNonce;
          trace.push('answered:state');
        },
        deadline: consoleNeverReplies ? NO_REPLY_DEADLINE : DEADLINE,
        label: 'state reply',
      });
    },
    async listener() {
      await start('listener');
      fs.mkdirSync(path.join(scratch, 'browser-profile'));
      trace.push('created:browser-profile');
    },
    async agent() {
      assert.equal(observedNonce, readinessNonce, 'agent requires an observed state reply');
      assert.ok(children.every((child) => child.connected && !child.exitObserved),
        'startup helpers must remain connected');
      await start('agent');
    },
  };

  async function launch({inject} = {}) {
    function boundary(when, phase) {
      const point = `${when}:${phase}`;
      trace.push(point);
      if (point === inject) throw new Error(`Injected ${point}`);
    }

    let failure;
    try {
      for (const phase of PHASES) {
        boundary('before', phase);
        await effects[phase]();
        boundary('after', phase);
      }
    } catch (error) {
      failure = error;
    } finally {
      // End only this fixture's owned IPC channels. Normal workers exit on disconnect.
      for (const child of [...children].reverse()) {
        if (child.connected) child.disconnect();
      }
    }

    const exited = await Promise.allSettled(children.map((child) => withinDeadline(
      child.exited, `${child.role} exit`, child.role === stubbornRole ? STUBBORN_EXIT_DEADLINE : DEADLINE)));
    const cleanupProven = children.every((child, index) =>
      exited[index].status === 'fulfilled' && !child.connected);
    if (ownsScratch && cleanupProven) fs.rmSync(scratch, {recursive: true});
    return {failure, cleanupProven, status: cleanupProven ? (failure ? 'refused' : 'completed') : 'cleanup unproven'};
  }

  function assertDurablePreserved() {
    assert.deepEqual(fs.readdirSync(durable), ['history']);
    assert.equal(fs.readFileSync(history, 'utf8'), 'prior enrollment\n');
  }

  async function readWorkerStarts() {
    await Promise.all(harnessChildren.map((child) => child.started));
    return fs.readFileSync(startupLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  return {scratch, children, trace, launch, assertDurablePreserved, readWorkerStarts, forceTeardown};
}

const EXPECTED_TRACE = [
  'before:preflight', 'after:preflight',
  'before:directories', 'after:directories',
  'before:capture-authority', 'start:authority', 'ready:authority', 'after:capture-authority',
  'before:control', 'start:console', 'ready:console', 'after:control',
  'before:readiness', 'answered:state', 'after:readiness',
  'before:listener', 'start:listener', 'ready:listener', 'created:browser-profile', 'after:listener',
  'before:agent', 'start:agent', 'ready:agent', 'after:agent',
];

async function assertWorkerStarts(fixture, expectedTrace) {
  const expected = expectedTrace.filter((event) => event.startsWith('start:')).map((event) => event.slice(6));
  const starts = await fixture.readWorkerStarts();
  assert.deepEqual(starts.map(({role}) => role), expected);
  assert.deepEqual(starts, fixture.children.map(({role, pid}) => ({role, pid})));
}

async function assertProcessExits(fixture, expectedTrace) {
  await assertWorkerStarts(fixture, expectedTrace);
  assert.ok(fixture.children.every((child) => child.exitObserved));
}

test('N10 successful bootstrap starts the agent only after all readiness checks', async (t) => {
  const fixture = makeFixture(t);
  assert.deepEqual(await fixture.launch(), {failure: undefined, cleanupProven: true, status: 'completed'});
  assert.deepEqual(fixture.trace, EXPECTED_TRACE);
  await assertProcessExits(fixture, EXPECTED_TRACE);
  assert.equal(fs.existsSync(fixture.scratch), false);
  fixture.assertDurablePreserved();
});

for (const phase of PHASES) {
  for (const when of ['before', 'after']) {
    const inject = `${when}:${phase}`;
    test(`N10 bootstrap refuses a fault ${when} ${phase}`, async (t) => {
      const fixture = makeFixture(t);
      const result = await fixture.launch({inject});
      assert.equal(result.failure.message, `Injected ${inject}`);
      assert.equal(result.status, 'refused');
      assert.equal(result.cleanupProven, true);
      const expectedTrace = EXPECTED_TRACE.slice(0, EXPECTED_TRACE.indexOf(inject) + 1);
      assert.deepEqual(fixture.trace, expectedTrace);
      await assertProcessExits(fixture, expectedTrace);
      assert.equal(fs.existsSync(fixture.scratch), false);
      fixture.assertDurablePreserved();
    });
  }
}

test('N10 an existing scratch directory causes refusal without modifying it', async (t) => {
  const fixture = makeFixture(t, {existingScratch: true});
  const result = await fixture.launch();
  assert.equal(result.failure.code, 'EEXIST');
  assert.equal(result.status, 'refused');
  assert.deepEqual(fixture.trace, EXPECTED_TRACE.slice(0, 3));
  await assertProcessExits(fixture, []);
  assert.deepEqual(fs.readdirSync(fixture.scratch), ['foreign']);
  assert.equal(fs.readFileSync(path.join(fixture.scratch, 'foreign'), 'utf8'), 'prior launch\n');
  fixture.assertDurablePreserved();
});

test('N10 a console that never replies refuses before listener or agent startup', async (t) => {
  const fixture = makeFixture(t, {consoleNeverReplies: true});
  const result = await fixture.launch();
  assert.equal(result.failure.message, 'Timed out waiting for console state reply');
  assert.equal(result.status, 'refused');
  assert.equal(result.cleanupProven, true);
  const expectedTrace = EXPECTED_TRACE.slice(0, EXPECTED_TRACE.indexOf('answered:state'));
  assert.deepEqual(fixture.trace, expectedTrace);
  await assertProcessExits(fixture, expectedTrace);
  assert.equal(fs.existsSync(fixture.scratch), false);
  fixture.assertDurablePreserved();
});

for (const [stubbornRole, phase, scratchFiles] of [
  ['authority', 'capture-authority', ['initial-capture']],
  ['agent', 'agent', ['browser-profile', 'initial-capture']],
]) {
  test(`N10 an unexited ${stubbornRole} leaves cleanup unproven and retains scratch`, async (t) => {
    const fixture = makeFixture(t, {stubbornRole});
    const inject = `after:${phase}`;
    const result = await fixture.launch({inject});
    assert.equal(result.failure.message, `Injected ${inject}`);
    assert.equal(result.cleanupProven, false);
    assert.equal(result.status, 'cleanup unproven');
    const expectedTrace = EXPECTED_TRACE.slice(0, EXPECTED_TRACE.indexOf(inject) + 1);
    assert.deepEqual(fixture.trace, expectedTrace);
    await assertWorkerStarts(fixture, expectedTrace);
    const stubborn = fixture.children.find((child) => child.role === stubbornRole);
    assert.equal(stubborn.connected, false);
    assert.equal(stubborn.exitObserved, false);
    assert.deepEqual(fs.readdirSync(fixture.scratch).sort(), scratchFiles);
    fixture.assertDurablePreserved();
    await fixture.forceTeardown();
    assert.equal(stubborn.exitObserved, true);
  });
}
