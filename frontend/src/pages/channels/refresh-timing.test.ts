import { describe, expect, test } from 'bun:test'
import { finishAfterMinimumDuration } from './refresh-timing'

describe('channel refresh timing', () => {
  test('keeps a fast refresh indicator visible for the remaining interval', async () => {
    const times = [100, 140]
    const delays: number[] = []
    const result = await finishAfterMinimumDuration(
      () => Promise.resolve('done'),
      600,
      () => times.shift()!,
      async milliseconds => { delays.push(milliseconds) },
    )
    expect(result).toBe('done')
    expect(delays).toEqual([560])
  })

  test('does not delay a refresh that already exceeded the minimum', async () => {
    const times = [100, 710]
    const delays: number[] = []
    await finishAfterMinimumDuration(
      () => Promise.resolve(),
      600,
      () => times.shift()!,
      async milliseconds => { delays.push(milliseconds) },
    )
    expect(delays).toEqual([])
  })

  test('waits before propagating a refresh failure', async () => {
    const times = [100, 200]
    const delays: number[] = []
    let failure: unknown
    try {
      await finishAfterMinimumDuration(
        () => Promise.reject(new Error('fixture failure')),
        600,
        () => times.shift()!,
        async milliseconds => { delays.push(milliseconds) },
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('fixture failure')
    expect(delays).toEqual([500])
  })
})
