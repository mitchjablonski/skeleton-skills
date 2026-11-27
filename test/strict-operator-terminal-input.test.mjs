import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readOperatorApproval } from './live/strict-operator-terminal-input.mjs';

const command = 'approve M3P8-4TWZ';
function fixture(options = {}) {
  const input = new EventEmitter(), output = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, paused: true,
    isPaused() { return this.paused; }, pause() { this.paused = true; },
    resume() { this.paused = false; }, setRawMode(value) { this.isRaw = value; } });
  let text = '', calls = [];
  Object.assign(output, { isTTY: true, write(value) { text += value; } });
  const args = { input, output, interactive: () => true,
    console: { banner: 'CONTROL', async handle(value) { calls.push(value); return ['Recorded: approve']; } },
    committed: () => true, timeout: 1000, ...options };
  const promise = readOperatorApproval(args);
  const feed = (value) => input.emit('data', Buffer.from(value));
  async function result(expected) {
    assert.equal(await promise, expected);
    assert.equal(input.isRaw, false);
    assert.equal(input.paused, true);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.listenerCount('error'), 0);
    assert.ok(text.endsWith('\x1b[?2004l'));
    assert.ok(!text.includes('M3P8-4TWZ'));
  }
  return { input, output, calls, promise, feed, result };
}

test('typed bursts require Enter and authoritative commit, without echo', async () => {
  const f = fixture();
  f.feed(command);
  assert.deepEqual(f.calls, []);
  f.feed('\r\n');
  await f.result(true);
  assert.deepEqual(f.calls, [command]);
  const split = fixture();
  split.feed(command + '\r');
  split.feed('\n');
  await split.result(true);
  const rejected = fixture({ committed: () => false });
  rejected.feed(command + '\r');
  await rejected.result(false);
});

test('refuses paste, batches, other actions and incomplete cancellation', async () => {
  for (const bytes of [command + '\rstatus\r', command + '\rX',
    '\x1b[200~' + command + '\x1b[201~\r', 'reshape M3P8-4TWZ\r',
    'status\r', command + '\x03', '\x00\r']) {
    const f = fixture();
    f.feed(bytes);
    await f.result(false);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.feed(command);
  f.input.emit('end');
  await f.result(false);
});

test('timeout, abort, loss of terminal identity and handler failure restore state', async () => {
  const timed = fixture({ timeout: 5 });
  timed.feed('approve');
  await timed.result(false);
  const abort = new AbortController();
  const cancelled = fixture({ signal: abort.signal });
  abort.abort();
  await cancelled.result(false);
  let live = true;
  const lost = fixture({ interactive: () => live });
  live = false;
  lost.feed(command + '\r');
  await lost.result(false);
  assert.deepEqual(lost.calls, []);
  const failed = fixture({ console: { banner: 'CONTROL', handle() { throw new Error('hidden'); } } });
  failed.feed(command + '\r');
  await failed.result(false);
});

test('queued second command cancels before an approval can be invoked', async () => {
  const f = fixture();
  f.feed(command + '\r');
  f.feed('status\r');
  await f.result(false);
  assert.deepEqual(f.calls, []);
});
