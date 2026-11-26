import { crc32, deflateRawSync } from 'node:zlib';
import * as yauzl from 'yauzl';
import { OfficeParseError } from './xml';

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

function normalizeZipEntryName(name: string): string {
  const cleaned = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0') || cleaned.split('/').some(seg => seg === '..')) {
    throw new OfficeParseError('corrupted', `Invalid archive entry path: ${name}`);
  }
  return cleaned;
}

/**
 * Reads every file entry from an existing ZIP archive into memory so modified XML/JSON
 * parts can be replaced losslessly while preserving untouched media, themes, styles,
 * macros, relationships, and metadata byte-for-byte.
 */
export function readAllZipEntries(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(new OfficeParseError('corrupted', openErr?.message ?? 'Invalid archive'));
        return;
      }
      const entries = new Map<string, Buffer>();
      let count = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closed */ }
        reject(err);
      };
      zip.on('error', err => fail(new OfficeParseError('corrupted', err.message)));
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closed */ }
        resolve(entries);
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if ((entry.generalPurposeBitFlag & 1) !== 0) {
          fail(new OfficeParseError('encrypted', 'Encrypted archive'));
          return;
        }
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        count += 1;
        if (count > MAX_ARCHIVE_ENTRIES) {
          fail(new OfficeParseError('too_large', 'Archive contains too many entries'));
          return;
        }
        let normalized: string;
        try {
          normalized = normalizeZipEntryName(entry.fileName);
        } catch {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(new OfficeParseError('corrupted', streamErr?.message ?? 'Unreadable archive entry'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
              stream.destroy(new OfficeParseError('too_large', 'Archive uncompressed content exceeds safety limit'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', err => fail(err instanceof OfficeParseError ? err : new OfficeParseError('corrupted', err.message)));
          stream.on('end', () => {
            entries.set(normalized, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

export interface BuildZipOptions {
  /** Entry name that must appear first and uncompressed (e.g. `mimetype` for ODF). */
  storedFirstEntry?: string;
}

/**
 * Builds a standard-compliant ZIP buffer (UTF-8 filenames flag 0x0800, deflate compression
 * when smaller than raw, or stored uncompressed when `storedFirstEntry` matches or raw is smaller).
 */
export function buildZipBuffer(entries: Iterable<[string, Buffer | string]>, options: BuildZipOptions = {}): Buffer {
  const ordered: Array<[string, Buffer]> = [];
  let firstEntry: [string, Buffer] | undefined;
  for (const [rawName, content] of entries) {
    const name = normalizeZipEntryName(rawName);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (options.storedFirstEntry && name === options.storedFirstEntry) {
      firstEntry = [name, buf];
    } else {
      ordered.push([name, buf]);
    }
  }
  if (firstEntry) ordered.unshift(firstEntry);

  const { time, date } = dosDateTime();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [path, uncompressed] of ordered) {
    const nameBytes = Buffer.from(path, 'utf8');
    const forceStored = options.storedFirstEntry === path || uncompressed.length === 0;
    const deflated = forceStored ? uncompressed : deflateRawSync(uncompressed, { level: 6 });
    const useDeflate = !forceStored && deflated.length < uncompressed.length;
    const payload = useDeflate ? deflated : uncompressed;
    const method = useDeflate ? 8 : 0;
    const flags = 0x0800; // UTF-8 file name encoding
    const sum = crc32(uncompressed) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, payload);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const count = ordered.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export async function patchZipBuffer(
  existingBytes: Buffer | undefined,
  updates: Record<string, Buffer | string | null>,
  options: BuildZipOptions = {},
): Promise<Buffer> {
  const entries = existingBytes && existingBytes.length >= 4 && (existingBytes.readUInt32LE(0) === 0x04034b50 || existingBytes.readUInt32LE(0) === 0x06054b50)
    ? await readAllZipEntries(existingBytes)
    : new Map<string, Buffer>();
  for (const [rawKey, value] of Object.entries(updates)) {
    const key = normalizeZipEntryName(rawKey);
    if (value === null) entries.delete(key);
    else entries.set(key, typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
  }
  return buildZipBuffer(entries, options);
}
