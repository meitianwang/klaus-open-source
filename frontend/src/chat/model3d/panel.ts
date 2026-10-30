// model3d 面板控制器：右侧面板 data-mode="model3d" 这块的 surface owner。
//
// 职责边界（和 chat.ts 的分工）：chat.ts 拥有面板的开合与 mode 切换，本模块拥有
// mode="model3d" 之下的一切——three.js 视口、大纲、检查器、以及把拖拽手势写回文档。
// 文档不在这里存：唯一真相在宿主进程的内核里（WASM，与宿主同进程），本模块只持有
// 「当前渲染的这一份」的只读副本。任何改动都发给 host，等 model3d:changed 回来再重渲。
//
// 与 digram 面板同构，两处差别：
//   1. digram 自己画 SVG；这里画的是内核求值出的真实几何。
//   2. 渲染是反向委托的——宿主进程没有 WebGL 上下文，所以 model3d_render 工具会把
//      请求发到面板，由面板离屏渲染后回传字节（digram 的 render-request/result 同款）。
//
// 没有安装卡：内核随包，零下载，面板打开即可用。

// TYPE-ONLY import: three.js is ~340 kB and must not ride the startup bundle.
// The class is loaded with a dynamic import the first time a viewport is
// actually built, so a user who never opens the 3D panel never downloads it.
import type { Model3DViewport, MeshPayload, SerializedScene } from './viewport'
import { icon } from '../../icons/registry'

const w = () => window as any
const tt = (key: string): string => w().tt?.(key) || key

interface Model3DApi {
  list(sessionId: string): Promise<{ documents: DocumentRow[] }>
  get(sessionId: string, id?: string): Promise<{ ok?: boolean; error?: string; document?: SerializedScene | null }>
  mesh(sessionId: string, name: string): Promise<MeshPayload>
  apply(sessionId: string, ops: unknown[], baseVersion?: number): Promise<{ ok?: boolean; stale?: boolean; error?: string; applied?: number; document?: SerializedScene }>
  renderResult(payload: { requestId: string; format?: string; data?: string; error?: string; panelVisible?: boolean }): Promise<unknown>
  onChanged(cb: (payload: { id: string; version: number; sessionId: string }) => void): unknown
  /** The host asking the panel to render, because the host has no WebGL context. */
  onRenderRequest(cb: (payload: RenderRequest) => void): unknown
}
interface RenderRequest { requestId: string; sessionId?: string; document: SerializedScene; format: string; width: number; height: number; engine?: 'raster' | 'pathtrace'; samples?: number; bounces?: number; frame?: number; clip?: string }

interface DocumentRow {
  id: string
  title: string
  version: number
  updatedAtMs: number
  objects: number
  meshes: number
  materials: number
}

const api = (): Model3DApi | undefined => w().klaus?.model3d

export interface Model3DPanelDeps {
  currentSessionId(): string | null
  openArtifactsPanel(mode: string): void
  closeArtifactsPanel(): void
  syncTopModeButtons(): void
  renderSessionList(): void
}

let deps: Model3DPanelDeps | undefined
let viewport: Model3DViewport | undefined
let viewportLoading: Promise<Model3DViewport | undefined> | undefined
let disposedPanel = false
let document_: SerializedScene | null = null
let selected: string | null = null
/** Guards against two overlapping reloads painting out of order. */
let loadToken = 0
let boundSession: string | null = null
let hasFramed = false
let renderSessionId: string | null = null
let renderRequests: Promise<void> = Promise.resolve()

// ---- DOM refs（index.html 静态骨架） ----
const viewportHost = () => document.getElementById('model3d-viewport')
const panelEl = () => document.getElementById('model3d-panel')

/**
 * Whether the 3D panel is the surface the user is actually looking at.
 *
 * The panel is one mode among many and switching away only sets display:none —
 * nothing disposes the viewport. So every path that could build one has to ask
 * first, or a session switch builds a three.js viewport for a hidden panel.
 */
