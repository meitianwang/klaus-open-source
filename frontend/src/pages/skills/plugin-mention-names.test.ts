import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { pluginMentionNames } from './localize'

// The mention label and its searchable aliases come from the same window tables
// the plugin page reads, so a row in the @ menu and the card on the page can
// never disagree about which name a plugin has in the active language.
const TABLES = {
  PLUGIN_NAME_EN_OVERRIDES: { digram: 'Diagrams' },
  PLUGIN_NAME_ZH_OVERRIDES: { digram: '图表' },
  PLUGIN_NAME_TOKEN_ZH: {},
  PLUGIN_LSP_LANGUAGE_NAMES: {},
}

const previousWindow = (globalThis as any).window

beforeEach(() => {
  ;(globalThis as any).window = { ...TABLES }
})

afterEach(() => {
  ;(globalThis as any).window = previousWindow
})

describe('pluginMentionNames', () => {
  test('a zh UI shows the zh product name and keeps the slug plus the en name searchable', () => {
    ;(globalThis as any).window.currentLang = 'zh'
    const names = pluginMentionNames({ id: 'digram@klaus-official', name: 'digram' })
    expect(names.display).toBe('图表')
    // The raw slug and the other-language product name stay addressable; the
    // displayed name itself is not duplicated into the alias set.
    expect(names.aliases).toEqual(['digram', 'Diagrams', 'Digram'])
  })

  test('an en UI shows the en product name and keeps the slug plus the zh name searchable', () => {
    ;(globalThis as any).window.currentLang = 'en'
    const names = pluginMentionNames({ id: 'digram@klaus-official', name: 'digram' })
    expect(names.display).toBe('Diagrams')
    expect(names.aliases).toEqual(['digram', '图表', 'Digram'])
  })

  test('a plugin without an override titleizes its slug and keeps the slug searchable', () => {
    ;(globalThis as any).window.currentLang = 'zh'
    const names = pluginMentionNames({ id: 'my-plug@klaus-official', name: 'my-plug' })
    // Same titleization the plugin page applies, so menu and page agree.
    expect(names.display).toBe('MY Plug')
    expect(names.aliases).toContain('my-plug')
  })

  test('a row whose display name equals its slug carries no redundant alias for it', () => {
    ;(globalThis as any).window.currentLang = 'en'
    const names = pluginMentionNames({ id: 'github@klaus-official', name: 'github' })
    // Without an en override the page shows the slug verbatim, so the mention
    // label is the slug itself and only the titleized form remains an alias.
    expect(names.display).toBe('github')
    expect(names.aliases).toEqual(['Github'])
  })
})
