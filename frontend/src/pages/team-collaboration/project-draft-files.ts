import type { DraftAttachment } from './data'

export const DRAFT_FILE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.pps', '.ppsx', '.xls', '.xlsx', '.xltx', '.xltm', '.html', '.txt']
export const DRAFT_FILE_LIMIT = 10 * 1024 * 1024
export const DRAFT_FILE_COUNT = 5
export interface SelectedDraftFile { id: string; file: File }
export function draftFileError(name: string, size: number): 'tc_attachment_size' | 'tc_attachment_type' | null {
  if (size > DRAFT_FILE_LIMIT) return 'tc_attachment_size'
  return DRAFT_FILE_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension)) ? null : 'tc_attachment_type'
}
export async function encodeDraftFile({ id, file }: SelectedDraftFile): Promise<DraftAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return { id, name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, base64: btoa(binary) }
}
