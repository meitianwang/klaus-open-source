// Restored message cards and immutable attachment identities shared by rewind and inline editing.
import type { PendingFileEntry } from '../engine-events'
import { isInlineImage } from './attachment-policy'
import { parseSelectedTextEnvelope } from '../selected-text-envelope'

export interface RestoredMessageDraft {
  text?: string | null
  attachments?: unknown
  displayMetadata?: any
}

export function restoredMessageTextCards(prepared: RestoredMessageDraft) {
  const metadata = prepared.displayMetadata
  const envelope = parseSelectedTextEnvelope(String(prepared.text || ''))
  const selections = Array.isArray(metadata?.selectedTextAttachments) ? metadata.selectedTextAttachments : []
  const quotedText = typeof metadata?.quotedText === 'string' ? metadata.quotedText : ''
  const selectedTextAttachments = selections.length ? selections
    : envelope?.selectedTextAttachments || (quotedText ? [{ text: quotedText, requestOffset: 0 }] : [])
  const text = typeof metadata?.displayText === 'string' ? metadata.displayText
    : metadata?.quoteOnly === true ? '' : envelope?.message ?? String(prepared.text || '')
  return {
    text,
    selectedTextAttachments,
    pastedCards: Array.isArray(metadata?.pastedCards) ? metadata.pastedCards : [],
  }
}

/** Basename of a path, for naming an attachment recovered from history. */
function basenameOf(path: string): string {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || 'attachment'
}

/**
 * Rebuild one sent attachment as a pending composer entry.
 *
 * `path` is the content-addressed pool copy the host read back out of the engine's
 * history, so it is already on disk: the entry is born uploaded (`uploading: false`,
 * `uploadPath` set) and never round-trips through `chat:upload`. That flag is load-bearing
 * twice over — it keeps the chip enabled instead of greyed, and it keeps `hasUploadInFlight`
 * from parking the user's Send waiting on an upload that will never happen.
 *
 * The thumbnail goes through the media channel, exactly as a sent bubble's does: a raw
 * filesystem path in an `<img>` is a broken image. Non-images get no preview at all and
 * render as a filename chip instead.
 *
 * Classification (inline image vs. path reference) is decided by `isInlineImage(name, mime)`
 * — the SAME call the fresh-send path uses — so an edited message re-delivers each file the
 * way it was first delivered. The recorded MIME wins over the name's extension: the pool
 * path always carries the true extension, but the display name a message recorded may not,
 * and guessing the delivery from a cosmetic rename would silently change how the file is
 * sent. A text-referenced file has no recorded MIME and falls back to its (upload-path)
 * extension, which is exactly the evidence a fresh path import has.
 */
export function pendingEntryFromPoolPath(
  path: string,
  name: string | undefined,
  mimeType: string | undefined,
  mediaUrl: (path: string) => string,
): PendingFileEntry {
  const fileName = String(name || '').trim() || basenameOf(path)
  const mime = /[/\\]$/.test(path) ? 'inode/directory' : String(mimeType || '').trim()
  // Classified from the recorded MIME, else from the POOL PATH's extension — never from the
  // display name. The pool path is written by `storeBytes` with the extension of the MIME it
  // resolved at ingest, so it is authoritative; a display name is cosmetic and a renamed file
  // must not change how it is delivered. A text-referenced file has no MIME and no pool path,
  // and falls back to its upload-path extension, the same evidence a fresh path import has.
  const isImage = mime ? isInlineImage(fileName, mime) : isInlineImage(basenameOf(path), null)
  return {
    file: { name: fileName, type: mime, size: 0 },
    objectUrl: isImage ? (mediaUrl(path) || null) : null,
    uploadPath: String(path),
    uploading: false,
    sourcePath: String(path),
  }
}

/**
 * The attachment list the host handed back, as pending composer entries.
 *
 * Entries with no usable path are dropped rather than passed through: they would render a
 * chip that silently sends nothing, which reads as an attachment the model ignored.
 */
export function pendingEntriesFromPrepare(
  attachments: unknown,
  mediaUrl: (path: string) => string,
): PendingFileEntry[] {
  if (!Array.isArray(attachments)) return []
  const entries: PendingFileEntry[] = []
  for (const raw of attachments) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path : ''
    if (!path) continue
    entries.push(pendingEntryFromPoolPath(path,
      typeof record.name === 'string' ? record.name : undefined,
      typeof record.mimeType === 'string' ? record.mimeType : undefined,
      mediaUrl))
  }
  return entries
}

/**
 * Whether this composer content is worth sending as an edit.
 *
 * Empty is refused here rather than sent: an edit truncates the conversation from its
 * target onward, so submitting nothing would delete the message and its whole turn and
 * replace them with an empty one.
 */
export function editCanSubmit(text: string, attachmentCount: number): boolean {
  return !!String(text || '').trim() || attachmentCount > 0
}
