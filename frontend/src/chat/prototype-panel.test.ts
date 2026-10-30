import { expect, test } from 'bun:test'
import { createPrototypePanel, type PrototypePanelEnvironment } from './prototype-panel'
import type { PrototypeBounds, PrototypePanelApi } from '../../bridge/prototype-api'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function tick() { for (let i = 0; i < 20; i++) await Promise.resolve() }

function fixture() {
  const calls: Array<{ op: string; id?: string; sessionId?: string; bounds?: PrototypeBounds }> = []
  const replies: Array<{ requestId: string; ok: boolean; error?: string }> = []
  const toasts: string[] = []
  let session = 'a', visible = true, width = 500
  let nextShow: ReturnType<typeof deferred<{ ok: boolean }>> | undefined
  let nextHide: ReturnType<typeof deferred<unknown>> | undefined
  let nextLayout: ReturnType<typeof deferred<unknown>> | undefined
  let openCount = 0, schedules = 0
  const api: PrototypePanelApi = {
    list: async () => ({ prototypes: [] }), open: async () => ({ ok: true }),
    panelShow: async (id, sessionId, bounds) => {
      calls.push({ op: 'show', id, sessionId, bounds })
      const held = nextShow; nextShow = undefined
      return held ? held.promise : { ok: true }
    },
    panelSetBounds: async bounds => { calls.push({ op: 'bounds', bounds }); return { ok: true } },
    panelHide: async () => {
      calls.push({ op: 'hide' })
      const held = nextHide; nextHide = undefined
      return held?.promise
    },
    panelClose: async () => { calls.push({ op: 'close' }) },
    onOpenPanel: () => {},
    openResult: async (requestId, ok, error) => { replies.push({ requestId, ok, error }) },
  }
  const env: PrototypePanelEnvironment = {
    api: () => api, currentSession: () => session, visible: () => visible,
    bounds: () => width ? { x: 20, y: 30, width, height: 600 } : null,
    layout: async () => { const held = nextLayout; nextLayout = undefined; await held?.promise },
    openMode: () => { visible = true },
    openTab: async payload => { openCount++; return surface.activate(payload) },
    toast: message => toasts.push(message), text: key => key,
    schedule: () => { schedules++ },
  }
  const surface = createPrototypePanel(env)
  return { surface, calls, replies, toasts, api,
    session: (value: string) => { session = value }, width: (value: number) => { width = value },
    visible: (value: boolean) => { visible = value },
    holdShow: () => (nextShow = deferred<{ ok: boolean }>()),
    holdHide: () => (nextHide = deferred<unknown>()),
    holdLayout: () => (nextLayout = deferred<unknown>()),
    counts: () => ({ openCount, schedules }),
  }
}

test('serializes presentation and ignores the receipt of a document closed during show', async () => {
  const f = fixture(), show = f.holdShow()
  const first = f.surface.activate({ id: 'first' })
  await tick()
  expect(f.calls.map(call => call.op)).toEqual(['show'])
  const closed = f.surface.close('first')
  const second = f.surface.activate({ id: 'second' })
  await tick()
  expect(f.calls.map(call => call.op)).toEqual(['show'])
  show.resolve({ ok: true })
  expect(await first).toBe(false)
  await closed
  expect(await second).toBe(true)
  expect(f.calls.map(call => `${call.op}:${call.id || ''}`)).toEqual(['show:first', 'close:', 'show:second'])
  expect(f.surface.state().activeId).toBe('second')
})

test('never issues a queued show invalidated by a hide or session switch', async () => {
  const f = fixture(), hidden = f.holdHide()
  const hiding = f.surface.hide()
  await tick()
  const discarded = f.surface.activate({ id: 'discarded' })
  await tick()
  f.session('b')
  const switching = f.surface.sessionChanged('b')
  hidden.resolve(undefined)
  await Promise.all([hiding, switching])
  expect(await discarded).toBe(false)
  expect(f.calls.some(call => call.op === 'show')).toBe(false)
  expect(f.calls.some(call => call.op === 'close')).toBe(false)
  expect(f.surface.state().activeId).toBe('')
})

