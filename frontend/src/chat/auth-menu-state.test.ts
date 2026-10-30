import { expect, test } from 'bun:test'
import { AuthMenuRequests } from './auth-menu-state'
import vectors from '../../../contracts/vectors/auth-menu-session-vectors.json'

for (const row of vectors.cases) {
  test(`menu ownership: ${row.name}`, () => {
    let current = row.opened
    const requests = new AuthMenuRequests(() => current)
    const state = { ...requests.capture(), activeMode: 'codex' }
    current = row.current
    if (row.invalidate) requests.invalidate()
    expect(requests.isCurrent(state)).toBe(row.selectable)
  })
}

test('capturing a menu does not fetch or suppress a second open', () => {
  let current: string | null = 'a'
  let reads = 0
  const requests = new AuthMenuRequests(() => {
    reads++
    return current
  })

  const first = requests.capture()
  const second = requests.capture()

  expect(first).toEqual({ sessionId: 'a', revision: 0 })
  expect(second).toEqual(first)
  expect(reads).toBe(2)
})

test('a draft menu becomes stale when the draft becomes a conversation', () => {
  let current: string | null = null
  const requests = new AuthMenuRequests(() => current)
  const state = { ...requests.capture(), activeMode: 'custom' }

  current = 'a'

  expect(requests.isCurrent(state)).toBe(false)
})

test('configuration changes invalidate an already open menu', () => {
  const requests = new AuthMenuRequests(() => 'a')
  const state = { ...requests.capture(), activeMode: 'codex' }

  requests.invalidate()

  expect(requests.isCurrent(state)).toBe(false)
})