function panelVisible(): boolean {
  const panel = panelEl()
  return !!panel && panel.offsetParent !== null
}
const emptyEl = () => document.getElementById('model3d-empty')
const docSelect = () => document.getElementById('model3d-doc-select') as HTMLSelectElement | null
const outlinerEl = () => document.getElementById('model3d-outliner')
const inspectorEl = () => document.getElementById('model3d-inspector')
const statusBar = () => document.getElementById('model3d-statusbar')
const statusText = () => document.getElementById('model3d-status-text')
const titleEl = () => document.getElementById('model3d-title')

function setStatus(text: string | null): void {
  const bar = statusBar()
  const label = statusText()
  if (!bar || !label) return
  if (!text) {
    bar.hidden = true
    return
  }
  label.textContent = text
  bar.hidden = false
}

/** The document switcher, so a task with several scenes can move between them. */
async function refreshDocList(sessionId: string): Promise<void> {
  const select = docSelect()
  const bridge = api()
  if (!select || !bridge) return
  let rows: DocumentRow[] = []
  try {
    rows = (await bridge.list(sessionId))?.documents ?? []
  } catch {
    rows = []
  }
  select.textContent = ''
  select.hidden = rows.length < 2
  for (const row of rows) {
    const option = window.document.createElement('option')
    option.value = row.id
    option.textContent = row.title || row.id
    if (row.id === document_?.id) option.selected = true
    select.appendChild(option)
  }
}

/** The outliner: every object, click to select, selection following the viewport. */
function renderOutliner(): void {
  const host = outlinerEl()
  if (!host) return
  const objects = document_?.objects ?? []
  host.hidden = objects.length === 0
  if (!objects.length) {
    host.textContent = ''
    return
  }
  host.textContent = ''
  const list = window.document.createElement('div')
  list.className = 'model3d-outliner-list'
  const ordered: Array<{ item: SerializedScene['objects'][number]; depth: number }> = []
  const visited = new Set<string>()
  const appendChildren = (parent: string | null, depth: number): void => {
    for (const item of objects) if ((item.parent ?? null) === parent && !visited.has(item.name)) { visited.add(item.name); ordered.push({ item, depth }); appendChildren(item.name, depth + 1) }
  }
  appendChildren(null, 0)
  for (const item of objects) if (!visited.has(item.name)) ordered.push({ item, depth: 0 })
  for (const { item, depth } of ordered) {
    const row = window.document.createElement('button')
    row.type = 'button'
    row.className = 'model3d-outliner-row'
    row.style.paddingInlineStart = `${8 + depth * 12}px`
    if (item.name === selected) row.classList.add('is-selected')
    if (item.visible === false) row.classList.add('is-hidden')
    const glyph = window.document.createElement('span')
    glyph.className = `model3d-outliner-glyph is-${item.type.toLowerCase()}`
    glyph.innerHTML = icon(item.type === 'CAMERA' ? 'model3d-render' : item.type === 'LIGHT' ? 'model3d-light' : 'model3d')
    const label = window.document.createElement('span')
    label.className = 'model3d-outliner-name'
    label.textContent = item.name
    // A modifier count is the useful at-a-glance fact: it says "this is not the
    // base primitive" without the panel having to fetch geometry to count it.
    const meta = window.document.createElement('span')
    meta.className = 'model3d-outliner-meta'
    meta.textContent = item.joint ? tt('model3d_joint') : item.type === 'MESH' && item.modifiers?.length ? String(item.modifiers.length) : item.type.toLowerCase()
    row.append(glyph, label, meta)
    row.addEventListener('click', () => {
      selected = item.name
      viewport?.select(item.name)
      renderOutliner()
      renderInspector()
    })
    list.appendChild(row)
  }
  host.appendChild(list)
}

