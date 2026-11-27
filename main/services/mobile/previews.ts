import { basename } from 'node:path';
import type { MediaFiles } from '../media-files';
import type { JsonObject } from '../service-types';
import { badRequest, MobileError } from './protocol';

// Base64 and its JSON envelope must fit the relay's ordinary response limit.
export const MOBILE_MEDIA_PREVIEW_LIMIT = 16 * 1024 * 1024;
export const MOBILE_MEDIA_DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

export interface MobileMediaPreviewOptions {
  offset?: unknown;
  length?: unknown;
}

interface ParsedMediaRange {
  offset: number;
  length: number;
}

function assertSupportedMediaMime(mimeType: string): void {
  if (!/^(?:image|audio|video)\//u.test(mimeType) && mimeType !== 'application/pdf') {
    throw new MobileError(415, 'unsupported_media_type', 'Use the file preview for this file type');
  }
}

export function parseMediaPreviewRange(options?: MobileMediaPreviewOptions): ParsedMediaRange | undefined {
  if (!options || (options.offset === undefined && options.length === undefined)) return undefined;
  const offset = options.offset === undefined ? 0 : options.offset;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw badRequest('offset must be a non-negative integer');
  }
  const requestedLength = options.length === undefined ? MOBILE_MEDIA_DEFAULT_CHUNK_BYTES : options.length;
  if (typeof requestedLength !== 'number' || !Number.isSafeInteger(requestedLength) || requestedLength < 0) {
    throw badRequest('length must be a non-negative integer');
  }
  return { offset, length: Math.min(requestedLength, MOBILE_MEDIA_PREVIEW_LIMIT) };
}

