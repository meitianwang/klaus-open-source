import { tt } from '../app/i18n'
import { showToast } from '../app/ui-shared'
import './image-preview.css'
import { icon } from '../icons/registry'

export interface PreviewImage {
  src: string
  path?: string
  sessionId?: string
  alt?: string
  name?: string
  isAnimated?: boolean
}
export interface ImagePreviewOptions {
  source?: Partial<PreviewImage>
  gallery?: PreviewImage[]
  index?: number
  opener?: HTMLElement
}
interface ImagePreviewActions {
  openTab?(image: PreviewImage): void | boolean | Promise<void | boolean>
  currentChat?(): string
  addToChat?(file: File, target: string): Promise<void>
}
let actions: ImagePreviewActions = {}
let activePreview: ((restoreFocus?: boolean) => void) | undefined
const imageMenus = new Map<HTMLElement, HTMLElement | undefined>()
const zoomOwners = new Set<{ root: HTMLElement; modal: boolean; dispatch: (command: string) => boolean }>()
if (typeof window !== 'undefined') (window as any).klausImageZoomCommand = (command: string): boolean | null => {
  const viewers = [...zoomOwners].reverse().filter(viewer => viewer.root.isConnected)
  const owner = viewers.find(viewer => viewer.modal) || viewers.find(viewer => viewer.root.contains(document.activeElement)
    || [...imageMenus].some(([menu, opener]) => menu.contains(document.activeElement) && !!opener && viewer.root.contains(opener)))
  return owner ? owner.dispatch(command) : null
}
export function configureImagePreview(next: ImagePreviewActions): void { actions = next }

export const IMAGE_ZOOM_STEPS = [.25, .33, .5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
export const IMAGE_MIN_SCALE = IMAGE_ZOOM_STEPS[0]
export const IMAGE_MAX_SCALE = IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1]
export function fitImageScale(width: number, height: number, stageWidth: number, stageHeight: number): number {
  const result = Math.min(1, stageWidth / width, stageHeight / height)
  return Number.isFinite(result) && result > 0 ? result : 1
}
export function imageZoomRamp(fit: number): number[] { return [...new Set([...IMAGE_ZOOM_STEPS, fit])].sort((a, b) => a - b) }
export function nextImageScale(scale: number, direction: number, fit: number): number {
  const ramp = imageZoomRamp(fit)
  return direction > 0 ? ramp.find(value => value > scale) ?? ramp[ramp.length - 1] : [...ramp].reverse().find(value => value < scale) ?? ramp[0]
}
export function imageWheelDelta(delta: number, mode: number): number { return delta * (mode === 1 ? 16 : mode === 2 ? 800 : 1) }
export function zoomImageAt(scale: number, next: number, x: number, y: number, anchorX: number, anchorY: number, fit = IMAGE_MIN_SCALE) {
  const clamped = Number.isFinite(next) ? Math.min(IMAGE_MAX_SCALE, Math.max(Math.min(IMAGE_MIN_SCALE, fit), next)) : scale
  const ratio = clamped / scale
  return { scale: clamped, x: anchorX - (anchorX - x) * ratio, y: anchorY - (anchorY - y) * ratio }
}
export function imageMenuActions(image: PreviewImage, capabilities: { copy: boolean; add: boolean; tab: boolean }): string[] {
  const result = capabilities.tab ? ['open'] : []
  if (/^https?:/i.test(image.src)) result.push('address')
  if (capabilities.add && image.isAnimated !== true) result.push('add')
  if (capabilities.copy && image.isAnimated !== true) result.push('copy')
  if (image.path) result.push('reveal')
  result.push('save')
  return result
}

export function imageFailureText(reason?: string): string {
  const key = reason === 'not-found' ? 'image_file_missing' : reason === 'denied' ? 'image_access_denied'
    : reason === 'busy' ? 'image_file_busy' : reason === 'invalid' ? 'image_invalid_data' : 'image_unavailable'
  return tt(key)
}

