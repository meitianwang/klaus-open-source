// What a queued row says when it has no words of its own.
//
// The fallback chain is the part worth testing: a row that carries only a paste,
// only selections, or only images must still be distinguishable from its
// neighbours in a stack. Every branch here was reachable in the product before it
// had a name — an attachment-only queued message used to render as "Queued
// follow-up", identical to every other one.
import { describe, expect, test } from 'bun:test'

const labels: Record<string, string> = {
  follow_up_summary_pasted: 'Pasted text',
  follow_up_summary_pasted_more_one: '{preview} (+{count} more pasted text attachment)',
  follow_up_summary_pasted_more: '{preview} (+{count} more pasted text attachments)',
  follow_up_summary_selections_one: '{count} selection',
  follow_up_summary_selections: '{count} selections',
  follow_up_summary_images_one: '{count} image',
  follow_up_summary_images: '{count} images',
  follow_up_summary_files_one: '{count} file',
  follow_up_summary_files: '{count} files',
  follow_up_summary_image_alt: 'Image attachment',
  follow_up_empty_queued: 'Queued follow-up',
}

// English is the only locale in this fixture that inflects for singular, which is
// the rule `ttCount` implements, so both forms get exercised here.
;(globalThis as Record<string, unknown>).window = { currentLang: 'en', tt: (key: string) => labels[key] ?? key }

const { queuedRowContent, queuedRowThumbnail } = await import('./queue-row-content')

/** A paste preview is the first non-empty lines; the real one lives in chat.ts. */
const previewOf = (text: string) => text.split('\n').filter(line => line.trim()).slice(0, 2).join('\n')
const mediaUrl = (path: string) => `klaus-media://uploads/${path.split('/').pop()}`
const content = (item: Parameters<typeof queuedRowContent>[0]) => queuedRowContent(item, { previewOf, resolveMediaUrl: mediaUrl })

describe('queued row content', () => {
  test('the message’s own words win over every summary', () => {
    const result = content({
      displayText: 'Fix the failing test',
      finalText: 'Fix the failing test',
      media: [{ type: 'image', path: '/uploads/a.png', name: 'a.png' }],
      liveAttachments: [{ type: 'image', name: 'a.png', src: 'blob:1' }],
      selectedTextAttachments: [{ text: 'a selection' }],
    })
    expect(result.text).toBe('Fix the failing test')
    expect(result.summaryOnly).toBe(false)
    expect(result.summary).toBe('')
    // A thumbnail still rides along: the row shows the image beside its words.
    expect(result.thumbnail?.src).toBe('klaus-media://uploads/a.png')
  })

  test('displayText is preferred over the model-visible envelope', () => {
    // `finalText` carries the selected-text envelope; showing it would print the
    // wrapper markup instead of what the user typed.
    const result = content({ displayText: '  Explain this  ', finalText: '<selected-text>…</selected-text>Explain this' })
    expect(result.text).toBe('Explain this')
  })

  test('a single paste shows its own preview', () => {
    const result = content({ pastedCards: [{ text: 'line one\nline two\nline three', previewText: '' }] })
    expect(result.summaryOnly).toBe(true)
    expect(result.summary).toBe('line one\nline two')
  })

  test('several pastes are counted, and the count excludes the one being previewed', () => {
    const result = content({
      pastedCards: [
        { previewText: 'first paste' },
        { previewText: 'second paste' },
        { previewText: 'third paste' },
      ],
    })
    expect(result.summary).toBe('first paste (+2 more pasted text attachments)')
  })

  test('two pastes use the singular form', () => {
    const result = content({ pastedCards: [{ previewText: 'first' }, { previewText: 'second' }] })
    expect(result.summary).toBe('first (+1 more pasted text attachment)')
  })

  test('a paste with nothing previewable still says what it is', () => {
    // Two cards, one of them previewed, so the remainder reads singular.
    const result = content({ pastedCards: [{ text: '   \n  ' }, { text: 'other' }] })
    expect(result.summary).toBe('Pasted text (+1 more pasted text attachment)')
  })

  test('selections are counted when there is no paste', () => {
    expect(content({ selectedTextAttachments: [{ text: 'a' }] }).summary).toBe('1 selection')
    expect(content({ selectedTextAttachments: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }).summary).toBe('3 selections')
  })

  test('images are counted across both attachment arrays', () => {
    const result = content({
      media: [{ type: 'image', path: '/uploads/a.png', name: 'a.png' }],
      liveAttachments: [{ type: 'image', name: 'b.png', src: 'blob:2' }],
    })
    expect(result.summary).toBe('2 images')
    expect(result.summaryOnly).toBe(true)
  })

  test('one image reads as singular', () => {
    expect(content({ liveAttachments: [{ type: 'image', name: 'a.png', src: 'blob:1' }] }).summary).toBe('1 image')
  })

  test('named files are listed rather than counted', () => {
    expect(content({ liveAttachments: [{ type: 'file', name: 'report.pdf' }] }).summary).toBe('report.pdf')
    expect(content({ liveAttachments: [{ type: 'file', name: 'a.pdf' }, { type: 'file', name: 'b.pdf' }] }).summary).toBe('a.pdf, b.pdf')
  })

  test('unnamed files fall back to a count', () => {
    expect(content({ liveAttachments: [{ type: 'file' }, { type: 'file' }] }).summary).toBe('2 files')
  })

  test('an empty row still names itself instead of rendering blank', () => {
    const result = content({ displayText: '', finalText: '', media: [], liveAttachments: [] })
    expect(result.summary).toBe('Queued follow-up')
    expect(result.summaryOnly).toBe(true)
    expect(result.thumbnail).toBeNull()
  })

  test('a malformed row is described rather than crashing the queue', () => {
    expect(content(null).summary).toBe('Queued follow-up')
    expect(content({ displayText: 42, media: 'not an array', liveAttachments: [null, 7] }).summary).toBe('Queued follow-up')
  })
})

