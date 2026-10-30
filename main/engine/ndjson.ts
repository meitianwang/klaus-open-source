// NDJSON framing for the engine's stdout.
//
// Ported from `klaus-host-core/src/rpc.rs:209` (`BufReader::new(input).lines()`),
// which is the framing the engine and the Rust host agree on: one JSON object per
// line, '\n' terminated.
//
// Plan §6.1 item 2 requires this to handle "跨 chunk、多帧、UTF-8、大消息、错误帧"
// (frames split across chunks, several frames in one chunk, UTF-8 split across a
// chunk boundary, large messages, and unparseable frames). Node's `data` event
// hands back raw Buffers, so two hazards exist that Rust's `lines()` does not have:
//
//   1. A multi-byte UTF-8 character can be split across two chunks. Concatenating
//      with `buf.toString()` per chunk produces U+FFFD -- exactly the corruption
//      the addon slice's UTF-8 decoder tests pinned. `StringDecoder` holds the
//      incomplete tail back until the rest arrives.
//   2. There is no maximum line length, so a large message (a big tool result) is
//      simply buffered until its newline. That is correct behaviour, but the buffer
//      is unbounded by design, matching the Rust side.
//
// An unparseable frame is NOT dropped here. The reader reports it so the caller can
// surface a protocol failure instead of silently hanging on a reply that will never
// be matched -- the same reasoning as `rpc.rs:232-239`.

import { StringDecoder } from 'node:string_decoder';

/** One complete line, with the trailing '\n' (and any '\r') removed. */
export type LineHandler = (line: string) => void;

/**
 * Incremental NDJSON splitter. Feed it raw chunks; it calls `onLine` once per
 * complete frame, in wire order.
 *
 * Mirrors tokio's `lines()`: splits on '\n' and strips a trailing '\r', so a
 * CRLF-terminated stream decodes identically.
 */
export class NdjsonFramer {
  private readonly decoder = new StringDecoder('utf8');
  /**
   * Decoded chunks of the line still being accumulated, oldest first. Kept as
   * SEPARATE strings on purpose: concatenating each chunk onto one growing buffer
   * copies the whole incomplete line per chunk, which is quadratic in the size of
   * a large frame -- a single 90 MB history reply would spend minutes re-copying
   * itself. Chunks are joined exactly once, when their line completes.
   */
  private parts: string[] = [];
  /** Count of complete frames emitted, for diagnostics. */
  frames = 0;
  /** Count of frames dropped as unparseable, for diagnostics. */
  unparseable = 0;

  constructor(private readonly onLine: LineHandler) {}

  /** Feed one raw chunk from the stream. */
  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    // Scan ONLY the newly arrived text: no earlier chunk can contain a newline,
    // because everything up to the last one was already emitted or is parked in
    // `parts`, and `parts` is newline-free by construction. This is what keeps a
    // chunk's cost proportional to the chunk instead of to the accumulated line.
    let from = 0;
    let newline: number;
    // Several frames may arrive in one chunk; emit all of them in order.
    while ((newline = text.indexOf('\n', from)) >= 0) {
      const line = this.parts.length ? this.parts.join('') + text.slice(from, newline) : text.slice(from, newline);
      this.parts = [];
      from = newline + 1;
      this.emit(line);
    }
    if (from < text.length) this.parts.push(text.slice(from));
  }

  /**
   * Flush at end of stream. tokio's `lines()` yields a final line with no trailing
   * newline before EOF, so a frame the engine wrote without '\n' must still be
   * delivered -- otherwise a terminating message is lost on a clean exit.
   */
  end(): void {
    const tail = this.decoder.end();
    const line = this.parts.length || tail ? this.parts.join('') + tail : '';
    this.parts = [];
    this.emit(line);
  }

  private emit(line: string): void {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const trimmed = line.trim();
    // `rpc.rs:227-229` skips blank lines rather than reporting them.
    if (trimmed.length === 0) return;
    this.frames++;
    this.onLine(trimmed);
  }
}

/**
 * Parse one frame, distinguishing the two failure modes the host must tell apart:
 * invalid JSON (a protocol error to surface) versus valid JSON that is not an
 * object (also a protocol error -- the engine never sends a bare scalar).
 */
export function parseFrame(line: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not a JSON object' };
  }
  return { ok: true, value };
}
