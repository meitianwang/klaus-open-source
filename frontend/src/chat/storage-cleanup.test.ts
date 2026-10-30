import { expect, test } from 'bun:test'
import { applyStorageChange } from './storage-cleanup'

function target(currentId: string | null = 'deleted') {
  let current = currentId, revision = 0
  const sessions = new Set(['deleted', 'retained']), drafts = new Map([['deleted', 'old draft'], ['retained', 'keep draft']])
  const order: string[] = []
  return { sessions, drafts, order, current: () => current, revision: () => revision,
    owner: {
      currentId: () => current,
      leaveCurrent: () => { order.push('leave'); current = null },
      remove: (ids: ReadonlySet<string>) => { revision++; order.push('remove'); for (const id of ids) sessions.delete(id) },
      forget: (id: string) => { order.push(`forget:${id}`); drafts.delete(id) },
      refresh: () => { order.push('refresh') },
    } }
}

test('confirmed deletion clears the selected owner before retiring its cached state', () => {
  const f = target()
  applyStorageChange(['deleted'], f.owner)
  expect(f.current()).toBeNull()
  expect([...f.sessions]).toEqual(['retained'])
  expect([...f.drafts]).toEqual([['retained', 'keep draft']])
  expect(f.order).toEqual(['leave', 'remove', 'forget:deleted', 'refresh'])
  expect(f.revision()).toBe(1)
})

test('skipped chats retain the active selection and draft', () => {
  const f = target('retained')
  applyStorageChange(['deleted'], f.owner)
  expect(f.current()).toBe('retained')
  expect(f.drafts.get('retained')).toBe('keep draft')
  expect(f.order).not.toContain('leave')
})

test('duplicate notifications retire each ID once per batch', () => {
  const f = target()
  applyStorageChange(['deleted', 'deleted', null, ''], f.owner)
  expect(f.order.filter(value => value === 'forget:deleted')).toHaveLength(1)
  expect(f.revision()).toBe(1)
})

test('malformed and empty notifications cannot reset a view', () => {
  const f = target()
  for (const value of [null, {}, [], [null, false, 1, '']]) applyStorageChange(value, f.owner)
  expect(f.current()).toBe('deleted')
  expect(f.revision()).toBe(0)
  expect(f.order).toEqual([])
})
