import { describe, expect, test } from 'bun:test'
import { AnnotationSessionManager } from '../main/browser/annotation-session'

const png = Buffer.from('frozen-png')
const viewport = { width: 800, height: 600 }

function fixture(overrides: { sessionId?: string; focusRevision?: number; tabId?: string } = {}) {
  const calls: Array<{ kind: string; value: unknown }> = []
  let currentSession = 'session-1'
  let focus = 7
  let tab = 'tab-1'
  let url = 'http://localhost:3000/checkout'
  let screenshotGate: Promise<void> | null = null
  let saveGate: Promise<void> | null = null
  const manager = {
    windowId: 11,
    state: () => ({
      conversationId: currentSession, tabId: tab, focusRevision: focus,
      url, title: 'Checkout',
    }),
    page: () => ({
      cdp: {
        screenshot: async () => {
          if (screenshotGate) await screenshotGate
          return { data: png.toString('base64') }
        },
        evaluate: async () => ({
          ...viewport,
          anchors: [
            { selector: '#pay', tagName: 'button', rect: { x: 100, y: 120, width: 200, height: 40 }, selectedText: 'Pay now' },
            { selector: '#pay-label', tagName: 'label', rect: { x: 90, y: 110, width: 220, height: 60 }, selectedText: 'Pay' },
          ],
        }),
      },
    }),
  }
  const persistence = {
    save: async (input: any) => {
      if (saveGate) await saveGate
      calls.push({ kind: 'save', value: input })
      return { path: '/content/shot.png', name: 'shot.png', mimeType: 'image/png' as const, size: input.bytes.length, width: input.width, height: input.height, previewUrl: 'klaus-media://preview/shot.png' }
    },
    commit: async (input: any) => { calls.push({ kind: 'commit', value: input }) },
    discard: async (id: string, path?: string) => { calls.push({ kind: 'discard', value: { id, path } }) },
  }
  const sessions = new AnnotationSessionManager({
    browser: manager as never,
    persistence,
    imageSize: async () => ({ width: 1600, height: 1200 }),
    cropImage: async (_bytes, rect) => { calls.push({ kind: 'crop', value: rect }); return { bytes: Buffer.from('crop'), width: 320, height: 180 } },
  })
  return {
    sessions, calls, persistence,
    setCurrent: (value: string) => { currentSession = value },
    setFocus: (value: number) => { focus = value },
    setTab: (value: string) => { tab = value },
    setUrl: (value: string) => { url = value },
    gateScreenshot: (value: Promise<void> | null) => { screenshotGate = value },
    gateSave: (value: Promise<void> | null) => { saveGate = value },
    get current() { return currentSession },
  }
}

describe('frozen annotation session', () => {
  test('captures one frozen snapshot and returns only bounded visible anchors', async () => {
    const f = fixture()
    const snapshot = await f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })
    expect(snapshot.snapshotId).toBeTruthy()
    expect(snapshot.tabId).toBe('tab-1')
    expect(snapshot.previewUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(snapshot.anchors[0]).toMatchObject({ kind: 'element', selector: '#pay', selectedText: 'Pay now' })
    expect(f.sessions.anchorAt(snapshot.snapshotId, { x: 200, y: 140 })?.selector).toBe('#pay')
    expect(f.sessions.anchorAt(snapshot.snapshotId, { x: 1, y: 1 })).toBeNull()
  })

  test('enforces one snapshot per window and releases it on discard', async () => {
    const f = fixture()
    const snapshot = await f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })
    await expect(f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })).rejects.toThrow(/already open/)
    await f.sessions.discard(snapshot.snapshotId)
    expect(f.sessions.has(snapshot.snapshotId)).toBe(false)
    expect(f.calls.some(entry => entry.kind === 'discard')).toBe(true)
  })

  test('crops the frozen bytes and validates task, tab and focus binding', async () => {
    const f = fixture()
    const snapshot = await f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })
    const saved = await f.sessions.save({
      snapshotId: snapshot.snapshotId, sessionId: 'session-1', tabId: 'tab-1', focusRevision: 7,
      crop: { x: 40, y: 50, width: 320, height: 180 },
    })
    expect(saved.path).toBe('/content/shot.png')
    expect(saved.mimeType).toBe('image/png')
    expect(f.calls.some(entry => entry.kind === 'crop')).toBe(true)
    const save = f.calls.find(entry => entry.kind === 'save')?.value as { bytes: Buffer }
    expect(save.bytes.toString()).toBe('crop')
    await expect(f.sessions.save({
      snapshotId: snapshot.snapshotId, sessionId: 'session-1', tabId: 'tab-2', focusRevision: 7,
    })).rejects.toThrow(/tab changed/)
  })

  test('rejects stale task snapshots before capture', async () => {
    const f = fixture()
    f.setFocus(8)
    await expect(f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })).rejects.toThrow(/stale task/)
  })

  test('rejects a same-tab URL change before anchoring or saving', async () => {
    const f = fixture()
    const snapshot = await f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })
    f.setUrl('http://localhost:3000/other')
    expect(() => f.sessions.anchorAt(snapshot.snapshotId, { x: 200, y: 140 })).toThrow(/page changed/)
    await expect(f.sessions.save({
      snapshotId: snapshot.snapshotId, sessionId: 'session-1', tabId: 'tab-1', focusRevision: 7,
    })).rejects.toThrow(/page changed/)
  })

  test('releaseWindow invalidates a pending capture', async () => {
    const f = fixture()
    let releaseShot!: () => void
    f.gateScreenshot(new Promise<void>(resolve => { releaseShot = resolve }))
    const capture = f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })
    await Promise.resolve()
    await f.sessions.releaseWindow(11)
    releaseShot()
    await expect(capture).rejects.toThrow(/released/)
    expect(f.sessions.has('missing')).toBe(false)
  })

  test('a late save cleans its staging file after discard', async () => {
    const f = fixture()
    const snapshot = await f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })
    let releaseSave!: () => void
    f.gateSave(new Promise<void>(resolve => { releaseSave = resolve }))
    const saving = f.sessions.save({
      snapshotId: snapshot.snapshotId, sessionId: 'session-1', tabId: 'tab-1', focusRevision: 7,
    })
    await Promise.resolve()
    await f.sessions.discard(snapshot.snapshotId)
    releaseSave()
    await expect(saving).rejects.toThrow(/discarded before saving completed/)
    expect(f.calls.some(entry => entry.kind === 'discard' && (entry.value as { path?: string }).path === '/content/shot.png')).toBe(true)
  })

  test('commit checks the captured binding but not the current chat, and adopted files survive discard', async () => {
    const f = fixture()
    const snapshot = await f.sessions.capture({ sessionId: 'session-1', focusRevision: 7 })
    await f.sessions.save({ snapshotId: snapshot.snapshotId, sessionId: 'session-1', tabId: 'tab-1', focusRevision: 7 })
    f.setCurrent('session-2')
    await f.sessions.commit({ snapshotId: snapshot.snapshotId, sessionId: 'session-1', tabId: 'tab-1', focusRevision: 7 })
    await f.sessions.discard(snapshot.snapshotId)
    expect(f.calls.some(entry => entry.kind === 'commit')).toBe(true)
    expect(f.calls.some(entry => entry.kind === 'discard' && (entry.value as { path?: string }).path === '/content/shot.png')).toBe(false)
  })
})
