// Native editor views paint over a renderer-owned rectangle. This controller
// serializes presentation requests and keeps ownership tied to the current chat.
export interface NativeEditorBounds { x: number; y: number; width: number; height: number }

// Native child views composite above every renderer layer, so renderer DOM
// overlays (toasts, tips) that intersect the panel rectangle disappear behind
// the native surface no matter how high their z-index is. Publish the covered
// right inset as a custom property so those overlays can lay out inside the
// uncovered region. Panels dock to the window's right edge, so the inset is
// the distance from the panel's left edge to the window's right edge.
const OVERLAY_INSET_PROPERTY = '--klaus-native-panel-inset-right'
let insetOwner: string | null = null
let insetSeq = 0
// Preload bridges import this module's types, so it is also type-checked inside
// the host program, which does not load the DOM library. Reach the renderer
// globals through a structural view of globalThis so the module compiles in
// both programs without widening either tsconfig; the runtime guards below
// keep the behaviour identical when no DOM is present.
interface NativeInsetStyle { setProperty(name: string, value: string): void; removeProperty(name: string): void }
const insetGlobal = globalThis as { document?: { documentElement?: { style: NativeInsetStyle } | null }; innerWidth?: number }
export function publishNativeOverlayInset(owner: string, bounds: NativeEditorBounds | null): void {
  if (bounds) insetOwner = owner
  else if (insetOwner === owner) insetOwner = null
  else return
  const root = insetGlobal.document?.documentElement
  if (!root) return
  if (!bounds) {
    root.style.removeProperty(OVERLAY_INSET_PROPERTY)
    return
  }
  const viewport = Number.isFinite(insetGlobal.innerWidth) ? Number(insetGlobal.innerWidth) : 0
  root.style.setProperty(OVERLAY_INSET_PROPERTY, `${Math.max(0, Math.round(viewport - bounds.x))}px`)
}
export interface NativeEditorOpenPayload { requestId?: string; id: string; title?: string; sessionId: string }
export interface NativeEditorPanelApi {
  panelShow(id: string, sessionId: string, bounds: NativeEditorBounds): Promise<{ ok?: boolean; error?: string }>
  panelSetBounds(bounds: NativeEditorBounds): Promise<{ ok?: boolean; error?: string }>
  panelHide(): Promise<unknown>
  panelClose(): Promise<unknown>
  openResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
export interface NativeEditorPanelEnvironment {
  api(): NativeEditorPanelApi | undefined
  currentSession(): string
  visible(): boolean
  bounds(): NativeEditorBounds | null
  layout(): Promise<unknown>
  openMode(): void
  openTab(payload: NativeEditorOpenPayload): Promise<boolean>
  toast(message: string): void
  text(key: string): string
  schedule(): void
}
export interface NativeEditorPanelLabels { title: string; openFailed: string; backgroundPending: string }

export function createNativeEditorPanel(env: NativeEditorPanelEnvironment, labels: NativeEditorPanelLabels) {
  const insetToken = `native-editor-${++insetSeq}`
  let activeId = '', activeSession = '', activeTitle = ''
  // The document each chat last held on screen. The host keeps every editor
  // alive while its chat is away, so returning to a chat can put its parked
  // document back up instead of losing the surface.
  const parked = new Map<string, { id: string; title: string }>()
  let epoch = 0, overlays = 0
  let lastBounds: NativeEditorBounds | null = null
  let opening: { epoch: number; promise: Promise<boolean> } | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const pending = new Map<string, NativeEditorOpenPayload>()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next.catch(() => undefined)
    return next
  }
  const current = (token: number) => token === epoch && activeSession === env.currentSession()
  const visible = () => !!activeId && activeSession === env.currentSession() && env.visible() && overlays === 0
  const same = (a: NativeEditorBounds | null, b: NativeEditorBounds | null) => !!a && !!b
    && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  async function show(): Promise<boolean> {
    if (!visible()) return false
    const bounds = env.bounds()
    if (!bounds) return false
    if (same(bounds, lastBounds)) return true
    const token = epoch, id = activeId, session = activeSession
    if (opening?.epoch === token) return opening.promise
    const promise = (async () => {
      const result = await enqueue(() => current(token) && visible()
        ? env.api()?.panelShow(id, session, bounds) ?? Promise.resolve({ ok: false })
        : Promise.resolve({ ok: false })).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      if (!current(token) || !visible()) return false
      if (!result?.ok) {
        if (parked.get(session)?.id === id) parked.delete(session)
        activeId = activeSession = activeTitle = ''
        lastBounds = null
        publishNativeOverlayInset(insetToken, null)
        env.toast(result?.error || env.text(labels.openFailed))
        return false
      }
      lastBounds = bounds
      publishNativeOverlayInset(insetToken, bounds)
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
    // Every activation needs a new receipt, including a previously visible document.
    lastBounds = null
    activeId = payload.id
    activeSession = sessionId
    activeTitle = payload.title || env.text(labels.title)
    env.openMode()
    await env.layout()
    return current(token) ? show() : false
  }

  async function hide(): Promise<void> {
    epoch++
    lastBounds = null
    publishNativeOverlayInset(insetToken, null)
    await enqueue(() => env.api()?.panelHide() ?? Promise.resolve()).catch(() => {})
  }

  async function close(id = ''): Promise<void> {
    if (id && id !== activeId) return
    // Closing the document drops its parked slot too: re-entering the chat
    // must not resurrect an editor the viewer dismissed.
    if (activeSession && parked.get(activeSession)?.id === (id || activeId)) parked.delete(activeSession)
    epoch++
    activeId = activeSession = activeTitle = ''
    lastBounds = null
    publishNativeOverlayInset(insetToken, null)
    await enqueue(() => env.api()?.panelClose() ?? Promise.resolve()).catch(() => {})
  }

  async function syncBounds(): Promise<void> {
    if (!visible()) return
    if (!lastBounds) { await show(); return }
    const next = env.bounds(), token = epoch
    if (!next || same(next, lastBounds)) return
    const result = await enqueue(() => current(token) && visible() && lastBounds
      ? env.api()?.panelSetBounds(next) ?? Promise.resolve({ ok: false })
      : Promise.resolve({ ok: false })).catch(() => ({ ok: false }))
    if (result?.ok && current(token) && visible() && lastBounds) {
      lastBounds = next
      publishNativeOverlayInset(insetToken, next)
    }
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

  async function onOpen(payload: NativeEditorOpenPayload): Promise<void> {
    if (!payload?.id || !payload.sessionId) return
    if (payload.sessionId !== env.currentSession()) {
      pending.set(payload.sessionId, payload)
      if (payload.requestId) await env.api()?.openResult(payload.requestId, false, env.text(labels.backgroundPending)).catch(() => {})
      return
    }
    let ok = false, error = ''
    try {
      ok = await env.openTab(payload) === true
      if (!ok) error = env.text(labels.openFailed)
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
    if (payload.requestId) await env.api()?.openResult(payload.requestId, ok, error || undefined).catch(() => {})
  }

  async function sessionChanged(sessionId: string): Promise<void> {
    const leaving = activeSession
    // Leaving a chat only parks the surface: the host retains the document,
    // and the tab strip owns the per-session descriptor snapshot. Clearing
    // the descriptors here made a chat's editor unreachable on return.
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
    await onOpen({ ...next, requestId: undefined })
  }

  return { activate, hide, close, syncBounds, suspend, resume, onOpen, sessionChanged,
    resumeId: () => parked.get(env.currentSession())?.id || '',
    state: () => ({ activeId, activeSession, activeTitle, epoch, overlays, lastBounds }) }
}
