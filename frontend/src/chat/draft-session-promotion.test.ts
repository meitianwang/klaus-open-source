import { expect, test } from 'bun:test'
import { DraftSessionPromotion } from './draft-session-promotion'

test('another empty draft owns a separate promotion and an old completion cannot reclaim it', async () => {
  const promotions = new DraftSessionPromotion()
  let finishA!: () => void, finishB!: () => void
  let selected: string | null = null
  const a = promotions.run(async isCurrent => {
    await new Promise<void>(resolve => { finishA = resolve })
    if (isCurrent()) selected = 'A'
    return 'A'
  })
  expect(promotions.run(async () => 'duplicate')).toBe(a)
  promotions.navigate()
  const b = promotions.run(async isCurrent => {
    await new Promise<void>(resolve => { finishB = resolve })
    if (isCurrent()) selected = 'B'
    return 'B'
  })
  expect(b).not.toBe(a)
  finishA(); expect(await a).toBe('A')
  expect(selected).toBeNull()
  expect(promotions.run(async () => 'duplicate B')).toBe(b)
  finishB(); expect(await b).toBe('B')
  expect(selected as string | null).toBe('B')
})

test('navigation during the second asynchronous promotion stage revokes UI ownership', async () => {
  const promotions = new DraftSessionPromotion()
  let finish!: () => void, transferred = false
  const result = promotions.run(async isCurrent => {
    expect(isCurrent()).toBe(true)
    await new Promise<void>(resolve => { finish = resolve })
    if (isCurrent()) transferred = true
    return 'created-session'
  })
  promotions.navigate(); finish()
  expect(await result).toBe('created-session')
  expect(transferred).toBe(false)
})
