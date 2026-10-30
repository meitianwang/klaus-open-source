import { describe, expect, test } from 'bun:test'
import { AttachmentHistory, installAttachmentHistory } from './attachment-history'
import { dispatchComposerEditCommand, registerOwnedEditControl, setComposerEditFallback } from './contenteditable-control'

function fixture() {
  let now = 0
  const timers = new Set<{ at: number; expire(): void }>()
  const history = new AttachmentHistory(expire => {
    const timer = { at: now + 60_000, expire }
    timers.add(timer)
    return () => { timers.delete(timer) }
  })
  const first = { name: 'first', uploading: true }, second = { name: 'second', uploading: false }
  let files = [first, second], current = true, changes = 0
  const finalized: object[] = []
  const remove = (entry: typeof first) => history.remove(entry, {
    files: () => files, setFiles: value => { files = value }, current: () => current,
    changed: () => { changes++ }, finalize: value => { finalized.push(value) },
  })
  return { history, first, second, remove, finalized,
    get files() { return files }, get changes() { return changes },
    append: (entry: typeof first) => { files.push(entry) }, retire: () => { current = false },
    advance: (ms: number) => {
      now += ms
      for (const timer of [...timers]) if (timer.at <= now && timers.has(timer)) timer.expire()
    },
  }
}

describe('attachment removal history', () => {
  test('undo and redo preserve identity and newer attachments in their existing order', () => {
    const f = fixture(), newer = { name: 'newer', uploading: false }
    f.remove(f.first); f.append(newer)
    expect(f.files).toEqual([f.second, newer])
    expect(f.history.apply('undo')).toBe(true)
    expect(f.files).toEqual([f.first, f.second, newer])
    expect(f.files[0]).toBe(f.first)
    expect(f.history.apply('redo')).toBe(true)
    expect(f.files).toEqual([f.second, newer])
    expect(f.changes).toBe(3)
    f.history.dispose()
    expect(f.finalized).toEqual([f.first])
  })

  test('a removed pending upload remains retained and undo exposes its settled object', () => {
    const f = fixture()
    f.remove(f.first)
    expect(f.history.retains(f.first)).toBe(true)
    f.first.uploading = false
    expect(f.history.apply('undo')).toBe(true)
    expect(f.files[0]).toBe(f.first)
    expect(f.files[0].uploading).toBe(false)
    f.history.dispose()
    expect(f.finalized).toEqual([])
    expect(f.history.retains(f.first)).toBe(false)
  })

  test('successful undo and redo renew expiry and finalize only applied removal once', () => {
    const f = fixture()
    f.remove(f.first); f.advance(59_999)
    expect(f.history.apply('undo')).toBe(true)
    f.advance(59_999)
    expect(f.history.apply('redo')).toBe(true)
    f.advance(59_999)
    expect(f.finalized).toEqual([])
    f.advance(1)
    expect(f.finalized).toEqual([f.first])
    expect(f.history.retains(f.first)).toBe(false)
    expect(f.history.apply('undo')).toBe(false)
    f.history.dispose()
    expect(f.finalized).toEqual([f.first])
  })

  test('an undone removal expires without deleting the restored file', () => {
    const f = fixture()
    f.remove(f.first); f.history.apply('undo'); f.advance(60_000)
    expect(f.finalized).toEqual([])
    expect(f.files[0]).toBe(f.first)
    expect(f.history.apply('redo')).toBe(false)
    f.history.dispose()
  })

  test('failed uploads and consumed restored cards retire their removal action', () => {
    for (const undoFirst of [false, true]) {
      const f = fixture()
      f.remove(f.first)
      if (undoFirst) f.history.apply('undo')
      f.history.discard(f.first)
      expect(f.history.retains(f.first)).toBe(false)
      expect(f.history.apply('undo')).toBe(false)
      expect(f.history.apply('redo')).toBe(false)
      expect(f.finalized).toEqual(undoFirst ? [] : [f.first])
      f.history.dispose()
    }
  })

  test('retired document owners cannot change the current tray', () => {
    const f = fixture(), newer = { name: 'newer', uploading: false }
    f.remove(f.first); f.append(newer); f.retire()
    expect(f.history.apply('undo')).toBe(false)
    expect(f.files).toEqual([f.second, newer])
    expect(f.finalized).toEqual([f.first])
    f.history.dispose()
  })

  test('new removal retires undone history without deleting its restored entry', () => {
    const f = fixture()
    f.remove(f.first); f.history.apply('undo'); f.remove(f.second)
    expect(f.history.apply('redo')).toBe(false)
    expect(f.history.retains(f.first)).toBe(false)
    f.history.dispose()
    expect(f.finalized).toEqual([f.second])
  })

  test('retains at most twenty removal actions and finalizes evictions', () => {
    const f = fixture()
    for (let index = 0; index < 21; index++) {
      const entry = { name: String(index), uploading: false }
      f.append(entry); f.remove(entry)
    }
    expect(f.finalized).toHaveLength(1)
    expect(f.finalized[0]).toEqual({ name: '0', uploading: false })
    let undone = 0
    while (f.history.apply('undo')) undone++
    expect(undone).toBe(20)
    f.history.dispose()
    expect(f.finalized).toHaveLength(1)
  })
})