/** The inspector: transform, material and the non-destructive modifier stack. */
function renderInspector(): void {
  const host = inspectorEl()
  if (!host) return
  const item = selected ? (document_?.objects ?? []).find(entry => entry.name === selected) : undefined
  host.hidden = !item
  host.textContent = ''
  if (!item) return
  const sections: Array<[string, Array<[string, string]>]> = [
    [tt('model3d_transform'), [
      [tt('model3d_location'), fmt3(item.location)],
      [tt('model3d_rotation'), fmt3(item.rotation_euler, true)],
      [tt('model3d_scale'), fmt3(item.scale)],
    ]],
  ]
  if (item.type === 'MESH') {
    if (item.materials?.length) sections.push([tt('model3d_materials'), item.materials.map(name => [name, ''])])
    else if (item.material) sections.push([tt('model3d_materials'), [[item.material, '']]])
    // The stack is the point of the design: show it in order, marking the
    // disabled layers so a "why did nothing change" question answers itself.
    if (item.modifiers?.length) {
      sections.push([tt('model3d_modifiers'), item.modifiers.map(modifier => [modifier.label || modifier.type, modifier.enabled ? modifier.type : `${modifier.type} (${tt('model3d_disabled')})`])])
    }
    if (item.rigid_body) sections.push([tt('model3d_physics'), [[tt('model3d_rigid_body'), item.rigid_body]]])
    if (item.cloth) sections.push([tt('model3d_physics'), [[tt('model3d_cloth'), item.cloth.preset]]])
    if (item.animated?.length) sections.push([tt('model3d_animation'), item.animated.map(path => [path, ''])])
  }
  if (item.type === 'CAMERA' && item.camera) {
    sections.push([tt('model3d_camera'), [[tt('model3d_lens'), `${item.camera.lens} mm`], [tt('model3d_active'), item.camera.active ? tt('model3d_yes') : tt('model3d_no')]]])
  }
  if (item.type === 'LIGHT' && item.light) {
    sections.push([tt('model3d_light'), [[tt('model3d_light_type'), item.light.type], [tt('model3d_energy'), String(Math.round(item.light.energy))]]])
  }
  for (const [heading, rows] of sections) {
    const block = window.document.createElement('div')
    block.className = 'model3d-inspector-block'
    const title = window.document.createElement('div')
    title.className = 'model3d-inspector-title'
    title.textContent = heading
    block.appendChild(title)
    for (const [key, value] of rows) {
      const row = window.document.createElement('div')
      row.className = 'model3d-inspector-row'
      const name = window.document.createElement('span')
      name.textContent = key
      row.appendChild(name)
      if (value) {
        const field = window.document.createElement('span')
        field.className = 'model3d-inspector-value'
        field.textContent = value
        row.appendChild(field)
      }
      block.appendChild(row)
    }
    host.appendChild(block)
  }
  const actions = window.document.createElement('div')
  actions.className = 'model3d-inspector-actions'
  const duplicate = window.document.createElement('button')
  duplicate.type = 'button'
  duplicate.className = 'model3d-inspector-btn'
  duplicate.textContent = tt('model3d_duplicate')
  duplicate.addEventListener('click', () => { void applyOps([{ type: 'duplicate', name: item.name }]) })
  const remove = window.document.createElement('button')
  remove.type = 'button'
  remove.className = 'model3d-inspector-btn is-danger'
  remove.textContent = tt('model3d_delete')
  remove.addEventListener('click', () => { void applyOps([{ type: 'delete', names: [item.name] }]) })
  actions.append(duplicate, remove)
  host.appendChild(actions)
}

function fmt3(value: number[] | undefined, degrees = false): string {
  if (!Array.isArray(value) || value.length < 3) return '—'
  const parts = value.slice(0, 3).map(entry => {
    const number = Number(entry) || 0
    return degrees ? `${((number * 180) / Math.PI).toFixed(1)}°` : number.toFixed(2)
  })
  return parts.join('  ')
}

/**
 * Send a panel mutation to the host and adopt what it publishes back.
 *
 * `baseVersion` is the version this UI built the ops against. If an agent edit
 * landed in between, the host replies `stale` with the current document instead
 * of applying, and we repaint that — so a drag can never silently overwrite an
 * agent's change.
 */
