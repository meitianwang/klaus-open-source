import { expect, test } from 'bun:test'
import type { EffectiveMediaModelCatalog } from '../../../../contracts/effective-media-models'
import { enqueueMediaSelection, mediaSelectionChange, type MediaSelectionSnapshot } from './effective-media-state'

function catalog(): EffectiveMediaModelCatalog {
  return { ok: true, selection: 'custom', current: { source: 'custom', modelId: 'custom-two' },
    currentBySource: { custom: { source: 'custom', modelId: 'custom-two' }, qwenwork: { source: 'qwenwork', modelId: 'native-two' }, none: { source: 'none', modelId: '' } },
    options: [
      { source: 'custom', modelId: 'custom-one', available: true }, { source: 'custom', modelId: 'custom-two', available: true },
      { source: 'qwenwork', modelId: 'native-one', available: true }, { source: 'qwenwork', modelId: 'native-two', available: true },
      { source: 'none', modelId: '', available: true },
    ] }
}
function deferred() {
  let resolve!: (value: { ok: boolean; error?: string }) => void
  return { promise: new Promise<{ ok: boolean; error?: string }>(done => { resolve = done }), resolve: (value: { ok: boolean; error?: string }) => resolve(value) }
}
function fixture(set: (source: string, model?: string) => Promise<{ ok: boolean; error?: string }>) {
  let snapshot: MediaSelectionSnapshot = { reply: catalog() }
  const frames: MediaSelectionSnapshot[] = []
  let settled = 0
  const update = (change: (current: MediaSelectionSnapshot) => MediaSelectionSnapshot) => { snapshot = change(snapshot); frames.push(snapshot) }
  const api = { set, error: 'Save failed', settled: () => { settled++ } }
  const choose = (value: string, field: 'source' | 'model', onSaved?: () => void) => {
    const change = mediaSelectionChange(snapshot.reply!, value, field)
    if (!change) throw Error('Invalid fixture choice')
    return enqueueMediaSelection(snapshot, change, update, api, onSaved)
  }
  return { choose, current: () => snapshot, frames, settled: () => settled }
}

test('a delayed source save immediately displays its remembered model instead of a blank or catalog head', async () => {
  const write = deferred(), calls: unknown[] = []
  const f = fixture(async (...args) => { calls.push(args); return write.promise })
  const done = f.choose('qwenwork', 'source')
  expect(f.current().reply?.current).toEqual({ source: 'qwenwork', modelId: 'native-two' })
  expect(f.current().pending).toBeDefined()
  expect(calls).toEqual([['qwenwork', 'native-two']])
  write.resolve({ ok: true }); await done
  expect(f.current().reply?.current.modelId).toBe('native-two')
  expect(f.current().pending).toBeUndefined()
  expect(f.settled()).toBe(1)
  expect(f.frames.every(frame => Boolean(frame.reply?.current.modelId))).toBe(true)
})

test('model choices and later source changes remain usable while earlier saves are pending', async () => {
  const write = deferred(), calls: unknown[] = []
  const f = fixture(async (...args) => { calls.push(args); return calls.length === 1 ? write.promise : { ok: true } })
  const first = f.choose('qwenwork', 'source')
  const second = f.choose('native-one', 'model')
  expect(f.current().reply?.current).toEqual({ source: 'qwenwork', modelId: 'native-one' })
  const third = f.choose('custom', 'source')
  expect(f.current().reply?.current).toEqual({ source: 'custom', modelId: 'custom-two' })
  expect(calls).toHaveLength(1)
  write.resolve({ ok: true }); await Promise.all([first, second, third])
  expect(calls).toEqual([['qwenwork', 'native-two'], ['qwenwork', 'native-one'], ['custom', 'custom-two']])
  expect(f.current().reply?.currentBySource.qwenwork.modelId).toBe('native-one')
  expect(f.current().reply?.current.modelId).toBe('custom-two')
  expect(f.current().pending).toBeUndefined()
})

