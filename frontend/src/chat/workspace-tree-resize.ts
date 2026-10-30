const STORAGE_KEY = 'klaus.workspace-tree-width.v1'

export function initializeWorkspaceTreeResize(): void {
  const handle = document.getElementById('workspace-tree-resizer')
  const panel = document.getElementById('artifacts-panel')
  const body = panel?.querySelector<HTMLElement>('.artifacts-body')
  if (!handle || !panel || !body || handle.dataset.bound) return
  handle.dataset.bound = 'true'
  let width = 250
  try { width = Number(localStorage.getItem(STORAGE_KEY)) || 250 } catch { /* Use the default width. */ }
  const limits = () => {
    const available = body.clientWidth || 460
    const max = Math.max(120, available * 0.6)
    return { min: Math.min(200, max), max }
  }
  const apply = (next: number, persist = false) => {
    const { min, max } = limits()
    const clamped = Math.round(Math.min(max, Math.max(min, next)))
    panel.style.setProperty('--workspace-tree-width', clamped + 'px')
    handle.setAttribute('aria-valuemin', String(Math.round(min)))
    handle.setAttribute('aria-valuemax', String(Math.round(max)))
    handle.setAttribute('aria-valuenow', String(clamped))
    if (persist) {
      width = clamped
      try { localStorage.setItem(STORAGE_KEY, String(width)) } catch { /* Resizing remains available. */ }
    }
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    const start = event.clientX
    const initial = Number(handle.getAttribute('aria-valuenow')) || width
    const move = (next: PointerEvent) => apply(initial + start - next.clientX)
    const finish = () => {
      apply(Number(handle.getAttribute('aria-valuenow')), true)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('lostpointercapture', finish)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('lostpointercapture', finish)
  })
  handle.addEventListener('keydown', event => {
    const { min, max } = limits()
    const current = Number(handle.getAttribute('aria-valuenow')) || width
    const next = { ArrowLeft: current + 10, ArrowRight: current - 10, Home: min, End: max }[event.key]
    if (next === undefined) return
    event.preventDefault(); apply(next, true)
  })
  handle.addEventListener('dblclick', () => apply(250, true))
  new ResizeObserver(() => apply(width)).observe(body)
  apply(width)
}