/** Reuse desktop capabilities so mobile cannot bypass session scope or revocation. */
export async function mobileMediaPreview(
  media: Pick<MediaFiles, 'grant' | 'respond'>,
  sessionId: string,
  path: string,
  signal: AbortSignal,
  options?: MobileMediaPreviewOptions,
): Promise<JsonObject> {
  const range = parseMediaPreviewRange(options);
  signal.throwIfAborted();
  let url: string;
  try { url = await media.grant(path, sessionId); }
  catch { throw new MobileError(403, 'media_unavailable', 'The media is unavailable in this conversation'); }
  signal.throwIfAborted();

  if (!range) {
    const response = await media.respond(new Request(url, { signal }));
    const reader = response.body?.getReader();
    try {
      if (!response.ok) throw new MobileError(response.status, 'media_unavailable', 'The media is no longer available');
      const mimeType = response.headers.get('content-type') || '';
      assertSupportedMediaMime(mimeType);
      if (Number(response.headers.get('content-length')) > MOBILE_MEDIA_PREVIEW_LIMIT) {
        throw new MobileError(413, 'media_too_large', 'Media preview exceeds the 16 MiB limit');
      }
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) while (true) {
        signal.throwIfAborted();
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MOBILE_MEDIA_PREVIEW_LIMIT) throw new MobileError(413, 'media_too_large', 'Media preview exceeds the 16 MiB limit');
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      return { sessionId, path, fileName: basename(path), mimeType, data: Buffer.concat(chunks).toString('base64') };
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  }

  if (range.length === 0) {
    const response = await media.respond(new Request(url, { method: 'HEAD', signal }));
    const reader = response.body?.getReader();
    try {
      if (!response.ok) throw new MobileError(response.status, 'media_unavailable', 'The media is no longer available');
      const mimeType = response.headers.get('content-type') || '';
      assertSupportedMediaMime(mimeType);
      const totalSize = Number(response.headers.get('content-length') ?? 0);
      if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
        throw new MobileError(500, 'invalid_media', 'Media length is unavailable');
      }
      const version = response.headers.get('etag') || undefined;
      return {
        sessionId,
        path,
        fileName: basename(path),
        mimeType,
        offset: Math.min(range.offset, totalSize),
        byteLength: 0,
        totalSize,
        eof: range.offset >= totalSize,
        ...(version ? { version } : {}),
        data: '',
      };
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  }

  const end = range.offset + range.length - 1;
  const response = await media.respond(new Request(url, { headers: { range: `bytes=${range.offset}-${end}` }, signal }));
  const reader = response.body?.getReader();
  try {
    const mimeType = response.headers.get('content-type') || '';
    const version = response.headers.get('etag') || undefined;
    if (response.status === 416) {
      if (mimeType) assertSupportedMediaMime(mimeType);
      const unsatisfied = /^bytes \*\/(\d+)$/u.exec(response.headers.get('content-range') || '');
      const totalSize = unsatisfied ? Number(unsatisfied[1]) : Number.NaN;
      if (Number.isSafeInteger(totalSize) && totalSize >= 0 && range.offset >= totalSize) {
        return {
          sessionId,
          path,
          fileName: basename(path),
          mimeType,
          offset: totalSize,
          byteLength: 0,
          totalSize,
          eof: true,
          ...(version ? { version } : {}),
          data: '',
        };
      }
      throw new MobileError(416, 'invalid_media_range', 'Requested media range is invalid');
    }
    if (!response.ok) throw new MobileError(response.status, 'media_unavailable', 'The media is no longer available');
    assertSupportedMediaMime(mimeType);

    if (response.status === 206) {
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') || '');
      if (!contentRange) throw new MobileError(500, 'invalid_media', 'Media range metadata is missing');
      const start = Number(contentRange[1]);
      const rangeEnd = Number(contentRange[2]);
      const totalSize = Number(contentRange[3]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(rangeEnd) || !Number.isSafeInteger(totalSize)
        || start !== range.offset || rangeEnd < start || rangeEnd - start + 1 > range.length) {
        throw new MobileError(500, 'invalid_media', 'Media range metadata is invalid');
      }
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) while (true) {
        signal.throwIfAborted();
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > range.length) throw new MobileError(500, 'invalid_media', 'Media chunk exceeded requested range');
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      const buffer = Buffer.concat(chunks);
      return {
        sessionId,
        path,
        fileName: basename(path),
        mimeType,
        offset: start,
        byteLength: buffer.byteLength,
        totalSize,
        eof: start + buffer.byteLength >= totalSize,
        ...(version ? { version } : {}),
        data: buffer.toString('base64'),
      };
    }

    const declaredTotal = response.headers.get('content-length');
    const parsedTotal = declaredTotal !== null ? Number(declaredTotal) : undefined;
    const chunks: Uint8Array[] = [];
    let cursor = 0;
    let captured = 0;
    if (reader) while (true) {
      signal.throwIfAborted();
      const next = await reader.read(); if (next.done) break;
      const chunk = next.value;
      const chunkStart = cursor;
      const chunkEnd = cursor + chunk.byteLength;
      cursor = chunkEnd;
      if (chunkEnd <= range.offset) continue;
      if (captured < range.length && chunkStart < range.offset + range.length) {
        const sliceStart = Math.max(0, range.offset - chunkStart);
        const sliceEnd = Math.min(chunk.byteLength, range.offset + range.length - chunkStart);
        if (sliceEnd > sliceStart) {
          chunks.push(chunk.subarray(sliceStart, sliceEnd));
          captured += sliceEnd - sliceStart;
        }
      }
      if (captured >= range.length && parsedTotal !== undefined && Number.isSafeInteger(parsedTotal) && parsedTotal >= cursor) {
        break;
      }
    }
    signal.throwIfAborted();
    const totalSize = parsedTotal !== undefined && Number.isSafeInteger(parsedTotal) && parsedTotal >= cursor ? parsedTotal : cursor;
    const buffer = Buffer.concat(chunks);
    const effectiveOffset = Math.min(range.offset, totalSize);
    return {
      sessionId,
      path,
      fileName: basename(path),
      mimeType,
      offset: effectiveOffset,
      byteLength: buffer.byteLength,
      totalSize,
      eof: effectiveOffset + buffer.byteLength >= totalSize,
      ...(version ? { version } : {}),
      data: buffer.toString('base64'),
    };
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