async function applyOps(ops: unknown[]): Promise<void> {
  const bridge = api()
  const sessionId = deps?.currentSessionId()
  if (!bridge || !sessionId) return
  // The catch branch is annotated to the same shape as the success type, so the
  // union keeps `document`/`stale` accessible below instead of narrowing to an
  // error-only object that lacks them.
  const reply: { ok?: boolean; stale?: boolean; error?: string; applied?: number; document?: SerializedScene } =
    await bridge.apply(sessionId, ops, document_?.version).catch((error: unknown) => ({
      ok: false, error: (error as Error | null)?.message || 'failed',
    }))
  if (reply?.ok === false) {
    w().showToast?.(reply.error || tt('model3d_edit_failed'), 'error')
    return
  }
  if (reply?.document) {
    document_ = reply.document
    paint()
    if (reply.stale) w().showToast?.(tt('model3d_reloaded'), 'info')
    return
  }
  await reload()
}

/** Push the cached document into the viewport and refresh the chrome. */
function paint(): void {
  const payload = document_
  if (!payload) return
  const view = viewport
  view?.update(payload)
  if (selected && !(payload.objects ?? []).some(item => item.name === selected)) {
    selected = null
    view?.select(null)
  }
  renderOutliner()
  renderInspector()
  renderPlayback()
  const count = payload.objects?.length ?? 0
  setStatus(count ? `${count} ${tt('model3d_objects')}` : null)
}

function renderPlayback(): void {
  const doc = document_, button = document.getElementById('model3d-play') as HTMLButtonElement | null, slider = document.getElementById('model3d-frame') as HTMLInputElement | null, output = document.getElementById('model3d-frame-value'), clipSelect = document.getElementById('model3d-clip') as HTMLSelectElement | null
  if (!button || !slider || !clipSelect || !output) return
  const clips = Object.values(doc?.clips ?? {}), native = (doc?.objects ?? []).some(item => Object.keys(item.animation ?? {}).length > 0), animated = !!doc && (native || clips.length > 0)
  for (const control of [button, slider, output]) control.hidden = !animated
  clipSelect.hidden = !animated || clips.length + (native ? 1 : 0) < 2
  const current = viewport?.currentClip ?? clips[0]?.name ?? ''
  clipSelect.textContent = ''
  if (native) { const option = document.createElement('option'); option.value = ''; option.textContent = tt('model3d_native_animation'); clipSelect.appendChild(option) }
  for (const clip of clips) { const option = document.createElement('option'); option.value = clip.name; option.textContent = clip.name; clipSelect.appendChild(option) }
  clipSelect.value = current
  let end = doc?.scene?.frameEnd ?? 250
  const start = doc?.scene?.frameStart ?? 1, fps = doc?.scene?.fps ?? 24
  for (const item of doc?.objects ?? []) for (const keys of Object.values(item.animation ?? {})) for (const key of keys) end = Math.max(end, key.frame)
  for (const clip of clips) for (const track of clip.tracks) if (track.times.length) end = Math.max(end, start + track.times[track.times.length - 1] * fps)
  slider.min = String(start); slider.max = String(Math.max(start + 1, end))
  updatePlaybackFrame(viewport?.currentFrame ?? start, viewport?.isPlaying ?? false)
}

function updatePlaybackFrame(frame: number, playing: boolean): void {
  const slider = document.getElementById('model3d-frame') as HTMLInputElement | null, output = document.getElementById('model3d-frame-value'), button = document.getElementById('model3d-play')
  if (slider) slider.value = String(frame)
  if (output) output.textContent = String(Math.round(frame))
  if (button) { button.setAttribute('aria-label', tt(playing ? 'model3d_pause' : 'model3d_play')); button.innerHTML = icon(playing ? 'goal-pause' : 'goal-resume') }
}

