import { expect, test } from 'bun:test'
import { externalImportHasDetectedItems, externalImportItemId, externalImportProviders, externalImportState, initExternalImportState, toggleProvider } from './state'

test('external import selects historical chats but requires explicit review of executable and project content', () => {
  const items = ['SESSIONS', 'PROJECTS', 'SKILLS', 'PLUGINS', 'MCP_SERVER_CONFIG', 'CONFIG'].map(itemType => ({ providerId: 'claude-code', itemType }))
  initExternalImportState({ items })
  expect(externalImportState.selectedProviderIds.has('claude-code')).toBe(true)
  expect(externalImportState.selectedItemIds).toEqual(new Set([externalImportItemId(items[0])]))
})

test('the three supported sources stay visible without conflating no data and unsupported native chats', () => {
  initExternalImportState({ items: [{ providerId: 'claude-code', itemType: 'SESSIONS' }] })
  const providers = externalImportProviders()
  expect(providers.map(provider => provider.id)).toEqual(['claude-code', 'qoder', 'codex'])
  expect(providers.find(provider => provider.id === 'qoder')).toMatchObject({ itemCount: 0, nativeChatsSupported: false })
  expect(providers.find(provider => provider.id === 'codex')).toMatchObject({ itemCount: 0, nativeChatsSupported: true })
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
