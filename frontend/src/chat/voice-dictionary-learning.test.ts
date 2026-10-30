import { expect, test } from 'bun:test'
import { publishDictionaryAdditions } from './voice-dictionary-learning'

test('learning notifications undo only the newly reported stable dictionary ids', async () => {
  const removed: string[] = [], terms: string[] = []
  let changes = 0, undo!: () => Promise<void>
  publishDictionaryAdditions({ ok: true, addedHotwords: [{ id: 'new-id', text: 'Klaus' }, { id: 'new-id', text: 'Klaus' }, { id: null, text: 'Ignored' }] }, {
    changed: () => { changes++ },
    remove: async id => { removed.push(id); return { ok: true } },
    notify: (words, callback) => { terms.push(...words); undo = callback },
  })
  expect(terms).toEqual(['Klaus']); expect(changes).toBe(1)
  await undo()
  expect(removed).toEqual(['new-id']); expect(changes).toBe(2)
})

test('failed or empty learning never presents a dictionary undo action', () => {
  for (const value of [null, { ok: false, addedHotwords: [{ id: 'old', text: 'Old' }] }, { ok: true, addedHotwords: [] }]) {
    publishDictionaryAdditions(value, { changed: () => { throw Error('unexpected change') }, remove: async () => null, notify: () => { throw Error('unexpected notice') } })
  }
})
