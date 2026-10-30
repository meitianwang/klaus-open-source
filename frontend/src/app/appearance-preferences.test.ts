import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const rootProperties = new Map<string, string>()
const preferences = new Map<string, unknown>()
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
const appWindow: any = {
  klaus: { settings: { kv: { get: async (key: string) => preferences.get(key) ?? null } } },
  matchMedia: () => ({ matches: true, addEventListener() {} }),
  dispatchEvent() {},
}

beforeAll(async () => {
  for (const [key, value] of Object.entries({
    window: appWindow,
    navigator: { platform: 'MacIntel' },
    document: {
      documentElement: {
        style: { setProperty: (name: string, value: string) => rootProperties.set(name, value) },
        dataset: {},
        classList: { toggle() {} },
        setAttribute() {},
      },
      querySelectorAll: () => [],
    },
  })) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  await import('./i18n')
  await appWindow.loadPreferences()
})

afterAll(() => {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

describe('appearance preference application', () => {
  test('missing saved sizes load desktop defaults instead of minimum values', async () => {
    preferences.clear()
    await appWindow.loadPreferences()
    expect(rootProperties.get('--text-body')).toBe('14px')
    expect(rootProperties.get('--text-small')).toBe('13px')
    expect(rootProperties.get('--code-font-size')).toBe('13px')
    expect(rootProperties.get('--leading-mcp-entry-name')).toBe('19px')
    expect(rootProperties.get('--leading-mcp-entry-desc')).toBe('16px')
    expect(rootProperties.get('--fg')).toBe('#dfdfdf')
    expect(rootProperties.get('--fg-secondary')).toBe('rgba(255, 255, 255, 0.7)')
    expect(rootProperties.get('--fg-tertiary')).toBe('rgba(255, 255, 255, 0.5)')
  })

  test('explicit font choices survive loading and scale the entire UI', async () => {
    preferences.set('appearance.ui_font_size', '16')
    preferences.set('appearance.code_font_size', '12')
    await appWindow.loadPreferences()
    expect(rootProperties.get('--text-body')).toBe('16px')
    expect(rootProperties.get('--text-display')).toBe('32px')
    expect(rootProperties.get('--code-font-size')).toBe('12px')
    expect(rootProperties.get('--leading-mcp-entry-name')).toBe('22px')
    expect(rootProperties.get('--leading-mcp-entry-desc')).toBe('19px')
  })

  test('custom palette ink remains distinct from the neutral default', async () => {
    preferences.set('appearance.dark.code_theme_id', 'catppuccin')
    await appWindow.loadPreferences()
    expect(rootProperties.get('--fg')).toBe('#cdd6f4')
    expect(rootProperties.get('--fg-secondary')).toBe('rgba(205, 214, 244, 0.7)')
  })
})
