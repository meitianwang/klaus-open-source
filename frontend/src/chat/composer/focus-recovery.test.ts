import { expect, test } from 'bun:test'
import { installComposerFocusRecovery } from './focus'

function fixture() {
  const listeners = new Map<string, Function>()
  let focused = true, blocked = false, idle = true
  const doc: any = { activeElement: null, hasFocus: () => focused,
    querySelectorAll: () => blocked ? [{ getClientRects: () => [{}] }] : [],
    defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
    addEventListener: (name: string, callback: Function) => { listeners.set(name, callback) },
    removeEventListener: (name: string) => { listeners.delete(name) },
  }
  const input = (id: string) => ({ id, ownerDocument: doc, isConnected: true, hidden: false,
    closest() { return this.hidden ? {} : null }, getClientRects() { return this.hidden ? [] : [{}] },
    focus() { doc.activeElement = this; listeners.get('focusin')?.() },
  })
  const main = input('input'), side = input('side-input'), outside = { closest: () => null }
  const dispose = installComposerFocusRecovery(main as unknown as HTMLElement, () => side as unknown as HTMLElement, () => idle)
  return { doc, main, side, dispose,
    outside() { doc.activeElement = outside },
    blocked(value: boolean) { blocked = value }, idle(value: boolean) { idle = value }, focused(value: boolean) { focused = value },
    key(extra: object = {}) { listeners.get('keydown')?.({ key: 'Escape', target: outside, ...extra }) },
  }
}

test('outside Escape recovers the remembered connected editor and falls back to the visible primary', () => {
  const f = fixture()
  f.outside(); f.key(); expect(f.doc.activeElement).toBe(f.main)
  f.side.focus(); f.outside(); f.key(); expect(f.doc.activeElement).toBe(f.side)
  f.side.hidden = true; f.outside(); f.key(); expect(f.doc.activeElement).toBe(f.main)
  f.main.hidden = true; f.outside(); const before = f.doc.activeElement; f.key(); expect(f.doc.activeElement).toBe(before)
  f.dispose()
})

test('modal, menu, terminal, composition and focused-editor owners keep Escape', () => {
  const f = fixture()
  for (const extra of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }, { key: 'Enter' },
    { target: { closest: () => ({}) } }]) {
    f.outside(); const before = f.doc.activeElement; f.key(extra); expect(f.doc.activeElement).toBe(before)
  }
  for (const change of [() => f.blocked(true), () => { f.blocked(false); f.focused(false) }, () => { f.focused(true); f.idle(false) }]) {
    change(); f.outside(); const before = f.doc.activeElement; f.key(); expect(f.doc.activeElement).toBe(before)
  }
  f.idle(true); f.dispose(); f.outside(); const before = f.doc.activeElement; f.key(); expect(f.doc.activeElement).toBe(before)
})
