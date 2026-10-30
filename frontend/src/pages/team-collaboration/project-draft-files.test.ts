import { describe, expect, test } from 'bun:test'
import { DRAFT_FILE_COUNT, DRAFT_FILE_EXTENSIONS, DRAFT_FILE_LIMIT, draftFileError, encodeDraftFile } from './project-draft-files'

describe('project draft context files', () => {
  test('permits the documented image and document extensions, no more than five files', () => {
    expect(DRAFT_FILE_COUNT).toBe(5)
    for (const extension of DRAFT_FILE_EXTENSIONS) expect(draftFileError(`Requirements${extension.toUpperCase()}`, 1024)).toBeNull()
    for (const name of ['payload.exe', 'file.sh', 'archive.zip', 'picture.png.exe', 'no-extension']) expect(draftFileError(name, 10)).toBe('tc_attachment_type')
  })
  test('accepts the exact ten-MiB boundary and rejects larger files', () => {
    expect(DRAFT_FILE_LIMIT).toBe(10485760)
    expect(draftFileError('context.pdf', DRAFT_FILE_LIMIT)).toBeNull()
    expect(draftFileError('context.pdf', DRAFT_FILE_LIMIT + 1)).toBe('tc_attachment_size')
  })
  test('preserves binary bytes across chunk boundaries instead of decoding them as text', async () => {
    const bytes = Uint8Array.from({ length: 70001 }, (_, index) => index % 256)
    const file = new File([bytes], 'diagram.png', { type: 'image/png' })
    const payload = await encodeDraftFile({ id: 'file-1', file })
    expect(payload.id).toBe('file-1')
    expect(payload.name).toBe('diagram.png')
    expect(payload.mimeType).toBe('image/png')
    expect(payload.size).toBe(bytes.length)
    expect(Buffer.from(payload.base64, 'base64')).toEqual(Buffer.from(bytes))
  })
  test('preserves multilingual text as its original UTF-8 bytes without reading arbitrary paths', async () => {
    const content = '项目要求\nCafé\n'
    const file = new File([content], 'requirements.txt')
    const payload = await encodeDraftFile({ id: 'file-2', file })
    expect(Buffer.from(payload.base64, 'base64').toString('utf8')).toBe(content)
    expect(payload.name).toBe('requirements.txt')
    expect(payload.mimeType).toBe('application/octet-stream')
    expect('path' in payload).toBe(false)
  })
})
