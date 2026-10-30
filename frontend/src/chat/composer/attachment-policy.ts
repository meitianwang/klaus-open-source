// How an attachment reaches the model, and how big it may be.
//
// Klaus used to inline EVERY attachment as a base64 content part, which forced a
// type whitelist: the model only accepts image and document parts, so a `.docx`
// or a `.zip` had nowhere to go and the whole message was refused. Images still
// need inlining — a model cannot "look at" a path — but everything else is better
// served by handing over the path and letting the agent's own read tool open it.
// Klaus's `read` tool already delivers PDFs as native document blocks with page ranges, so a referenced PDF
// loses nothing and gains freedom from the inline size cap.
//
// The rule lives here because four call sites need it (main and side composer,
// each for File objects and for disk paths). Written out four times it drifts,
// and it already had: the path-based entry point never checked size at all.

/** Extensions the model can receive as an inline image content part. */
const INLINE_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp']

/** MIME types accepted as an inline image, including the legacy `x-png` spelling. */
const INLINE_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/x-png',
  'image/gif',
  'image/webp',
]

/** Inlined bytes ride inside the message, so this cap is about the request. */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * Referenced files never enter the message — only their path does. The cap is
 * here because the bytes are still copied into the uploads dir over IPC, so it
 * bounds renderer memory rather than request size.
 */
export const MAX_REFERENCED_FILE_BYTES = 45 * 1024 * 1024

function extensionOf(name: string): string {
  const base = String(name || '').split(/[/\\]/).pop() || ''
  const dot = base.lastIndexOf('.')
  // `dot > 0` keeps a dotfile like `.gitignore` from reading as extension "gitignore".
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * Whether this attachment is delivered as an inline image part. MIME wins when
 * present because a screenshot pasted from the clipboard often has no filename
 * worth trusting; the extension is the fallback for path-imported files, which
 * arrive with no MIME at all.
 */
export function isInlineImage(name: string, mimeType?: string | null): boolean {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim()
  if (mime) return INLINE_IMAGE_MIME_TYPES.includes(mime)
  return INLINE_IMAGE_EXTENSIONS.includes(extensionOf(name))
}

/** Byte ceiling for this attachment, which depends on how it will be delivered. */
export function maxAttachmentBytes(name: string, mimeType?: string | null): number {
  return isInlineImage(name, mimeType) ? MAX_INLINE_IMAGE_BYTES : MAX_REFERENCED_FILE_BYTES
}

/** `null` when the attachment fits, otherwise the ceiling it exceeded. */
export function attachmentSizeRejection(
  name: string,
  size: number,
  mimeType?: string | null,
): number | null {
  const limit = maxAttachmentBytes(name, mimeType)
  return Number(size) > limit ? limit : null
}

/**
 * Human-readable byte count for attachment chips. Lives here because every
 * surface that shows an attachment (composer row, sent bubble, question card)
 * must print the same number for the same file.
 */
export function formatAttachmentSize(size: number | undefined): string {
  const bytes = Number(size) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`
}
