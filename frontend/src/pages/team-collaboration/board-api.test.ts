import { describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { allPages, errorText } from './board-api'
import type { BoardT } from './board-i18n'

describe('collaboration board transport helpers', () => {
  test('loads every server page and passes each cursor unchanged', async () => {
    const cursors: (string | undefined)[] = []
    const result = await allPages(async cursor => {
      cursors.push(cursor)
      return cursor === undefined ? { items: [1], nextCursor: 'opaque/next' } : { items: [2, 3], nextCursor: null }
    })
    expect(result).toEqual([1, 2, 3])
    expect(cursors).toEqual([undefined, 'opaque/next'])
  })
  test('rejects a repeated cursor instead of hanging or silently dropping rows', async () => {
    await rejects(allPages(async () => ({ items: [1], nextCursor: 'same' })), /repeated pagination cursor/)
  })
  test('does not downgrade server permission errors to an empty success', async () => {
    await rejects(allPages(async () => { throw new Error('FORBIDDEN') }), /FORBIDDEN/)
  })
  test('keeps server errors visible and uses the conflict recovery message', () => {
    const t: BoardT = key => key
    expect(errorText(new Error('Cloud offline'), t)).toBe('Cloud offline')
    expect(errorText({ code: 'version_conflict' }, t)).toBe('conflict')
    expect(errorText(null, t)).toBe('error')
  })
})
