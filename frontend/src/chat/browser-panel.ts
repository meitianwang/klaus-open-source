// Browser 面板域（自 chat.ts 拆出，逻辑原样，strict 类型化）。
//
// 内嵌浏览器是原生子视图（native child view）：显示/定位/隐藏经 IPC 与宿主
// 同步，bounds 同步做了幂等防抖（重复应用同一矩形会引发渲染回环）。
// artifacts 面板编排（open/close/mode）仍在 chat.ts，经 initBrowserPanel(deps)
// 注入；workspace/artifacts 域拆出后改直接 import。
import { tt } from '../app/i18n'
import { showToast } from '../app/ui-shared'
import { publishNativeOverlayInset } from './native-editor-panel'

// Owner tag for the shared native-overlay inset registry (native-editor-panel).
const BROWSER_INSET_OWNER = 'browser-panel'
import { acceptBrowserViewState, invalidateBrowserFrames } from './browser-view'
import { noteBrowserPanelManualResize, syncBrowserAutoWidth } from './browser-auto-width'
import type { BrowserUseOpenRequest } from '../../bridge/types'
import { browserOpenGuard } from './browser-open-request'
import { browserAddress } from '../../../contracts/browser-settings'
import { openBrowserAnnotation, type BrowserAnnotationController } from './browser-annotation-controller'

export { noteBrowserPanelManualResize }

// ---- window.klaus 最小面（bridge 无导出类型，结构化声明本域用到的通道） ----
interface BrowserBounds { x: number; y: number; width: number; height: number }
interface BrowserTabInfo { id: string; title?: string; url?: string; active?: boolean; loading?: boolean }
interface BrowserUseState {
  conversationId?: string
  focusRevision?: number
  enabled?: boolean
  visible?: boolean
  presentationTransferred?: boolean
  url?: string
  canGoBack?: boolean
  canGoForward?: boolean
  tabs?: BrowserTabInfo[]
  tabId?: string | null
  loading?: boolean
  contentWidth?: number
  contentRevision?: number
}
interface BrowserOpResult { ok?: boolean; error?: string; state?: BrowserUseState; dataUrl?: string }
interface KlausBrowserApi {
  browserUse?: {
    state?: () => Promise<BrowserUseState>
    show?: (bounds: BrowserBounds, scope?: BrowserUseOpenRequest) => Promise<BrowserOpResult>
    hide?: () => Promise<unknown>
    setBounds?: (bounds: BrowserBounds) => Promise<unknown>
    navigate?: (url: string) => Promise<BrowserOpResult>
    back?: () => Promise<BrowserOpResult>
    forward?: () => Promise<BrowserOpResult>
    reload?: () => Promise<BrowserOpResult>
    screenshot?: (options?: { presented?: boolean; quality?: number }) => Promise<BrowserOpResult>
    tabs?: (req: { action: 'select' | 'new' | 'close'; tabId?: string; url?: string }) => Promise<BrowserOpResult>
  }
  settings?: {
    browserUse?: {
      get?: () => Promise<{ enabled?: boolean; showFullUrl?: boolean } | null>
      subscribe?: (cb: (settings: { showFullUrl?: boolean }) => void) => () => void
    }
  }
  on?: {
    browserUseState?: (cb: (state: BrowserUseState) => void) => unknown
    browserUseOpenPanel?: (cb: (request?: BrowserUseOpenRequest) => void) => unknown
  }
}
const klausApi = () => (window as unknown as { klaus?: KlausBrowserApi }).klaus

// ---- 跨域依赖注入（artifacts 编排 / 视图清场仍在 chat.ts） ----
export interface BrowserPanelDeps {
  closeSettingsIfActive(): void
  hideNonChatViews(): void
  hideBtwPanel(): void
  setCurrentNonChatView(view: null): void
  setArtifactsPanelMode(mode: string): void
  openArtifactsPanel(mode: string): void
  closeArtifactsPanel(): void
  syncTopModeButtons(): void
  renderSessionList(): void
}
let deps!: BrowserPanelDeps