test('hides for nested overlays and restores only after the final overlay closes', async () => {
  const f = fixture()
  expect(await f.surface.activate({ id: 'document' })).toBe(true)
  await f.surface.suspend(); await f.surface.suspend()
  await f.surface.resume()
  expect(f.calls.map(call => call.op)).toEqual(['show', 'hide'])
  await f.surface.resume()
  expect(f.calls.map(call => call.op)).toEqual(['show', 'hide', 'show'])
  expect(f.calls.at(-1)?.id).toBe('document')
  await f.surface.resume()
  expect(f.calls).toHaveLength(3)
})

test('a switch during overlay resume cannot show the outgoing document', async () => {
  const f = fixture()
  await f.surface.activate({ id: 'a-document' })
  await f.surface.suspend()
  const layout = f.holdLayout()
  const resuming = f.surface.resume()
  f.session('b')
  await f.surface.sessionChanged('b')
  layout.resolve(undefined)
  await resuming
  expect(f.calls.filter(call => call.op === 'show')).toHaveLength(1)
})

test('background results wait for their owning chat and acknowledge each request once', async () => {
  const f = fixture()
  await f.surface.onOpen({ requestId: 'background', id: 'b-document', title: 'B design', sessionId: 'b' })
  expect(f.counts().openCount).toBe(0)
  expect(f.calls).toHaveLength(0)
  expect(f.replies).toEqual([{ requestId: 'background', ok: false, error: 'prototype_background_pending' }])
  f.session('b')
  await f.surface.sessionChanged('b')
  expect(f.counts().openCount).toBe(1)
  expect(f.calls.at(-1)).toMatchObject({ op: 'show', id: 'b-document', sessionId: 'b' })
  expect(f.surface.state().activeTitle).toBe('B design')
  expect(f.replies).toHaveLength(1)
  expect(await f.surface.activate({ id: 'a-document', sessionId: 'a' })).toBe(false)
})

test('rapid chat switches leave the pending result for its next valid selection', async () => {
  const f = fixture()
  await f.surface.onOpen({ id: 'b-document', sessionId: 'b' })
  const hide = f.holdHide()
  f.session('b')
  const toB = f.surface.sessionChanged('b')
  await tick()
  f.session('c')
  const toC = f.surface.sessionChanged('c')
  hide.resolve(undefined)
  await Promise.all([toB, toC])
  expect(f.counts().openCount).toBe(0)
  f.session('b')
  await f.surface.sessionChanged('b')
  expect(f.counts().openCount).toBe(1)
  expect(f.calls.at(-1)?.id).toBe('b-document')
})

test('late layout and resize retain the document while a collapsed panel stays hidden', async () => {
  const f = fixture()
  f.width(0)
  expect(await f.surface.activate({ id: 'late' })).toBe(false)
  expect(f.calls).toHaveLength(0)
  f.width(500)
  await f.surface.syncBounds()
  f.width(600)
  await f.surface.syncBounds()
  expect(f.calls.map(call => call.op)).toEqual(['show', 'bounds'])
  f.visible(false)
  await f.surface.hide()
  await f.surface.syncBounds()
  expect(f.surface.state().activeId).toBe('late')
  expect(f.calls.map(call => call.op)).toEqual(['show', 'bounds', 'hide'])
  expect(await f.surface.activate({ id: 'late' })).toBe(true)
  expect(f.calls.at(-1)?.op).toBe('show')
})

test('reports a failed foreground presentation and never treats failure as visible', async () => {
  const f = fixture()
  f.api.panelShow = async () => ({ ok: false, error: 'Runtime unavailable' })
  await f.surface.onOpen({ id: 'failed', sessionId: 'a', requestId: 'foreground' })
  expect(f.toasts).toEqual(['Runtime unavailable'])
  expect(f.replies).toEqual([{ requestId: 'foreground', ok: false, error: 'prototype_open_failed' }])
  expect(f.surface.state().lastBounds).toBeNull()
})
