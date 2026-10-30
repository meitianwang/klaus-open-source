import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const INDEX_HTML = root('../../index.html')
const CHAT_TS = root('./chat.ts')
const PANEL = root('./canvas-panel.ts')
const PANEL_TABS = root('./panels/panel-tabs.tsx')

describe('Canvas right work panel', () => {
  test('owns a closable Canvas mode inside the shared panel', () => {
    const panelStart = INDEX_HTML.indexOf('<aside id="artifacts-panel"')
    const canvasStart = INDEX_HTML.indexOf('<section id="canvas-panel"')
    const panelEnd = INDEX_HTML.indexOf('</aside>', panelStart)
    expect(canvasStart).toBeGreaterThan(panelStart)
    expect(canvasStart).toBeLessThan(panelEnd)
    expect(PANEL_TABS).toContain("canvas: { fixed: false, mode: 'canvas'")
    expect(PANEL_TABS).toContain("case 'canvas':")
    expect(PANEL_TABS).toContain('openCanvas,')
    expect(PANEL_TABS).toContain('closeCanvas,')
    expect(CHAT_TS).toContain("'spec', 'canvas'")
  })

  test('routes host opens through the shared panel', () => {
    expect(PANEL).toContain('onOpenPanel(openPayload)')
    expect(PANEL).toContain('panelShow(path, title, next, reload)')
    expect(PANEL).toContain('ok = opened === true')
  })

  test('reloads the same path and defers background-session opens', () => {
    expect(PANEL_TABS).toContain('reloadCanvas: !!existingForPath')
    expect(PANEL).toContain('showRuntime({ reload })')
    expect(PANEL).toContain('enqueueHost(')
    expect(PANEL).toContain('pendingBySession.set(payload.sessionId, payload)')
    expect(PANEL).toContain("window.addEventListener('klaus:session-change'")
  })
})
