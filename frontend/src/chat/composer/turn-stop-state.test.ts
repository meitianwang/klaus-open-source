import { expect, test } from 'bun:test'
import { createTurnStopState } from './turn-stop-state'

test('a predecessor stop never changes the successor affordance or releases its stop', () => {
  let turn = 'first'
  const stops = createTurnStopState(() => turn)
  const first = stops.add('chat')
  expect(stops.has('chat')).toBe(true)
  turn = 'second'
  expect(stops.has('chat')).toBe(false)
  const second = stops.add('chat')
  expect(stops.has('chat')).toBe(true)
  expect(stops.delete('chat', first)).toBe(false)
  expect(stops.has('chat')).toBe(true)
  expect(stops.delete('chat', second)).toBe(true)
  expect(stops.has('chat')).toBe(false)
})

test('stop intent is independent across conversations and explicit completion releases only its owner', () => {
  const turns = new Map([['left', 'a'], ['right', 'b']])
  const stops = createTurnStopState(id => turns.get(id) || null)
  const left = stops.add('left')
  stops.add('right')
  stops.delete('left', left)
  expect(stops.has('left')).toBe(false)
  expect(stops.has('right')).toBe(true)
})

test('a stop reserved before a turn identity exists does not attach itself to its eventual successor', () => {
  let turn: string | null = null
  const stops = createTurnStopState(() => turn)
  stops.add('chat')
  expect(stops.has('chat')).toBe(true)
  turn = 'engine-turn'
  expect(stops.has('chat')).toBe(false)
})
