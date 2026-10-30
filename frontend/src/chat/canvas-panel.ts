// Canvas right-panel surface.
//
// The generated React module is never evaluated in the main renderer: that page
// owns the full `window.klaus` bridge. The shell embeds canvas.html as a native
// child webview over #canvas-panel-host, preserving the narrow Canvas bridge while
// still making Canvas a normal, closable right-panel tab.

interface CanvasBounds { x: number; y: number; width: number; height: number }
interface CanvasOpenPayload { requestId?: string; filePath?: string; displayName?: string; sessionId?: string }
interface CanvasPanelApi {
  panelShow(filePath: string, displayName: string, bounds: CanvasBounds, reload?: boolean): Promise<{ ok?: boolean; error?: string }>
  panelSetBounds(bounds: CanvasBounds): Promise<{ ok?: boolean; error?: string }>
  panelHide(): Promise<unknown>
  panelClose(): Promise<unknown>
  onOpenPanel(cb: (payload: CanvasOpenPayload) => void): unknown
  openResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}

const w = () => window as any
const api = (): CanvasPanelApi | undefined => w().klaus?.canvas
const panel = document.getElementById('artifacts-panel')
const host = document.getElementById('canvas-panel-host')

let activePath = ''
let activeTitle = ''
let activeSession = ''
let presentationEpoch = 0
let opening: { epoch: number; promise: Promise<boolean> } | null = null
let boundsRaf = 0
let lastBounds: CanvasBounds | null = null
let suspendedForOverlay = 0
const pendingBySession = new Map<string, CanvasOpenPayload>()
let hostQueue: Promise<unknown> = Promise.resolve()
const transitions: Array<{ action: string; epoch: number; path: string; at: number }> = []
const currentSession = (): string => w().getCurrentSessionId?.() || ''
function trace(action: string) {
  transitions.push({ action, epoch: presentationEpoch, path: activePath, at: performance.now() })
  if (transitions.length > 64) transitions.shift()
}
function current(epoch: number) { return epoch === presentationEpoch && activeSession === currentSession() }

function enqueueHost<T>(operation: () => Promise<T>): Promise<T> {
  const next = hostQueue.then(operation, operation)
  hostQueue = next.then(() => undefined, () => undefined)
  return next
}

function visible() {
  return !!host
    && panel?.getAttribute('data-mode') === 'canvas'
    && !panel.classList.contains('collapsed')
    && !!activePath
    && activeSession === currentSession()
}

