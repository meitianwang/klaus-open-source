import { basename } from 'node:path';
import type { MediaFiles } from '../media-files';
import type { JsonObject } from '../service-types';
import { MobileError } from './protocol';

// Base64 and its JSON envelope must fit the relay's ordinary response limit.
export const MOBILE_MEDIA_PREVIEW_LIMIT = 16 * 1024 * 1024;

/** Reuse desktop capabilities so mobile cannot bypass session scope or revocation. */
export async function mobileMediaPreview(media: Pick<MediaFiles, 'grant' | 'respond'>, sessionId: string, path: string, signal: AbortSignal): Promise<JsonObject> {
  signal.throwIfAborted();
  let url: string;
  try { url = await media.grant(path, sessionId); }
  catch { throw new MobileError(403, 'media_unavailable', 'The media is unavailable in this conversation'); }
  signal.throwIfAborted();
  const response = await media.respond(new Request(url, { signal }));
  const reader = response.body?.getReader();
  try {
    if (!response.ok) throw new MobileError(response.status, 'media_unavailable', 'The media is no longer available');
    const mimeType = response.headers.get('content-type') || '';
    if (!/^(?:image|audio|video)\//u.test(mimeType) && mimeType !== 'application/pdf') {
      throw new MobileError(415, 'unsupported_media_type', 'Use the file preview for this file type');
    }
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
