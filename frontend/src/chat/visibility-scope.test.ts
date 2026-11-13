import { expect, test } from 'bun:test'
import { createVisibilityScope } from './visibility-scope'

test('retained view state survives effect disconnection and resumes with one listener', () => {
  const scope = createVisibilityScope()
  let listeners = 0, deliveries = 0
  const listenersById = new Set<() => void>()
  const state = { draft: 'retained input' }
  scope.add(() => {
    const receive = () => { deliveries++ }
    listenersById.add(receive); listeners++
    return () => { listenersById.delete(receive); listeners-- }
  })
  for (const receive of listenersById) receive()
  scope.setActive(false)
  expect(listeners).toBe(0)
  expect(state.draft).toBe('retained input')
  scope.setActive(false)
  for (const receive of listenersById) receive()
  expect(deliveries).toBe(1)
  scope.setActive(true)
  scope.setActive(true)
  expect(listeners).toBe(1)
  for (const receive of listenersById) receive()
  expect(deliveries).toBe(2)
  scope.dispose()
  expect(listeners).toBe(0)
  scope.setActive(true)
  expect(listeners).toBe(0)
})

test('an effect registered while hidden starts only when the view returns', () => {
  const scope = createVisibilityScope()
  scope.setActive(false)
  let active = false
  scope.add(() => { active = true; return () => { active = false } })
  expect(active).toBe(false)
  scope.setActive(true)
  expect(active).toBe(true)
  scope.dispose()
  expect(active).toBe(false)
})

test('visible effects reconnect without changing retained state or accepting callbacks from old ownership', () => {
  const scope = createVisibilityScope(), events = new EventTarget()
  const editor = { text: 'Retained', selection: [2, 5], undo: ['Earlier'], references: [{}], attachments: [{}] }
  const callbacks: Array<() => void> = []
  scope.add(current => {
    const input = () => { if (current()) editor.text += '!' }
    callbacks.push(input)
    events.addEventListener('input', input)
    return () => events.removeEventListener('input', input)
  })
  events.dispatchEvent(new Event('input'))
  expect(editor.text).toBe('Retained!')
  scope.setActive(false)
  events.dispatchEvent(new Event('input'))
  callbacks[0]()
  expect(editor.text).toBe('Retained!')
  scope.setActive(true)
  callbacks[0]()
  expect(editor.text).toBe('Retained!')
  events.dispatchEvent(new Event('input'))
  expect(editor.text).toBe('Retained!!')
  expect(editor.selection).toEqual([2, 5])
  expect(editor.undo).toEqual(['Earlier'])
  expect(editor.references).toHaveLength(1)
  expect(editor.attachments).toHaveLength(1)
  scope.dispose()
})

test('registering the same effect twice never creates duplicate active handlers', () => {
  const scope = createVisibilityScope(), events = new EventTarget()
  let value = ''
  const start = () => {
    const input = () => { value += 'x' }
    events.addEventListener('input', input)
    return () => events.removeEventListener('input', input)
  }
  scope.add(start); scope.add(start)
  events.dispatchEvent(new Event('input'))
  expect(value).toBe('x')
  scope.setActive(false); scope.setActive(true); scope.setActive(true)
  events.dispatchEvent(new Event('input'))
  expect(value).toBe('xx')
  scope.dispose(); events.dispatchEvent(new Event('input'))
  expect(value).toBe('xx')
})

test('an effect added while hidden cannot start after permanent disposal', () => {
  const scope = createVisibilityScope()
  let started = false
  scope.setActive(false)
  scope.add(() => { started = true })
  scope.dispose(); scope.setActive(true)
  expect(started).toBe(false)
})
