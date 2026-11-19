import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PHASES = ['preflight', 'directories', 'capture-authority', 'control', 'readiness', 'listener', 'agent'];
const DEADLINE = 3000;
const WORKER = `
  setTimeout(() => process.exit(2), 10000);
  process.on('disconnect', () => process.exit(0));
  process.on('message', (message) => {
    if (message === 'state') process.send('state answered');
  });
  process.send('ready');
`;

function withinDeadline(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), DEADLINE);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function expectMessage(child, message, request) {
  let receive;
  let sendError;
  const reply = new Promise((resolve, reject) => {
    receive = (value) => {
      if (value === message) resolve();
    };
    sendError = (error) => {
      if (error) reject(error);
    };
    child.on('message', receive);
  });
  const exited = child.exited.then(() => {
    throw new Error(`${child.role} exited while waiting for ${message}`);
  });
  const result = withinDeadline(Promise.race([reply, exited]), `${child.role} ${message}`);
  if (request !== undefined) child.send(request, sendError);
  return result.finally(() => child.off('message', receive));
}

function makeFixture(t, {existingScratch = false} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-n10-bootstrap-'));
  const durable = path.join(base, 'durable');
  const history = path.join(durable, 'history');
  const scratch = path.join(base, 'scratch');
  fs.mkdirSync(durable);
  fs.writeFileSync(history, 'prior enrollment\n');
  if (existingScratch) {
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, 'foreign'), 'prior launch\n');
  }

  const children = [];
  const trace = [];
  t.after(() => {
    if (children.every((child) => child.exitObserved)) fs.rmSync(base, {recursive: true, force: true});
  });

  let ownsScratch = false;
  let receipt;
  let control;

  async function start(role) {
    trace.push(`start:${role}`);
    const child = spawn(process.execPath, ['--eval', WORKER], {
      env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    children.push(child);
    child.role = role;
    child.exitObserved = false;
    child.on('error', () => {}); // A failed spawn closes without a proven exit.
    child.exited = new Promise((resolve) => child.once('exit', () => {
      child.exitObserved = true;
      resolve();
    }));
    await expectMessage(child, 'ready');
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
      await expectMessage(control, 'state answered', 'state');
      trace.push('answered:state');
    },
    async listener() {
      await start('listener');
      fs.mkdirSync(path.join(scratch, 'browser-profile'));
      trace.push('created:browser-profile');
    },
    async agent() {
      assert.ok(children.every((child) => child.connected && !child.exitObserved),
        'startup helpers must remain connected');
      await start('agent');
    },
  };

  async function launch({inject, withholdExitProof} = {}) {
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
      // End only this fixture's owned IPC channels. The workers exit on disconnect.
      for (const child of [...children].reverse()) {
        if (child.connected) child.disconnect();
      }
    }

    const exited = await Promise.allSettled(children.map((child) => withinDeadline(child.exited, `${child.role} exit`)));
    const cleanupProven = children.every((child, index) =>
      exited[index].status === 'fulfilled' && !child.connected && child.role !== withholdExitProof);
    if (ownsScratch && cleanupProven) fs.rmSync(scratch, {recursive: true});
    return {failure, cleanupProven, status: cleanupProven ? (failure ? 'refused' : 'completed') : 'cleanup unproven'};
  }

  function assertDurablePreserved() {
    assert.deepEqual(fs.readdirSync(durable), ['history']);
    assert.equal(fs.readFileSync(history, 'utf8'), 'prior enrollment\n');
  }

  return {scratch, children, trace, launch, assertDurablePreserved};
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

function assertProcessExits(fixture, expectedTrace) {
  assert.deepEqual(fixture.children.map((child) => `start:${child.role}`),
    expectedTrace.filter((event) => event.startsWith('start:')));
  assert.ok(fixture.children.every((child) => child.exitObserved));
}

test('N10 successful bootstrap starts the agent only after all readiness checks', async (t) => {
  const fixture = makeFixture(t);
  assert.deepEqual(await fixture.launch(), {failure: undefined, cleanupProven: true, status: 'completed'});
  assert.deepEqual(fixture.trace, EXPECTED_TRACE);
  assertProcessExits(fixture, EXPECTED_TRACE);
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
      assertProcessExits(fixture, expectedTrace);
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
  assertProcessExits(fixture, []);
  assert.deepEqual(fs.readdirSync(fixture.scratch), ['foreign']);
  assert.equal(fs.readFileSync(path.join(fixture.scratch, 'foreign'), 'utf8'), 'prior launch\n');
  fixture.assertDurablePreserved();
});

test('N10 unproven cleanup reports failure and retains owned scratch', async (t) => {
  const fixture = makeFixture(t);
  const result = await fixture.launch({inject: 'after:agent', withholdExitProof: 'agent'});
  assert.equal(result.failure.message, 'Injected after:agent');
  assert.equal(result.cleanupProven, false);
  assert.equal(result.status, 'cleanup unproven');
  assert.deepEqual(fixture.trace, EXPECTED_TRACE);
  assertProcessExits(fixture, EXPECTED_TRACE);
  assert.deepEqual(fs.readdirSync(fixture.scratch).sort(), ['browser-profile', 'initial-capture']);
  fixture.assertDurablePreserved();
});
