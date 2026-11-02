import { expect, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import vectors from '../../../../contracts/vectors/composer-refresh-vectors.json'
import { subscribePredictionRefresh } from './prediction-refresh'
import { createPredictionSessionSelector, type PredictionSourceState } from './predictions'

type Stream = PredictionSourceState & { running: boolean; text: string }
const stream = (): Stream => ({ running: false, text: '', history: [], historyGeneration: 1,
  turnStatuses: { terminal: 'completed' }, activeTurnId: null, liveTurnId: 'terminal', lastTerminalStatus: 'completed' })
const settle = () => Promise.resolve()
function fixture(running = false) {
  const store = createStore<{ engineStatus: string; sessions: Record<string, Stream> }>(() => ({
    engineStatus: 'ok', sessions: { selected: { ...stream(), running }, background: stream() },
  }))
  const calls = { refresh: 0, reads: 0, invalidated: [] as string[] }
  const select = createPredictionSessionSelector()
  const stop = subscribePredictionRefresh(store, {
    currentSessionId: () => 'selected',
    session: () => {
      calls.reads++
      const state = store.getState(), current = state.sessions.selected!
      return state.engineStatus !== 'ok' || current.running ? null : select('selected', current)
    },
    invalidate: id => { calls.invalidated.push(id) },
    refresh: () => { calls.refresh++ },
  })
  const update = (id: string, patch: Partial<Stream>) => store.setState(state => ({ sessions: {
    ...state.sessions, [id]: { ...state.sessions[id]!, ...patch },
  } }))
  return { store, calls, stop, update }
}

test('background text never wakes prediction UI but new running sessions still invalidate their candidates', async () => {
  const f = fixture()
  for (let index = 0; index < vectors.backgroundUpdates; index++) f.update('background', { running: true, text: String(index) })
  await settle()
  expect(f.calls.refresh).toBe(vectors.backgroundPredictionRefreshes)
  expect(f.calls.reads).toBe(1)
  expect(f.calls.invalidated).toEqual(['background'])
  f.stop()
})

test('streaming text stays quiet and terminal plus history publications coalesce into one refresh', async () => {
  const f = fixture(true)
  for (let index = 0; index < vectors.backgroundUpdates; index++) f.update('selected', { text: String(index) })
  await settle()
  expect(f.calls.refresh).toBe(0)
  f.update('selected', { running: false })
  f.update('selected', { history: [] })
  await settle()
  expect(f.calls.refresh).toBe(vectors.terminalPredictionRefreshes)
  f.stop()
})

test('irrelevant selected-session metadata cannot restart source reads or paint the input', async () => {
  const f = fixture()
  for (let index = 0; index < 30; index++) f.update('selected', { text: String(index) })
  await settle()
  expect(f.calls.refresh).toBe(0)
  f.update('selected', { historyGeneration: 2 })
  await settle()
  expect(f.calls.refresh).toBe(1)
  f.stop()
})

test('engine recovery refreshes the current source and disposal cancels a queued update', async () => {
  const f = fixture()
  f.store.setState({ engineStatus: 'error' })
  await settle()
  expect(f.calls.refresh).toBe(1)
  f.store.setState({ engineStatus: 'ok' })
  await settle()
  expect(f.calls.refresh).toBe(2)
  f.update('selected', { history: [] })
  f.stop()
  await settle()
  expect(f.calls.refresh).toBe(2)
})
