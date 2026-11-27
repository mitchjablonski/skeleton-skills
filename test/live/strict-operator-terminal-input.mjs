import { createControlInput } from '../../lib/strict-control-input.mjs';

// The caller owns terminal identity and the witness-bound console. TTY flags
// and byte framing cannot establish human origin against terminal injection.
export async function readOperatorApproval({ input, output, interactive, console, committed, signal, timeout = 120_000 }) {
  const isInteractive = () => { try { return typeof interactive === 'function' && interactive() === true; } catch { return false; } };
  if (!isInteractive() || input?.isTTY !== true || output?.isTTY !== true
      || typeof input.setRawMode !== 'function' || typeof console?.handle !== 'function'
      || typeof console.banner !== 'string' || typeof committed !== 'function'
      || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000
      || signal?.aborted) return false;
  const parser = createControlInput();
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused();
  return new Promise((resolve) => {
    let done = false, submitted = false, swallowLF = false, timer, pasteEnabled = false, rawSet = false;
    function finish(result = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', data);
      input.removeListener('end', fail);
      input.removeListener('close', fail);
      input.removeListener('error', fail);
      output.removeListener('error', fail);
      signal?.removeEventListener('abort', fail);
      parser.reset();
      try { if (pasteEnabled) output.write('\x1b[?2004l'); } catch { result = false; }
      try { if (rawSet) input.setRawMode(wasRaw); } catch { result = false; }
      try { if (wasPaused) input.pause(); } catch { result = false; }
      resolve(result);
    }
    function fail() { finish(false); }
    function data(chunk) {
      if (done) return;
      if (submitted && swallowLF && chunk instanceof Uint8Array && chunk.length === 1 && chunk[0] === 10) {
        swallowLF = false;
        return;
      }
      // Permit OS typing bursts, but never a batch with trailing commands or
      // partial input after Enter. Paste is refused even when printable.
      if (submitted || !isInteractive() || !(chunk instanceof Uint8Array) || chunk.includes(27)) return fail();
      const enter = chunk.findIndex((byte) => byte === 13 || byte === 10);
      if (enter !== -1 && enter !== chunk.length - 1
          && !(enter === chunk.length - 2 && chunk[enter] === 13 && chunk[enter + 1] === 10)) return fail();
      let events;
      try { events = parser.push(chunk); } catch { return fail(); }
      if (!events.length) return;
      const event = events[0];
      if (events.length !== 1 || event.type !== 'line'
          || !/^approve [0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(event.text)) return fail();
      submitted = true;
      swallowLF = chunk[chunk.length - 1] === 13;
      Promise.resolve().then(() => {
        if (!done && isInteractive()) return console.handle(event.text);
        throw new Error('Operator terminal unavailable');
      }).then(() => {
        if (!done) finish(isInteractive() && committed() === true);
      }).catch(fail);
    }
    try {
      input.on('data', data);
      input.on('end', fail);
      input.on('close', fail);
      input.on('error', fail);
      output.on('error', fail);
      signal?.addEventListener('abort', fail, { once: true });
      timer = setTimeout(fail, timeout);
      // Set flags before mutations so partial failures still trigger cleanup.
      rawSet = true;
      input.setRawMode(true);
      pasteEnabled = true;
      output.write(`\x1b[?2004h${console.banner}\r\nType approve CODE from the decision page, then Enter. Ctrl-C cancels.\r\n`);
      input.resume();
      if (signal?.aborted) fail();
    } catch { fail(); }
  });
}
