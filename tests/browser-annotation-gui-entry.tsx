import { createRoot } from 'react-dom/client'
import { BrowserAnnotationOverlay } from '../frontend/src/chat/browser-annotation-view'
import type { BrowserAnnotationLabels } from '../frontend/src/chat/browser-annotation-core'

const labels: BrowserAnnotationLabels = { title: '批注页面', hint: '点击元素或拖拽选择区域', note: '备注', cancel: '取消', submit: '添加到对话', element: '元素', region: '区域' }
import type { BrowserAnnotationAnchor, BrowserAnnotationSelection } from '../frontend/src/chat/browser-annotation-core'

const snapshot = {
  id: 'synthetic-1',
  tabId: 'tab-1',
  url: 'http://localhost:4173/checkout',
  title: 'Synthetic checkout',
  previewUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22800%22 height=%22600%22%3E%3Crect width=%22800%22 height=%22600%22 fill=%22%23f6f7f9%22/%3E%3Crect x=%22100%22 y=%22120%22 width=%22200%22 height=%2240%22 rx=%228%22 fill=%22%23246bfe%22/%3E%3C/svg%3E',
  width: 800,
  height: 600,
  capturedAt: 1,
}

const element: BrowserAnnotationAnchor = {
  kind: 'element',
  selector: '#pay',
  tagName: 'button',
  selectedText: 'Pay now',
  rect: { x: 100, y: 120, width: 200, height: 40 },
}

const result: Record<string, unknown> = { checks: [] }
const rootNode = document.getElementById('root')!
const root = createRoot(rootNode)

function wait(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }
function assert(name: string, value: unknown) {
  ;(result.checks as Array<{ name: string; ok: boolean }>).push({ name, ok: Boolean(value) })
  if (!value) throw new Error(`Failed: ${name}`)
}
function point(rect: DOMRect, x: number, y: number) {
  return { clientX: rect.x + (x / 800) * rect.width, clientY: rect.y + (y / 600) * rect.height }
}
function fire(target: Element, type: string, x: number, y: number) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pointerId: 1 }))
}
function setTextarea(value: string) {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(item => item.textContent?.trim() === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found as HTMLButtonElement
}
async function stageRect() {
  const image = document.querySelector('[data-browser-annotation-stage] img') as HTMLImageElement
  await new Promise<void>(resolve => image.complete ? resolve() : image.addEventListener('load', () => resolve(), { once: true }))
  return image.getBoundingClientRect()
}

async function mount(key: string, mode: 'always' | 'necessary', onRecord: (selection: BrowserAnnotationSelection) => void, onCancel: () => void) {
  root.render(
    <BrowserAnnotationOverlay
      key={key}
      snapshot={snapshot}
      screenshotMode={mode}
      labels={labels}
      onAnchorAt={p => (p.x >= 100 && p.x <= 300 && p.y >= 120 && p.y <= 160 ? element : null)}
      onSubmit={onRecord}
      onCancel={onCancel}
    />,
  )
  await wait(80)
}

async function run() {
  try {
    let submitted: BrowserAnnotationSelection | null = null
    await mount('element', 'necessary', value => { submitted = value }, () => {})
    const stage = await stageRect()
    const stageEl = document.querySelector('[data-browser-annotation-stage]')!
    const center = point(stage, 200, 140)
    fire(stageEl, 'pointerdown', center.clientX, center.clientY)
    fire(stageEl, 'pointerup', center.clientX, center.clientY)
    await wait(80)
    setTextarea('Align this button with the total.')
    button(labels.submit).click()
    await wait(80)
    assert('element anchor selected', submitted?.anchor.kind === 'element')
    assert('element keeps whole screenshot in necessary mode', submitted?.cropScreenshot === false)
    result.element = submitted

    submitted = null
    await mount('region', 'necessary', value => { submitted = value }, () => {})
    const regionStageRect = await stageRect()
    const regionStage = document.querySelector('[data-browser-annotation-stage]')!
    const start = point(regionStageRect, 40, 50)
    const end = point(regionStageRect, 360, 230)
    fire(regionStage, 'pointerdown', start.clientX, start.clientY)
    fire(regionStage, 'pointermove', end.clientX, end.clientY)
    fire(regionStage, 'pointerup', end.clientX, end.clientY)
    await wait(80)
    setTextarea('Check the order summary spacing.')
    button(labels.submit).click()
    await wait(80)
    assert('region anchor selected', submitted?.anchor.kind === 'region')
    assert('necessary crops a pure region', submitted?.cropScreenshot === true)
    result.region = submitted

    submitted = null
    await mount('always-region', 'always', value => { submitted = value }, () => {})
    const alwaysStageRect = await stageRect()
    const alwaysStage = document.querySelector('[data-browser-annotation-stage]')!
    const alwaysStart = point(alwaysStageRect, 40, 50)
    const alwaysEnd = point(alwaysStageRect, 360, 230)
    fire(alwaysStage, 'pointerdown', alwaysStart.clientX, alwaysStart.clientY)
    fire(alwaysStage, 'pointermove', alwaysEnd.clientX, alwaysEnd.clientY)
    fire(alwaysStage, 'pointerup', alwaysEnd.clientX, alwaysEnd.clientY)
    await wait(80)
    button(labels.submit).click()
    await wait(80)
    assert('always keeps whole screenshot for a region', submitted?.cropScreenshot === false)
    result.alwaysRegion = submitted

    let cancelled = false
    await mount('escape', 'necessary', () => {}, () => { cancelled = true })
    const overlay = document.querySelector('[data-browser-annotation-overlay]') as HTMLElement
    assert('overlay receives focus', document.activeElement === overlay)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(40)
    assert('Escape callback runs', cancelled)
    result.cancelled = cancelled
    result.ok = (result.checks as Array<{ ok: boolean }>).every(item => item.ok)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    result.ok = false
  } finally {
    const pre = document.createElement('pre')
    pre.id = 'result'
    pre.textContent = JSON.stringify(result)
    document.body.append(pre)
    ;(window as unknown as { __done?: boolean }).__done = true
  }
}

void run()