async function loadDocument(sessionId: string, id?: string): Promise<void> {
  const bridge = api()
  if (!bridge) return
  const token = ++loadToken
  const reply: { ok?: boolean; error?: string; document?: SerializedScene | null } =
    await bridge.get(sessionId, id).catch((error: unknown) => ({
      ok: false, error: (error as Error | null)?.message || tt('model3d_load_failed'),
    }))
  if (token !== loadToken) return
  if (reply?.ok === false || !reply?.document) {
    document_ = null
    hasFramed = false
    const empty = emptyEl()
    if (empty) empty.style.display = ''
    if (reply?.error) w().showToast?.(String(reply.error), 'error')
    renderOutliner()
    renderInspector()
    setStatus(null)
    return
  }
  document_ = reply.document
  const empty = emptyEl()
  if (empty) empty.style.display = (reply.document.objects?.length ?? 0) ? 'none' : ''
  // A hidden panel caches the document but builds no viewport: three.js would
  // otherwise be imported and a WebGL context allocated for pixels nobody sees.
  // activate() runs this again once the panel is on screen. Delegated
  // off-screen rendering keeps its own ensureViewport() call, because a
  // model3d_render request must succeed with the panel closed.
  const view = panelVisible() ? await ensureViewport() : undefined
  if (token !== loadToken) return
  paint()
  if ((reply.document.objects?.length ?? 0) && !hasFramed) {
    hasFramed = true
    if (view) {
      try { await view.whenReady(); if (token === loadToken) view.fitAll() }
      catch (error) { if (token === loadToken) w().showToast?.(String((error as Error)?.message ?? error), 'error') }
    }
  }
  await refreshDocList(sessionId)
}

async function reload(): Promise<void> {
  const sessionId = deps?.currentSessionId()
  if (!sessionId) return
  await loadDocument(sessionId, document_?.id as string | undefined)
}

/**
 * Build the viewport on first use, loading three.js then.
 *
 * The dynamic import is the whole reason this is async: a ~340 kB WebGL stack
 * must not sit in the startup bundle for a panel most sessions never open. The
 * in-flight promise is shared so two callers cannot each construct a viewport
 * and leak a WebGL context.
 */
async function ensureViewport(): Promise<Model3DViewport | undefined> {
  if (viewport) return viewport
  const host = viewportHost()
  if (!host) return undefined
  viewportLoading ??= (async () => {
    const { Model3DViewport: Viewport } = await import('./viewport')
    // The panel may have been closed while the chunk was loading.
    if (!viewportHost() || disposedPanel) {
      viewportLoading = undefined
      return undefined
    }
    viewport = new Viewport({
      container: host,
      loadMesh: async (name: string): Promise<MeshPayload> => {
        const bridge = api()
        const sessionId = renderSessionId ?? boundSession ?? deps?.currentSessionId()
        if (!bridge || !sessionId) throw new Error('No 3D session')
        return bridge.mesh(sessionId, name)
      },
      // A drag ends in one write-back; the host publishes the authoritative
      // document and model3d:changed drives the repaint.
      onTransform: async (name: string, next) => {
        // Destructure rather than object-spread: the spread compiles to a
        // `_defineProperty` runtime helper that the bundler may hoist into the
        // three.js chunk, and the panel's static import of that helper would then
        // pull three onto the startup path. Explicit fields avoid the helper.
        const { location, rotation_euler, scale } = next
        await applyOps([{ type: 'transform', name, location, rotation_euler, scale }])
      },
      onSelect: (name: string | null) => {
        selected = name
        renderOutliner()
        renderInspector()
      },
      onFrame: updatePlaybackFrame,
    })
    viewportLoading = undefined
    return viewport
  })().catch(error => {
    viewportLoading = undefined
    w().showToast?.(String((error as Error | null)?.message || error), 'error')
    return undefined
  })
  return viewportLoading
}

/**
 * Answer a host render request by drawing off-screen and returning the bytes.
 *
 * The host cannot render: there is no WebGL context in the main process. So it
 * sends the document it wants drawn, this panel draws it at the requested size
 * WITHOUT disturbing the visible view, and hands the bytes back. A failure is
 * reported rather than left hanging, or the tool call would time out.
 */
