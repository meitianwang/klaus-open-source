import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pipThreadSurfaceVisible, pipWorkPanelGeometry } from './computer-use-pip-geometry'
import { computePipAnchors, scaledPipRect } from './computer-use-pip-model'

const host = { x: 0, y: 0, width: 1920, height: 1100 }
const sidebar = { x: 0, y: 0, width: 320, height: 1100 }
const panel = { x: 1450, y: 0, width: 470, height: 1100 }
const header = { x: 1451, y: 0, width: 469, height: 44 }
const viewport = { x: 1451, y: 44, width: 469, height: 1056 }
const measurements = (changes: Partial<Parameters<typeof pipWorkPanelGeometry>[0]> = {}) => ({
  panel, header, viewport, mode: 'monitor', collapsed: false,
  sections: [
    { x: 1463, y: 54, width: 445, height: 186 },
    { x: 1463, y: 240, width: 445, height: 260 },
  ],
  paddingTop: 10, paddingBottom: 12, ...changes,
})

describe('picture in picture work-panel bounds', () => {
  test('a short overview leaves native hosting space below its content in the right pane', () => {
    const geometry = pipWorkPanelGeometry(measurements())
    expect(geometry.homeSurface).toEqual({ x: 1450, y: 0, width: 470, height: 512 })
    const anchors = computePipAnchors(host, [sidebar, geometry.obstacle!], geometry.homeSurface)
    expect(anchors[1].point).toEqual({ x: 1896, y: 524 })
    expect(anchors[1].point.x - 250).toBeGreaterThan(panel.x)
    expect(anchors[1].point.y + 250).toBeLessThan(host.height)
  })

  test('content taller than the scrollport reserves only the visible pane', () => {
    const geometry = pipWorkPanelGeometry(measurements({
      sections: [{ x: 1463, y: 54, width: 445, height: 2000 }],
    }))
    expect(geometry.homeSurface).toEqual(panel)
    const anchors = computePipAnchors(host, [sidebar, geometry.obstacle!], geometry.homeSurface)
    expect(anchors[1].point.x).toBeLessThanOrEqual(panel.x - 12)
  })

  test('scrolling and folding use current section bounds instead of scrollHeight or the full aside', () => {
    const scrolled = pipWorkPanelGeometry(measurements({ sections: [
      { x: 1463, y: -200, width: 445, height: 250 },
      { x: 1463, y: 50, width: 445, height: 300 },
    ] }))
    expect(scrolled.homeSurface?.height).toBe(362)
    const folded = pipWorkPanelGeometry(measurements({
      sections: [{ x: 1463, y: 54, width: 445, height: 80 }],
    }))
    expect(folded.homeSurface?.height).toBe(146)
    expect(computePipAnchors(host, [folded.obstacle!], folded.homeSurface)[1].point.y).toBe(158)
  })

  test('header and body padding remain occupied even with no visible summary sections', () => {
    expect(pipWorkPanelGeometry(measurements({ sections: [] })).homeSurface)
      .toEqual({ ...panel, height: 66 })
  })

  test('all other panel modes reserve the whole pane and a collapsed pane reserves nothing', () => {
    for (const mode of ['workspace', 'diff', 'terminal', 'side-chat', 'canvas', 'subagent', 'browser']) {
      expect(pipWorkPanelGeometry(measurements({ mode }))).toEqual({ obstacle: panel, homeSurface: null })
    }
    expect(pipWorkPanelGeometry(measurements({ collapsed: true }))).toEqual({ obstacle: null, homeSurface: null })
    expect(pipWorkPanelGeometry(measurements({ panel: null }))).toEqual({ obstacle: null, homeSurface: null })
  })

  test('Files and Changes inside the work panel do not hide the thread host', () => {
    const root = (inPanel: boolean, route = '', hidden = false) => ({
      hidden, body: { classList: { contains: (name: string) => name === route } },
      querySelectorAll: () => [{ closest: () => inPanel ? {} : null }],
    }) as unknown as Pick<Document, 'hidden' | 'body' | 'querySelectorAll'>
    expect(pipThreadSurfaceVisible(root(true))).toBe(true)
    expect(pipThreadSurfaceVisible(root(false))).toBe(false)
    expect(pipThreadSurfaceVisible(root(true, 'settings-open'))).toBe(false)
    expect(pipThreadSurfaceVisible(root(true, 'non-chat-view'))).toBe(false)
    expect(pipThreadSurfaceVisible(root(true, '', true))).toBe(false)
  })

  test('zoom converts natural bounds and padding before the unchanged native anchor rules', () => {
    const zoom = 1.25
    const natural = measurements()
    const geometry = pipWorkPanelGeometry({ ...natural,
      panel: scaledPipRect(panel, zoom), header: scaledPipRect(header, zoom), viewport: scaledPipRect(viewport, zoom),
      sections: natural.sections.map(section => scaledPipRect(section, zoom)), paddingTop: 10 / zoom, paddingBottom: 12 / zoom,
    })
    expect(geometry.homeSurface).toEqual({ x: 1160, y: 0, width: 376, height: 409.6 })
    expect(computePipAnchors(scaledPipRect(host, zoom), [geometry.obstacle!], geometry.homeSurface)[1].point)
      .toEqual({ x: 1512, y: 421.6 })
  })

  test('semantic measurement markers include the right pane without changing product layout wrappers', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    expect(html).toMatch(/<div id="app"[^>]*data-pip-anchor-host="klaus-main-thread"/)
    expect(html).toMatch(/<div id="sidebar"[^>]*data-pip-obstacle="sidebar"/)
    expect(html).toMatch(/<aside id="artifacts-panel"[^>]*data-pip-work-panel="thread"/)
    expect(html).toMatch(/class="artifacts-body"[^>]*data-pip-home-surface="thread-summary-panel"/)
    expect(html.match(/data-pip-summary-section/g)?.length).toBe(6)
  })
})
