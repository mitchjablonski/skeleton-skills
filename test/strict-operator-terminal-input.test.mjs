import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readOperatorApproval } from './live/strict-operator-terminal-input.mjs';
import { runNamespace } from './live/strict-real-seat-contained.mjs';

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

function restartDriver(confirmAgent) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  const acks = [];
  child.stdin.on('data', (bytes) => acks.push(bytes.toString()));
  let prompt;
  const prompting = new Promise((resolve) => { prompt = resolve; });
  const run = runNamespace({
    scratch: '/fixture', review: { binding: {} },
    output: { write() {} }, client: {},
    control: { signal: new AbortController().signal, windowCurrent: () => true },
    confirmAgent: async (_text, signal) => {
      prompt();
      return confirmAgent(signal);
    },
  }, () => child);
  const stop = (status) => {
    child.emit('exit', status);
    child.stdout.end();
    child.emit('close', status);
  };
  child.stdout.write('1');
  return { prompting, run, stop, acks };
}

test('a failed driver aborts the pending confirmation and preserves its fixed outcome', { timeout: 2000 }, async () => {
  for (const [status, label] of [
    [40, 'interactive-agent-pane-closed'],
    [41, 'interactive-agent-input-refused'],
    [42, 'interactive-agent-not-ready'],
    [43, 'interactive-agent-channel-refused'],
    [44, 'interactive-agent-turn-missing'],
    [125, 'real-seat-cleanup-unproven'],
    [1, 'contained-restart-refused'],
  ]) {
    const fixture = restartDriver((signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(false), { once: true });
    }));
    const rejected = assert.rejects(fixture.run, { label });
    await fixture.prompting;
    fixture.stop(status);
    await rejected;
    assert.deepEqual(fixture.acks, []);
  }
});

test('a closed agent pane is reported before queued output can be written', { skip: process.platform !== 'linux' }, () => {
  const entry = fileURLToPath(new URL('./live/strict-interactive-claude-relay.py', import.meta.url));
  const script = `
import runpy, socket, sys
from contextlib import ExitStack
module = runpy.run_path(sys.argv[1])
relay = object.__new__(module["AgentRelay"])
failure = module["RelayRefused"]
with ExitStack() as stack:
    relay.listener, listener_peer = socket.socketpair()
    stack.enter_context(relay.listener)
    stack.enter_context(listener_peer)
    relay.channel, other = socket.socketpair()
    stack.enter_context(relay.channel)
    stack.enter_context(other)
    relay.pane, pane = socket.socketpair()
    stack.enter_context(relay.pane)
    pane.close()
    relay.output = bytearray(b"fixture text")
    relay.send = bytearray()
    try:
        relay.poll(0.2)
    except failure as error:
        assert error.status == failure.PANE_CLOSED
    else:
        raise AssertionError("expected pane closure")
    assert relay.output == b"fixture text"
`;
  const child = spawnSync('/usr/bin/python3', ['-I', '-c', script, entry], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