describe('queued row thumbnail', () => {
  test('a blob preview the renderer still holds is used as-is', () => {
    expect(queuedRowThumbnail({ liveAttachments: [{ type: 'image', name: 'a.png', src: 'blob:live' }] }, mediaUrl)).toEqual({ src: 'blob:live', alt: 'a.png' })
  })

  test('a row restored after a reload resolves its durable uploads path', () => {
    // The blob URL died with the page that minted it, so the media channel has to
    // mint a new one from the path the engine will read.
    const thumb = queuedRowThumbnail({ media: [{ type: 'image', path: '/uploads/shot.png', name: 'shot.png' }] }, mediaUrl)
    expect(thumb).toEqual({ src: 'klaus-media://uploads/shot.png', alt: 'shot.png' })
  })

  test('a document is never treated as an image', () => {
    expect(queuedRowThumbnail({ media: [{ type: 'document', path: '/uploads/a.pdf', name: 'a.pdf' }] }, mediaUrl)).toBeNull()
  })

  test('an unresolvable path yields no thumbnail rather than a broken image', () => {
    expect(queuedRowThumbnail({ media: [{ type: 'image', path: '/uploads/gone.png' }] }, () => '')).toBeNull()
  })

  test('a nameless image gets the localized alt text', () => {
    expect(queuedRowThumbnail({ liveAttachments: [{ type: 'image', src: 'blob:x' }] }, mediaUrl)).toEqual({ src: 'blob:x', alt: 'Image attachment' })
  })
})

 test('the display and engine copies count a single image once', () => {
  expect(content({ displayText: '', finalText: 'model attachment context', media: [{ type: 'image', path: '/uploads/a.png', name: 'a.png' }], liveAttachments: [{ type: 'image', name: 'a.png', src: 'blob:expired' }] }).summary).toBe('1 image')
})
 test('separate same-named images are not collapsed', () => {
  expect(content({ media: [{ type: 'image', name: 'a.png', path: '/one/a.png' }, { type: 'image', name: 'a.png', path: '/two/a.png' }], liveAttachments: [{ type: 'image', name: 'a.png' }, { type: 'image', name: 'a.png' }] }).summary).toBe('2 images')
})
