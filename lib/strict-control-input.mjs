// #151: bounded streaming parser for control-terminal input. PROTOTYPE, pure,
// imports nothing, wired into nothing. It turns raw terminal bytes (as a
// trusted raw-mode terminal would deliver them, in arbitrary chunks) into
// whole-line events for the control console, which
// still interprets commands and normalises codes. Raw mode, terminal
// ownership, human origin and output escape filtering are separate gates.
//
// Rules (tests split every vector at every byte offset):
//   - A line is accepted only at an explicit Enter typed OUTSIDE a paste, and
//     only after the whole line has been validated. Nothing is emitted for a
//     line before that point, so an invalid suffix can never follow an
//     already-accepted prefix.
//   - Typed input: printable ASCII 0x20-0x7E is appended; Enter is CR or LF,
//     and CRLF counts once (also across chunks); Backspace (0x08) and DEL
//     (0x7F) delete the last typed character; Ctrl-U clears the line; Ctrl-C
//     emits an interrupt and clears the line. Any other control byte, any
//     non-ASCII byte, or any escape sequence other than the bracketed-paste
//     markers poisons the line.
//   - Bracketed paste (ESC [ 2 0 0 ~ ... ESC [ 2 0 1 ~), markers may span any
//     chunk boundary. Pasted bytes must all be printable ASCII; a pasted
//     newline, CR, tab, ESC, C1, DEL or non-ASCII byte poisons the line, so a
//     multi-line paste can never become several commands. Pasting never
//     submits. A start marker inside a paste, or an end marker outside one,
//     poisons the line.
//   - A poisoned line produces exactly one { type: "rejected", reason } when
//     its Enter arrives (or at end()), and nothing else. Over-long lines
//     (more than maxLine characters) are poisoned with reason "overflow".
//   - Bounded: the line buffer never exceeds maxLine characters, the escape
//     buffer never exceeds 6 bytes, and an unclosed paste is discarded byte
//     by byte (no buffering) until its end marker, end() or reset().
//   - Events are frozen and exact: { type: "line", text }, { type:
//     "rejected", reason } or { type: "interrupt" }. Reasons are generic and
//     never contain input.

const freeze = Object.freeze;
export const CONTROL_INPUT_MAX_LINE = 200; // the console's own limit
export const REJECT_REASONS = freeze(["unsupported-byte", "escape", "paste-content", "malformed-paste", "overflow", "incomplete"]);

const ESC = 0x1b, CR = 0x0d, LF = 0x0a, BS = 0x08, DEL = 0x7f, CTRL_U = 0x15, CTRL_C = 0x03;
const PASTE_START = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // ESC [ 2 0 0 ~
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];   // ESC [ 2 0 1 ~
const printable = (b) => b >= 0x20 && b <= 0x7e;
const sliceOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer").get;

const line = (text) => freeze({ type: "line", text });
const rejected = (reason) => freeze({ type: "rejected", reason });
const INTERRUPT = freeze({ type: "interrupt" });

/** Copy a Uint8Array (or Buffer) through intrinsic slots only; anything else throws TypeError. */
function bytesOf(chunk) {
  try { sliceOf.call(chunk); } catch { throw new TypeError("control input must be a Uint8Array"); }
  return Uint8Array.prototype.slice.call(chunk);
}

/**
 * Create a parser. maxLine may only be lowered.
 * Returns { push(bytes) -> events[], end() -> events[], reset() }.
 */
export function createControlInput({ maxLine = CONTROL_INPUT_MAX_LINE } = {}) {
  if (!Number.isSafeInteger(maxLine) || maxLine < 1 || maxLine > CONTROL_INPUT_MAX_LINE) throw new RangeError("maxLine out of range");
  let buf = "";          // validated characters of the current line
  let poison = null;     // reason the current line will be rejected, or null
  let inPaste = false;
  let esc = [];          // pending escape-sequence bytes (at most 6)
  let lastWasCR = false; // swallow the LF of a CRLF

  const poisonWith = (reason) => { if (!poison) poison = reason; };
  const clearLine = () => { buf = ""; poison = null; };
  const append = (b) => {
    if (poison) return;
    if (buf.length >= maxLine) { poisonWith("overflow"); return; }
    buf += String.fromCharCode(b);
  };
  const submit = (out) => {
    out.push(poison ? rejected(poison) : line(buf));
    clearLine();
  };

  // An escape sequence that is complete or impossible: act on it.
  function finishEscape() {
    const seq = esc; esc = [];
    const is = (m) => seq.length === m.length && seq.every((x, i) => x === m[i]);
    if (is(PASTE_START)) { if (inPaste) poisonWith("malformed-paste"); else inPaste = true; return; }
    if (is(PASTE_END)) { if (inPaste) inPaste = false; else poisonWith("malformed-paste"); return; }
    poisonWith(inPaste ? "paste-content" : "escape");
  }
  const couldBeMarker = (seq) => [PASTE_START, PASTE_END].some((m) => seq.length <= m.length && seq.every((x, i) => x === m[i]));

  function step(b, out) {
    if (esc.length) {
      esc.push(b);
      if (!couldBeMarker(esc)) {
        // Not a paste marker. Outside a paste, swallow the rest of a CSI-style
        // sequence would need unbounded lookahead; instead poison and drop
        // just these bytes (later bytes are judged on their own).
        esc = []; poisonWith(inPaste ? "paste-content" : "escape"); return;
      }
      if (esc.length === 6) finishEscape();
      return;
    }
    if (b === ESC) { esc = [b]; lastWasCR = false; return; }
    if (inPaste) {
      if (!printable(b)) poisonWith("paste-content");
      else append(b);
      lastWasCR = false;
      return;
    }
    if (b === LF && lastWasCR) { lastWasCR = false; return; } // CRLF counts once
    lastWasCR = b === CR;
    if (b === CR || b === LF) { submit(out); return; }
    if (b === CTRL_C) { clearLine(); out.push(INTERRUPT); return; }
    if (b === CTRL_U) { clearLine(); return; }
    if (b === BS || b === DEL) { if (!poison) buf = buf.slice(0, -1); return; }
    if (printable(b)) { append(b); return; }
    poisonWith("unsupported-byte");
  }

  return freeze({
    push(chunk) {
      const bytes = bytesOf(chunk);
      const out = [];
      for (const b of bytes) step(b, out);
      return freeze(out);
    },
    /** End of input: an unfinished line, paste or escape is rejected, never submitted. */
    end() {
      const out = [];
      if (esc.length || inPaste || buf.length || poison) out.push(rejected("incomplete"));
      esc = []; inPaste = false; lastWasCR = false; clearLine();
      return freeze(out);
    },
    /** Drop all state without emitting anything. */
    reset() { esc = []; inPaste = false; lastWasCR = false; clearLine(); },
  });
}
