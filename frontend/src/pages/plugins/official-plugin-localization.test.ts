import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { localizePluginDescription, localizePluginName } from '../skills/localize'

// The official plugin lineup ships localized product names and Chinese
// descriptions through the shared market tables mounted on window. A missing
// entry degrades silently: the en card prints the raw package slug and the zh
// card prints a titleized slug, which is exactly the "the name says nothing"
// regression this file pins. The slug list is spelled out here on purpose —
// the official lineup lives in the private catalog, which this repository
// must not read, so adding an official plugin means adding its slug here.
const OFFICIAL_SLUGS = [
  'audio-separator',
  'browser',
  'digram',
  'iphoneuse',
  'model3d',
  'ppt',
  'prototype-studio',
  'reverse-engineering',
  'stickman-video-director',
  'video-editing',
  'voice-clone',
] as const

const CJK = /[一-鿿]/
let previousWindow: PropertyDescriptor | undefined

beforeAll(async () => {
  const g = globalThis as any
  previousWindow = Object.getOwnPropertyDescriptor(g, 'window')
  g.window = { currentLang: 'en' }
  const { installMarketTables } = await import('../settings/market-tables')
  installMarketTables(g.window)
})

afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete (globalThis as any).window
})

const pluginRow = (slug: string) => ({ id: `${slug}@klaus-official`, name: slug })

describe('official plugin localization', () => {
  test('every official plugin shows a product name instead of its slug in en', () => {
    ;(globalThis as any).window.currentLang = 'en'
    const slugs = OFFICIAL_SLUGS.filter(slug => {
      const display = localizePluginName(pluginRow(slug))
      return display.length === 0 || display === slug
    })
    expect(slugs).toEqual([])
  })

  test('every official plugin has a Chinese product name carrying CJK', () => {
    ;(globalThis as any).window.currentLang = 'zh'
    const slugs = OFFICIAL_SLUGS.filter(slug => !CJK.test(localizePluginName(pluginRow(slug))))
    expect(slugs).toEqual([])
  })

  test('every official plugin resolves a Chinese description distinct from the en copy', () => {
    const slugs = OFFICIAL_SLUGS.filter(slug => {
      const row = pluginRow(slug)
      ;(globalThis as any).window.currentLang = 'en'
      const en = localizePluginDescription(row)
      ;(globalThis as any).window.currentLang = 'zh'
      const zh = localizePluginDescription(row)
      return !CJK.test(zh) || zh === en
    })
    expect(slugs).toEqual([])
  })

  test('the phone-control plugin keeps the names this round restored', () => {
    ;(globalThis as any).window.currentLang = 'en'
    expect(localizePluginName(pluginRow('iphoneuse'))).toBe('iPhone Use')
    ;(globalThis as any).window.currentLang = 'zh'
    expect(localizePluginName(pluginRow('iphoneuse'))).toBe('iPhone 操控')
  })
})
