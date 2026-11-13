import { describe, expect, test } from 'bun:test'
import cursorVectors from '../../../../contracts/vectors/cursor-grouped-parameters-vectors.json'
import { agentFieldsFromContent, buildAgentMarkdownFromForm, buildAgentModelItems, normalizeAgentCreateName } from './model-items'

const base = {
  name: 'audit-agent',
  description: 'Use for a focused audit.',
  model: 'inherit',
  prompt: 'Inspect the requested surface and report concrete findings.',
}

describe('agent form contract', () => {
  for (const [toolsMode, marker] of [
    ['all', 'tools: "*"'],
    ['read', 'tools:\n  - Read\n  - Glob\n  - Grep'],
    ['none', 'tools: []'],
  ] as const) {
    test(`round-trips the ${toolsMode} tool policy`, () => {
      const markdown = buildAgentMarkdownFromForm({ ...base, toolsMode })
      expect(markdown).toContain(marker)
      expect(agentFieldsFromContent(markdown)?.toolsMode).toBe(toolsMode)
    })
  }

  test('round-trips the optional execution controls', () => {
    const markdown = buildAgentMarkdownFromForm({
      ...base,
      toolsMode: 'read',
      isolation: 'worktree',
      maxTurns: 9,
      background: true,
    })
    expect(agentFieldsFromContent(markdown)).toEqual({
      ...base,
      toolsMode: 'read',
      isolation: 'worktree',
      maxTurns: 9,
      background: true,
    })
  })

  test('normalizes names to the same safe filename-compatible form used by the editor', () => {
    expect(normalizeAgentCreateName('  Review my change!  ')).toBe('Review-my-change')
  })

  test('round-trips a concrete source:model reference written by the form', () => {
    const markdown = buildAgentMarkdownFromForm({ ...base, model: 'qoder:fast', toolsMode: 'all' })
    expect(markdown).toContain('model: qoder:fast')
    expect(agentFieldsFromContent(markdown)?.model).toBe('qoder:fast')
  })

  test('model references the engine would reject fall back to the raw editor', () => {
    for (const model of ['qoder:', ':fast', 'qoder :fast', 'qoder: fast', 'Qoder Fast', 'qoder:fa st']) {
      const markdown = buildAgentMarkdownFromForm({ ...base, model, toolsMode: 'all' })
      expect(agentFieldsFromContent(markdown)).toBeNull()
    }
  })

  for (const [source, sourceName, modelId] of [
    ['qwenwork', 'QwenWork', 'ultimate'],
  ] as const) {
  test(`reads the shared mapping for ${source} and keeps all four menu entries`, async () => {
    const previous = (globalThis as any).window
    ;(globalThis as any).window = {
      currentLang: 'en',
      settingsApi: {
        kv: { get: async () => { throw new Error('Do not read auth_mode or legacy mappings') } },
        models: {
          getTiers: async () => ({ ok: true, mapping: { version: 1, revision: 1, high: { source, modelId }, medium: { source: 'custom', modelId: 'standard' }, low: null } }),
          tierOptions: async () => ({ ok: true, revision: 2, sources: [
            { source, status: 'ready', options: [{ modelId, label: 'Premium' }] },
            { source: 'custom', status: 'ready', options: [{ modelId: 'standard', label: 'Standard' }] },
          ], tiers: { high: { status: 'unavailable', label: 'Another revision model' }, medium: { status: 'ready', label: 'Another revision model' }, low: { status: 'inherit' } } }),
        },
      },
    }
    try {
      expect(await buildAgentModelItems()).toEqual([
        { value: 'inherit', label: 'Follow this chat’s main model' },
        { value: 'high', label: `High · ${sourceName} · Premium` },
        { value: 'medium', label: 'Medium · Custom model · Standard' },
        { value: 'low', label: 'Low · Follow this chat’s main model' },
      ])
    } finally {
      ;(globalThis as any).window = previous
    }
  })
  }

  test('three tiers using the same model are never deduplicated', async () => {
    const previous = (globalThis as any).window
    const target = { source: 'codex', modelId: 'shared' }
    ;(globalThis as any).window = {
      currentLang: 'en',
      settingsApi: { models: {
        getTiers: async () => ({ ok: true, mapping: { version: 1, revision: 1, high: target, medium: target, low: target } }),
        tierOptions: async () => ({ ok: true, sources: [{ source: 'codex', status: 'ready', options: [{ modelId: 'shared', label: 'One model' }] }], tiers: { high: { status: 'ready' }, medium: { status: 'ready' }, low: { status: 'ready' } } }),
      } },
    }
    try {
      const items = await buildAgentModelItems()
      expect(items.map(item => item.value)).toEqual(['inherit', 'high', 'medium', 'low'])
      expect(items.slice(1).every(item => item.label?.includes('One model'))).toBe(true)
    } finally {
      ;(globalThis as any).window = previous
    }
  })

  test('catalog model labels remain selectable without local credential availability checks', async () => {
    const previous = (globalThis as any).window
    ;(globalThis as any).window = {
      currentLang: 'en',
      settingsApi: { models: {
        getTiers: async () => ({ ok: true, mapping: { version: 1, revision: 1, high: { source: 'custom', modelId: 'no-key' }, medium: null, low: null } }),
        tierOptions: async () => ({ ok: true, sources: [{ source: 'custom', status: 'ready', options: [
          { modelId: 'valid', label: 'Configured model' }, { modelId: 'no-key', label: 'Missing key model', available: false },
        ] }], tiers: { high: { status: 'ready', label: 'Configured model' }, medium: { status: 'inherit' }, low: { status: 'inherit' } } }),
      } },
    }
    try {
      const items = await buildAgentModelItems()
      expect(items[1].label).toBe('High · Custom model · Missing key model')
      expect(items.map(item => item.value)).toEqual(['inherit', 'high', 'medium', 'low'])
    } finally {
      ;(globalThis as any).window = previous
    }
  })

  test('unavailable catalogs preserve explicit references and the fixed menu', async () => {
    const previous = (globalThis as any).window
    ;(globalThis as any).window = {
      currentLang: 'en',
      settingsApi: { models: {
        getTiers: async () => ({ ok: true, mapping: { version: 1, revision: 1, high: { source: 'local', modelId: 'deleted' }, medium: null, low: null } }),
        tierOptions: async () => { throw new Error('Catalog failed') },
      } },
    }
    try {
      const items = await buildAgentModelItems()
      expect(items.map(item => item.value)).toEqual(['inherit', 'high', 'medium', 'low'])
      expect(items[1].label).toContain('deleted')
      expect(items[1].label).toContain('Unavailable')
      expect(items[2].label).toBe('Medium · Follow this chat’s main model')
    } finally {
      ;(globalThis as any).window = previous
    }
  })

  test('a mapping failure does not turn unavailable tiers into inherited choices', async () => {
    const previous = (globalThis as any).window
    ;(globalThis as any).window = {
      currentLang: 'en',
      settingsApi: { models: { getTiers: async () => { throw new Error('Read failed') }, tierOptions: async () => { throw new Error('Read failed') } } },
    }
    try {
      expect(await buildAgentModelItems()).toEqual([
        { value: 'inherit', label: 'Follow this chat’s main model' },
        { value: 'high', label: 'High · Unavailable' },
        { value: 'medium', label: 'Medium · Unavailable' },
        { value: 'low', label: 'Low · Unavailable' },
      ])
    } finally {
      ;(globalThis as any).window = previous
    }
  })
})


