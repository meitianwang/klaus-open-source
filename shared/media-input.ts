/** Exact media MIME identities advertised by a model; parameters remain significant. */
const MEDIA_EXTENSIONS: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
}
const OPAQUE_MEDIA_MIME_TYPES = new Set(['video/audio/s16le', 'video/audio/wav', 'video/videoframe/jpeg2000', 'video/text/timestamp'])
export const MEDIA_INPUT_FILE_LIMIT = 18 * 1024 * 1024
export const MEDIA_INPUT_TOTAL_LIMIT = 45 * 1024 * 1024
export const MEDIA_INPUT_PART_LIMIT = 20

export function mediaInputMime(name: string, declared = ''): string | undefined {
  const mime = declared.trim().toLowerCase()
  if (OPAQUE_MEDIA_MIME_TYPES.has(mime)) return mime
  if (/^(audio|video)\/[a-z0-9!#$&^_.+-]+(?:;[^\r\n\0]*)?$/.test(mime)) return mime
  if (mime && mime !== 'application/octet-stream') return undefined
  const base = name.split(/[/\\]/).at(-1) ?? '', dot = base.lastIndexOf('.')
  return dot > 0 ? MEDIA_EXTENSIONS[base.slice(dot + 1).toLowerCase()] : undefined
}
