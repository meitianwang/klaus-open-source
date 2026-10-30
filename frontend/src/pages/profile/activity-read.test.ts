import { afterAll, beforeAll, expect, test } from 'bun:test'
import { loadProfileActivity } from './activity-read'
import type { ProfileActivity } from './activity'

const originalWindow = globalThis.window
let read: () => Promise<ProfileActivity>
const activity: ProfileActivity = { days: [], totalTokens: 0, peakDailyTokens: 0, longestTaskMs: 0, longestStreakDays: 0, currentStreakDays: 0 }

beforeAll(() => {
  globalThis.window = { klaus: { profile: { activity: () => read() } } } as unknown as Window & typeof globalThis
})
afterAll(() => { globalThis.window = originalWindow })

test('concurrent profile views share one aggregate read and refresh after settlement', async () => {
  let calls = 0
  let resolve!: (value: ProfileActivity) => void
  read = () => { calls++; return new Promise(done => { resolve = done }) }
  const first = loadProfileActivity()
  const remount = loadProfileActivity()
  await Promise.resolve()
  expect(calls).toBe(1)
  resolve(activity)
  expect(await first).toEqual(activity)
  expect(await remount).toEqual(activity)
  const refresh = loadProfileActivity()
  await Promise.resolve()
  expect(calls).toBe(2)
  resolve(activity)
  await refresh
})

test('a failed shared read releases the next retry', async () => {
  read = async () => { throw Error('unavailable') }
  const first = loadProfileActivity()
  const second = loadProfileActivity()
  const settled = await Promise.allSettled([first, second])
  expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected'])
  read = async () => activity
  expect(await loadProfileActivity()).toEqual(activity)
})
