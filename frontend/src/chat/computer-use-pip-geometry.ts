import type { ComputerUsePipRect as Rect } from '../../bridge/types'

export function pipThreadSurfaceVisible(root: Pick<Document, 'hidden' | 'body' | 'querySelectorAll'> = document): boolean {
  if (root.hidden || root.body.classList.contains('non-chat-view') || root.body.classList.contains('settings-open')) return false
  // Files and Changes are work-panel modes. Only a detail surface outside that
  // pane replaces the thread; an occupied pane is handled as an obstacle below.
  return ![...root.querySelectorAll('#diff-view.active, #workspace-main-view.active')]
    .some(element => !element.closest('[data-pip-work-panel]'))
}

interface WorkPanelMeasurements {
  panel: Rect | null
  mode: string | null
  collapsed: boolean
  header: Rect | null
  viewport: Rect | null
  sections: Rect[]
  paddingTop: number
  paddingBottom: number
}

function intersection(rect: Rect, clip: Rect): Rect | null {
  const x = Math.max(rect.x, clip.x)
  const y = Math.max(rect.y, clip.y)
  const right = Math.min(rect.x + rect.width, clip.x + clip.width)
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** Empty Overview space can host PiP; other work surfaces reserve the whole pane. */
export function pipWorkPanelGeometry(measurements: WorkPanelMeasurements): { obstacle: Rect | null; homeSurface: Rect | null } {
  const { panel, mode, collapsed, header, viewport, sections, paddingTop, paddingBottom } = measurements
  if (!panel || collapsed) return { obstacle: null, homeSurface: null }
  if (mode !== 'monitor') return { obstacle: panel, homeSurface: null }
  const headerRect = header ? intersection(header, panel) : null
  const scrollport = viewport ? intersection(viewport, panel) : null
  let bottom = headerRect ? headerRect.y + headerRect.height : panel.y
  if (scrollport) {
    const visibleSections = sections.flatMap(section => {
      const visible = intersection(section, scrollport)
      return visible ? [visible] : []
    })
    const contentBottom = visibleSections.length
      ? Math.max(...visibleSections.map(section => section.y + section.height))
      : scrollport.y + Math.max(0, paddingTop)
    bottom = Math.max(bottom, Math.min(scrollport.y + scrollport.height, contentBottom + Math.max(0, paddingBottom)))
  }
  const height = Math.min(panel.height, bottom - panel.y)
  const occupied = height > 0 ? { ...panel, height } : null
  return { obstacle: occupied, homeSurface: occupied }
}
