// The `__klausBinary` envelope, reproduced decode-only.
//
// A JSON IPC boundary cannot carry an ArrayBuffer: it flattens to `{}`. The renderer
// therefore wraps every buffer in `{__klausBinary: "<standard base64>"}` before the
// call (`bridge/ipc.ts:17,37-55`), and the shell decodes that envelope.
//
// Decoding is NOT global. `decode_binary` is called from exactly four places, each
// naming one field: `voice.rs:1260` (`payload.data`), `voice.rs:1407`
// (`payload.data`), `accounts.rs:679` (`payload.buffer`), `files.rs:2008`
// (`payload.buffer`). There is no recursive walk over `args` in `dispatch_channel`.
// That matters for the router's design: it must pass args through UNTOUCHED and let
// a handler decode the field it expects. A router that eagerly decoded every
// base64-looking value would corrupt ordinary string arguments.
//
// There is no OUTBOUND encoder to reproduce. The shell never emits the envelope;
// bytes going back to the renderer ride per-channel field names (`dataBase64` at
// `feedback.rs:202`, `imageUrl` data URLs at `image_gen.rs:278`, screencast `data`
// at `iab_view.rs:225`). Keeping those names is what stays compatible, so this module
// deliberately exports no encode function.

/** The envelope key the renderer wraps buffers in (`ipc.ts:17`). */
export const BINARY_KEY = '__klausBinary';

/** A JSON value as it crosses the boundary. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Decode one field's binary payload, accepting the three forms `decode_binary`
 * accepts (`voice.rs:897-919`):
 *
 *  1. `{__klausBinary: "<base64>"}` — the envelope the renderer actually sends.
 *  2. `"<base64>"` — a bare string, so a hand-written probe can drive these channels.
 *  3. `[104, 105]` — an array of byte numbers, the same probe affordance.
 *
 * Anything else — including a bare `{}`, which is what a lost ArrayBuffer looks like
 * after JSON flattening — returns `undefined`, exactly as the Rust `Option` does.
 * The alphabet is STANDARD base64 (`+`/`/`, `=` padded), not URL-safe; the Rust side
 * uses `general_purpose::STANDARD`, and a URL-safe string would silently differ.
 */
export function decodeBinary(value: JsonValue | undefined, maxBytes = Infinity): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') {
    return fromBase64(value, maxBytes);
  }

  if (Array.isArray(value)) {
    if (value.length > maxBytes) return undefined;
    // Every element must be an integer byte. A non-numeric or out-of-range element
    // means this was never a byte array, so refuse rather than truncating.
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255) {
        return undefined;
      }
      bytes[index] = item;
    }
    return bytes;
  }

  if (typeof value === 'object') {
    const encoded = (value as { [key: string]: JsonValue })[BINARY_KEY];
    if (typeof encoded !== 'string') return undefined;
    return fromBase64(encoded, maxBytes);
  }

  return undefined;
}

/**
 * Decode standard base64 to bytes, or `undefined` if the string is not the exact
 * form the Rust side accepts.
 *
 * Two independent defects make a naive `Buffer.from` wrong here, and both are real:
 *
 *  1. It IGNORES characters outside the alphabet, so `"aGk!!!"` and `"a G k"` both
 *     decode to `[104,105]`. Rust returns `None` for those.
 *  2. It ignores non-zero trailing bits, so `"aG=="` decodes to `[104]` even though
 *     its last four bits are `0110` rather than the canonical `0000`. Rust rejects
 *     that too.
 *
 * So: a shape check first (catches defect 1, and pins canonical padding), then a
 * re-encode comparison (catches defect 2, which no regex can express).
 *
 * The strictness is the Rust decoder's, verified in base64 0.22.1 — the version the
 * retired shell's `Cargo.lock` resolved to (readable with
 * `git show c743c126^:apps/tauri/Cargo.lock`; the engine still pins base64 0.22).
 * `decode_binary` uses
 * `general_purpose::STANDARD`, which is `GeneralPurpose::new(&alphabet::STANDARD, PAD)`
 * (`engine/general_purpose/mod.rs:332`), and `PAD` is `GeneralPurposeConfig::new()`
 * (`mod.rs:347`) whose defaults are `decode_padding_mode: RequireCanonical`
 * (`mod.rs:262`) — padding REQUIRED, so unpadded `"aGk"` is refused — and
 * `decode_allow_trailing_bits: false` (`mod.rs:261`) — defect 2.
 *
 * Returning `undefined` rather than throwing matches the Rust `Option`: a channel
 * handed garbage answers "no bytes" and its own handler reports the bad request in
 * its own words (`voice.rs:897-919` ends in `.ok()`).
 */
function fromBase64(encoded: string, maxBytes: number): Uint8Array | undefined {
  // An empty payload is legal and decodes to zero bytes, as it does in Rust.
  if (encoded.length === 0) return new Uint8Array(0);
  if (encoded.length % 4 || encoded.length > Math.ceil(maxBytes / 3) * 4) return undefined;
  const buffer = Buffer.from(encoded, 'base64');
  // Re-encoding is canonical by construction, so an exact match proves the input had
  // no surplus bits and no dropped characters.
  if (buffer.length > maxBytes || buffer.toString('base64') !== encoded) return undefined;
  return buffer;
}

// Exact re-encoding also validates alphabet and padding. A repeated-group regex can
// overflow V8's regexp stack on valid multi-megabyte uploads, so no regex is needed.

/**
 * The first argument of an `args` array, as every shell handler reads it.
 *
 * `arg0` (`main.rs:5115-5117`) is `args.first().cloned().unwrap_or(Value::Null)`:
 * ONLY the first element is ever read, and a missing one is `null` rather than an
 * error. Handlers then pick their field out of that object, so the wire is
 * effectively `args: [payload]` — which is also how `mobile.rs` builds its call.
 * Reproducing `arg0` here keeps every ported handler's signature identical to the
 * Rust one instead of inventing a second argument convention.
 */
export function arg0(args: JsonValue[] | undefined): JsonValue {
  if (!Array.isArray(args) || args.length === 0) return null;
  const first = args[0];
  return first === undefined ? null : first;
}
