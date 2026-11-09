// The host rectangle carries an isolated native editor; this renderer owns only
// presentation and never evaluates the editor runtime or its documents.
import type { VideoEditingBounds, VideoEditingOpenPayload, VideoEditingPanelApi } from '../../bridge/video-editing-api'

type Reply = { ok?: boolean; error?: string }
export interface VideoEditingPanelEnvironment {
  api(): VideoEditingPanelApi | undefined
  currentSession(): string
  visible(): boolean
  bounds(): VideoEditingBounds | null
  layout(): Promise<unknown>
  openMode(): void
  openTab(payload: VideoEditingOpenPayload): Promise<boolean>
  toast(message: string): void
  text(key: string): string
  schedule(): void
}

export function createVideoEditingPanel(env: VideoEditingPanelEnvironment) {
  let activeId = '', activeSession = '', activeTitle = ''
  // The film each chat last held on screen. The host keeps every editor alive
  // while its chat is away, so returning to a chat can put its parked film
  // back up instead of losing the surface.
  const parked = new Map<string, { id: string; title: string }>()
  let epoch = 0, overlays = 0
  let lastBounds: VideoEditingBounds | null = null
  let opening: { epoch: number; promise: Promise<boolean> } | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const pending = new Map<string, VideoEditingOpenPayload>()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next.catch(() => undefined)
    return next
  }
  const current = (token: number) => token === epoch && activeSession === env.currentSession()
  const visible = () => !!activeId && activeSession === env.currentSession() && env.visible() && overlays === 0
  const same = (a: VideoEditingBounds | null, b: VideoEditingBounds | null) => !!a && !!b
    && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  async function show(): Promise<boolean> {
    if (!visible()) return false
    const bounds = env.bounds()
    if (!bounds) return false
    if (same(bounds, lastBounds)) return true
    const token = epoch, id = activeId, session = activeSession
    if (opening?.epoch === token) return opening.promise
    const promise = (async () => {
      const result: Reply = await enqueue(() => current(token) && visible()
        ? env.api()?.panelShow(id, session, bounds) ?? Promise.resolve({ ok: false })
        : Promise.resolve({ ok: false })).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      if (!current(token) || !visible()) return false
      if (!result?.ok) {
        if (parked.get(session)?.id === id) parked.delete(session)
        activeId = activeSession = activeTitle = ''
        lastBounds = null
        env.toast(result?.error || env.text('video_editing_open_failed'))
        return false
      }
      lastBounds = bounds
      if (!same(bounds, env.bounds())) env.schedule()
      return true
    })()
    opening = { epoch: token, promise }
    try { return await promise } finally { if (opening?.promise === promise) opening = null }
  }

  async function activate(payload: { id: string; title?: string; sessionId?: string }): Promise<boolean> {
    const sessionId = payload.sessionId || env.currentSession()
    if (!payload.id || !sessionId || sessionId !== env.currentSession()) return false
    const token = ++epoch
    // A new epoch cannot trust an earlier show receipt, even for the same id.
    lastBounds = null
    activeId = payload.id
    activeSession = sessionId
    activeTitle = payload.title || env.text('video_editing_title')
    env.openMode()
    await env.layout()
    return current(token) ? show() : false
  }

  async function hide(): Promise<void> {
    epoch++
    lastBounds = null
    await enqueue(() => env.api()?.panelHide() ?? Promise.resolve()).catch(() => {})
  }

  async function close(id = ''): Promise<boolean> {
    if (id && id !== activeId) return true
    // Closing the film drops its parked slot too: re-entering the chat must
    // not resurrect an editor the viewer dismissed.
    if (activeSession && parked.get(activeSession)?.id === (id || activeId)) parked.delete(activeSession)
    const token = ++epoch
    const result = await enqueue(() => env.api()?.panelClose() ?? Promise.resolve()).catch(error => ({
      ok: false, error: error instanceof Error ? error.message : String(error),
    }))
    if (result?.ok === false) {
      env.toast(result.error || env.text('video_editing_close_failed'))
      return false
    }
    if (token === epoch) {
      activeId = activeSession = activeTitle = ''
      lastBounds = null
    }
    return true
  }

  async function syncBounds(): Promise<void> {
    if (!visible()) return
    if (!lastBounds) { await show(); return }
    const next = env.bounds(), token = epoch
    if (!next || same(next, lastBounds)) return
    const result = await enqueue(() => current(token) && visible() && lastBounds
      ? env.api()?.panelSetBounds(next) ?? Promise.resolve({ ok: false })
      : Promise.resolve({ ok: false })).catch(() => ({ ok: false }))
    if (result?.ok && current(token) && visible() && lastBounds) lastBounds = next
  }

  async function suspend(): Promise<void> {
    overlays++
    if (overlays === 1) await hide()
  }
  async function resume(): Promise<void> {
    if (overlays <= 0 || --overlays > 0) return
    const token = epoch
    await env.layout()
    if (current(token)) await show()
  }

  async function onOpen(payload: VideoEditingOpenPayload): Promise<void> {
    if (!payload?.id || !payload.sessionId) return
    if (payload.sessionId !== env.currentSession()) {
      pending.set(payload.sessionId, payload)
      if (payload.requestId) await env.api()?.openResult(payload.requestId, false, env.text('video_editing_background_pending')).catch(() => {})
      return
    }
    let ok = false, error = ''
    try {
      ok = await env.openTab(payload) === true
      if (!ok) error = env.text('video_editing_open_failed')
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
    if (payload.requestId) await env.api()?.openResult(payload.requestId, ok, error || undefined).catch(() => {})
  }

  async function sessionChanged(sessionId: string): Promise<void> {
    // Hide immediately; the host retains each document. The tab strip owns
    // the per-session descriptor snapshot, so clearing descriptors here made
    // a chat's film unreachable on return.
    const leaving = activeSession
    if (leaving && leaving !== sessionId && activeId) parked.set(leaving, { id: activeId, title: activeTitle })
    if (leaving !== sessionId) {
      const hiding = hide(), token = epoch
      activeId = activeSession = activeTitle = ''
      await hiding
      if (token !== epoch || sessionId !== env.currentSession()) return
    } else if (sessionId !== env.currentSession()) return
    const next = pending.get(sessionId)
    if (!next) return
    pending.delete(sessionId)
    // The original request has already received its background result.
    await onOpen({ ...next, requestId: undefined })
  }

  return { activate, hide, close, syncBounds, suspend, resume, onOpen, sessionChanged,
    resumeId: () => parked.get(env.currentSession())?.id || '',
    state: () => ({ activeId, activeSession, activeTitle, epoch, overlays, lastBounds }) }
}

