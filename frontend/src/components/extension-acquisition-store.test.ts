import { describe, expect, test } from 'bun:test'
import { ExtensionAcquisitionStore, type AcquisitionOutcome } from './extension-acquisition-store'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ExtensionAcquisitionStore', () => {
  test('serializes concurrent acquisitions, attaches progress only while running, and cancels queued/running items cleanly', async () => {
    let listener: ((event: any) => void) | undefined
    const cancelledIds: string[] = []
    const store = new ExtensionAcquisitionStore({
      cancel: async id => { cancelledIds.push(id); return { ok: true, cancelled: true } },
      onProgress: cb => { listener = cb; return () => { listener = undefined } },
    })

    let settleA!: (value: AcquisitionOutcome) => void
    const first = store.enqueue('skill-a', 'update', () => new Promise(resolve => { settleA = resolve }))
    let ranB = false
    const second = store.enqueue('skill-b', 'update', async () => { ranB = true; return { ok: true } })
    await tick()

    expect(store.getSnapshot().operations['skill-a']?.phase).toBe('running')
    expect(store.getSnapshot().operations['skill-b']?.phase).toBe('queued')

    // Cancel queued skill-b before it reaches IPC.
    expect(await store.cancel('skill-b')).toBe(true)
    expect(store.getSnapshot().operations['skill-b']).toBeUndefined()

    // Stream progress on skill-a.
    listener?.({ id: 'skill-a', action: 'update', stage: 'downloading', percent: 41, transferred: 50, total: 100, bytesPerSecond: 20, cancellable: true })
    expect(store.getSnapshot().operations['skill-a']?.progress?.percent).toBe(41)

    // Cancel running skill-a.
    expect(await store.cancel('skill-a')).toBe(true)
    expect(store.getSnapshot().operations['skill-a']?.cancelling).toBe(true)
    expect(cancelledIds).toEqual(['skill-a'])

    settleA({ ok: false, cancelled: true })
    expect((await first).cancelled).toBe(true)
    expect((await second).cancelled).toBe(true)
    expect(ranB).toBe(false)
    expect(store.getSnapshot().operations['skill-a']).toBeUndefined()
  })

  test('batch updates count failures separately from user cancellations', async () => {
    const store = new ExtensionAcquisitionStore({})
    await store.runBatch(['ok-item', 'cancelled-item', 'failed-item'], id =>
      store.enqueue(id, 'update', async () => {
        if (id === 'ok-item') return { ok: true, version: '2.0.0' }
        if (id === 'cancelled-item') return { ok: false, cancelled: true }
        return { ok: false, error: 'Network unavailable' }
      }),
    )
    expect(store.getSnapshot().batch).toEqual({
      total: 3,
      completed: 3,
      failed: 1,
      running: false,
    })
  })
})