// ---- DOM refs（index.html 静态骨架） ----
const artifactsPanel = document.getElementById('artifacts-panel')
const browserToggleBtn = document.getElementById('browser-panel-toggle')
const browserPanelHost = document.getElementById('browser-panel-host')
const browserUrlInput = document.getElementById('browser-url-input') as HTMLInputElement | null
const browserBackBtn = document.getElementById('browser-back') as HTMLButtonElement | null
const browserForwardBtn = document.getElementById('browser-forward') as HTMLButtonElement | null
const browserReloadBtn = document.getElementById('browser-reload') as HTMLButtonElement | null
const browserScreenshotBtn = document.getElementById('browser-screenshot') as HTMLButtonElement | null
const browserAnnotateBtn = document.getElementById('browser-annotate') as HTMLButtonElement | null

// ---- 状态 ----
let browserState: BrowserUseState | null = null
let browserBoundsRaf = 0
// The last bounds actually pushed to the native webview. The bounds sync is
// idempotent against it: re-applying identical bounds is what let a render /
// resize feedback re-enter the sync every frame (the page "jitter", and a
// webview repositioned every frame never paints → blank). Reset on show/hide so
// the next sync always re-applies.
let lastSyncedBounds: BrowserBounds | null = null
let browserUrlInputEditing = false
let browserShowFullUrl = false
let browserSessionGeneration = 0
let browserRuntimeShowCount = 0
let browserStatePushRevision = 0
let browserTabOpenRevision = 0
// Overlay suspension is counted: nested overlays share one hide, and the
// native view returns only after the last of them is gone.
let browserRuntimeSuspendedForOverlay = 0
// Bumped by every suspend and resume edge so an asynchronous step that lost
// the race (a capture still in flight when the dialog already closed) stops.
let browserOverlayEpoch = 0
// Whether the page has to come back when the last overlay leaves: it was on
// screen when the overlay arrived, or a show was requested underneath it.
let browserOverlayRestore = false
let browserOverlaySnapshot: HTMLImageElement | null = null
interface BrowserShowRequest { scope: BrowserUseOpenRequest; isCurrent(): boolean; revision: number }
let browserShowRevision = 0
let browserOpeningRequest: BrowserShowRequest | null = null
let browserDeferredShow: BrowserShowRequest | null = null

function deferBrowserShow(request: BrowserShowRequest): void {
  browserOverlayRestore = true
  if (!browserDeferredShow || browserDeferredShow.revision <= request.revision) browserDeferredShow = request
}

function browserOpenSurface() {
  return {
    sessionId: (window as unknown as { currentSessionId?: string }).currentSessionId || null,
    generation: browserSessionGeneration,
    visible: !document.hidden && !document.body.classList.contains('non-chat-view')
      && !document.body.classList.contains('settings-open')
      && !document.querySelector('#diff-view.active, #workspace-main-view.active'),
  }
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

function withinMs<T>(work: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!work) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms)
    work.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(undefined) })
  })
}

function clearBrowserOverlaySnapshot(): void {
  browserOverlaySnapshot?.remove()
  browserOverlaySnapshot = null
}

/**
 * Lay a still image of the on-screen page into the panel before the native view
 * steps aside, so an overlay's backdrop dims and blurs the page like the rest of
 * the window instead of exposing an empty panel. Bounded: when the capture is
 * slow or fails, the view leaves anyway, because a page painted over a dialog
 * is the worse outcome.
 */
async function placeBrowserOverlaySnapshot(epoch: number): Promise<void> {
  const capture = klausApi()?.browserUse?.screenshot
  if (!browserPanelHost || !capture) return
  const generation = browserSessionGeneration
  const sessionId = browserOpenSurface().sessionId
  const tabId = browserState?.tabId
  const current = () => epoch === browserOverlayEpoch && generation === browserSessionGeneration
    && sessionId === browserOpenSurface().sessionId && tabId === browserState?.tabId && isBrowserPanelVisible()
  const res = await withinMs(capture({ presented: true, quality: 82 }), 300)
  if (!current() || !res?.ok || typeof res.dataUrl !== 'string' || !res.dataUrl) return
  const image = document.createElement('img')
  image.className = 'browser-overlay-snapshot'
  image.alt = ''
  image.setAttribute('aria-hidden', 'true')
  image.draggable = false
  image.src = res.dataUrl
  await withinMs(image.decode?.(), 200)
  if (!current()) return
  clearBrowserOverlaySnapshot()
  browserPanelHost.appendChild(image)
  browserOverlaySnapshot = image
  // One painted frame with the image in place before the native view leaves.
  await nextFrame()
}

