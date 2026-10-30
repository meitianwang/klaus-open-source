// The pure decisions behind editing an already-sent message in the composer.
//
// These are the parts of the flow that can be wrong in a way no DOM run catches cheaply:
// an attachment rebuilt with the wrong flags parks the Send forever, a MIME invented from
// the display name changes how the file is delivered, and an edit left visible to the wrong
// conversation truncates the wrong history.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodeSelectedTextEnvelope } from '../selected-text-envelope'
import {
  editCanSubmit, pendingEntriesFromPrepare, pendingEntryFromPoolPath, restoredMessageTextCards,
} from './sent-message-edit'

const mediaUrl = (path: string): string => `klaus-media://preview/${path.split('/').pop()}`

describe('an attachment recovered from history', () => {
  test('directory paths retain their identity even with an image extension or stale MIME', () => {
    for (const path of ['/workspace/images.png/', 'C:\\workspace\\images.png\\']) {
      const entry = pendingEntryFromPoolPath(path, 'images.png', 'image/png', () => { throw Error('A directory cannot use image preview') })
      expect(entry.file.type).toBe('inode/directory')
      expect(entry.objectUrl).toBeNull()
      expect(entry.uploading).toBe(false)
      expect(entry.uploadPath).toBe(path)
    }
  })
  test('is born uploaded, so it neither greys out nor parks the Send', () => {
    // `uploading: false` with a real `uploadPath` is load-bearing twice: the chip renders
    // enabled, and `hasUploadInFlight` stays false so Send is not parked waiting on an
    // upload that will never happen (the file is already on disk in the pool).
    const entry = pendingEntryFromPoolPath('/pool/aaa/report.md', 'report.md', undefined, mediaUrl)
    expect(entry.uploading).toBe(false)
    expect(entry.uploadPath).toBe('/pool/aaa/report.md')
    expect(entry.sourcePath).toBe('/pool/aaa/report.md')
  })

  test('previews an image through the media channel, never as a raw filesystem path', () => {
    // A bare path in an <img> is a broken image; the pool copy is only reachable over the
    // media scheme, which is what a sent bubble's thumbnail already uses.
    const image = pendingEntryFromPoolPath('/pool/aaa/photo.png', 'photo.png', 'image/png', mediaUrl)
    expect(image.objectUrl).toBe('klaus-media://preview/photo.png')
  })

  test('gives a non-image no preview at all', () => {
    // It renders as a filename chip instead. An objectUrl for a document would draw a
    // broken thumbnail where the chip belongs.
    expect(pendingEntryFromPoolPath('/pool/aaa/report.md', 'report.md', undefined, mediaUrl).objectUrl).toBeNull()
    expect(pendingEntryFromPoolPath('/pool/aaa/spec.pdf', 'spec.pdf', 'application/pdf', mediaUrl).objectUrl).toBeNull()
  })

  test('a recorded MIME decides delivery even when the display name disagrees', () => {
    // The name a message recorded is cosmetic. Without this, renaming a screenshot to
    // "notes.txt" before sending would change how the model receives it on a later edit.
    const renamed = pendingEntryFromPoolPath('/pool/aaa/photo.png', 'renamed-by-user.txt', 'image/png', mediaUrl)
    expect(renamed.objectUrl).toBe('klaus-media://preview/photo.png')
    expect(renamed.file.name).toBe('renamed-by-user.txt')
    expect(renamed.file.type).toBe('image/png')
  })

  test('with no recorded MIME, the POOL PATH extension decides, not the display name', () => {
    // Text-referenced files carry no MIME. The pool/upload path is written from the type
    // resolved at ingest, so its extension is authoritative; a cosmetic rename still
    // cannot change the delivery.
    const renamed = pendingEntryFromPoolPath('/uploads/aaa/photo.png', 'renamed.txt', undefined, mediaUrl)
    expect(renamed.objectUrl).toBe('klaus-media://preview/photo.png')
    expect(pendingEntryFromPoolPath('/uploads/aaa/report.md', 'report.png', undefined, mediaUrl).objectUrl).toBeNull()
  })

  test('falls back to the basename when no name was recorded', () => {
    const entry = pendingEntryFromPoolPath('/pool/aaa/notes.txt', '', undefined, mediaUrl)
    expect(entry.file.name).toBe('notes.txt')
  })
})

describe('the attachment list the host hands back', () => {
  test('rebuilds every entry with a path, in order', () => {
    const entries = pendingEntriesFromPrepare(
      [{ path: '/pool/a.png', name: 'a.png' }, { path: '/pool/b.md', name: 'b.md' }], mediaUrl)
    expect(entries.map(entry => entry.file.name)).toEqual(['a.png', 'b.md'])
    expect(entries.every(entry => entry.uploading === false)).toBe(true)
  })

  test('drops an entry with no usable path rather than drawing a chip that sends nothing', () => {
    // Such a chip would look attached and then vanish from the payload — indistinguishable
    // from a model that ignored the attachment.
    const entries = pendingEntriesFromPrepare(
      [{ path: '/pool/a.png' }, { name: 'ghost.png' }, { path: '' }, null, 'junk'], mediaUrl)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.file.name).toBe('a.png')
  })

  test('tolerates a missing or malformed list', () => {
    expect(pendingEntriesFromPrepare(undefined, mediaUrl)).toEqual([])
    expect(pendingEntriesFromPrepare(null, mediaUrl)).toEqual([])
    expect(pendingEntriesFromPrepare('not-a-list', mediaUrl)).toEqual([])
  })
})

describe('the complete draft restored by rewind', () => {
  const vectors = JSON.parse(readFileSync(fileURLToPath(new URL(
    '../../../../contracts/vectors/message-rewind-scope-vectors.json', import.meta.url,
  )), 'utf8'))[0].restoredDrafts as Array<{name:string;draft:any;expected:{body:string;files:number;quotes:number;pastedCards:number}}>
  for (const vector of vectors) test(vector.name, () => {
    const cards = restoredMessageTextCards(vector.draft)
    expect(cards.text).toBe(vector.expected.body)
    expect(cards.selectedTextAttachments).toHaveLength(vector.expected.quotes)
    expect(cards.pastedCards).toHaveLength(vector.expected.pastedCards)
    expect(pendingEntriesFromPrepare(vector.draft.attachments, mediaUrl)).toHaveLength(vector.expected.files)
  })

  test('a legacy selected-text envelope restores its body and every quote', () => {
    const text = encodeSelectedTextEnvelope('Please inspect.', [{text:'First quote',requestOffset:0},{text:'Second quote',requestOffset:14}])
    const cards = restoredMessageTextCards({text})
    expect(cards.text).toBe('Please inspect.')
    expect(cards.selectedTextAttachments.map((entry: any) => entry.text)).toEqual(['First quote','Second quote'])
  })
})

describe('what may be sent as an edit', () => {
  test('text alone, or an attachment alone, is enough', () => {
    expect(editCanSubmit('words', 0)).toBe(true)
    expect(editCanSubmit('', 1)).toBe(true)
  })

  test('whitespace-only text with no attachment cannot be sent', () => {
    // Submitting nothing would truncate the message and its turn and replace them with an
    // empty one — the user loses a message they did not ask to lose.
    expect(editCanSubmit('', 0)).toBe(false)
    expect(editCanSubmit('   ', 0)).toBe(false)
    expect(editCanSubmit('\n\t ', 0)).toBe(false)
  })
})
