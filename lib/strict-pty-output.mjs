// N6 prototype. Import-free and disconnected from the launcher.
export const PTY_OUTPUT_MAX_CHUNK = 16 * 1024;

const ESC = 0x1b, BEL = 0x07, LF = 0x0a, ST = 0x9c;
const OSC = 0x9d, DCS = 0x90, APC = 0x9f, PM = 0x9e, SOS = 0x98, CSI = 0x9b;
const TMUX_PREFIX = "tmux;";
const STRING_NAMES = { [OSC]: "osc", [DCS]: "dcs", [APC]: "apc", [PM]: "pm", [SOS]: "sos" };

// Read input views through intrinsic slots in the trusted launcher realm.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (key) => Object.getOwnPropertyDescriptor(typedArray, key).get;
const tagOf = getter(Symbol.toStringTag);
const lengthOf = getter("byteLength");
const offsetOf = getter("byteOffset");
const bufferOf = getter("buffer");
const valuesOf = typedArray.values;

function copyChunk(chunk) {
  if (tagOf.call(chunk) !== "Uint8Array") throw new TypeError("PTY output must be a Uint8Array");
  // Validate detached and out-of-bounds views through intrinsic slots.
  valuesOf.call(chunk);
  const length = lengthOf.call(chunk);
  if (length > PTY_OUTPUT_MAX_CHUNK) throw new RangeError("PTY output chunk too large");
  return new Uint8Array(new Uint8Array(bufferOf.call(chunk), offsetOf.call(chunk), length));
}

/** A single raw byte stream. push() returns plain text. end() closes it. */
export function createStrictPtyOutput() {
  let state = "text";
  let stringKind = 0;
  let stringEscape = false;
  let dcsPrefixLength = -1;
  let continuation = 0;
  let continuationMin = 0x80;
  let continuationMax = 0xbf;
  let closed = false;
  let pendingBytes = 0;

  // A C1-range byte can also be a UTF-8 continuation. Give a recognized
  // UTF-8 prefix priority so these bytes do not open or close strings.
  function unicodeByte(byte) {
    if (continuation && byte >= continuationMin && byte <= continuationMax) {
      continuation--;
      continuationMin = 0x80;
      continuationMax = 0xbf;
      return true;
    }
    continuation = 0;
    if (byte < 0xc2 || byte > 0xf4) return false;
    continuation = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : 3;
    continuationMin = byte === 0xe0 ? 0xa0 : byte === 0xf0 ? 0x90 : 0x80;
    continuationMax = byte === 0xed ? 0x9f : byte === 0xf4 ? 0x8f : 0xbf;
    return true;
  }

  function startString(kind) {
    state = "string";
    stringKind = kind;
    stringEscape = false;
    dcsPrefixLength = kind === DCS ? 0 : -1;
  }

  function discardStringByte(byte, unicode) {
    if (dcsPrefixLength >= 0 && dcsPrefixLength < TMUX_PREFIX.length) {
      dcsPrefixLength = byte === TMUX_PREFIX.charCodeAt(dcsPrefixLength) ? dcsPrefixLength + 1 : -1;
    }
    const wrapped = dcsPrefixLength === TMUX_PREFIX.length;
    if ((!unicode && byte === ST && !wrapped) || (byte === BEL && stringKind === OSC)
      || (stringEscape && byte === 0x5c)) {
      state = "text";
      return;
    }
    // In a transparent DCS wrapper, doubled ESC quotes a payload ESC.
    // Consume such pairs for any DCS so a quoted ESC cannot begin ST.
    stringEscape = byte === ESC && !(stringKind === DCS && stringEscape);
  }

  function plainByte(byte) {
    const unicode = unicodeByte(byte);
    if (state === "string") {
      discardStringByte(byte, unicode);
      return false;
    }
    if (unicode) return false;
    // Seven-bit C1 controls use ESC followed by the C1 byte minus 0x40.
    const control = state === "escape" && byte >= 0x40 && byte <= 0x5f ? byte + 0x40 : byte;
    if (byte === ESC) {
      state = "escape";
    } else if (control === CSI) {
      state = "csi";
    } else if (control === OSC || control === DCS || control === APC || control === PM || control === SOS) {
      startString(control);
    } else if (state === "escape" || state === "escape-intermediate") {
      if (byte >= 0x20 && byte <= 0x2f) state = "escape-intermediate";
      if (byte >= 0x30 && byte <= 0x7e) state = "text";
    } else if (state === "csi") {
      if (byte >= 0x40 && byte <= 0x7e) state = "text";
    } else {
      return byte === LF || (byte >= 0x20 && byte <= 0x7e);
    }
    return false;
  }

  return Object.freeze({
    push(chunk) {
      if (closed) throw new Error("PTY output stream is closed");
      let bytes;
      try {
        bytes = copyChunk(chunk);
      } catch (error) {
        closed = true;
        throw error;
      }
      let text = "";
      for (const byte of bytes) {
        // Count the bytes consumed inside sequences since the last emitted one,
        // so re-arming a sequence can't keep the count small. Bytes discarded in
        // text state (CR, tabs, non-ASCII) hide nothing and aren't counted.
        const inSequence = state !== "text";
        if (plainByte(byte)) {
          text += String.fromCharCode(byte);
          pendingBytes = 0;
        } else if (inSequence && pendingBytes < Number.MAX_SAFE_INTEGER) pendingBytes++;
      }
      return text;
    },
    end() {
      closed = true;
      return "";
    },
    // For the launcher's own chrome, never the transcript: whether an
    // unfinished control string, CSI or escape sequence is discarding output
    // now (or was at end()), its kind, and how many bytes were discarded since
    // the last emitted byte. null when nothing is withheld.
    withheld() {
      if (state === "text") return null;
      const kind = state === "string" ? STRING_NAMES[stringKind] : state === "csi" ? "csi" : "escape";
      return Object.freeze({ kind, bytes: pendingBytes });
    },
  });
}