function handleRenderRequest(payload: RenderRequest): Promise<void> {
  const task = renderRequests.then(() => performRenderRequest(payload))
  renderRequests = task.catch(() => {})
  return task
}

async function performRenderRequest(payload: RenderRequest): Promise<void> {
  const bridge = api()
  if (!bridge) return
  const format = String(payload.format || 'png').toLowerCase() === 'jpg' || String(payload.format).toLowerCase() === 'jpeg' ? 'jpg' : 'png'
  try {
    renderSessionId = payload.sessionId ?? boundSession
    const view = await ensureViewport()
    if (!view) throw new Error(tt('model3d_render_needs_panel'))
    // A render for another conversation must not swap the scene the user is
    // looking at. There is exactly one viewport and one WebGL context here, so the
    // honest answer is a refusal the agent can act on, not a silent hijack.
    if (panelVisible() && payload.sessionId && boundSession && boundSession !== payload.sessionId) {
      throw new Error('The 3D panel is showing another conversation\'s scene; it cannot render this one without replacing what the user is looking at.')
    }
    // The request carries the document the host wants drawn, and that document is
    // the authoritative latest state. Gating this sync on the document ID — as it
    // used to be — treated "same scene" as "already current", but an edit inside
    // one scene bumps only the version, so a camera the agent had just moved never
    // reached the viewport and every render returned the same stale frame, byte
    // for byte. Syncing unconditionally is also what lets this work with the panel
    // closed: nothing here touches the visible view's camera, orbit target or size.
    view.update(payload.document)
    const camera = (payload.document?.objects ?? []).find(item => item.camera?.active)?.name ?? null
    const lens = (payload.document?.objects ?? []).find(item => item.camera?.active)?.camera?.lens
    const bytes = await view.renderOffscreen({
      width: Number(payload.width) || 640,
      height: Number(payload.height) || 480,
      format,
      camera,
      lens,
      engine: payload.engine,
      samples: payload.samples,
      bounces: payload.bounces,
      frame: payload.frame,
      clip: payload.clip,
    })
    let binary = ''
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index] as number)
    // Whether the user can actually see THIS scene is reported alongside the
    // bytes. A render succeeds with the panel closed by design, and a panel left
    // open on another conversation is not showing this scene either — so
    // visibility is the panel being on screen AND bound to the requesting session.
    // Without this the agent's only evidence is a valid image file, which is
    // exactly what led it to tell the user "the panel is open, orbit it" while
    // nothing was on screen.
    const visibleToUser = panelVisible() && (!payload.sessionId || boundSession === payload.sessionId)
    await bridge.renderResult({ requestId: payload.requestId, format, data: btoa(binary), panelVisible: visibleToUser })
  } catch (error) {
    await bridge.renderResult({ requestId: payload.requestId, error: String((error as Error | null)?.message || error) }).catch(() => {})
  } finally {
    renderSessionId = null
  }
}

async function activate(sessionId?: string): Promise<void> {
  const target = sessionId || deps?.currentSessionId()
  // Reopening after a close must clear the disposed flag, or ensureViewport()
  // would refuse to build the viewport ever again for this page.
  disposedPanel = false
  deps?.openArtifactsPanel('model3d')
  deps?.syncTopModeButtons()
  if (!target) {
    setStatus(null)
    return
  }
  boundSession = target
  const title = titleEl()
  if (title) title.textContent = tt('model3d_title')
  // Awaited before the load: loadDocument pushes the document into the viewport,
  // and a viewport still being imported would drop that first update.
  await ensureViewport()
  await loadDocument(target)
}