function bounds(): CanvasBounds | null {
  if (!host) return null
  const rect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function sameBounds(a: CanvasBounds | null, b: CanvasBounds | null) {
  return !!a && !!b
    && a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height
}

function waitForLayout() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

export function scheduleCanvasBoundsSync() {
  if (boundsRaf) return
  boundsRaf = requestAnimationFrame(async () => {
    boundsRaf = 0
    if (!visible() || suspendedForOverlay) return
    // Layout can become usable after activation's two frames. Create the view
    // in that case; a bounds ACK alone is never proof of a presented view.
    if (lastBounds === null) { await showRuntime(); return }
    const next = bounds()
    if (!next || sameBounds(next, lastBounds)) return
    const epoch = presentationEpoch
    const result = await enqueueHost(() => current(epoch) && visible() && !suspendedForOverlay && lastBounds !== null
      ? api()?.panelSetBounds(next) ?? Promise.resolve({ ok: false }) : Promise.resolve({ ok: false })).catch(() => ({ ok: false }))
    if (result?.ok && current(epoch) && visible() && !suspendedForOverlay && lastBounds !== null) lastBounds = next
  })
}

async function showRuntime({ reload = false } = {}) {
  if (!visible() || suspendedForOverlay) return false
  const next = bounds()
  if (!next) return false
  if (!reload && sameBounds(next, lastBounds)) return true
  const path = activePath
  const title = activeTitle
  const epoch = presentationEpoch
  if (opening?.epoch === epoch) return opening.promise
  const promise = (async () => {
    const result = await enqueueHost(() => {
      if (!current(epoch) || !visible() || suspendedForOverlay) return Promise.resolve({ ok: false })
      trace('show-request')
      return api()?.panelShow(path, title, next, reload) ?? Promise.resolve({ ok: false })
    }).catch((error: unknown) => ({
      ok: false, error: error instanceof Error ? error.message : String(error),
    }))
    if (!current(epoch) || !visible() || suspendedForOverlay) return false
    if (!result?.ok) {
      trace('show-failed')
      w().showToast?.(result?.error || 'Canvas could not open')
      return false
    }
    trace('show-ack')
    lastBounds = next
    if (!sameBounds(next, bounds())) scheduleCanvasBoundsSync()
    return true
  })()
  opening = { epoch, promise }
  try { return await promise } finally { if (opening?.promise === promise) opening = null }
}

export async function activateCanvasPanel({ path, title, reload = false }: { path?: string; title?: string; reload?: boolean } = {}) {
  if (!path) return false
  const epoch = ++presentationEpoch
  if (path !== activePath || activeSession !== currentSession()) lastBounds = null
  activePath = path
  activeSession = currentSession()
  activeTitle = title || path.split(/[\\/]/).pop()?.replace(/\.canvas\.tsx$/, '') || 'Canvas'
  trace('activate')
  w().openArtifactsPanel?.('canvas')
  await waitForLayout()
  if (!current(epoch)) return false
  return showRuntime({ reload })
}

export async function hideCanvasPanel() {
  presentationEpoch++
  lastBounds = null
  trace('hide')
  await enqueueHost(() => api()?.panelHide() ?? Promise.resolve()).catch(() => {})
}

export async function closeCanvasPanel(path = '') {
  if (path && path !== activePath) return
  presentationEpoch++
  trace('close')
  activePath = ''
  activeTitle = ''
  activeSession = ''
  lastBounds = null
  await enqueueHost(() => api()?.panelClose() ?? Promise.resolve()).catch(() => {})
}

export function initCanvasPanel() {
  w().klausActivateCanvasPanel = activateCanvasPanel
  w().klausHideCanvasPanel = hideCanvasPanel
  w().klausCloseCanvasPanel = closeCanvasPanel
  w().klausActiveCanvasPath = () => activePath
  w().klausCanvasDiagnostics = () => ({ activePath, activeSession, presentationEpoch, suspendedForOverlay, lastBounds,
    bounds: bounds(), mode: panel?.getAttribute('data-mode'), collapsed: panel?.classList.contains('collapsed'), transitions: [...transitions] })

  // Overlays nest (a menu opened from inside the image preview closes while the
  // preview is still up), so suspension is counted: the native view returns only
  // when the last overlay that asked for it is gone.
  w().klausSuspendCanvasForOverlay = async () => {
    suspendedForOverlay++
    if (suspendedForOverlay > 1 || !visible()) return
    presentationEpoch++
    lastBounds = null
    trace('suspend')
    await enqueueHost(() => api()?.panelHide() ?? Promise.resolve()).catch(() => {})
  }
  w().klausResumeCanvasAfterOverlay = async () => {
    if (suspendedForOverlay <= 0) return
    suspendedForOverlay--
    if (suspendedForOverlay > 0) return
    const epoch = presentationEpoch
    trace('resume')
    await waitForLayout()
    if (!current(epoch)) return
    await showRuntime()
  }

  const openPayload = (payload: CanvasOpenPayload) => {
    if (!payload?.filePath) return
    const currentSessionId = w().getCurrentSessionId?.() || ''
    if (payload.sessionId && payload.sessionId !== currentSessionId) {
      pendingBySession.set(payload.sessionId, payload)
      if (payload.requestId) void api()?.openResult(payload.requestId, false, 'This Canvas belongs to a background task and will open when that task is selected.')
      return
    }
    void (async () => {
      let ok = false
      let error = ''
      try {
        const opened = await w().KlausPanelTabs?.openCanvas?.({ path: payload.filePath, title: payload.displayName })
        ok = opened === true
        if (!ok) error = 'The Canvas panel could not present this artifact.'
      } catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
      if (payload.requestId) await api()?.openResult(payload.requestId, ok, error).catch(() => {})
    })()
  }

  api()?.onOpenPanel(openPayload)
  let sessionChange = 0
  window.addEventListener('klaus:session-change', async (event) => {
    const token = ++sessionChange
    const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || ''
    await w().KlausPanelTabs?.clearCanvases?.()
    if (token !== sessionChange || sessionId !== currentSession()) return
    const pending = pendingBySession.get(sessionId)
    if (!pending) return
    pendingBySession.delete(sessionId)
    openPayload(pending)
  })

  if (host && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleCanvasBoundsSync).observe(host)
  }
  window.addEventListener('resize', scheduleCanvasBoundsSync)
}