test('a non-default saved Cursor variant keeps its tier available under the base model label', async () => {
  const previous = (globalThis as any).window
  ;(globalThis as any).window = { currentLang: 'en', settingsApi: { models: {
    getTiers: async () => ({ ok: true, mapping: { version: 1, revision: 1, high: { source: 'cursor', modelId: cursorVectors.savedSelection.slice('cursor:'.length) }, medium: null, low: null } }),
    tierOptions: async () => ({ ok: true, sources: [{ source: 'cursor', status: 'ready', options: [{ ...cursorVectors.model, modelId: cursorVectors.model.value.slice('cursor:'.length) }] }], tiers: { high: { status: 'ready' }, medium: { status: 'inherit' }, low: { status: 'inherit' } } }),
  } } }
  try {
    expect((await buildAgentModelItems())[1]?.label).toBe('High · Cursor · Fixture Model')
  } finally { (globalThis as any).window = previous }
})


test('a known Antigravity target retains its tier label regardless of account entitlement', async () => {
  const previous = (globalThis as any).window
  const row = { modelId: 'restricted', label: 'Restricted model', available: false, reason: 'Account restricted' }
  ;(globalThis as any).window = { currentLang: 'en', settingsApi: { models: {
    getTiers: async () => ({ ok: true, mapping: { version: 1, revision: 1, high: { source: 'antigravity', modelId: 'restricted' }, medium: null, low: null } }),
    tierOptions: async () => ({ ok: true, sources: [{ source: 'antigravity', status: 'ready', options: [row] }], tiers: { high: { status: 'ready' }, medium: { status: 'inherit' }, low: { status: 'inherit' } } }),
  } } }
  try {
    expect((await buildAgentModelItems())[1]?.label).toBe('High · Antigravity · Restricted model')
    expect(row.available).toBe(false)
  } finally { (globalThis as any).window = previous }
})