export function initModel3DPanel(injected: Model3DPanelDeps): void {
  deps = injected

  document.getElementById('model3d-fit')?.addEventListener('click', () => {
    void ensureViewport().then(view => view?.fitAll())
  })
  document.getElementById('model3d-grid')?.addEventListener('click', () => {
    void ensureViewport().then(view => { if (view) view.setGridVisible(!view.gridIsVisible) })
  })
  document.getElementById('model3d-play')?.addEventListener('click', () => { viewport?.play(!viewport.isPlaying) })
  document.getElementById('model3d-frame')?.addEventListener('input', event => { viewport?.play(false); viewport?.setFrame(Number((event.target as HTMLInputElement).value)) })
  document.getElementById('model3d-clip')?.addEventListener('change', event => { viewport?.play(false); viewport?.setFrame(document_?.scene?.frameStart ?? 1, (event.target as HTMLSelectElement).value || null) })
  docSelect()?.addEventListener('change', event => {
    const id = (event.target as HTMLSelectElement).value
    const sessionId = deps?.currentSessionId()
    if (id && sessionId) {
      hasFramed = false
      void loadDocument(sessionId, id)
    }
  })

  // Keyboard: the gizmo mode follows the usual 3D-app keys, but only while this
  // panel owns focus, so it cannot steal shortcuts from the composer.
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const panel = document.getElementById('model3d-panel')
    if (!panel || panel.offsetParent === null) return
    const key = event.key.toLowerCase()
    // A keystroke must not pay for the three.js import: only an already-built
    // viewport gets the shortcut, and the first paint comes from activate().
    if (key === 'g') { viewport?.setMode('translate'); event.preventDefault() }
    else if (key === 'r') { viewport?.setMode('rotate'); event.preventDefault() }
    else if (key === 's' && !event.metaKey && !event.ctrlKey) { viewport?.setMode('scale'); event.preventDefault() }
    else if (key === 'f') { viewport?.fitAll(); event.preventDefault() }
    else if ((key === 'delete' || key === 'backspace') && selected) { void applyOps([{ type: 'delete', names: [selected] }]) }
  })

  window.addEventListener('klaus:lang-change', () => {
    const title = titleEl()
    if (title) title.textContent = tt('model3d_title')
    renderOutliner()
    renderInspector()
    renderPlayback()
  })
  window.addEventListener('klaus:session-change', (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || ''
    document_ = null
    selected = null
    hasFramed = false
    boundSession = sessionId || null
    viewport?.select(null)
    renderOutliner()
    renderInspector()
    setStatus(null)
    if (sessionId) void loadDocument(sessionId)
  })

  api()?.onChanged((payload) => {
    if (payload.sessionId !== deps?.currentSessionId()) return
    void loadDocument(payload.sessionId, payload.id)
  })

  api()?.onRenderRequest((payload) => {
    void handleRenderRequest(payload)
  })

  // Transcript artifact cards pass both identities so a stale click cannot open
  // another conversation's scene after a session switch. The 3D store is scoped
  // per session, so a card from a session that is no longer current has nothing
  // to load here: refusing beats opening a panel that shows an empty scene while
  // claiming to have found the model.
  w().klausOpenModel3DPanel = (id?: string, sessionId?: string) => {
    const current = deps?.currentSessionId()
    if (typeof sessionId === 'string' && sessionId && current && sessionId !== current) return
    void activate(current || undefined).then(() => {
      const target = typeof id === 'string' ? id : undefined
      const session = deps?.currentSessionId()
      if (target && session) void loadDocument(session, target)
    })
  }
  w().klausCloseModel3DPanel = () => {
    // 单实例 surface：关掉就回到 Monitor，并释放 WebGL 上下文——浏览器对上下文数量
    // 有上限，留着一个会在每次开关面板后累积。
    disposedPanel = true
    viewport?.dispose()
    viewport = undefined
    viewportLoading = undefined
    document_ = null
    selected = null
    hasFramed = false
    boundSession = null
    renderOutliner()
    renderInspector()
    setStatus(null)
    deps?.openArtifactsPanel('monitor')
    deps?.syncTopModeButtons()
    deps?.renderSessionList()
  }
  w().KlausModel3D = {
    activate,
    reload: () => {
      const sessionId = deps?.currentSessionId()
      if (sessionId) return loadDocument(sessionId)
    },
    select: (name: string | null) => {
      selected = name
      viewport?.select(name)
      renderOutliner()
      renderInspector()
    },
    boundSession: () => boundSession,
  }
}
