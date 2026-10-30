// Attachment contract shared by every collaboration surface that uploads a file.
//
// The allowlist is the server's own table (src/collaboration/files.ts): an
// extension is only accepted with the one media type it maps to, and the server
// re-checks the bytes against that type. Listing a pairing here that the server
// refuses would surface as file_type_not_allowed after a pointless upload, so
// this table is a copy of the server's, not a superset.
export const ATTACHMENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
export const ATTACHMENT_EXTENSIONS = Object.keys(ATTACHMENT_TYPES)
export const ATTACHMENT_INPUT_ACCEPT = ATTACHMENT_EXTENSIONS.map(extension => `.${extension}`).join(',')
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
/** The server rejects the 101st file in one scope; the client refuses the same one. */
export const ATTACHMENT_SCOPE_LIMIT = 100

export function attachmentExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}
/** The media type to declare for a picked file, or null when the pairing is not allowed. */
export function attachmentMediaType(name: string): string | null {
  return ATTACHMENT_TYPES[attachmentExtension(name)] ?? null
}
export function attachmentError(name: string, size: number): 'size' | 'type' | null {
  if (size > ATTACHMENT_MAX_BYTES) return 'size'
  return attachmentMediaType(name) ? null : 'type'
}
/** Canonical base64 of the picked bytes; the server rejects anything else. */
export async function encodeAttachment(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(binary)
}
export function attachmentSize(size: number): string {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
}
