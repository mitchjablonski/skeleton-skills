// Private fixture entrypoint. Caller MUST supply isolated network/PID/mount
// namespaces, a fresh writable HOME, /opt/claude, and a controlling PTY.
// This adapter is not a sandbox. It never reads or records terminal input.
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';

if (process.platform !== 'linux' || process.cwd() !== '/work' ||
    !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
  throw Error('private Linux /work controlling PTY required');
}
const statusValue = process.env.STRICT_INTERACTIVE_STATUS_FD;
const statusFd = Number(statusValue);
if (!Number.isSafeInteger(statusFd) || statusFd < 3) {
  throw Error('invalid private status FD');
}
const status = event => {
  try { fs.writeSync(statusFd, JSON.stringify({ event }) + '\n'); }
  catch { stop(); }
};
const key = 'sk-ant-local-dummy-only';
fs.mkdirSync('/home/agent/.claude', { recursive: true, mode: 0o700 });
// Synthetic onboarding only; never import an existing user's configuration.
const config = {
  hasCompletedOnboarding: true, theme: 'dark',
  customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
  projects: { '/work': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
};
for (const file of ['/home/agent/.claude.json', '/home/agent/.claude/.claude.json']) {
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
}
const MAX_BODY = 1024 * 1024;
const MAX_REQUESTS = 32;
let requests = 0, turns = 0, child, stopping = false, killTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child) {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
  }
}
function reply(res, stream) {
  const text = 'LOCAL-FIXTURE-REPLY';
  const message = { id: `msg_fixture_${turns}`, type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-5', content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 5 } };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
  } else {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { ...message, content: [], stop_reason: null } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    send('message_stop', {});
    res.end();
  }
  status('turn');
}
const server = http.createServer((req, res) => {
  if (++requests > MAX_REQUESTS || req.method !== 'POST' ||
      !['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens', '/v1/messages/count_tokens?beta=true'].includes(req.url)) {
    res.writeHead(400); res.end('{}'); return;
  }
  let bytes = 0, chunks = [];
  req.on('error', () => {});
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_BODY) { chunks = []; req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      chunks = [];
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1}'); return;
      }
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
      const text = typeof last?.content === 'string' ? [last.content]
        : Array.isArray(last?.content) ? last.content.filter(part => part.type === 'text').map(part => part.text) : [];
      if (last?.role !== 'user' || !text.includes('Desktop witness message: DESKTOP-WITNESS')
          || (body.tools?.length ?? 0) !== 0 || turns !== 0) {
        res.writeHead(400); res.end('{}'); return;
      }
      ++turns;
      reply(res, body.stream === true);
    } catch { res.writeHead(400); res.end('{}'); }
  });
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.maxConnections = 4;
await new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
});
const env = {
  HOME: '/home/agent', USER: 'agent', SHELL: '/bin/bash', PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8', TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: '/home/agent/.claude',
  ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
  DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', CLAUDE_CODE_SAFE_MODE: '1',
};
const args = ['--model', 'claude-sonnet-4-5', '--tools', '',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--settings', '{"disableAllHooks":true,"enabledPlugins":{}}',
  '--disable-slash-commands'];
// Inherit the exact PTY descriptors. No pipes, print mode, or terminal proxy.
child = spawn('/opt/claude', args, { cwd: '/work', env, stdio: [0, 1, 2] });
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, stop);
const timeout = setTimeout(stop, 260000);
try {
  const result = await new Promise(resolve => {
    child.once('spawn', () => status('ready'));
    child.once('error', () => resolve({ code: 1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = result.code ?? 1;
} finally {
  clearTimeout(timeout); clearTimeout(killTimer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
