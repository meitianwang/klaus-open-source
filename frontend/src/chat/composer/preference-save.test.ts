import { expect, test } from 'bun:test'
import { createPreferenceSaver } from './preference-save'

function fixture() {
  let sessionId: string | undefined = 'chat-A'
  let value = 'model-A'
  const errors: unknown[] = []
  const saver = createPreferenceSaver({
    getSessionId: () => sessionId, getValue: () => value,
    setValue: next => { value = next }, onError: error => { errors.push(error) },
  })
  return { saver, errors, value: () => value, switchSession: (id: string | undefined, next: string) => { sessionId = id; value = next } }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a failed preference save rolls back its own optimistic pick and exposes the reason', async () => {
  const f = fixture()
  const request = deferred()
  const saved = f.saver.save('model-B', (value, sessionId) => {
    expect([value, sessionId]).toEqual(['model-B', 'chat-A'])
    return request.promise
  })
  expect(f.value()).toBe('model-B')
  const error = new Error('write denied')
  request.reject(error)
  await saved
  expect(f.value()).toBe('model-A')
  expect(f.errors).toEqual([error])
})

test('a late rejection cannot roll back a newer selection', async () => {
  const f = fixture()
  const first = deferred()
  const a = f.saver.save('model-B', () => first.promise)
  const b = f.saver.save('model-C', async () => {})
  await b
  first.reject(new Error('stale failure'))
  await a
  expect(f.value()).toBe('model-C')
  expect(f.errors).toEqual([])
})

test('a late rejection cannot touch another chat even if it has the same model name', async () => {
  const f = fixture()
  const first = deferred()
  const saved = f.saver.save('model-B', () => first.promise)
  f.switchSession('chat-B', 'model-B')
  first.reject(new Error('chat-A failure'))
  await saved
  expect(f.value()).toBe('model-B')
  expect(f.errors).toEqual([])
})

test('an authoritative preferences refresh invalidates older save callbacks', async () => {
  const f = fixture()
  const first = deferred()
  const saved = f.saver.save('model-B', () => first.promise)
  f.saver.invalidate()
  first.reject(new Error('old refresh failure'))
  await saved
  expect(f.value()).toBe('model-B')
  expect(f.errors).toEqual([])
})

test('a success reply does not overwrite a newer authoritative preference', async () => {
  const f = fixture()
  const first = deferred()
  const saved = f.saver.save('model-B', () => first.promise)
  f.switchSession('chat-A', 'model-C')
  first.resolve()
  await saved
  expect(f.value()).toBe('model-C')
})

test('a new chat save remains unscoped', async () => {
  const f = fixture()
  f.switchSession(undefined, 'model-A')
  await f.saver.save('model-B', async (_value, id) => { expect(id).toBeUndefined() })
  expect(f.value()).toBe('model-B')
})

test('a failed native selection restores its reasoning and mode as one value', async () => {
  let value = { level: 'high', ultraMode: true }
  const errors: unknown[] = []
  const saver = createPreferenceSaver({
    getSessionId: () => 'chat-A',
    getValue: () => ({ ...value }),
    setValue: next => { value = { ...next } },
    isEqual: (left, right) => left.level === right.level && left.ultraMode === right.ultraMode,
    onError: error => { errors.push(error) },
  })
  const request = deferred()
  const saved = saver.save({ level: 'low', ultraMode: false }, () => request.promise)
  expect(value).toEqual({ level: 'low', ultraMode: false })
  request.reject(new Error('selection rejected'))
  await saved
  expect(value).toEqual({ level: 'high', ultraMode: true })
  expect(errors).toHaveLength(1)
})
