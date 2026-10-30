import { expect, test } from 'bun:test'
import { createSpecAnnotationDelivery } from './spec-annotation-delivery'

test('keeps captured annotations until a successful delivery and allows retry', async () => {
  const items = [{ content: 'Acceptance', comment: 'Handle empty input.', path: '/project/spec.md' }]
  let clears = 0
  let sends = 0
  const delivery = createSpecAnnotationDelivery(async list => {
    expect(list).toEqual(items)
    return ++sends > 1
  })
  delivery.capture({ peek: () => items, clear: () => { clears++ } })
  expect(await delivery.send()).toBe(false)
  expect(clears).toBe(0)
  expect(delivery.getSnapshot()).toMatchObject({ items, failed: true })
  expect(await delivery.send()).toBe(true)
  expect(clears).toBe(1)
  expect(delivery.getSnapshot()).toMatchObject({ items: [], failed: false })
  expect(await delivery.send()).toBe(true)
  expect(sends).toBe(2)
})

test('a detached selection surface cannot erase the retryable snapshot', async () => {
  const items = [{ content: 'Interface', comment: 'Keep this API.' }]
  const delivery = createSpecAnnotationDelivery(() => { throw new Error('Unavailable') })
  delivery.capture({ peek: () => items, clear: () => { items.length = 0 } })
  items.length = 0
  expect(await delivery.send()).toBe(false)
  expect(delivery.getSnapshot().items).toEqual([{ content: 'Interface', comment: 'Keep this API.' }])
})
