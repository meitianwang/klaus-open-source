import { endianness } from 'node:os';
import { BrowserError, object, type BrowserObject } from './types';

export const MAX_CHROME_FRAME = 8 * 1024 * 1024;
export const MAX_NATIVE_OUTBOUND = 1024 * 1024;

/** Chrome native messaging uses native endian; Klaus relay clients use LE. */
export function chromeFrame(message: BrowserObject, native = false, maximum = MAX_CHROME_FRAME): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > maximum) throw new BrowserError('invalid_request', 'Chrome relay message is too large.');
  const result = Buffer.allocUnsafe(4 + body.length);
  if (native && endianness() === 'BE') result.writeUInt32BE(body.length); else result.writeUInt32LE(body.length);
  body.copy(result, 4); return result;
}

export class ChromeFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly native = false) {}
  push(chunk: Buffer): BrowserObject[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: BrowserObject[] = [];
    while (this.buffer.length >= 4) {
      const length = this.native && endianness() === 'BE' ? this.buffer.readUInt32BE() : this.buffer.readUInt32LE();
      if (!length || length > MAX_CHROME_FRAME) throw new BrowserError('invalid_request', 'Invalid Chrome relay frame size.');
      if (this.buffer.length < length + 4) break;
      const value: unknown = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BrowserError('invalid_request', 'Chrome relay messages must be JSON objects.');
      messages.push(object(value)); this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}
