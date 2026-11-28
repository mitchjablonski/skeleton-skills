// Trusted host worker: stdout is exclusively a bounded framed text protocol.
import { once } from 'node:events';
import { createStrictPtyOutput } from '../../lib/strict-pty-output.mjs';

const filter = createStrictPtyOutput();
const header = Buffer.alloc(2);
let headerUsed = 0;
let body = null;
let bodyUsed = 0;

async function respond(input) {
  // Buffer is a Uint8Array subclass; the parser intentionally requires the
  // intrinsic Uint8Array tag, so give it an ordinary view.
  const result = Buffer.from(filter.push(new Uint8Array(input)), 'ascii');
  if (result.length > input.length || result.some(b => b !== 10 && (b < 32 || b > 126))) {
    throw new Error('filter-protocol');
  }
  const frame = Buffer.alloc(2 + result.length);
  frame.writeUInt16BE(result.length);
  result.copy(frame, 2);
  if (!process.stdout.write(frame)) await once(process.stdout, 'drain');
}

try {
  for await (const chunk of process.stdin) {
    let offset = 0;
    while (offset < chunk.length) {
      if (body === null) {
        const count = Math.min(2 - headerUsed, chunk.length - offset);
        chunk.copy(header, headerUsed, offset, offset + count);
        headerUsed += count;
        offset += count;
        if (headerUsed !== 2) continue;
        const size = header.readUInt16BE();
        if (size < 1 || size > 8192) throw new Error('filter-protocol');
        body = Buffer.alloc(size);
        bodyUsed = 0;
      }
      const count = Math.min(body.length - bodyUsed, chunk.length - offset);
      chunk.copy(body, bodyUsed, offset, offset + count);
      bodyUsed += count;
      offset += count;
      if (bodyUsed === body.length) {
        await respond(body);
        body = null;
        headerUsed = 0;
      }
    }
  }
  if (body !== null || headerUsed !== 0) throw new Error('filter-protocol');
  filter.end();
} catch {
  // No errors, input, or parser state are printed on either output stream.
  process.exitCode = 1;
  process.stdin.destroy();
}