test('queued writes notify only their own successful choice after a delayed source save', async () => {
  const write = deferred(), notices: string[] = []
  let calls = 0
  const f = fixture(async () => ++calls === 1 ? write.promise : calls === 2 ? { ok: true } : { ok: false, error: 'Save failed' })
  const source = f.choose('qwenwork', 'source', () => notices.push('source'))
  const model = f.choose('native-one', 'model', () => notices.push('model'))
  const failed = f.choose('custom', 'source', () => notices.push('failed'))
  expect(notices).toEqual([])
  write.resolve({ ok: true })
  await Promise.all([source, model, failed])
  expect(notices).toEqual(['source', 'model'])
  expect(f.current().reply?.selection).toBe('qwenwork')
})

test('failed source changes restore the complete last confirmed pair', async () => {
  const f = fixture(async () => ({ ok: false, error: 'Credential expired' }))
  await f.choose('qwenwork', 'source')
  expect(f.current().reply?.current).toEqual({ source: 'custom', modelId: 'custom-two' })
  expect(f.current().error).toBe('Credential expired')
  expect(f.current().saveError).toBe(true)
  expect(f.current().pending).toBeUndefined()
})

test('a failed queued model choice rolls back to the preceding successful source change', async () => {
  const write = deferred()
  let calls = 0
  const f = fixture(async () => ++calls === 1 ? write.promise : { ok: false, error: 'Model unavailable' })
  const source = f.choose('qwenwork', 'source')
  const model = f.choose('native-one', 'model')
  write.resolve({ ok: true }); await Promise.all([source, model])
  expect(f.current().reply?.current).toEqual({ source: 'qwenwork', modelId: 'native-two' })
  expect(f.current().error).toBe('Model unavailable')
})

test('a newer valid choice can succeed after an earlier source change fails', async () => {
  const write = deferred()
  let calls = 0
  const f = fixture(async () => ++calls === 1 ? write.promise : { ok: true })
  const first = f.choose('qwenwork', 'source')
  const last = f.choose('custom', 'source')
  write.resolve({ ok: false, error: 'Old source failed' }); await Promise.all([first, last])
  expect(f.current().reply?.current).toEqual({ source: 'custom', modelId: 'custom-two' })
  expect(f.current().error).toBeUndefined()
})

test('unavailable remembered identities are preserved without attempting to write an unavailable model', () => {
  const value = catalog()
  value.currentBySource.qwenwork = { source: 'qwenwork', modelId: 'retired' }
  value.options.push({ source: 'qwenwork', modelId: 'retired', available: false })
  expect(mediaSelectionChange(value, 'qwenwork', 'source')).toEqual({ source: 'qwenwork', modelId: 'retired' })
  expect(mediaSelectionChange(value, 'retired', 'model')).toBeNull()
  delete value.currentBySource.qwenwork
  expect(mediaSelectionChange(value, 'qwenwork', 'source')).toBeNull()
})

test('an intentionally disabled service keeps its real empty model identity', async () => {
  const calls: unknown[] = []
  const f = fixture(async (...args) => { calls.push(args); return { ok: true } })
  await f.choose('none', 'source')
  expect(f.current().reply?.current).toEqual({ source: 'none', modelId: '' })
  expect(calls).toEqual([['none', '']])
})

test('a verified disconnected music choice saves its model while preserving readiness', async () => {
  const none = { source: 'none', modelId: '' }, music = { source: 'qwenwork', modelId: 'minimax-music-2.5' }
  let snapshot: MediaSelectionSnapshot = { reply: { ok: true, selection: 'none', current: none, currentBySource: { none, qwenwork: music }, options: [
    { ...none, available: true }, { ...music, available: false, selectable: true, connected: false },
  ] } }
  const change = mediaSelectionChange(snapshot.reply!, 'qwenwork', 'source')!
  expect(change).toEqual({ ...music, model: music.modelId })
  const calls: unknown[] = []
  await enqueueMediaSelection(snapshot, change, update => { snapshot = update(snapshot) }, {
    set: async (...args) => { calls.push(args); return { ok: true } }, error: 'Save failed', settled: () => {},
  })
  expect(calls).toEqual([['qwenwork', 'minimax-music-2.5']])
  expect(snapshot.reply?.current).toEqual(music)
  expect(snapshot.reply?.options[1]).toMatchObject({ available: false, connected: false })
  expect(mediaSelectionChange({ ...snapshot.reply!, selection: 'none', options: [{ ...music, available: false }] }, 'qwenwork', 'source')).toBeNull()
})