test('focused document history answers before attachment actions; unowned input has no fallback', () => {
  const doc = { activeElement: null as object | null, addEventListener() {} } as unknown as Document
  const root = { ownerDocument: doc, isConnected: true, contains: () => false } as unknown as HTMLElement
  let textHistory = true, attachmentCalls = 0
  const unregister = registerOwnedEditControl(root, () => textHistory)
  setComposerEditFallback(root, () => { attachmentCalls++; return true })
  Object.defineProperty(doc, 'activeElement', { configurable: true, value: root })
  expect(dispatchComposerEditCommand(doc, 'undo')).toBe(true)
  expect(attachmentCalls).toBe(0)
  textHistory = false
  expect(dispatchComposerEditCommand(doc, 'redo')).toBe(true)
  expect(attachmentCalls).toBe(1)
  Object.defineProperty(doc, 'activeElement', { configurable: true, value: {} })
  expect(dispatchComposerEditCommand(doc, 'undo')).toBeNull()
  expect(attachmentCalls).toBe(1)
  unregister()
})

test('local attachment shortcuts follow the owning platform and leave composition untouched', () => {
  for (const platform of ['MacIntel', 'Linux x86_64']) {
    const listeners: Record<string, (event: any) => void> = {}
    const input = { ownerDocument: { defaultView: { navigator: { platform } } },
      addEventListener: (name: string, callback: (event: any) => void) => { listeners[name] = callback },
    } as unknown as HTMLElement
    const f = fixture(); f.remove(f.first)
    installAttachmentHistory(input, null, f.history)
    const apple = platform === 'MacIntel'
    const event = (extra: object) => ({ key: 'z', defaultPrevented: false, isComposing: false, keyCode: 90,
      ctrlKey: !apple, metaKey: apple, altKey: false, shiftKey: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...extra })
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true, metaKey: true },
      { ctrlKey: apple, metaKey: !apple }, ...(apple ? [{ key: 'y' }] : [])]) {
      const denied = event(extra); listeners.keydown(denied)
      expect(denied.defaultPrevented).toBe(false)
      expect(f.files).toEqual([f.second])
    }
    const undo = event({}); listeners.keydown(undo)
    expect(undo.defaultPrevented).toBe(true)
    expect(f.files).toEqual([f.first, f.second])
    const redo = event(apple ? { shiftKey: true } : { key: 'y' }); listeners.keydown(redo)
    expect(redo.defaultPrevented).toBe(true)
    expect(f.files).toEqual([f.second])
    f.history.dispose()
  }
})

test('the preview hit layer forwards Restore coordinates without intercepting ordinary preview clicks', () => {
  const listeners: Record<string, (event: any) => void> = {}, actions: string[] = []
  const restore = { disabled: false, getBoundingClientRect: () => ({ left: 20, right: 80, top: 40, bottom: 60 }),
    focus: () => { actions.push('focus') }, click: () => { actions.push('restore') } }
  const open = { parentElement: { querySelector: () => restore } }
  const previews = { addEventListener: (name: string, callback: (event: any) => void) => { listeners[name] = callback } } as unknown as HTMLElement
  const input = { ownerDocument: { defaultView: { navigator: { platform: 'MacIntel' } } }, addEventListener() {} } as unknown as HTMLElement
  const f = fixture(); installAttachmentHistory(input, previews, f.history)
  const event = (x: number, y: number) => ({ clientX: x, clientY: y, target: { closest: () => open },
    preventDefault: () => { actions.push('prevent') }, stopPropagation: () => { actions.push('stop') } })
  listeners.click(event(10, 50)); expect(actions).toEqual([])
  listeners.click(event(30, 30)); expect(actions).toEqual([])
  listeners.click(event(30, 50)); expect(actions).toEqual(['prevent', 'stop', 'focus', 'restore'])
  f.history.dispose()
})
