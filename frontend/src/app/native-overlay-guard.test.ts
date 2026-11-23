import { afterAll, beforeAll, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/browser-tool-contracts.json'

// The guard watches the real document through a MutationObserver. Bun has no
// DOM, so this suite drives it with a small element tree whose `matches`
// understands exactly the overlay markers the guard looks for.

type Records = Array<{ type: 'childList' | 'attributes'; target: FakeElement; addedNodes: FakeElement[]; removedNodes: FakeElement[] }>
let observerCallback: ((records: Records) => void) | null = null
let observedOptions: Record<string, unknown> | null = null

class FakeMutationObserver {
  constructor(callback: (records: Records) => void) { observerCallback = callback }
  observe(_root: unknown, options: Record<string, unknown>) { observedOptions = options }
  disconnect() { observerCallback = null }
}

class FakeElement {
  nodeType = 1
  children: FakeElement[] = []
  parent: FakeElement | null = null
  attributes = new Map<string, string>()
  classes = new Set<string>()
  hidden = false
  constructor(public tag = 'div', options: { classes?: string[]; attrs?: Record<string, string> } = {}) {
    for (const name of options.classes || []) this.classes.add(name)
    for (const [key, value] of Object.entries(options.attrs || {})) this.attributes.set(key, value)
  }
  get isConnected(): boolean {
    let node: FakeElement | null = this
    while (node) { if (node === root) return true; node = node.parent }
    return false
  }
  get firstElementChild(): FakeElement | null { return this.children[0] || null }
  append(child: FakeElement) { child.parent = this; this.children.push(child) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }
  contains(other: FakeElement): boolean {
    let node: FakeElement | null = other
    while (node) { if (node === this) return true; node = node.parent }
    return false
  }
  matches(_selector: string): boolean {
    return this.attributes.get('aria-modal') === 'true'
      || (this.tag === 'dialog' && this.attributes.has('open'))
      || this.classes.has('klaus-dialog-overlay') || this.classes.has('kls-modal-overlay')
      || this.classes.has('klaus-inline-vis-backdrop')
      || (this.classes.has('drop-overlay') && this.classes.has('active'))
      || this.attributes.has('data-klaus-native-suspend')
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = []
    const walk = (node: FakeElement) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child) } }
    walk(this)
    return found
  }
}

let root: FakeElement
const previous = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
beforeAll(() => { Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: FakeMutationObserver }) })
afterAll(() => {
  if (previous) Object.defineProperty(globalThis, 'MutationObserver', previous)
  else Reflect.deleteProperty(globalThis, 'MutationObserver')
})

function visible(element: FakeElement): boolean {
  let node: FakeElement | null = element
  while (node) { if (node.hidden) return false; node = node.parent }
  return element.isConnected
}

async function fixture(hookNames = ['Browser', 'Canvas', 'Prototype', 'VideoEditing', 'Ppt', 'Design', 'PhotoEditing']) {
  const { createNativeOverlayGuard } = await import('./native-overlay-guard')
  root = new FakeElement('body')
  const calls: string[] = []
  const host: Record<string, unknown> = {}
  for (const name of hookNames) {
    host[`klausSuspend${name}ForOverlay`] = () => { calls.push(`suspend:${name}`) }
    host[`klausResume${name}AfterOverlay`] = () => { calls.push(`resume:${name}`) }
  }
  const frames: Array<() => void> = []
  const guard = createNativeOverlayGuard({
    root: root as unknown as Element,
    host,
    schedule: callback => { frames.push(callback) },
    visible: element => visible(element as unknown as FakeElement),
  })
  const flush = () => { for (const callback of frames.splice(0)) callback() }
  const added = (node: FakeElement, parent = root) => {
    parent.append(node)
    observerCallback?.([{ type: 'childList', target: parent, addedNodes: [node], removedNodes: [] }])
    flush()
  }
  const removed = (node: FakeElement) => {
    const parent = node.parent!
    node.remove()
    observerCallback?.([{ type: 'childList', target: parent, addedNodes: [], removedNodes: [node] }])
    flush()
  }
  const changed = (node: FakeElement) => {
    observerCallback?.([{ type: 'attributes', target: node, addedNodes: [], removedNodes: [] }])
    flush()
  }
  return { guard, calls, host, frames, added, removed, changed }
}

test('a confirm dialog parks every native surface once and restores them on close', async () => {
  const f = await fixture()
  const overlay = new FakeElement('div', { classes: ['klaus-dialog-overlay'] })
  overlay.append(new FakeElement('div', { classes: ['klaus-dialog-card'], attrs: { role: 'dialog', 'aria-modal': 'true' } }))
  f.added(overlay)
  const expectedSuspends = vectors.modalPresentation.suspendedSurfaces.map(name => `suspend:${name}`)
  const expectedResumes = vectors.modalPresentation.suspendedSurfaces.map(name => `resume:${name}`)
  expect(f.calls).toEqual(expectedSuspends)
  f.removed(overlay)
  expect(f.calls.slice(expectedSuspends.length)).toEqual(expectedResumes)
  expect(f.guard.held()).toBe(false)
})

