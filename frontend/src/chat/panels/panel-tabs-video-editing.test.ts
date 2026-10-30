import { expect, test } from 'bun:test'
import { createPanelTabsFixture } from './panel-tabs-quote-routing.test'

function fixture() {
  let mode = 'monitor'
  let sessionId = 'owner'
  let activeVideoId = ''
  let activePrototypeId = ''
  const activations: string[] = []
  const window = {
    addEventListener() {},
    getCurrentSessionId: () => sessionId,
    klausActiveVideoEditingId: () => activeVideoId,
    klausActivePrototypeId: () => activePrototypeId,
    klausActivateVideoEditingPanel: async ({ id }: { id: string }) => {
      activations.push(id)
      mode = 'video-editing'
      activeVideoId = id
      return true
    },
    klausActivatePrototypePanel: async ({ id }: { id: string }) => {
      mode = 'prototype'
      activePrototypeId = id
      return true
    },
    klausOpenMonitorPanel: () => { mode = 'monitor' },
  }
  const panel = { classList: { contains: () => false }, getAttribute: () => mode }
  return {
    ...createPanelTabsFixture(window, panel), window, activations,
    setSession: (value: string) => { sessionId = value },
    presentVideo: (id: string) => { mode = 'video-editing'; activeVideoId = id },
  }
}

test('video tabs are created only for the active owner and become active after presentation', async () => {
  const f = fixture()
  expect(await f.actions.openVideoEditing({ id: 'foreign', title: 'Foreign project', sessionId: 'other' })).toBe(false)
  expect(f.activations).toEqual([])
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'video-editing')).toBe(false)
  expect(await f.actions.openVideoEditing({ id: 'film', title: 'My video', sessionId: 'owner' })).toBe(true)
  const tab = f.snapshot().tabs.find((item: any) => item.kind === 'video-editing')
  expect(tab).toMatchObject({ key: 'film', title: 'My video', active: true })
})

test('a late video activation cannot replace a newer selection', async () => {
  const f = fixture()
  let finishFirst!: (value: boolean) => void
  f.window.klausActivateVideoEditingPanel = async ({ id }: { id: string }) => {
    if (id === 'first') return new Promise<boolean>(resolve => { finishFirst = resolve })
    f.presentVideo(id)
    return true
  }
  const first = f.actions.openVideoEditing({ id: 'first', sessionId: 'owner' })
  expect(await f.actions.openVideoEditing({ id: 'second', sessionId: 'owner' })).toBe(true)
  finishFirst(true)
  expect(await first).toBe(false)
  expect(f.snapshot().tabs.find((tab: any) => tab.active)?.key).toBe('second')
})

test('a video activation that completes after a session change stays inactive', async () => {
  const f = fixture()
  let finish!: (value: boolean) => void
  f.window.klausActivateVideoEditingPanel = async () => new Promise<boolean>(resolve => { finish = resolve })
  const opening = f.actions.openVideoEditing({ id: 'film', sessionId: 'owner' })
  f.setSession('next')
  f.actions.beginSessionSwitch()
  finish(true)
  expect(await opening).toBe(false)
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'video-editing' && tab.active)).toBe(false)
})

test('video cleanup preserves prototype tabs and mode changes never create a video descriptor', async () => {
  const f = fixture()
  f.presentVideo('unregistered')
  f.actions.onModeChanged('video-editing')
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'video-editing')).toBe(false)
  await f.actions.openPrototype({ id: 'design', title: 'Design', sessionId: 'owner' })
  await f.actions.openVideoEditing({ id: 'film', title: 'Film', sessionId: 'owner' })
  f.actions.clearVideoEditings()
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'video-editing')).toBe(false)
  expect(f.snapshot().tabs.find((tab: any) => tab.kind === 'prototype')).toMatchObject({ key: 'design', title: 'Design' })
})

test('video tabs come back with the owning chat after a session round trip', async () => {
  const f = fixture()
  expect(await f.actions.openVideoEditing({ id: 'film', title: 'My video', sessionId: 'owner' })).toBe(true)
  f.actions.beginSessionSwitch('owner', 'other')
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'video-editing')).toBe(false)
  f.actions.beginSessionSwitch('other', 'owner')
  expect(f.snapshot().tabs.find((tab: any) => tab.kind === 'video-editing')).toMatchObject({ key: 'film', title: 'My video', sessionId: 'owner' })
})
