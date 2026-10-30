import { expect, test } from 'bun:test'
import { SessionNavigation } from './session-navigation'

test('back and forward follow actual visits and a new visit replaces the forward branch', () => {
  const navigation = new SessionNavigation()
  navigation.observe('a'); navigation.observe('b'); navigation.observe('c')
  expect(navigation.move(-1)).toBe('b')
  navigation.observe('b')
  expect(navigation.move(-1)).toBe('a')
  expect(navigation.move(1)).toBe('b')
  navigation.observe('d')
  expect(navigation.canMove(1)).toBe(false)
  expect(navigation.move(-1)).toBe('b')
})
test('deleted chats leave navigation while drafts and independent window histories remain available', () => {
  const first = new SessionNavigation(), second = new SessionNavigation()
  first.observe('removed'); first.observe('kept')
  first.retain(new Set(['kept']))
  expect(first.move(-1)).toBeNull()
  expect(first.move(-1)).toBeUndefined()
  expect(first.move(1)).toBe('kept')
  expect(second.canMove(-1)).toBe(false)
})
