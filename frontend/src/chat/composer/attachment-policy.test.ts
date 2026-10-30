// Pins the attachment policy: images are inlined under a 10MB cap, everything
// else travels as a path under a much looser one, and no type is refused
// outright. The old behaviour (a five-extension whitelist that rejected the
// message) is exactly what these tests must not allow back in.
import { describe, expect, test } from 'bun:test'
import {
  attachmentSizeRejection,
  isInlineImage,
  maxAttachmentBytes,
  MAX_INLINE_IMAGE_BYTES,
  MAX_REFERENCED_FILE_BYTES,
} from './attachment-policy'

describe('isInlineImage', () => {
  test('accepts the image types the model takes as a content part', () => {
    expect(isInlineImage('a.png')).toBe(true)
    expect(isInlineImage('a.JPG')).toBe(true)
    expect(isInlineImage('a.jpeg')).toBe(true)
    expect(isInlineImage('a.gif')).toBe(true)
    expect(isInlineImage('a.webp')).toBe(true)
  })

  test('trusts the MIME type over the filename when one is present', () => {
    // A pasted screenshot arrives as `image.png` with a real MIME and no useful name.
    expect(isInlineImage('', 'image/png')).toBe(true)
    expect(isInlineImage('screenshot', 'image/webp')).toBe(true)
    // The legacy spelling some tools still emit.
    expect(isInlineImage('x', 'image/x-png')).toBe(true)
    // A MIME with parameters is still an image.
    expect(isInlineImage('x', 'image/jpeg; charset=binary')).toBe(true)
    // MIME present and NOT an image wins over an image-looking name.
    expect(isInlineImage('trap.png', 'application/octet-stream')).toBe(false)
  })

  test('falls back to the extension when no MIME is given', () => {
    // Path-imported files reach the composer with no MIME at all.
    expect(isInlineImage('/tmp/shot.png', '')).toBe(true)
    expect(isInlineImage('/tmp/shot.png', null)).toBe(true)
  })

  test('everything else is referenced, not inlined', () => {
    for (const name of ['notes.docx', 'archive.zip', 'main.rs', 'report.pdf', 'data.csv']) {
      expect(isInlineImage(name)).toBe(false)
    }
  })

  test('PDF is referenced now, because the read tool opens it natively', () => {
    expect(isInlineImage('report.pdf')).toBe(false)
    expect(isInlineImage('report.pdf', 'application/pdf')).toBe(false)
  })

  test('a dotfile has no extension to match', () => {
    expect(isInlineImage('.gitignore')).toBe(false)
    expect(isInlineImage('.png')).toBe(false)
  })

  test('tolerates a missing name', () => {
    expect(isInlineImage('')).toBe(false)
  })
})

describe('maxAttachmentBytes', () => {
  test('images are capped tighter than referenced files', () => {
    expect(maxAttachmentBytes('a.png')).toBe(MAX_INLINE_IMAGE_BYTES)
    expect(maxAttachmentBytes('a.zip')).toBe(MAX_REFERENCED_FILE_BYTES)
    expect(MAX_INLINE_IMAGE_BYTES).toBeLessThan(MAX_REFERENCED_FILE_BYTES)
  })
})

describe('attachmentSizeRejection', () => {
  test('reports the ceiling that was exceeded, or null when it fits', () => {
    expect(attachmentSizeRejection('a.png', 1024)).toBe(null)
    expect(attachmentSizeRejection('a.png', MAX_INLINE_IMAGE_BYTES)).toBe(null)
    expect(attachmentSizeRejection('a.png', MAX_INLINE_IMAGE_BYTES + 1))
      .toBe(MAX_INLINE_IMAGE_BYTES)
  })

  test('a 30MB archive is accepted where the old 10MB gate refused it', () => {
    expect(attachmentSizeRejection('archive.zip', 30 * 1024 * 1024)).toBe(null)
  })

  test('a 25MB PDF is accepted where the old inline path refused it', () => {
    expect(attachmentSizeRejection('report.pdf', 25 * 1024 * 1024)).toBe(null)
  })

  test('a referenced file still has a ceiling', () => {
    expect(attachmentSizeRejection('huge.zip', MAX_REFERENCED_FILE_BYTES + 1))
      .toBe(MAX_REFERENCED_FILE_BYTES)
  })
})