function mediaApi(): any { return (window as any).klaus?.media }
function nameOf(image: PreviewImage): string { return image.name || image.path?.split(/[\\/]/).pop() || image.alt || 'image' }
function localPayload(image: PreviewImage) { return { sessionId: image.sessionId ?? '', filePath: image.path, name: nameOf(image) } }
async function imageFile(image: PreviewImage): Promise<File> {
  if (image.path) {
    const result = await mediaApi()?.readImage(localPayload(image))
    if (!result?.ok) throw new Error(result?.error || tt('image_unavailable'))
    const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0))
    return new File([bytes], result.name || nameOf(image), { type: result.mimeType })
  }
  const response = await fetch(image.src)
  if (!response.ok) throw new Error(tt('image_unavailable'))
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error(tt('image_unavailable'))
  return new File([blob], nameOf(image), { type: blob.type })
}
async function imagePayload(image: PreviewImage): Promise<Record<string, unknown>> {
  if (image.path) return localPayload(image)
  const file = await imageFile(image)
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(tt('image_unavailable')))
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.readAsDataURL(file)
  })
  return { sessionId: image.sessionId ?? '', data, mimeType: file.type, name: file.name }
}
export async function performImageAction(action: string, image: PreviewImage): Promise<void> {
  try {
    if (action === 'open') {
      const preview = activePreview
      if (!actions.openTab || await actions.openTab(image) === false) throw new Error(tt('image_action_failed'))
      if (activePreview === preview) preview?.(false)
      return
    }
    if (action === 'address') {
      if (!/^https?:/i.test(image.src)) return
      const result = await (window as any).klaus?.clipboard?.writeText(image.src)
      if (result?.ok === false) throw new Error(result.error)
      showToast(tt('image_address_copied')); return
    }
    if (action === 'add') {
      const target = actions.currentChat?.() ?? ''
      const file = await imageFile(image)
      if (!actions.addToChat) throw new Error(tt('image_action_failed'))
      await actions.addToChat(file, target); return
    }
    const method = action === 'save' ? 'saveImage' : action === 'copy' ? 'copyImage' : 'revealImage'
    const result = await mediaApi()?.[method](await imagePayload(image))
    if (!result?.ok) throw new Error(result?.error || tt('image_action_failed'))
    if (!result.cancelled && action !== 'reveal') showToast(tt(action === 'save' ? 'image_saved' : 'image_copied'))
  } catch (error) { showToast(tt('image_action_failed') + ': ' + (error instanceof Error ? error.message : String(error))) }
}
const menuKeys: Record<string, string> = { open: 'image_open_tab', address: 'image_copy_address', add: 'image_add_chat', copy: 'image_copy', reveal: 'image_reveal', save: 'image_save' }
export function showImageMenu(image: PreviewImage, x: number, y: number, opener?: HTMLElement): () => void {
  const menu = document.createElement('div')
  menu.className = 'image-preview-menu'
  menu.setAttribute('role', 'menu')
  const close = (restore = false) => {
    imageMenus.delete(menu)
    menu.remove()
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', key, true)
    if (restore && opener?.isConnected) opener.focus()
  }
  const outside = (event: Event) => { if (!menu.contains(event.target as Node)) close() }
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true) }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return
    event.preventDefault(); event.stopImmediatePropagation()
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  for (const action of imageMenuActions(image, { copy: typeof mediaApi()?.copyImage === 'function', add: !!actions.addToChat, tab: !!actions.openTab })) {
    const button = document.createElement('button')
    button.type = 'button'; button.setAttribute('role', 'menuitem')
    button.dataset.imageAction = action; button.textContent = tt(menuKeys[action])
    button.addEventListener('click', () => { close(true); void performImageAction(action, image) })
    menu.appendChild(button)
  }
  document.body.appendChild(menu)
  imageMenus.set(menu, opener)
  const bounds = menu.getBoundingClientRect()
  menu.style.left = Math.max(8, Math.min(x, innerWidth - bounds.width - 8)) + 'px'
  menu.style.top = Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) + 'px'
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', key, true)
  menu.querySelector<HTMLButtonElement>('button')?.focus()
  return () => close()
}

