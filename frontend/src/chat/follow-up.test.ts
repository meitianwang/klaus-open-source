// follow-up 纯逻辑 helpers 的单元测试（迁自 js/follow-up.test.cjs，改 ES import）。
import { describe, expect, test } from 'bun:test'
import * as followUp from './follow-up'

describe('follow-up mode helpers', () => {
  test('normalizes unknown values to the queue default', () => {
    expect(followUp.normalizeMode('queue')).toBe('queue')
    expect(followUp.normalizeMode('steer')).toBe('steer')
    expect(followUp.normalizeMode('later')).toBe('queue')
    expect(followUp.normalizeMode(null)).toBe('queue')
  })

  test('resolves the one-message inverted action', () => {
    expect(followUp.resolveSubmitAction('queue', false)).toBe('queue')
    expect(followUp.resolveSubmitAction('queue', true)).toBe('steer')
    expect(followUp.resolveSubmitAction('steer', false)).toBe('steer')
    expect(followUp.resolveSubmitAction('steer', true)).toBe('queue')
  })

  test('updates queued messages without mutating the original array', () => {
    const items = [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
      { id: 'c', text: 'third' },
    ]

    expect(followUp.reorderItem(items, 'c', 'a').map(item => item.id)).toEqual(['c', 'a', 'b'])
    expect(followUp.removeItem(items, 'b').map(item => item.id)).toEqual(['a', 'c'])
    expect(followUp.updateItem(items, 'a', { text: 'edited' })[0].text).toBe('edited')
    expect(items.map(item => item.text)).toEqual(['first', 'second', 'third'])
  })
})
