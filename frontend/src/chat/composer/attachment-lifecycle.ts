import type { PendingFileEntry } from '../engine-events'

/** Disposal can race an upload completion; each object URL is revoked once. */
export function disposeAttachmentObjectUrl(entry: { objectUrl?: string | null }): void {
  const url = entry.objectUrl
  entry.objectUrl = null
  if (url) URL.revokeObjectURL(url)
}

export function pendingPastedTextEntry(text: string): PendingFileEntry {
  return { kind: 'pasted-text', file: { name: 'pasted text', type: 'text/plain', size: text.length },
    objectUrl: null, uploadPath: null, uploading: true }
}

/** Resolve only into a retained draft; removed cards must not orphan host files. */
export async function settlePastedTextAttachment(pending: PendingFileEntry, text: string, lifecycle: {
  create(text: string): Promise<PendingFileEntry | null>
  retained(): boolean
  removeStored(path: string): Promise<unknown>
}): Promise<'ready' | 'failed' | 'discarded'> {
  const entry = await lifecycle.create(text)
  pending.uploading = false
  if (!lifecycle.retained()) {
    if (entry?.uploadPath) await lifecycle.removeStored(entry.uploadPath).catch(() => undefined)
    return 'discarded'
  }
  if (!entry) return 'failed'
  Object.assign(pending, entry, { uploading: false })
  return 'ready'
}