export function imagePreviewOptionsFromElement(element: HTMLElement, root: HTMLElement): ImagePreviewOptions {
  const figures = (root?.querySelectorAll ? [...root.querySelectorAll<HTMLElement>('[data-media-figure], [data-media-thumb]')] : [element])
    .filter(figure => (figure === element || !figure.classList.contains('is-media-broken'))
      && !figure.closest?.('[inert], [aria-hidden="true"]') && !!figure.querySelector('img')?.getAttribute('src'))
  if (!figures.includes(element)) figures.unshift(element)
  const sourceOf = (figure: HTMLElement): PreviewImage => {
    const img = figure.querySelector('img')!
    return { src: img.currentSrc || img.getAttribute('src') || '', path: figure.dataset?.mediaPath || undefined,
      sessionId: figure.dataset?.mediaSession ?? '', alt: img.alt, name: img.alt }
  }
  return { source: sourceOf(element), gallery: figures.map(sourceOf), index: Math.max(0, figures.indexOf(element)), opener: element }
}
export function bindImageContextMenu(root: HTMLElement): () => void {
  let closeMenu: (() => void) | undefined
  const handler = (event: MouseEvent) => {
    const figure = (event.target as Element)?.closest<HTMLElement>('[data-media-figure], [data-media-thumb]')
    if (!figure || figure.classList.contains('is-media-broken')) return
    event.preventDefault(); event.stopPropagation()
    closeMenu?.()
    closeMenu = showImageMenu(imagePreviewOptionsFromElement(figure, root).source as PreviewImage, event.clientX, event.clientY, figure)
  }
  root.addEventListener('contextmenu', handler)
  return () => { closeMenu?.(); root.removeEventListener('contextmenu', handler) }
}

