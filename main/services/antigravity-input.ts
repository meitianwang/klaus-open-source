import type { Json } from '../ipc/contract';
import { object, string, type JsonObject } from './service-types';
import { mediaInputMime, MEDIA_INPUT_FILE_LIMIT, MEDIA_INPUT_PART_LIMIT, MEDIA_INPUT_TOTAL_LIMIT } from '../../shared/media-input';

/** Native input has stricter wire and aggregate bounds than ordinary queued file references. */
export function validateAntigravityQueueInput(value: Json | undefined): void {
  const text = (raw: unknown): void => { if (typeof raw !== 'string' || raw.length > 1024 * 1024 || raw.includes('\0')) throw new Error('Input text is invalid or too large'); };
  if (typeof value === 'string') { text(value); return; }
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Input must contain between 1 and 32 parts');
  let totalBytes = 0, count = 0;
  for (const part of value) {
    const row = object(part), image = row.type === 'image', document = row.type === 'document', media = row.type === 'media';
    const keys = row.type === 'text' ? ['type', 'text'] : image ? ['type', 'base64', 'mimeType'] : ['type', 'base64', 'mimeType', 'filename'];
    if (!part || typeof part !== 'object' || Array.isArray(part) || Object.keys(row).some(key => !keys.includes(key))) throw new Error('Unexpected or missing request fields');
    if (row.type === 'text') { text(row.text); continue; }
    if (!image && !document && !media) throw new Error('Unsupported input part');
    if (image ? !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(string(row.mimeType))
      : media ? mediaInputMime('', string(row.mimeType)) !== row.mimeType : row.mimeType !== 'application/pdf') throw new Error('Unsupported input MIME type');
    const data = string(row.base64);
    if (!data || data.length > 24 * 1024 * 1024 || data.length % 4 !== 0) throw new Error('Invalid input base64');
    const decoded = Buffer.from(data, 'base64');
    if (decoded.toString('base64') !== data) throw new Error('Invalid input base64');
    if (media && decoded.length > MEDIA_INPUT_FILE_LIMIT) throw new Error('Media input exceeds the per-file limit');
    totalBytes += decoded.length; count++;
    if (totalBytes > MEDIA_INPUT_TOTAL_LIMIT || count > MEDIA_INPUT_PART_LIMIT) throw new Error('Inline attachment budget exceeded');
    if ((document || media) && row.filename !== undefined) text(row.filename);
  }
}

export function antigravityMediaExtension(mime: string, known: (mime: string) => string | undefined): string | undefined {
  const exact = mediaInputMime('', mime);
  if (!exact) return undefined;
  const base = exact.split(';', 1)[0]!;
  const aliases: Record<string, string> = { 'audio/webm': 'webm', 'audio/mp3': 'mp3', 'audio/m4a': 'm4a',
    'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav' };
  return known(base) ?? aliases[base] ?? 'bin';
}

/** Only a native media block can replace a recorded upload with its durable pooled copy. */
export function antigravityMediaDisplay(localRender: JsonObject, blocks: Json[], exists: (path: string) => boolean): { localRender: JsonObject; blocks: Json[] } | undefined {
  const matched = new Set<Json>();
  const attachments = (Array.isArray(localRender.attachments) ? localRender.attachments : []).map(attachment => {
    const file = object(attachment), name = string(file.name), mime = string(file.mimeType);
    if (!mediaInputMime('', mime) || !name) return attachment;
    const media = blocks.find(block => {
      const candidate = object(block);
      return !matched.has(block) && candidate.type === 'media' && candidate.filename === name && candidate.mimeType === mime;
    });
    if (media === undefined) return attachment;
    matched.add(media);
    const original = string(file.path), pooled = string(object(media).path);
    return !pooled || exists(original) ? attachment : { ...file, path: pooled, ...(original ? { originalPath: string(file.originalPath) || original } : {}) };
  });
  if (!matched.size) return undefined;
  return { localRender: { ...localRender, attachments }, blocks: blocks.filter(block => !matched.has(block)) };
}

export function antigravityEditMetadata(row: Record<string, Json> | undefined, fallback: Json): Json {
  const rendered = object(row?.localRender);
  const restored = Array.isArray(rendered.attachments) && rendered.attachments.some(value => {
    const file = object(value);
    return Boolean(string(file.originalPath) && mediaInputMime('', string(file.mimeType)));
  });
  return restored ? row!.localRender! : fallback;
}