function sameBounds(a: BrowserBounds | null, b: BrowserBounds | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function isBrowserPanelMode(): boolean {
  return artifactsPanel?.getAttribute('data-mode') === 'browser'
}

export function isBrowserPanelVisible(): boolean {
  return !!browserPanelHost && isBrowserPanelMode() && !artifactsPanel?.classList.contains('collapsed')
}

export function updateBrowserPanelState(state: BrowserUseState | null = browserState): boolean {
  if (state && !acceptBrowserViewState(state)) return false
  if (state && (state.tabId !== browserState?.tabId || state.conversationId !== browserState?.conversationId)) {
    clearBrowserOverlaySnapshot()
  }
  browserState = state || browserState
  const current = browserState || {}
  browserPanelHost?.classList.toggle('browser-mounted', !!current.visible)
  if (browserUrlInput && !browserUrlInputEditing) {
    browserUrlInput.value = browserAddress(current.url || '', browserShowFullUrl, false)
  }
  if (browserBackBtn) browserBackBtn.disabled = !current.canGoBack
  if (browserForwardBtn) browserForwardBtn.disabled = !current.canGoForward
  if (browserReloadBtn) browserReloadBtn.disabled = !current.visible
  if (browserScreenshotBtn) browserScreenshotBtn.disabled = !current.visible
  if (browserAnnotateBtn) browserAnnotateBtn.disabled = !current.visible || !!current.loading
  // Every host-side page in the active conversation gets its own panel tab, so
  // two pages can be open at once instead of one replacing the other.
  const panelTabs = (window as unknown as { KlausPanelTabs?: { syncBrowserTabs?: (tabs: BrowserTabInfo[], activeId: string | null) => void } }).KlausPanelTabs
  panelTabs?.syncBrowserTabs?.(Array.isArray(current.tabs) ? current.tabs : [], current.tabId || null)
  syncBrowserAutoWidth(current, isBrowserPanelVisible())
  return true
}

export function browserRuntimeVisible(): boolean {
  return !!browserState?.visible || !!browserPanelHost?.classList.contains('browser-mounted')
}

export async function hideBrowserRuntime(options: { ensureDetached?: boolean } = {}): Promise<void> {
  // Nothing is mounted, so there is nothing to detach: skip the whole round trip.
  //
  // Without this guard the hide path fed itself at the display's frame rate. The
  // host answers hide() by publishing browser-use:state; that event calls
  // scheduleBrowserBoundsSync(); its rAF sees a panel that is not visible and
  // calls hideBrowserRuntime() again. Each turn wrote the toolbar's disabled
  // attributes and re-published the tab strip, so an idle window burned a
  // renderer core with no interaction and no animation running — and bumped the
  // frame generation every pass for no reason. The bounds sync already guards
  // against exactly this loop via lastSyncedBounds; the hide side needs the same
  // idempotence. The pages themselves stay retained either way.
  // Explicit surface transitions use ensureDetached because a native child view
  // can outlive a renderer reload. In that case the host still has a mounted view
  // while this module's state and DOM class both start empty. Frame-driven layout
  // reconciliation keeps the cheap local guard so a hidden panel cannot re-enter
  // the host at the display refresh rate.
  if (!options.ensureDetached && !browserRuntimeVisible()) return
  lastSyncedBounds = null
  publishNativeOverlayInset(BROWSER_INSET_OWNER, null)
  // Hiding detaches the native view while retaining the page and its login state.
  invalidateBrowserFrames()
  await klausApi()?.browserUse?.hide?.().catch(() => {})
  updateBrowserPanelState({ ...(browserState || {}), visible: false })
}

function browserHostBounds(): BrowserBounds | null {
  if (!browserPanelHost) return null
  const rect = browserPanelHost.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function waitBrowserPanelLayout(): Promise<unknown> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

export function scheduleBrowserBoundsSync(): void {
  if (browserBoundsRaf) return
  browserBoundsRaf = requestAnimationFrame(async () => {
    browserBoundsRaf = 0
    if (!isBrowserPanelVisible()) {
      clearBrowserOverlaySnapshot()
      await hideBrowserRuntime()
      return
    }
    const bounds = browserHostBounds()
    if (!bounds) return
    // Position-only and idempotent. Applying the SAME bounds again is the loop:
    // it does not change the page but any state echo / re-render could re-enter
    // here. Skip it, and DON'T funnel the reply back through
    // updateBrowserPanelState (that re-renders the tab strip every frame and can
    // perturb the host box, re-arming the ResizeObserver).
    if (sameBounds(bounds, lastSyncedBounds)) return
    lastSyncedBounds = bounds
    publishNativeOverlayInset(BROWSER_INSET_OWNER, bounds)
    // The host positions its native view in this rectangle; no pixel stream or
    // input coordinate translation passes through the renderer.
    await klausApi()?.browserUse?.setBounds?.(bounds).catch(() => {})
  })
}

async function showBrowserRuntime(scope?: BrowserUseOpenRequest, isCurrent: () => boolean = () => true): Promise<boolean> {
  const generation = browserSessionGeneration
  const sessionId = browserOpenSurface().sessionId || 'manual'
  const request: BrowserShowRequest = {
    scope: { sessionId, ...(browserState?.conversationId === sessionId ? { focusRevision: browserState.focusRevision } : {}), ...scope },
    isCurrent: () => isCurrent() && generation === browserSessionGeneration
      && sessionId === (browserOpenSurface().sessionId || 'manual') && isBrowserPanelVisible(),
    revision: ++browserShowRevision,
  }
  if (!request.isCurrent()) return false
  // Keep the exact target and ownership guard when an overlay defers an open.
  if (browserRuntimeSuspendedForOverlay > 0) { deferBrowserShow(request); return false }
  // Creating a page publishes hidden tab state before show completes. Keep
  // automatic recovery from superseding that explicit, still-pending request.
  browserRuntimeShowCount++
  browserOpeningRequest = request
  try {
    return await performBrowserRuntimeShow(request)
  } finally {
    browserRuntimeShowCount--
    if (browserOpeningRequest === request) browserOpeningRequest = null
  }
}

async function performBrowserRuntimeShow(request: BrowserShowRequest): Promise<boolean> {
  const { scope, isCurrent } = request
  const epoch = browserOverlayEpoch
  let settings: any
  try {
    settings = await klausApi()?.settings?.browserUse?.get?.()
  } catch (error) {
    showToast((error as Error | null)?.message || tt('browser_settings_load_failed'))
    return false
  }
  if (!isCurrent()) return false
  if (settings?.enabled === false) {
    showToast(tt('browser_disabled'))
    return false
  }
  // The settings read above yields, and an overlay may have arrived meanwhile.
  if (browserRuntimeSuspendedForOverlay > 0) { deferBrowserShow(request); return false }
  const bounds = browserHostBounds()
  if (!bounds) return false
  const res = await klausApi()?.browserUse?.show?.(bounds, scope).catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
  if (!isCurrent()) return false
  if (!res?.ok) {
    // An overlay that arrived while this show was in flight hid the view, which
    // supersedes the request on the host. That is not a failure to report: the
    // page comes back when the overlay leaves.
    if (epoch !== browserOverlayEpoch || browserRuntimeSuspendedForOverlay > 0) {
      if (browserRuntimeSuspendedForOverlay > 0) deferBrowserShow(request)
      return false
    }
    showToast(res?.error || tt('browser_open_failed'))
    return false
  }
  // The host completed the show just before an overlay's hide reached it. The
  // overlay wins; the page returns with the overlay's resume.
  if (browserRuntimeSuspendedForOverlay > 0) {
    deferBrowserShow(request)
    updateBrowserPanelState(res.state || null)
    await hideBrowserRuntime({ ensureDetached: true })
    return false
  }
  // Avoid a redundant native layout pass after the view has been attached.
  lastSyncedBounds = bounds
  publishNativeOverlayInset(BROWSER_INSET_OWNER, bounds)
  updateBrowserPanelState(res.state || null)
  return true
}

export async function showBrowserPanel(scope?: BrowserUseOpenRequest): Promise<void> {
  const opening = browserOpenSurface()
  const validScope = browserOpenGuard(scope, browserOpenSurface)
  if (!validScope()) return
  // Manual opens are owned by the task that initiated them too, including the
  // two layout frames before showBrowserRuntime begins.
  const isCurrent = () => {
    const current = browserOpenSurface()
    return validScope() && opening.sessionId === current.sessionId
      && opening.generation === current.generation && current.visible
  }
  deps.closeSettingsIfActive()
  deps.hideNonChatViews()
  // Not hideDiffView: switching to a browser page leaves the changes tab open.
  deps.hideBtwPanel()
  deps.setCurrentNonChatView(null)
  deps.setArtifactsPanelMode('browser')
  deps.openArtifactsPanel('browser')
  await waitBrowserPanelLayout()
  if (!isCurrent() || !isBrowserPanelVisible()) return
  await showBrowserRuntime(scope, isCurrent)
  if (!isCurrent()) return
  scheduleBrowserBoundsSync()
  deps.syncTopModeButtons()
  deps.renderSessionList()
}

export async function hideBrowserPanel(): Promise<void> {
  clearBrowserOverlaySnapshot()
  browserOverlayEpoch++
  browserOverlayRestore = false
  browserDeferredShow = null
  if (isBrowserPanelMode()) deps.closeArtifactsPanel()
  await hideBrowserRuntime({ ensureDetached: true })
}

async function navigateBrowserToInput(urlOverride?: string): Promise<void> {
  const url = (typeof urlOverride === 'string' ? urlOverride : browserUrlInput?.value)?.trim()
  if (!url) return
  if (!isBrowserPanelVisible()) await showBrowserPanel()
  const res = await klausApi()?.browserUse?.navigate?.(url).catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
  if (!res?.ok) {
    showToast(res?.error || tt('browser_open_failed'))
    return
  }
  updateBrowserPanelState(res.state || null)
}

export function initBrowserPanel(injected: BrowserPanelDeps): void {
  deps = injected
  const w = window as unknown as Record<string, unknown>
  let annotation: BrowserAnnotationController | undefined
  let annotationOpening = false
  let annotationAbort: AbortController | undefined
  browserAnnotateBtn?.addEventListener('click', async () => {
    if (annotation || annotationOpening) return
    annotationOpening = true
    const opening = new AbortController()
    annotationAbort = opening
    const mount = document.createElement('div')
    document.body.appendChild(mount)
    const surface = (window as any).klaus.browserUse
    const check = async (promise: Promise<any>) => {
      const result = await promise
      if (result?.ok === false) throw new Error(result.error || tt('settings_failed'))
      return result
    }
    try {
      const settings = await (window as any).klaus.settings.browserUse.get()
      opening.signal.throwIfAborted()
      annotation = await openBrowserAnnotation({
        signal: opening.signal,
        api: {
          currentSessionId: () => browserOpenSurface().sessionId || 'manual',
          currentFocusRevision: () => browserState?.focusRevision ?? null,
          capture: request => check(surface.annotationCapture(request)),
          anchorAt: request => check(surface.annotationAnchor(request)),
          save: request => check(surface.annotationSave(request)),
          commit: async request => { await check(surface.annotationCommit(request)) },
          discard: async id => { await check(surface.annotationDiscard(id)) },
          suspendBrowser: () => (w.klausSuspendBrowserForOverlay as () => Promise<void>)(),
          resumeBrowser: async () => {
            annotation = undefined
            mount.remove()
            await (w.klausResumeBrowserAfterOverlay as () => Promise<void>)()
          },
        },
        mount,
        labels: { title: tt('browser_annotate'), hint: tt('browser_annotation_hint'), note: tt('browser_annotation_note'),
          cancel: tt('cancel'), submit: tt('browser_annotation_submit'), element: tt('browser_annotation_element'), region: tt('browser_annotation_region') },
        screenshotMode: settings.annotationScreenshots === 'necessary' ? 'necessary' : 'always',
        onSubmit: (payload, sessionId) => {
          if (!(window as any).klausComposer?.appendBrowserAnnotation?.(payload, sessionId)) throw new Error(tt('browser_annotation_stale'))
        },
        onError: error => showToast(error instanceof Error ? error.message : String(error)),
      })
    } catch (error) {
      mount.remove()
      if (!opening.signal.aborted) showToast(error instanceof Error ? error.message : String(error))
    } finally { annotationOpening = false }
  })
  let preferencesRevision = 0
  const applyPreferences = (settings: { showFullUrl?: boolean } | null | undefined) => {
    if (!settings) return
    browserShowFullUrl = settings.showFullUrl === true
    updateBrowserPanelState()
  }
  klausApi()?.settings?.browserUse?.subscribe?.(settings => {
    preferencesRevision++
    applyPreferences(settings)
  })
  const readPreferencesRevision = preferencesRevision
  void klausApi()?.settings?.browserUse?.get?.().then(settings => {
    if (preferencesRevision === readPreferencesRevision) applyPreferences(settings)
  }).catch(() => {})

  // The embedded browser is a native child view, so it paints above every HTML
  // layer in the window: a panel dropdown that overlaps it would be sliced in half
  // no matter what z-index it carries. Overlays therefore ask the runtime to step
  // aside and put it back afterwards. Hiding does not destroy the view, so the
  // page keeps its state across the round trip.
  // Overlays nest (a menu opened from inside the image preview closes while the
  // preview is still up), so suspension is counted: the native view returns only
  // when the last overlay that asked for it is gone.
  w.klausSuspendBrowserForOverlay = async () => {
    browserRuntimeSuspendedForOverlay++
    if (browserRuntimeSuspendedForOverlay > 1) return
    const epoch = ++browserOverlayEpoch
    // A show still in flight would attach the view after this point, so it
    // counts as on screen: hiding now supersedes it on the host.
    const pendingShow = browserRuntimeShowCount > 0
    if (browserOpeningRequest) deferBrowserShow(browserOpeningRequest)
    const onScreen = browserRuntimeVisible()
    // A restore still owed by the previous overlay (it closed, and this one
    // opened before the page came back) carries over to this overlay.
    if (!onScreen && !pendingShow && !browserOverlayRestore) return
    browserOverlayRestore = true
    if (onScreen && !pendingShow) await placeBrowserOverlaySnapshot(epoch)
    if (epoch !== browserOverlayEpoch) return
    // Always reach the host: a state echo that landed during the capture can
    // clear the local mounted flag while the native view is still attached.
    // This is a single edge, so it cannot feed the frame loop the guard stops.
    await hideBrowserRuntime({ ensureDetached: true })
  }
  w.klausResumeBrowserAfterOverlay = async () => {
    if (browserRuntimeSuspendedForOverlay <= 0) return
    browserRuntimeSuspendedForOverlay--
    if (browserRuntimeSuspendedForOverlay > 0) return
    const epoch = ++browserOverlayEpoch
    // Menus close BEFORE the item they were clicked for runs, so wait one frame:
    // if that action moved the panel elsewhere (a new terminal, a closed panel),
    // re-showing the page here would only flash it back for a frame.
    await nextFrame()
    // Another overlay arrived in that frame; it now owns the pending restore.
    if (epoch !== browserOverlayEpoch) return
    const restore = browserOverlayRestore
    const deferred = browserDeferredShow
    browserOverlayRestore = false
    browserDeferredShow = null
    const generation = browserSessionGeneration
    const tabRevision = browserTabOpenRevision
    const sessionId = browserOpenSurface().sessionId || 'manual'
    const selectedTab = () => browserState?.tabId || browserState?.tabs?.find(tab => tab.active)?.id || browserState?.tabs?.[0]?.id
    const targetId = selectedTab()
    // A deferred explicit open retains its original target. Restoring a page
    // instead always names an existing tab, so closing the last one while the
    // settings read is in flight cannot create a replacement about:blank page.
    if (isBrowserPanelVisible() && deferred?.isCurrent()) {
      await showBrowserRuntime(deferred.scope, deferred.isCurrent)
    } else if (restore && targetId && isBrowserPanelVisible()) {
      await showBrowserRuntime({ sessionId, targetId, focusRevision: browserState?.focusRevision }, () =>
        epoch === browserOverlayEpoch && generation === browserSessionGeneration
        && tabRevision === browserTabOpenRevision && targetId === selectedTab()
        && !!browserState?.tabs?.some(tab => tab.id === targetId))
    } else if (browserState) {
      reconcileBrowserState(browserState)
    }
    // The still image stays under the view until the view is attached again.
    if (epoch === browserOverlayEpoch) clearBrowserOverlaySnapshot()
    scheduleBrowserBoundsSync()
  }

  // Panel-strip hooks for browser pages. Selecting a tab points the host at that
  // page before the panel is shown; closing one removes the page itself, and the
  // state push that follows reconciles the strip.
  w.klausActiveBrowserTabId = () => browserState?.tabId || null
  w.klausOpenBrowserTab = async ({ tabId, url }: { tabId?: string; url?: string } = {}) => {
    const revision = ++browserTabOpenRevision
    const surface = browserOpenSurface()
    const isCurrent = () => revision === browserTabOpenRevision
      && surface.sessionId === browserOpenSurface().sessionId
      && surface.generation === browserSessionGeneration
    if (tabId) {
      const res = await klausApi()?.browserUse?.tabs?.({ action: 'select', tabId })
        .catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
      if (!isCurrent()) return false
      if (!res?.ok) {
        showToast(res?.error || tt('browser_open_failed'))
        // Keep the Browser surface reachable even when its runtime is disabled
        // or unavailable. The empty panel is the durable affordance; a toast on
        // its own disappears and leaves the user on an unrelated surface.
        await showBrowserPanel()
        return false
      }
      if (res.state) updateBrowserPanelState(res.state)
      await showBrowserPanel()
      return true
    }
    // Create BEFORE revealing the surface: showing it asks the host to ensure a
    // page exists, so creating afterwards would leave one blank page behind for
    // every new page the user asked for.
    const res = await klausApi()?.browserUse?.tabs?.({ action: 'new', url: url || '' })
      .catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
    if (!isCurrent()) return false
    if (!res?.ok) {
      showToast(res?.error || tt('browser_open_failed'))
      // Creating a page can fail before the runtime exists (for example when
      // the Browser plugin is disabled). Still reveal the Browser surface so
      // the toolbar and empty state explain which feature the action targeted.
      await showBrowserPanel()
      return false
    }
    if (res.state) updateBrowserPanelState(res.state)
    await showBrowserPanel()
    return true
  }
  w.klausNewBrowserTab = () => (w.klausOpenBrowserTab as (o?: object) => Promise<void>)({})
  w.klausCloseBrowserTab = async (tabId: string) => {
    const res = await klausApi()?.browserUse?.tabs?.({ action: 'close', tabId })
      .catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
    if (!res?.ok) {
      showToast(res?.error || tt('settings_failed'))
      return false
    }
    if (res.state) updateBrowserPanelState(res.state)
    if (!browserState?.tabs?.length) await hideBrowserRuntime()
    return true
  }

  w.showBrowserPanel = showBrowserPanel
  w.hideBrowserPanel = hideBrowserPanel
  w.isBrowserPanelVisible = isBrowserPanelVisible
  // Reattach existing pages after transient layout changes. Empty tab sets stay
  // empty, and overlays/settings retain ownership of their hide/resume cycle.
  const reconcileBrowserState = (state: BrowserUseState, allowAutomaticShow = true): void => {
    if (!browserOpenSurface().visible || !isBrowserPanelVisible()) {
      // WebContentsView is owned by the main process and can survive a renderer
      // reload. Detach an authoritative visible view before applying the
      // task/revision filter: immediately after reload there is no selected task,
      // so the still-attached view belongs to a different task and that filter
      // quite correctly rejects its UI state. Visibility cleanup is window-wide,
      // though, and must not be rejected with it.
      if (state.visible) void hideBrowserRuntime({ ensureDetached: true })
      return
    }
    if (!updateBrowserPanelState(state)) return
    scheduleBrowserBoundsSync()
    if (
      allowAutomaticShow && !state.presentationTransferred && state && state.enabled !== false && state.visible === false &&
      Array.isArray(state.tabs) && state.tabs.length > 0 &&
      !document.hidden &&
      isBrowserPanelVisible() && browserRuntimeShowCount === 0 &&
      !browserRuntimeSuspendedForOverlay &&
      !document.body.classList.contains('settings-open')
    ) {
      void showBrowserRuntime().catch(() => {})
    }
  }
  klausApi()?.on?.browserUseState?.((state) => {
    browserStatePushRevision++
    reconcileBrowserState(state)
  })
  // Pushes are edge-triggered, so a freshly loaded renderer must also read the
  // main process once. Ignore the reply if a newer push already won the race.
  const stateRevisionAtRead = browserStatePushRevision
  void klausApi()?.browserUse?.state?.().then(state => {
    // This initial read may resolve while an explicit two-frame panel open is
    // still waiting for layout. It may reconcile or detach, but must not start a
    // second show that competes with the user's pending one.
    if (stateRevisionAtRead === browserStatePushRevision) reconcileBrowserState(state, false)
  }).catch(() => {})
  klausApi()?.on?.browserUseOpenPanel?.((request) => {
    const scope = request?.sessionId === undefined ? undefined : {
      sessionId: request.sessionId, targetId: request.targetId, focusRevision: request.focusRevision,
    }
    void showBrowserPanel(scope)
  })
  window.addEventListener('pagehide', () => annotationAbort?.abort())
  window.addEventListener('klaus:session-change', () => {
    annotationAbort?.abort()
    void annotation?.close()
    const generation = ++browserSessionGeneration
    invalidateBrowserFrames()
    // The still image belongs to the previous task's page.
    clearBrowserOverlaySnapshot()
    browserOverlayEpoch++
    browserOverlayRestore = false
    browserDeferredShow = null
    // setConversation may emit before this event. Re-read its authoritative
    // revision without allowing an older task's response to restore its frame.
    void klausApi()?.browserUse?.state?.().then(state => {
      if (generation === browserSessionGeneration) updateBrowserPanelState(state)
    }).catch(() => {})
  })
  if (browserPanelHost && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleBrowserBoundsSync).observe(browserPanelHost)
  }
  window.addEventListener('resize', scheduleBrowserBoundsSync)

  browserToggleBtn?.addEventListener('click', () => {
    if (isBrowserPanelVisible() || browserRuntimeVisible()) void hideBrowserPanel()
    else void showBrowserPanel()
  })
  browserUrlInput?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      browserUrlInputEditing = false
      browserUrlInput.blur()
      updateBrowserPanelState()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const url = browserUrlInput.value.trim()
    browserUrlInputEditing = false
    void navigateBrowserToInput(url).finally(() => browserUrlInput.blur())
  })
  browserUrlInput?.addEventListener('input', () => {
    browserUrlInputEditing = true
  })
  browserUrlInput?.addEventListener('focus', () => {
    browserUrlInputEditing = true
    browserUrlInput.value = browserAddress(browserState?.url || '', browserShowFullUrl, true)
    browserUrlInput.select()
  })
  browserUrlInput?.addEventListener('blur', () => {
    browserUrlInputEditing = false
    updateBrowserPanelState()
  })
  browserBackBtn?.addEventListener('click', async () => {
    const res = await klausApi()?.browserUse?.back?.().catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
    if (res?.ok) updateBrowserPanelState(res.state || null)
    else showToast(res?.error || tt('settings_failed'))
  })
  browserForwardBtn?.addEventListener('click', async () => {
    const res = await klausApi()?.browserUse?.forward?.().catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
    if (res?.ok) updateBrowserPanelState(res.state || null)
    else showToast(res?.error || tt('settings_failed'))
  })
  browserReloadBtn?.addEventListener('click', async () => {
    const res = await klausApi()?.browserUse?.reload?.().catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
    if (res?.ok) updateBrowserPanelState(res.state || null)
    else showToast(res?.error || tt('settings_failed'))
  })
  browserScreenshotBtn?.addEventListener('click', async () => {
    const res = await klausApi()?.browserUse?.screenshot?.().catch((err: unknown): BrowserOpResult => ({ ok: false, error: (err as Error | null)?.message || String(err) }))
    showToast(res?.ok ? tt('browser_screenshot') : (res?.error || tt('settings_failed')))
  })
}
