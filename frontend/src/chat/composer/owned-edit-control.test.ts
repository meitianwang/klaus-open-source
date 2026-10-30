import { expect, test } from 'bun:test'
import { dispatchComposerEditCommand, refreshComposerFocusReport, registerOwnedEditControl, setComposerFocusReporter } from './contenteditable-control'

class FocusDocument extends EventTarget {
  activeElement: unknown = null
  focusListeners = 0
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    if (args[0] === 'focusin') this.focusListeners++
    super.addEventListener(...args)
  }
}
function control(doc: FocusDocument) {
  const child = {}, root = { ownerDocument: doc, isConnected: true, contains: (target: unknown) => target === child }
  return { child, root: root as unknown as HTMLElement }
}

test('owned editor callbacks share focus reporting and distinguish false from unowned null', () => {
  const doc = new FocusDocument(), first = control(doc), reports: boolean[] = [], commands: string[] = []
  setComposerFocusReporter(state => reports.push(state.owned))
  const dispose = registerOwnedEditControl(first.root, command => { commands.push(command); return false })
  try {
    doc.activeElement = first.child
    doc.dispatchEvent(new Event('focusin'))
    expect(reports.at(-1)).toBe(true)
    expect(dispatchComposerEditCommand(doc as unknown as Document, 'undo')).toBe(false)
    expect(dispatchComposerEditCommand(doc as unknown as Document, 'redo')).toBe(false)
    expect(commands).toEqual(['undo', 'redo'])
    doc.activeElement = {}
    doc.dispatchEvent(new Event('focusin'))
    expect(reports.at(-1)).toBe(false)
    expect(dispatchComposerEditCommand(doc as unknown as Document, 'undo')).toBeNull()
    expect(commands).toHaveLength(2)
  } finally { dispose(); setComposerFocusReporter(null) }
})

test('disposal removes the retired editor while preserving another current editor', () => {
  const doc = new FocusDocument(), first = control(doc), second = control(doc), calls: string[] = []
  const a = registerOwnedEditControl(first.root, command => { calls.push('a:' + command); return true })
  const b = registerOwnedEditControl(second.root, command => { calls.push('b:' + command); return true })
  try {
    doc.activeElement = first.child
    expect(dispatchComposerEditCommand(doc as unknown as Document, 'undo')).toBe(true)
    a()
    expect(dispatchComposerEditCommand(doc as unknown as Document, 'undo')).toBeNull()
    doc.activeElement = second.child
    expect(dispatchComposerEditCommand(doc as unknown as Document, 'redo')).toBe(true)
    expect(calls).toEqual(['a:undo', 'b:redo'])
  } finally { a(); b() }
})

test('a new editor in a previously retired document reports ownership without duplicate focus listeners', () => {
  const doc = new FocusDocument(), first = control(doc), reports: boolean[] = []
  setComposerFocusReporter(state => reports.push(state.owned))
  doc.activeElement = first.child
  const a = registerOwnedEditControl(first.root, () => true)
  expect(reports.at(-1)).toBe(true)
  a()
  expect(reports.at(-1)).toBe(false)
  const second = control(doc)
  doc.activeElement = second.child
  const b = registerOwnedEditControl(second.root, () => true)
  try {
    expect(reports.at(-1)).toBe(true)
    expect(doc.focusListeners).toBe(1)
    const count = reports.length
    refreshComposerFocusReport()
    expect(reports).toHaveLength(count)
    Object.assign(second.root, { isConnected: false })
    doc.dispatchEvent(new Event('focusin'))
    expect(reports.at(-1)).toBe(false)
    expect(dispatchComposerEditCommand(doc as unknown as Document, 'undo')).toBeNull()
  } finally { b(); setComposerFocusReporter(null) }
})