const w = () => window as any
let controller: ReturnType<typeof createVideoEditingPanel> | undefined
let boundsFrame = 0
export function scheduleVideoEditingBoundsSync(): void {
  if (boundsFrame) return
  boundsFrame = requestAnimationFrame(() => { boundsFrame = 0; void controller?.syncBounds() })
}
export function hideVideoEditingPanel(): Promise<void> { return controller?.hide() ?? Promise.resolve() }

export function initVideoEditingPanel(): void {
  if (controller) return
  const panel = document.getElementById('artifacts-panel')
  const host = document.getElementById('video-editing-panel-host')
  const text = (key: string) => w().tt?.(key) || key
  controller = createVideoEditingPanel({
    api: () => w().klaus?.videoEditing,
    currentSession: () => w().getCurrentSessionId?.() || '',
    visible: () => !!host && panel?.getAttribute('data-mode') === 'video-editing' && !panel.classList.contains('collapsed'),
    bounds: () => {
      const rect = host?.getBoundingClientRect()
      return rect && rect.width > 0 && rect.height > 0 ? {
        x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
      } : null
    },
    layout: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    openMode: () => w().openArtifactsPanel?.('video-editing'),
    openTab: payload => w().KlausPanelTabs?.openVideoEditing?.(payload) ?? Promise.resolve(false),
    toast: message => w().showToast?.(message), text,
    schedule: scheduleVideoEditingBoundsSync,
  })
  const surface = controller
  w().klausActivateVideoEditingPanel = surface.activate
  w().klausHideVideoEditingPanel = surface.hide
  w().klausCloseVideoEditingPanel = surface.close
  w().klausActiveVideoEditingId = () => surface.state().activeId
  w().klausSuspendVideoEditingForOverlay = surface.suspend
  w().klausResumeVideoEditingAfterOverlay = surface.resume
  w().klausVideoEditingDiagnostics = surface.state
  w().klausVideoEditingResumeId = surface.resumeId
  // Clicking a known artifact asks the host to resolve its owned document.
  w().klausOpenVideoEditingPanel = async (id: string, sessionId?: string) => {
    const session = sessionId || w().getCurrentSessionId?.() || ''
    if (!id || !session || session !== w().getCurrentSessionId?.()) return false
    const result = await w().klaus?.videoEditing?.open(id, session)
    if (!result?.ok) w().showToast?.(result?.error || text('video_editing_open_failed'))
    return result?.ok === true
  }
  w().klaus?.videoEditing?.onOpenPanel((payload: VideoEditingOpenPayload) => { void surface.onOpen(payload) })
  window.addEventListener('klaus:session-change', event => {
    void surface.sessionChanged((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || '')
  })
  if (host && typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleVideoEditingBoundsSync).observe(host)
  window.addEventListener('resize', scheduleVideoEditingBoundsSync)
  // Switching to another app only occludes this window. The native editor stays attached through that, so the
  // embedded studio never goes through a hidden/visible cycle it answers by ending its own session for good.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') scheduleVideoEditingBoundsSync()
  })
  // A renderer reload may leave a native view attached to the previous document.
  void surface.hide()
}
