import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const names = ['window', 'document', 'localStorage'] as const
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
const storage = new Map<string, string>()
let panelTabs: any

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { addEventListener() {}, dispatchEvent() { return true } } },
    document: { configurable: true, value: {
      getElementById: () => null,
      body: { classList: { toggle() {} } },
    } },
    localStorage: { configurable: true, value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    } },
  })
  await import('./panel-tabs')
  panelTabs = (globalThis as any).window.KlausPanelTabs
})

afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

describe('browser tab persistence', () => {
  test('later task registration preserves one already-open child tab', async () => {
    panelTabs.clearSubagents()
    await panelTabs.openSubagent('early-child', 'Review')
    await panelTabs.openSubagent('dispatch', 'Review')
    panelTabs.remapSubagentTasks({ 'early-child': 'dispatch' })
    expect(panelTabs.remove('subagent', 'early-child')).toBeNull()
    expect(panelTabs.remove('subagent', 'dispatch')?.key).toBe('dispatch')
    expect(panelTabs.remove('subagent', 'dispatch')).toBeNull()
  })
  test('does not save temporary loopback pages but keeps ordinary pages', () => {
    panelTabs.beginSessionSwitch(null, 'preview-source')
    panelTabs.syncBrowserTabs([
      { id: 'iab-local', url: 'http://127.0.0.1:8874/klaus.html', title: 'Klaus' },
      { id: 'iab-public', url: 'https://example.com/docs', title: 'Docs' },
    ])
    panelTabs.saveFor('preview-source')
    expect(JSON.parse(storage.get('klaus.panelTabs.preview-source')!).tabs).toEqual([
      { kind: 'browser', url: 'https://example.com/docs' },
    ])
    expect(panelTabs.remove('browser', 'iab-local')?.url).toBe('http://127.0.0.1:8874/klaus.html')
  })

  test('ignores previously saved local URLs without hiding a live agent page', () => {
    storage.set('klaus.panelTabs.preview-return', JSON.stringify({ version: 1, tabs: [
      { kind: 'browser', url: 'http://localhost:8791/preview' },
      { kind: 'browser', url: 'http://[::1]:8792/preview' },
      { kind: 'browser', url: 'https://example.com/docs' },
    ] }))
    panelTabs.beginSessionSwitch('preview-source', 'preview-return')
    expect(panelTabs.remove('browser', 'restored:http://localhost:8791/preview')).toBeNull()
    expect(panelTabs.remove('browser', 'restored:http://[::1]:8792/preview')).toBeNull()
    expect(panelTabs.remove('browser', 'restored:https://example.com/docs')?.pending).toBe(true)
    panelTabs.syncBrowserTabs([{ id: 'iab-agent', url: 'http://127.0.0.1:8874/klaus.html', title: 'Klaus' }])
    expect(panelTabs.remove('browser', 'iab-agent')?.url).toBe('http://127.0.0.1:8874/klaus.html')
  })

  test('restores native editor descriptors with their document key', () => {
    storage.set('klaus.panelTabs.native-return', JSON.stringify({ version: 1, tabs: [
      { kind: 'ppt', key: 'deck-a', title: 'Quarterly review' },
      { kind: 'ppt' },
      { kind: 'video-editing', key: 'film', title: 'My video' },
    ] }))
    panelTabs.beginSessionSwitch(null, 'native-return')
    expect(panelTabs.remove('ppt', 'deck-a')).toMatchObject({ key: 'deck-a', title: 'Quarterly review', sessionId: 'native-return' })
    expect(panelTabs.remove('ppt', '')).toBeNull()
    expect(panelTabs.remove('video-editing', 'film')).toMatchObject({ key: 'film', sessionId: 'native-return' })
  })
})