test('modal dialogs, active drop overlays, and opt-in wide popovers suspend all seven native surfaces', async () => {
  const f = await fixture()
  const commandDialog = new FakeElement('div', { attrs: { role: 'dialog', 'aria-modal': 'true' } })
  f.added(commandDialog)
  expect(f.calls).toEqual([
    'suspend:Browser',
    'suspend:Canvas',
    'suspend:Prototype',
    'suspend:VideoEditing',
    'suspend:Ppt',
    'suspend:Design',
    'suspend:PhotoEditing',
  ])
  f.removed(commandDialog)
  f.calls.length = 0

  const dropOverlay = new FakeElement('div', { classes: ['drop-overlay'] })
  f.added(dropOverlay)
  expect(f.calls).toEqual([])
  dropOverlay.classes.add('active')
  f.changed(dropOverlay)
  expect(f.calls).toHaveLength(7)
  dropOverlay.classes.delete('active')
  f.changed(dropOverlay)
  expect(f.calls).toHaveLength(14)
  f.calls.length = 0

  const widePopover = new FakeElement('div', { attrs: { role: 'dialog', 'data-klaus-native-suspend': 'true' } })
  f.added(widePopover)
  expect(f.calls).toHaveLength(7)
  f.removed(widePopover)
  expect(f.calls).toHaveLength(14)
})

test('stacked modals hold one lease until the last one closes', async () => {
  const f = await fixture(['Browser'])
  const outer = new FakeElement('div', { classes: ['kls-modal-overlay'] })
  const inner = new FakeElement('div', { classes: ['klaus-dialog-overlay'] })
  f.added(outer)
  f.added(inner)
  expect(f.calls).toEqual(['suspend:Browser'])
  f.removed(inner)
  expect(f.calls).toEqual(['suspend:Browser'])
  f.removed(outer)
  expect(f.calls).toEqual(['suspend:Browser', 'resume:Browser'])
})

test('a modal hidden inside an inactive page does not count until its page is shown', async () => {
  const f = await fixture(['Browser'])
  const page = new FakeElement('section')
  page.hidden = true
  f.added(page)
  f.added(new FakeElement('div', { attrs: { role: 'dialog', 'aria-modal': 'true' } }), page)
  expect(f.calls).toEqual([])
  page.hidden = false
  f.changed(page)
  expect(f.calls).toEqual(['suspend:Browser'])
  page.hidden = true
  f.changed(page)
  expect(f.calls).toEqual(['suspend:Browser', 'resume:Browser'])
})

test('a native dialog counts only while it is open', async () => {
  const f = await fixture(['Browser'])
  const dialog = new FakeElement('dialog')
  f.added(dialog)
  expect(f.calls).toEqual([])
  dialog.attributes.set('open', '')
  f.changed(dialog)
  expect(f.calls).toEqual(['suspend:Browser'])
  dialog.attributes.delete('open')
  f.changed(dialog)
  expect(f.calls).toEqual(['suspend:Browser', 'resume:Browser'])
})

test('unrelated attribute churn does not schedule any evaluation', async () => {
  const f = await fixture(['Browser'])
  const transcript = new FakeElement('main')
  f.added(transcript)
  f.added(new FakeElement('div', { classes: ['kls-modal-overlay'] }))
  expect(f.calls).toEqual(['suspend:Browser'])
  // A streaming transcript rewrites classes many times per frame.
  for (let index = 0; index < 50; index++) observerCallback?.([{ type: 'attributes', target: transcript, addedNodes: [], removedNodes: [] }])
  expect(f.frames).toHaveLength(0)
  expect(observedOptions?.attributeFilter).toEqual(['class', 'hidden', 'open', 'aria-modal', 'data-klaus-native-suspend'])
})

test('only surfaces that were sent aside are brought back', async () => {
  const f = await fixture(['Browser'])
  const overlay = new FakeElement('div', { classes: ['kls-modal-overlay'] })
  f.added(overlay)
  // A surface registered while the modal is up never received a suspend, so
  // resuming it would underflow its shared overlay counter.
  f.host.klausSuspendCanvasForOverlay = () => { f.calls.push('suspend:Canvas') }
  f.host.klausResumeCanvasAfterOverlay = () => { f.calls.push('resume:Canvas') }
  f.removed(overlay)
  expect(f.calls).toEqual(['suspend:Browser', 'resume:Browser'])
})

test('disposing while a modal is open releases the lease', async () => {
  const f = await fixture(['Browser'])
  f.added(new FakeElement('div', { classes: ['klaus-inline-vis-backdrop'] }))
  f.guard.dispose()
  expect(f.calls).toEqual(['suspend:Browser', 'resume:Browser'])
})
