import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalImportFlow } from './ExternalImport'
import { externalImportHasDetectedItems, externalImportItemId, externalImportProviders, externalImportState, initExternalImportState, toggleProvider } from './state'

test('external import selects historical chats but requires explicit review of executable and project content', () => {
  const items = ['SESSIONS', 'PROJECTS', 'SKILLS', 'PLUGINS', 'MCP_SERVER_CONFIG', 'CONFIG'].map(itemType => ({ providerId: 'claude-code', itemType }))
  initExternalImportState({ items })
  expect(externalImportState.selectedProviderIds.has('claude-code')).toBe(true)
  expect(externalImportState.selectedItemIds).toEqual(new Set([externalImportItemId(items[0])]))
})

test('the three supported sources stay visible even when some have no importable items', () => {
  initExternalImportState({ items: [{ providerId: 'claude-code', itemType: 'SESSIONS' }] })
  const providers = externalImportProviders()
  expect(providers.map(provider => provider.id)).toEqual(['claude-code', 'qoder', 'codex'])
  expect(providers.find(provider => provider.id === 'qoder')).toMatchObject({ itemCount: 0 })
  expect(providers.find(provider => provider.id === 'codex')).toMatchObject({ itemCount: 0 })
  expect(externalImportState.selectedProviderIds).toEqual(new Set(['claude-code']))
  toggleProvider('qoder')
  expect(externalImportState.selectedProviderIds).toEqual(new Set(['claude-code']))
  toggleProvider('claude-code')
  expect(externalImportHasDetectedItems()).toBe(true)
  expect(externalImportState.selectedProviderIds.size).toBe(0)
})

test('removed sources cannot reappear from a stale detection payload', () => {
  initExternalImportState({
    providers: [{ id: 'kiro', name: 'Kiro', itemCount: 1 }],
    items: [{ providerId: 'kiro', itemType: 'SKILLS' }],
  })
  expect(externalImportProviders().map(provider => provider.id)).toEqual(['claude-code', 'qoder', 'codex'])
  expect(externalImportHasDetectedItems()).toBe(false)
  expect(externalImportState.selectedProviderIds.size).toBe(0)
})

for (const [currentLang, count, empty] of [
  ['en', '2 importable items', 'No importable local data was found on this computer.'],
  ['zh', '发现 2 项可导入内容', '未在这台电脑上检测到可导入的本地数据。'],
] as const) {
  test(`external import renders the Qoder count and empty state without chat notices (${currentLang})`, () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { currentLang } })
    try {
      const render = () => renderToStaticMarkup(createElement(ExternalImportFlow, {
        mode: 'embedded', onSkip: () => {}, onImported: () => {},
      }))
      initExternalImportState({ items: [
        { providerId: 'qoder', itemType: 'SKILLS' },
        { providerId: 'qoder', itemType: 'PROJECTS' },
      ] })
      const populated = render()
      expect(populated).toMatch(new RegExp(`>Qoder</div><div[^>]*>${count}</div>`))
      initExternalImportState({ items: [] })
      const emptyMarkup = render()
      expect(emptyMarkup).toContain(empty)
      for (const markup of [populated, emptyMarkup]) {
        expect(markup).not.toMatch(/原生聊天暂不支持|Native chats not supported|native chats are not supported yet/i)
      }
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
}
