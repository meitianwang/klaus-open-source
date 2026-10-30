import { describe, expect, test } from 'bun:test'
import { pendingPastedTextEntry, settlePastedTextAttachment } from './attachment-lifecycle'

describe('pending pasted attachment ownership', () => {
  test('settles the same retained entry without replacing its owner identity', async () => {
    const pending = pendingPastedTextEntry('text')
    const result = await settlePastedTextAttachment(pending, 'text', {
      create: async () => ({ ...pendingPastedTextEntry('text'), uploadPath: '/owned/paste', uploading: false }),
      retained: () => true, removeStored: async () => { throw new Error('Retained files must survive') },
    })
    expect(result).toBe('ready')
    expect(pending.uploadPath).toBe('/owned/paste')
    expect(pending.uploading).toBe(false)
  })

  test('a removed pending card releases a late host file', async () => {
    const removed: string[] = []
    const pending = pendingPastedTextEntry('text')
    const result = await settlePastedTextAttachment(pending, 'text', {
      create: async () => ({ ...pendingPastedTextEntry('text'), uploadPath: '/owned/orphan' }),
      retained: () => false, removeStored: async path => { removed.push(path) },
    })
    expect(result).toBe('discarded')
    expect(pending.uploading).toBe(false)
    expect(pending.uploadPath).toBeNull()
    expect(removed).toEqual(['/owned/orphan'])
  })

  test('failed creation settles pending state without manufacturing inline text', async () => {
    const pending = pendingPastedTextEntry('large text')
    const result = await settlePastedTextAttachment(pending, 'large text', {
      create: async () => null, retained: () => true, removeStored: async () => {},
    })
    expect(result).toBe('failed')
    expect(pending.uploading).toBe(false)
    expect(pending.uploadPath).toBeNull()
  })
})
