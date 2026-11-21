// #207 fixed control-console worker for a launcher-owned fixture PTY.
import fs from 'node:fs';
import net from 'node:net';
import tty from 'node:tty';
import {createControlInput} from '../../lib/strict-control-input.mjs';
import {createControlConsole} from '../../lib/strict-control-console.mjs';
import {createHumanCommandClient} from '../../lib/strict-human-channel.mjs';

const fds = process.argv.slice(2).map(Number);
if (fds.length !== 5 || new Set(fds).size !== 5 || !fds.every((fd) => Number.isSafeInteger(fd) && fd > 2)) process.exit(2);
const [socketFd, reportFd, refreshSignalFd, refreshReportFd, terminalFd] = fds;
if (!tty.isatty(terminalFd)) process.exit(2);
fs.closeSync(refreshSignalFd);
fs.closeSync(refreshReportFd);
setTimeout(() => process.exit(3), 15000);

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
    verifyAndCommit: reject, recapture: reject, endSession: reject,
  },
  newRequestId: () => 'terminal-fixture-only',
});
const input = createControlInput();
let pending = Promise.resolve();
let finishing = false;
function finish() {
  if (finishing) return;
  finishing = true;
  pending.then(() => {
    const tail = input.end();
    const clean = stateCalls === 1 && decisionCalls === 0 && tail.length === 1 && tail[0].reason === 'incomplete';
    process.exit(clean ? 0 : 4);
  }, () => process.exit(4));
}
process.on('SIGHUP', finish);

try {
  fs.writeFileSync(reportFd, JSON.stringify(await client.state()));
} finally {
  fs.closeSync(reportFd);
}
fs.writeSync(terminalFd, `${control.banner}\r\n`);

const terminal = fs.createReadStream(null, {fd: terminalFd, highWaterMark: 1024, autoClose: false});
terminal.on('data', (chunk) => {
  if (finishing) return;
  for (const event of input.push(chunk)) {
    const line = event.type === 'line' ? event.text : null;
    pending = pending.then(async () => {
      const lines = await control.handle(line);
      if (lines.length) fs.writeSync(terminalFd, lines.map((item) => `${item}\r\n`).join(''));
    });
  }
});
terminal.on('end', finish);
terminal.on('error', finish);
