import { expect, test } from 'bun:test'
import { referenceCapabilityTile, rememberComposerMcpVisuals, sanitizeMcpCatalogGlyph, mcpReferenceLabel } from './capability-chip-visuals'
import { normalizeComposerReferences } from './reference-token'
import { resolveFileCardBadge } from './file-card-visuals'

test('catalog path bodies retain geometry but unsafe SVG is rejected', () => {
  const path = '<path d="M4 4h16v16H4z"/>'
  expect(sanitizeMcpCatalogGlyph(path)).toContain(`viewBox="0 0 24 24"`)
  for (const bad of ['<script/>', '<path onload="alert(1)"/>', '<path fill="url(https://example.com)"/>', '<path href="x"/>']) expect(sanitizeMcpCatalogGlyph(bad)).toBe('')
  rememberComposerMcpVisuals([{ id: 'postgres', nameEn: 'PostgreSQL', iconSvg: path }])
  expect(mcpReferenceLabel({ name: 'postgres' })).toBe('PostgreSQL')
  expect(referenceCapabilityTile({ kind: 'mcp', name: 'postgres', needsAuth: true }, '')).toContain(path)
  expect(referenceCapabilityTile({ kind: 'mcp', name: 'postgres', needsAuth: true }, '')).toContain('slash-chip-status-dot')
})

test('restored connector identity remains distinct from MCP', () => {
  for (const id of ['github', 'macos-calendar']) {
    const [ref] = normalizeComposerReferences(`[Label](klaus:mcp/${id})`, [])
    expect(ref.connectorId).toBe(id)
    expect(referenceCapabilityTile(ref, '')).toContain('is-connector-tile')
  }
})

test('semantic file tiles classify known extensions and use a generic fallback', () => {
  for (const [ext, tone] of Object.entries({ pdf: 'pdf', ts: 'code', xlsx: 'sheet', docx: 'doc', zip: 'archive', mp4: 'media', unknown: 'generic' })) expect(resolveFileCardBadge(`name.${ext}`).tone).toBe(tone)
})

import { rememberComposerPluginVisuals, renderCapabilityMiniTileHtml } from './capability-chip-visuals'

test('shipped and registered artwork use brand tiles, unknown entries use glyphs', () => {
  const tile = (kind: 'skill' | 'plugin' | 'agent', id: string, iconUrl?: string) => referenceCapabilityTile({ kind, id, name: id, iconUrl }, '')
  expect(tile('skill', 'pdf')).toContain('<img src="skill-logos/pdf.png"')
  expect(tile('skill', 'custom', 'data:image/png;base64,iVBORw0KGgo=')).toContain('is-brand-tile')
  expect(tile('skill', 'custom')).not.toContain('is-brand-tile')
  for (const id of ['design', 'design@klaus-official']) expect(tile('plugin', id)).toContain('is-plugin-tile is-brand-tile')
  rememberComposerPluginVisuals([{ id: 'custom', iconDataUrl: 'https://example.com/icon.png' }])
  expect(tile('plugin', 'custom')).toContain('is-plugin-tile is-brand-tile')
  expect(tile('plugin', 'unknown')).not.toContain('is-brand-tile')
  expect(tile('agent', 'explore')).toContain('is-agent-tile is-brand-tile')
  expect(renderCapabilityMiniTileHtml('shortcut', 'slash-token-icon', '<svg/>')).toContain('is-shortcut-tile')
})

test('healthy and passive references and unchanged quotes have distinct markup', async () => {
  for (const name of ['github', 'postgres']) expect(referenceCapabilityTile({ kind: 'mcp', name, needsAuth: false }, '')).not.toContain('slash-chip-status-dot')
  const previous = globalThis.window
  ;(globalThis as any).window ??= globalThis
  try {
    const { renderSentQuoteCardHtml } = await import('../transcript/factories')
    const { composerReferenceClass, composerReferenceIconSvg } = await import('./reference-pill')
    expect(composerReferenceClass({ kind: 'skill', name: 'demo', unavailable: true })).toContain('is-unavailable')
    for (const kind of ['file', 'folder', 'browser-tab', 'conversation', 'device'] as const) {
      expect(composerReferenceClass({ kind, name: 'demo' })).toContain('is-context-chip')
      expect(composerReferenceIconSvg({ kind, name: 'sample', value: '', range: { start: 0, end: 0 } })).not.toContain('slash-chip-tile')
    }
    for (const inline of [false, true]) {
      const html = renderSentQuoteCardHtml({ text: 'hello world' }, inline)
      expect(html).toContain(`class="kls-attach-chip is-quote${inline ? ' is-inline' : ''}"`)
      expect(html).not.toMatch(/slash-chip-tile|data-file-tone/)
    }
  } finally {
    if (previous) globalThis.window = previous
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