export interface ImageViewState { scale: number; x: number; y: number; fitted: boolean; index: number }
export interface ImageViewer { dispose(): void; fit(): void; zoom(scale: number): void; state(): ImageViewState }
export function mountImageViewer(host: HTMLElement, gallery: PreviewImage[], index = 0, options: { close?: () => void; modal?: boolean; state?: ImageViewState; onZoomChange?: (scale: number | null) => void } = {}): ImageViewer {
  let current = Math.min(Math.max(0, index), gallery.length - 1), scale = 1, x = 0, y = 0, fitted = true, ready = false
  let menuClose: (() => void) | undefined
  let restoring = options.state
  const root = document.createElement('section')
  root.className = 'image-preview-viewer'
  root.tabIndex = -1
  root.setAttribute('aria-label', tt('image_preview'))
  const toolbar = document.createElement('div'); toolbar.className = 'image-preview-toolbar'
  const caption = document.createElement('div'); caption.className = 'image-preview-caption'
  const controls = document.createElement('div'); controls.className = 'image-preview-controls'
  const stage = document.createElement('div'); stage.className = 'image-preview-stage'; stage.tabIndex = 0
  const surface = document.createElement('div'); surface.className = 'image-preview-surface'
  const image = document.createElement('img'); image.draggable = false
  const status = document.createElement('div'); status.className = 'image-preview-status'; status.setAttribute('role', 'status')
  const percent = document.createElement('span'); percent.className = 'image-preview-percent'; percent.setAttribute('aria-live', 'polite')
  const buttons = new Map<string, HTMLButtonElement>()
  const button = (id: string, label: string, text: string, callback: () => void) => {
    const node = document.createElement('button'); node.type = 'button'; node.dataset.imageControl = id
    node.setAttribute('aria-label', tt(label));
    const glyphs: Record<string, string> = { previous: 'browser-nav-back', next: 'browser-nav-forward', out: 'ws-file-zoom-out', in: 'ws-file-zoom-in', save: 'install', close: 'image-lightbox-close', menu: 'panel-tab-more' }
    if (glyphs[id]) node.innerHTML = icon(glyphs[id]); else node.textContent = text
    node.addEventListener('click', callback); controls.appendChild(node); buttons.set(id, node); return node
  }
  const update = () => {
    stage.style.overflow = fitted ? 'hidden' : 'auto'
    image.style.width = image.naturalWidth * scale + 'px'
    image.style.height = image.naturalHeight * scale + 'px'
    surface.style.width = Math.max(stage.clientWidth, image.naturalWidth * scale) + 'px'
    surface.style.height = Math.max(stage.clientHeight, image.naturalHeight * scale) + 'px'
    stage.classList.toggle('can-pan', ready && (image.naturalWidth * scale > stage.clientWidth || image.naturalHeight * scale > stage.clientHeight))
    percent.textContent = Math.round(scale * 100) + '%'
    root.dataset.imageScale = String(scale)
    for (const id of ['out', 'in', 'fit', 'actual', 'save']) buttons.get(id)!.disabled = !ready || id === 'out' && scale <= Math.min(IMAGE_MIN_SCALE, fitScale()) || id === 'in' && scale >= IMAGE_MAX_SCALE
    buttons.get('previous')!.disabled = current <= 0
    buttons.get('next')!.disabled = current >= gallery.length - 1
  }
  const fitScale = () => fitImageScale(image.naturalWidth, image.naturalHeight, stage.clientWidth, stage.clientHeight)
  const fit = () => {
    fitted = true; x = y = 0
    stage.style.overflow = 'hidden'
    if (ready) scale = fitScale()
    update()
    stage.scrollLeft = stage.scrollTop = 0
    if (ready && !restoring) options.onZoomChange?.(null)
  }
  const zoom = (next: number, anchorX = 0, anchorY = 0) => {
    if (!ready) return
    const bounds = stage.getBoundingClientRect(), before = image.getBoundingClientRect()
    const pointerX = bounds.left + bounds.width / 2 + anchorX, pointerY = bounds.top + bounds.height / 2 + anchorY
    const relativeX = Math.min(1, Math.max(0, (pointerX - before.left) / before.width))
    const relativeY = Math.min(1, Math.max(0, (pointerY - before.top) / before.height))
    const state = zoomImageAt(scale, next, x, y, anchorX, anchorY, fitScale())
    if (state.scale === scale) return
    scale = state.scale; fitted = false; update()
    options.onZoomChange?.(scale)
    const after = image.getBoundingClientRect()
    stage.scrollLeft += after.left + after.width * relativeX - pointerX
    stage.scrollTop += after.top + after.height * relativeY - pointerY
  }
  let disposed = false
  let loadEpoch = 0
  const load = (next: number) => {
    const epoch = ++loadEpoch
    for (const pointer of pointers.keys()) if (stage.hasPointerCapture(pointer)) stage.releasePointerCapture(pointer)
    pointers.clear()
    pinch = undefined; drag = undefined
    current = Math.min(Math.max(0, next), gallery.length - 1)
    ready = false; x = y = 0; scale = 1; fitted = true
    const source = gallery[current]
    image.alt = source.alt || nameOf(source)
    caption.textContent = (gallery.length > 1 ? (current + 1) + ' / ' + gallery.length + ' · ' : '') + (source.alt || nameOf(source))
    status.textContent = tt('image_loading'); status.hidden = false; image.hidden = true
    retry.hidden = true
    image.removeAttribute('src'); update()
    if (!source.path || typeof mediaApi()?.readImage !== 'function') { image.src = source.src; return }
    void mediaApi().readImage({ ...localPayload(source), inspect: true }).then((result: any) => {
      if (disposed || epoch !== loadEpoch) return
      if (result?.ok && result.url) image.src = result.url
      else {
        status.textContent = imageFailureText(result?.reason); retry.hidden = false
        update()
      }
    }).catch(() => {
      if (disposed || epoch !== loadEpoch) return
      status.textContent = imageFailureText(); retry.hidden = false; update()
    })
  }
  button('previous', 'image_previous', '←', () => load(current - 1)).hidden = gallery.length < 2
  button('next', 'image_next', '→', () => load(current + 1)).hidden = gallery.length < 2
  button('out', 'workspace_zoom_out', '−', () => zoom(nextImageScale(scale, -1, fitScale())))
  controls.appendChild(percent)
  button('in', 'workspace_zoom_in', '+', () => zoom(nextImageScale(scale, 1, fitScale())))
  button('fit', 'workspace_zoom_fit', tt('workspace_zoom_fit_label'), fit)
  button('actual', 'workspace_zoom_reset', '100%', () => { x = y = 0; zoom(1); fitted = false; options.onZoomChange?.(scale); update() })
  button('save', 'image_save', '↓', () => void performImageAction('save', gallery[current]))
  const more = button('menu', 'image_more', '⋯', () => {
    menuClose?.()
    const bounds = more.getBoundingClientRect()
    menuClose = showImageMenu(gallery[current], bounds.left, bounds.bottom + 4, more)
  })
  if (options.close) button('close', 'image_close', '×', options.close)
  image.addEventListener('load', () => {
    ready = image.naturalWidth > 0; image.hidden = !ready; status.hidden = ready
    if (!ready) return
    if (restoring && !restoring.fitted) {
      scale = Math.min(IMAGE_MAX_SCALE, Math.max(Math.min(IMAGE_MIN_SCALE, fitScale()), restoring.scale)); fitted = false; update()
      stage.scrollLeft = restoring.x; stage.scrollTop = restoring.y
    } else fit()
    restoring = undefined
  })
  image.addEventListener('error', () => {
    ready = false; image.hidden = true; status.hidden = false; status.textContent = imageFailureText(); update()
    const epoch = loadEpoch, source = gallery[current]
    if (!source.path || typeof mediaApi()?.readImage !== 'function') return
    void mediaApi().readImage({ ...localPayload(source), inspect: true, loadFailed: true }).then((result: any) => {
      if (disposed || epoch !== loadEpoch || ready) return
      status.textContent = imageFailureText(result?.ok ? undefined : result?.reason)
    }).catch(() => { /* Keep the generic failure and explicit retry if inspection fails. */ })
  })
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'image-preview-retry'
  retry.textContent = tt('image_retry'); retry.addEventListener('click', () => load(current))
  status.addEventListener('click', () => { if (!ready) load(current) })
  // Loading failures retain navigation and explicit retry, without exposing invalid pixels.
  const retryUpdate = () => { retry.hidden = ready || status.textContent === tt('image_loading') }
  image.addEventListener('load', retryUpdate); image.addEventListener('error', retryUpdate)
  surface.append(image); stage.append(surface, status, retry)
  toolbar.append(caption, controls); root.append(toolbar, stage); host.appendChild(root)
  const pointers = new Map<number, { x: number; y: number }>()
  let lastPointer: { x: number; y: number } | undefined
  let pinch: { scale: number; distance: number } | undefined
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined
  const point = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY })
  const distance = (points: Array<{ x: number; y: number }>) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
  const rebaseGesture = () => {
    pinch = undefined; drag = undefined
    if (pointers.size === 1) {
      const [id, position] = [...pointers.entries()][0]
      drag = { id, ...position, left: stage.scrollLeft, top: stage.scrollTop }
    } else if (pointers.size > 1) {
      const d = distance([...pointers.values()])
      if (d > 0) pinch = { distance: d, scale }
    }
  }
  stage.addEventListener('pointerdown', event => {
    lastPointer = point(event)
    if (event.pointerType !== 'touch' || !ready || (event.target as Element).closest('button')) return
    pointers.set(event.pointerId, point(event)); stage.setPointerCapture(event.pointerId); stage.focus(); event.preventDefault()
    rebaseGesture()
  })
  stage.addEventListener('pointermove', event => {
    lastPointer = point(event)
    const previous = pointers.get(event.pointerId)
    if (!previous) return
    pointers.set(event.pointerId, point(event)); const after = [...pointers.values()]
    event.preventDefault(); event.stopPropagation()
    if (after.length === 1) { if (drag?.id === event.pointerId) { stage.scrollLeft = drag.left - (event.clientX - drag.x); stage.scrollTop = drag.top - (event.clientY - drag.y) }; return }
    if (!pinch) return
    const bounds = stage.getBoundingClientRect()
    const center = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 }
    zoom(pinch.scale * distance(after) / pinch.distance, center.x - bounds.left - bounds.width / 2, center.y - bounds.top - bounds.height / 2)
  })
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(event, e => {
    const id = (e as PointerEvent).pointerId
    if (!pointers.delete(id)) return
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id)
    rebaseGesture()
  })
  stage.addEventListener('wheel', event => {
    if (!ready || !event.ctrlKey) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = stage.getBoundingClientRect()
    const inside = (p: { x: number; y: number }) => p.x >= bounds.left && p.x <= bounds.right && p.y >= bounds.top && p.y <= bounds.bottom
    const eventPoint = { x: event.clientX, y: event.clientY }
    const anchor = (eventPoint.x || eventPoint.y) && inside(eventPoint) ? eventPoint : lastPointer && inside(lastPointer) ? lastPointer : { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    zoom(scale * Math.exp(-imageWheelDelta(event.deltaY, event.deltaMode) / 200), anchor.x - bounds.left - bounds.width / 2, anchor.y - bounds.top - bounds.height / 2)
  }, { passive: false })
  stage.addEventListener('dblclick', event => { event.preventDefault(); if (fitted) zoom(1); else fit() })
  stage.addEventListener('contextmenu', event => { event.preventDefault(); menuClose?.(); menuClose = showImageMenu(gallery[current], event.clientX, event.clientY, stage) })
  const onKey = (event: KeyboardEvent) => {
    if (document.querySelector('.image-preview-menu')) return
    if (!options.modal && !root.contains(document.activeElement)) return
    if (event.defaultPrevented || event.isComposing) return
    if (event.key === 'Escape' && options.close) { event.preventDefault(); event.stopPropagation(); options.close(); return }
    if (event.key === 'Tab' && options.modal) {
      const focusable = [...root.querySelectorAll<HTMLElement>('button:not(:disabled):not([hidden]), [tabindex="0"]')]
      const at = focusable.indexOf(document.activeElement as HTMLElement)
      focusable[(at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus()
      event.preventDefault(); return
    }
    if (['ArrowLeft', 'ArrowRight', '+', '=', '-', '0', 'f', 'F'].includes(event.key)) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target as Element)?.closest?.('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      if (event.key === 'ArrowLeft' && current > 0) load(current - 1)
      else if (event.key === 'ArrowRight' && current < gallery.length - 1) load(current + 1)
      else if (event.key === '+' || event.key === '=') zoom(nextImageScale(scale, 1, fitScale()))
      else if (event.key === '-') zoom(nextImageScale(scale, -1, fitScale()))
      else if (event.key === '0') { x = y = 0; zoom(1) }
      else if (event.key.toLowerCase() === 'f') fit()
    }
  }
  const zoomOwner = { root, modal: options.modal === true, dispatch: (command: string) => {
    if (command === 'fit') fit()
    else if (command === 'in' || command === 'out') zoom(nextImageScale(scale, command === 'in' ? 1 : -1, fitScale()))
    else return false
    return true
  } }
  zoomOwners.add(zoomOwner)
  document.addEventListener('keydown', onKey, true)
  const resize = new ResizeObserver(() => { if (fitted) fit(); else update() })
  resize.observe(stage)
  load(options.state?.index ?? current)
  retry.hidden = true
  return { fit, zoom, state: () => ({ scale, x: stage.scrollLeft, y: stage.scrollTop, fitted, index: current }), dispose: () => { disposed = true; ++loadEpoch; zoomOwners.delete(zoomOwner); menuClose?.(); resize.disconnect(); document.removeEventListener('keydown', onKey, true); image.removeAttribute('src'); root.remove() } }
}
// The embedded browser and the Canvas are native child views: they paint above
// every HTML layer in the window, so a full-screen lightbox cannot cover them
// with z-index alone. Ask their runtimes to step aside for the preview and put
// them back afterwards; hiding retains the pages, so nothing is lost.
function suspendNativeSurfacesForPreview(): () => void {
  const host = window as unknown as {
    klausSuspendBrowserForOverlay?: () => Promise<void> | void
    klausResumeBrowserAfterOverlay?: () => Promise<void> | void
    klausSuspendCanvasForOverlay?: () => Promise<void> | void
    klausResumeCanvasAfterOverlay?: () => Promise<void> | void
    klausSuspendPrototypeForOverlay?: () => Promise<void> | void
    klausResumePrototypeAfterOverlay?: () => Promise<void> | void
    klausSuspendVideoEditingForOverlay?: () => Promise<void> | void
    klausResumeVideoEditingAfterOverlay?: () => Promise<void> | void
    klausSuspendPptForOverlay?: () => Promise<void> | void
    klausResumePptAfterOverlay?: () => Promise<void> | void
  }
  void host.klausSuspendBrowserForOverlay?.()
  void host.klausSuspendCanvasForOverlay?.()
  void host.klausSuspendPrototypeForOverlay?.()
  void host.klausSuspendVideoEditingForOverlay?.()
  void host.klausSuspendPptForOverlay?.()
  let released = false
  return () => {
    if (released) return
    released = true
    void host.klausResumeBrowserAfterOverlay?.()
    void host.klausResumeCanvasAfterOverlay?.()
    void host.klausResumePrototypeAfterOverlay?.()
    void host.klausResumeVideoEditingAfterOverlay?.()
    void host.klausResumePptAfterOverlay?.()
  }
}

export function openImagePreview(src: string, options: ImagePreviewOptions = {}): void {
  activePreview?.()
  const opener = options.opener || document.activeElement as HTMLElement | undefined
  const source: PreviewImage = { src, ...options.source }
  const gallery = options.gallery?.length ? options.gallery : [source]
  const overlay = document.createElement('div')
  overlay.className = 'image-lightbox'
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', tt('image_preview'))
  const previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  const resumeNativeSurfaces = suspendNativeSurfacesForPreview()
  let disposed = false
  const close = (restoreFocus = true) => {
    if (disposed) return
    disposed = true; viewer.dispose(); overlay.remove(); document.body.style.overflow = previousOverflow; activePreview = undefined
    resumeNativeSurfaces()
    if (restoreFocus && opener?.isConnected) opener.focus()
  }
  document.body.appendChild(overlay)
  const viewer = mountImageViewer(overlay, gallery, options.index ?? 0, { close, modal: true })
  overlay.addEventListener('click', event => { if (event.target === overlay) close() })
  activePreview = close
  overlay.querySelector<HTMLElement>('[data-image-control="close"]')?.focus()
}
