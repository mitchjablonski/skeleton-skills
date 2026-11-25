// Fixed control-console worker for a launcher-owned fixture PTY.
import fs from 'node:fs';
import net from 'node:net';
import tty from 'node:tty';
import {createControlInput} from '../../lib/strict-control-input.mjs';
import {createControlConsole} from '../../lib/strict-control-console.mjs';
import {createHumanCommandClient} from '../../lib/strict-human-channel.mjs';

const [mode, ...fdArgs] = process.argv.slice(2);
if (!['standalone', 'decision', 'restart', 'refresh-lost', 'refresh-malformed'].includes(mode)) process.exit(2);
const fds = fdArgs.map(Number);
if (fds.length !== 5 || new Set(fds).size !== 5 || !fds.every((fd) => Number.isSafeInteger(fd) && fd > 2)) process.exit(2);
const [socketFd, reportFd, refreshSignalFd, refreshReportFd, terminalFd] = fds;
if (!tty.isatty(terminalFd)) process.exit(2);
let refresh;
let refreshReportOpen = true;
function closeRefreshReport() {
  if (refreshReportOpen) {
    refreshReportOpen = false;
    fs.closeSync(refreshReportFd);
  }
}
const refreshEnabled = mode !== 'standalone' && mode !== 'decision';
if (!refreshEnabled) {
  fs.closeSync(refreshSignalFd);
  closeRefreshReport();
}
setTimeout(() => {
  closeRefreshReport();
  process.exit(3);
}, 15000);

const client = createHumanCommandClient(new net.Socket({fd: socketFd, readable: true, writable: true}));
let stateCalls = 0;
let decisionCalls = 0;
const reject = async () => {
  decisionCalls++;
  return {kind: 'rejected', code: 'unavailable'};
};
const control = createControlConsole({
  authority: {
    state: () => { stateCalls++; return client.state(); },
    verifyAndCommit: mode === 'decision' ? client.verifyAndCommit : reject,
    recapture: reject, endSession: reject,
  },
  newRequestId: () => 'terminal-fixture-only',
});
const input = createControlInput();
let pending = Promise.resolve();
let finishing = false;
function finish(status = 0) {
  if (finishing) return;
  finishing = true;
  refresh?.destroy();
  closeRefreshReport();
  pending.then(() => {
    const tail = input.end();
    const clean = mode !== 'standalone' || (
      stateCalls === 1 && decisionCalls === 0 && tail.length === 1 && tail[0].reason === 'incomplete'
    );
    process.exit(clean ? status : 4);
  }, () => process.exit(4));
}
process.on('SIGHUP', () => finish());

function queue(operation) {
  pending = pending.then(() => {
    if (!finishing) return operation();
  });
  pending.catch(() => finish(4));
}

try {
  fs.writeFileSync(reportFd, JSON.stringify(await client.state()));
} catch (error) {
  closeRefreshReport();
  throw error;
} finally {
  fs.closeSync(reportFd);
}
fs.writeSync(terminalFd, `${control.banner}\r\n`);

const terminal = fs.createReadStream(null, {fd: terminalFd, highWaterMark: 1024, autoClose: false});
terminal.on('data', (chunk) => {
  if (finishing) return;
  for (const event of input.push(chunk)) {
    const line = event.type === 'line' ? event.text : null;
    queue(async () => {
      const lines = await control.handle(line);
      if (!finishing && lines.length) fs.writeSync(terminalFd, lines.map((item) => `${item}\r\n`).join(''));
    });
  }
});
terminal.on('end', finish);
terminal.on('error', () => finish());

if (refreshEnabled) {
  let requested = false;
  // A pollable stream lets a terminal hangup cancel a pending refresh without
  // waiting for the launcher to write to or close the refresh pipe first.
  refresh = new net.Socket({fd: refreshSignalFd, readable: true, writable: false, readableHighWaterMark: 2});
  refresh.on('error', () => finish(4));
  refresh.on('data', (bytes) => {
    if (requested || bytes.length !== 1 || bytes[0] !== 0x52) {
      finish(4);
      return;
    }
    requested = true;
  });
  refresh.on('end', () => {
    if (!requested) {
      finish(4);
      return;
    }
    queue(async () => {
      try {
        if (mode === 'restart') {
          const state = await client.state();
          if (!finishing) fs.writeFileSync(refreshReportFd, JSON.stringify(state));
        } else if (mode === 'refresh-malformed') {
          fs.writeFileSync(refreshReportFd, '[]');
        }
      } finally {
        closeRefreshReport();
      }
    });
  });
}
