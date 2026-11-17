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
//   - A broken escape prefix poisons the line; its bytes are dropped, but the
//     byte that broke it is judged afresh (so ESC ESC[200~ still starts a
//     paste, and ESC then Enter still submits the rejection).
//   - Inside a paste, Enter and Ctrl-C are paste content (they poison the
//     line) and never submit or interrupt. A paste ends only at its end
//     marker, end() or reset(); a host should reset() on its own timeout.
//   - Paste nesting is counted, so an inner end marker never resumes typed
//     input inside the outer paste; the paste ends only when the depth
//     returns to zero. Nesting deeper than CONTROL_INPUT_MAX_PASTE_DEPTH
//     latches: everything is discarded until end() or reset().
//   - push() accepts at most CONTROL_INPUT_MAX_CHUNK bytes. Any API error
//     (not a Uint8Array, too large, detached) clears the line and makes
//     every later push throw until end() or reset().
//   - Trust: bracketed-paste markers are framing supplied by a trusted
//     terminal. They are not proof that a human typed the Enter, and this
//     parser is no defence against synthetic input on that terminal.
//   - Bounded: the line buffer never exceeds maxLine characters and the
//     escape buffer never exceeds 6 bytes.
//   - Events are frozen and exact: { type: "line", text }, { type:
//     "rejected", reason } or { type: "interrupt" }. Reasons are generic and
//     never contain input.

const freeze = Object.freeze;
export const CONTROL_INPUT_MAX_LINE = 200; // the console's own limit
export const CONTROL_INPUT_MAX_CHUNK = 16384; // bytes per push
export const CONTROL_INPUT_MAX_PASTE_DEPTH = 8; // nesting beyond this latches
export const REJECT_REASONS = freeze(["unsupported-byte", "escape", "paste-content", "malformed-paste", "overflow", "incomplete"]);

const ESC = 0x1b, CR = 0x0d, LF = 0x0a, BS = 0x08, DEL = 0x7f, CTRL_U = 0x15, CTRL_C = 0x03;
const PASTE_START = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // ESC [ 2 0 0 ~
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];   // ESC [ 2 0 1 ~
const printable = (b) => b >= 0x20 && b <= 0x7e;
const TA = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (k) => Object.getOwnPropertyDescriptor(TA, k).get;
const tagOf = getter(Symbol.toStringTag), bufferOf = getter("buffer"), offsetOf = getter("byteOffset"), lengthOf = getter("byteLength");
const U8 = Uint8Array;

const line = (text) => freeze({ type: "line", text });
const rejected = (reason) => freeze({ type: "rejected", reason });
const INTERRUPT = freeze({ type: "interrupt" });

/**
 * Copy a Uint8Array (or Buffer) through intrinsic slots only: no species,
 * iterator, constructor or own-property lookups on the caller's object.
 * Other typed arrays, subclasses' overrides, proxies and array-likes are
 * refused or ignored; anything that isn't a Uint8Array throws TypeError.
 */
function bytesOf(chunk) {
  let view, len;
  try {
    if (tagOf.call(chunk) !== "Uint8Array") throw 0;
    len = lengthOf.call(chunk);
    if (len > CONTROL_INPUT_MAX_CHUNK) return null;
    view = new U8(bufferOf.call(chunk), offsetOf.call(chunk), len);
  } catch { throw new TypeError("control input must be a Uint8Array"); }
  return new U8(view); // our own view: copied from internal slots
}

/** Options: undefined, or a plain object whose only key is an own data property maxLine. */
function maxLineOf(options) {
  if (options === undefined) return CONTROL_INPUT_MAX_LINE;
  try {
    const proto = Object.getPrototypeOf(options);
    if (typeof options !== "object" || options === null || (proto !== Object.prototype && proto !== null)) throw 0;
    const keys = Reflect.ownKeys(options);
    if (keys.length === 0) return CONTROL_INPUT_MAX_LINE;
    if (keys.length !== 1 || keys[0] !== "maxLine") throw 0;
    const d = Object.getOwnPropertyDescriptor(options, "maxLine");
    if (!("value" in d)) throw 0;
    return d.value;
  } catch { throw new TypeError("invalid control input options"); }
}

/**
 * Create a parser. maxLine may only be lowered.
 * Returns { push(bytes) -> events[], end() -> events[], reset() }.
 */
export function createControlInput(options) {
  const maxLine = maxLineOf(options);
  if (!Number.isSafeInteger(maxLine) || maxLine < 1 || maxLine > CONTROL_INPUT_MAX_LINE) throw new RangeError("maxLine out of range");
  let buf = "";          // validated characters of the current line
  let poison = null;     // reason the current line will be rejected, or null
  let depth = 0;         // bracketed-paste nesting; > 0 means inside a paste
  let latched = false;   // nesting over the bound: discard everything until end()/reset()
  let broken = false;    // an API error happened: push throws until end()/reset()
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
    if (is(PASTE_START)) {
      if (depth) poisonWith("malformed-paste");
      if (depth === CONTROL_INPUT_MAX_PASTE_DEPTH) { latched = true; return; }
      depth++; return;
    }
    if (is(PASTE_END)) { if (depth) depth--; else poisonWith("malformed-paste"); return; }
    poisonWith(depth ? "paste-content" : "escape");
  }
  const couldBeMarker = (seq) => [PASTE_START, PASTE_END].some((m) => seq.length <= m.length && seq.every((x, i) => x === m[i]));

  function step(b, out) {
    if (latched) return;
    if (esc.length) {
      esc.push(b);
      if (!couldBeMarker(esc)) {
        // Not a paste marker: poison the line and drop the bytes before the
        // breaking byte. The breaking byte itself is judged afresh, so an ESC
        // can start a real marker and an Enter or Ctrl-C still acts.
        esc = []; poisonWith(depth ? "paste-content" : "escape");
        step(b, out);
        return;
      }
      if (esc.length === 6) finishEscape();
      return;
    }
    if (b === ESC) { esc = [b]; lastWasCR = false; return; }
    if (depth) {
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
      if (broken) throw new Error("control input needs reset() after an error");
      let bytes;
      try { bytes = bytesOf(chunk); } catch (e) { broken = true; clearLine(); throw e; }
      if (bytes === null) { broken = true; clearLine(); throw new RangeError("control input chunk too large"); }
      const out = [];
      for (let i = 0; i < bytes.length; i++) step(bytes[i], out);
      return freeze(out);
    },
    /** End of input: an unfinished line, paste or escape is rejected, never submitted. */
    end() {
      const out = [];
      if (esc.length || depth || latched || buf.length || poison) out.push(rejected("incomplete"));
      esc = []; depth = 0; latched = false; broken = false; lastWasCR = false; clearLine();
      return freeze(out);
    },
    /** Drop all state without emitting anything. */
    reset() { esc = []; depth = 0; latched = false; broken = false; lastWasCR = false; clearLine(); },
  });
}
