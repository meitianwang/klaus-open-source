// Curated extension brand tiles: regression guards.
//
// Pins three things, mirroring the skill-logo guards:
//
// 1. The connector logo map answers by connector id (case-insensitive) and
//    returns an empty string for unknown ids — an empty string is what sends
//    callers back to their stroke-glyph fallback; a stale src would paint a
//    broken-image bar instead.
// 2. Every mapped tile really exists under public/ so a rename or a dropped
//    asset cannot ship as a broken tile.
// 3. The GitHub connector resolves to its shipped brand mark, so the market
//    card, the installed row and the detail dialogs cannot silently fall back
//    to the generic plug glyph again.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

let getConnectorLogoSrc: (connectorId: unknown) => string
let getPluginLogoSrc: (plugin: { id?: unknown; iconDataUrl?: unknown } | null | undefined) => string
let getAgentLogoSrc: (agentType: unknown) => string

beforeAll(async () => {
  const mod = await import('./extension-logos')
  getConnectorLogoSrc = mod.getConnectorLogoSrc
  getPluginLogoSrc = mod.getPluginLogoSrc
  getAgentLogoSrc = mod.getAgentLogoSrc
})

describe('curated extension logos', () => {
  test('connector ids map to shipped brand tiles, unknown ids fall back empty', () => {
    expect(getConnectorLogoSrc('github')).toBe('extension-logos/connectors/github.png')
    expect(getConnectorLogoSrc('GitHub')).toBe('extension-logos/connectors/github.png')
    expect(getConnectorLogoSrc('computeruse')).toBe('skill-logos/computer-use.png')
    expect(getConnectorLogoSrc('group:macos')).toBe('extension-logos/connectors/macos.png')
    expect(getConnectorLogoSrc('macos-mail')).toBe('')
    expect(getConnectorLogoSrc(null)).toBe('')
    expect(getConnectorLogoSrc(undefined)).toBe('')
  })

  test('every mapped connector tile exists on disk under public/', () => {
    for (const id of ['github', 'computeruse', 'computer-use', 'group:macos', 'connectors:macos']) {
      const src = getConnectorLogoSrc(id)
      expect(src).not.toBe('')
      expect(existsSync(new URL(`../../public/${src}`, import.meta.url))).toBe(true)
    }
  })

  test('plugin and agent maps keep their curated entries and fall back empty', () => {
    expect(getPluginLogoSrc({ id: 'browser@builtin' })).toBe('extension-logos/plugins/browser.png')
    expect(getPluginLogoSrc({ id: 'iphoneuse@klaus-official' })).toBe('extension-logos/plugins/iphoneuse.png')
    expect(getPluginLogoSrc({ id: 'unknown@somewhere' })).toBe('')
    expect(getAgentLogoSrc('explore')).toBe('extension-logos/agents/explore.png')
    expect(getAgentLogoSrc('nope')).toBe('')
  })

  test('every mapped plugin tile exists on disk under public/', () => {
    for (const id of ['browser@builtin', 'digram@klaus-official', 'model3d@klaus-official',
      'prototype-studio@klaus-official', 'iphoneuse@klaus-official']) {
      const src = getPluginLogoSrc({ id })
      expect(src).not.toBe('')
      expect(existsSync(new URL(`../../public/${src}`, import.meta.url))).toBe(true)
    }
  })

  test('package artwork replaces bundled fallbacks and supports new plugin identities', () => {
    const vector = JSON.parse(readFileSync(new URL('../../../contracts/vectors/plugin-icon-vectors.json', import.meta.url), 'utf8'))
    expect(getPluginLogoSrc({ id: 'iphoneuse@klaus-official', iconDataUrl: vector.iconDataUrl })).toBe(vector.iconDataUrl)
    expect(getPluginLogoSrc({ id: 'new-plugin@local', iconDataUrl: vector.iconDataUrl })).toBe(vector.iconDataUrl)
    for (const iconDataUrl of vector.rejectedValues) {
      expect(getPluginLogoSrc({ id: 'new-plugin@local', iconDataUrl })).toBe('')
    }
    expect(getPluginLogoSrc({ id: 'new-plugin@local', iconDataUrl: 'data:image/png;base64,' + 'A'.repeat(90_000) })).toBe('')
  })
})
