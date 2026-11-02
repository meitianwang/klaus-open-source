import { expect, test } from 'bun:test'
import { createEditorDiscovery, routeComposerPickerKey, type EditorDiscoveryContext } from './editor-discovery'
import type { ComposerTextControl } from './contenteditable-control'
import type { SlashMenuApi } from './slash-menu'
import type { ComposerQuery } from './composer-query'

function pending<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  let query: ComposerQuery | null = { prefix: '/', start: 0, end: 2, query: 'a' }
  let context: EditorDiscoveryContext | null = { owner: 'side-a:1', sessionId: 'side-a' }
  const calls = { shown: [] as unknown[], inserted: [] as unknown[], commands: [] as unknown[], failures: [] as unknown[], edits: [] as unknown[], hidden: 0, dismissed: 0, continued: 0 }
  const input = { value: '/a', selectionStart: 2, selectionEnd: 2, ownerDocument: { activeElement: null as unknown }, focus() { this.ownerDocument.activeElement = this } }
  input.focus()
  const control = { revision: 1, composing: false, queryAtCaret: () => query,
    dismissQuery() { calls.dismissed++; query = null },
    continueQuery() { calls.continued++ },
    replaceRange(start: number, end: number, text: string) { calls.edits.push([start, end, text]); this.revision++; query = { prefix: '@', start: 0, end: text.length + 1, query: text } },
  }
  let open = true
  const menu = { isOpen: () => open, hide() { calls.hidden++; open = false }, showSlash: (items: unknown) => { open = true; calls.shown.push(items) }, showMention: (options: unknown) => { open = true; calls.shown.push(options) }, navigate() {}, clickActive() {} }
  let load = async () => [{ name: 'alpha', kind: 'skill' }, { name: 'action', kind: 'command' }]
  let reference = async () => ({ kind: 'plugin' as const, name: 'Plugin', value: '[Plugin](plugin:one)' })
  const discovery = createEditorDiscovery({ input: input as unknown as HTMLTextAreaElement, control: control as unknown as ComposerTextControl,
    menu: menu as unknown as SlashMenuApi, context: () => context, load: () => load(), matches: (command, term) => command.name.includes(term),
    command: (item, range) => calls.commands.push([item, range]), reference: () => reference(),
    insert: (item, range) => calls.inserted.push([item, range]), failure: error => calls.failures.push(error) })
  return { calls, input, control, discovery, closeMenu: () => { open = false }, query: (value: ComposerQuery | null) => { query = value },
    context: (value: EditorDiscoveryContext | null) => { context = value }, load: (value: typeof load) => { load = value }, reference: (value: typeof reference) => { reference = value } }
}

test('button discovery owns a query without inserting a trigger into the draft', async () => {
  const f = fixture()
  f.input.value = 'Review '; f.input.selectionStart = f.input.selectionEnd = 7
  f.discovery.open()
  expect(f.input.value).toBe('Review ')
  expect(f.calls.shown.at(-1)).toMatchObject({ activation: 'synthetic', query: '', sessionId: 'side-a' })
  f.input.value = 'Review diagram'; f.input.selectionStart = f.input.selectionEnd = 14; f.control.revision++
  await f.discovery.refresh()
  expect(f.calls.shown.at(-1)).toMatchObject({ activation: 'synthetic', query: 'diagram' })
  await f.discovery.selectMention({ kind: 'command', name: 'Diagram', path: 'diagram', rel: '', isDir: false, command: { name: 'diagram', kind: 'skill' } })
  expect(f.calls.commands).toEqual([[{ name: 'diagram', kind: 'skill' }, { prefix: '@', start: 7, end: 14, query: 'diagram' }]])
  expect(f.calls.inserted).toEqual([])
})

test('context actions consume only their owned query and never dispatch after a binding change', async () => {
  const f = fixture()
  f.query({ prefix: '@', start: 3, end: 7, query: 'add' }); await f.discovery.refresh()
  let opened = 0
  const action = { kind: 'action' as const, name: 'Attach files', path: 'attach', rel: '', isDir: false, action: () => { opened++ } }
  await f.discovery.selectMention(action)
  expect(f.calls.edits).toEqual([[3, 7, '']])
  expect(opened).toBe(1)
  f.query({ prefix: '@', start: 0, end: 1, query: '' }); await f.discovery.refresh()
  f.context({ owner: 'side-b:2', sessionId: 'side-b' })
  await f.discovery.selectMention(action)
  expect(opened).toBe(1)
})

test('context keyboard uses Enter while Tab, spaces and digits retain normal editor behavior', () => {
  const calls: string[] = []
  const options = { context: true, alternateNavigation: true, composing: false, visible: true,
    navigate: (direction: number) => calls.push(`move:${direction}`), select: () => calls.push('select'), escape: () => calls.push('close') }
  const key = (name: string, extra = {}) => ({ key: name, preventDefault() {}, stopImmediatePropagation() {}, ...extra } as KeyboardEvent)
  for (const name of ['Tab', ' ', '1', '2', '3']) expect(routeComposerPickerKey(key(name), options)).toBe(false)
  expect(calls).toEqual([])
  for (const name of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) expect(routeComposerPickerKey(key(name), options)).toBe(true)
  expect(calls).toEqual(['move:1', 'move:-1', 'select', 'close'])
  expect(routeComposerPickerKey(key('n', { ctrlKey: true }), options)).toBe(true)
  expect(routeComposerPickerKey(key('Enter', { isComposing: true }), options)).toBe(false)
})

test('each editor publishes only its own scoped catalog', async () => {
  const one = fixture(), two = fixture()
  two.context({ owner: 'side-b:1', sessionId: 'side-b' })
  one.query({ prefix: '$', start: 0, end: 2, query: 'a' })
  await Promise.all([one.discovery.refresh(), two.discovery.refresh()])
  expect(one.calls.shown).toEqual([[{ name: 'alpha', kind: 'skill' }]])
  expect(two.calls.shown[0]).toHaveLength(2)
})

for (const change of ['revision', 'query', 'focus', 'owner', 'return', 'hide'] as const) {
  test(`a pending catalog cannot publish after ${change} changes`, async () => {
    const f = fixture(), wait = pending<Array<{ name: string; kind: string }>>()
    f.load(() => wait.promise)
    const request = f.discovery.refresh()
    if (change === 'revision') f.control.revision++
    if (change === 'query') f.query({ prefix: '/', start: 0, end: 3, query: 'ab' })
    if (change === 'focus') f.input.ownerDocument.activeElement = null
    if (change === 'owner') f.context({ owner: 'side-b:2', sessionId: 'side-b' })
    if (change === 'return') f.context({ owner: 'side-a:3', sessionId: 'side-a' })
    if (change === 'hide') f.discovery.hide()
    wait.resolve([{ name: 'alpha', kind: 'skill' }]); await request
    expect(f.calls.shown).toEqual([])
  })
}

test('async reference resolution cannot insert into a later binding of the same chat', async () => {
  const f = fixture(), wait = pending<{ kind: 'plugin'; name: string; value: string }>()
  f.query({ prefix: '@', start: 0, end: 2, query: 'p' }); await f.discovery.refresh()
  f.reference(() => wait.promise)
  const selection = f.discovery.selectMention({ kind: 'plugin', name: 'Plugin', path: 'one', rel: '', isDir: false })
  f.context({ owner: 'side-a:3', sessionId: 'side-a' })
  wait.resolve({ kind: 'plugin', name: 'Plugin', value: 'one' }); await selection
  expect(f.calls.inserted).toEqual([])
})

test('category Escape returns to the root and explicit directory completion continues a spaced path', async () => {
  const f = fixture()
  f.query({ prefix: '@', start: 0, end: 2, query: 'f' }); await f.discovery.refresh()
  await f.discovery.selectMention({ kind: 'category', category: 'files', name: 'Files', path: '', rel: '', isDir: false })
  expect(f.calls.shown.at(-1)).toMatchObject({ query: '', scope: 'files', sessionId: 'side-a' })
  f.discovery.keydown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} } as KeyboardEvent)
  expect(f.calls.shown.at(-1)).toMatchObject({ scope: null })
  await f.discovery.selectMention({ name: 'My folder', path: '/root/My folder', rel: 'My folder', isDir: true }, 'complete')
  expect(f.calls.edits.at(-1)).toEqual([1, 1, 'My folder/'])
  expect(f.calls.continued).toBe(1)
  expect(f.calls.inserted).toEqual([])
})

test('directory Enter inserts a reference and consumes exactly its authored query', async () => {
  const f = fixture()
  f.query({ prefix: '@', start: 3, end: 5, query: 'p' }); await f.discovery.refresh()
  await f.discovery.selectMention({ name: 'Folder', path: '/root/folder', rel: 'folder', isDir: true })
  expect(f.calls.inserted).toHaveLength(1)
  expect(f.calls.inserted[0]).toEqual([{ kind: 'plugin', name: 'Plugin', value: '[Plugin](plugin:one)' }, { prefix: '@', start: 3, end: 5, query: 'p' }])
})

test('discovery failures are reported only by the current owner', async () => {
  const f = fixture(), wait = pending<Array<{ name: string; kind: string }>>()
  f.load(() => wait.promise); const request = f.discovery.refresh(); f.discovery.hide()
  wait.reject(new Error('late')); await request
  expect(f.calls.failures).toEqual([])
  f.load(async () => { throw new Error('current') }); await f.discovery.refresh()
  expect(f.calls.failures).toHaveLength(1)
})

test('picker keys preserve modified and composing editing events', () => {
  const calls: string[] = []
  const options = { composing: false, visible: true, navigate: () => calls.push('navigate'), select: (intent: string) => calls.push(intent), escape: () => calls.push('escape') }
  for (const extra of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    expect(routeComposerPickerKey({ key: 'Enter', ...extra } as unknown as KeyboardEvent, options)).toBe(false)
  }
  expect(routeComposerPickerKey({ key: 'Tab', preventDefault() { calls.push('prevent') }, stopImmediatePropagation() { calls.push('stop') } } as KeyboardEvent, options)).toBe(true)
  expect(calls).toEqual(['complete', 'prevent', 'stop'])
})

test('external menu closure leaves Enter with the editor submit route', async () => {
  const f = fixture(); await f.discovery.refresh(); f.closeMenu()
  expect(f.discovery.keydown({ key: 'Enter' } as KeyboardEvent)).toBe(false)
})

test('old picker rows cannot swallow Enter while a changed query is loading', async () => {
  const f = fixture(); await f.discovery.refresh()
  const wait = pending<Array<{ name: string; kind: string }>>()
  f.load(() => wait.promise); f.control.revision++
  f.query({ prefix: '/', start: 0, end: 3, query: 'al' })
  const loading = f.discovery.refresh()
  expect(f.discovery.keydown({ key: 'Enter' } as KeyboardEvent)).toBe(false)
  wait.resolve([{ name: 'alpha', kind: 'skill' }]); await loading
})
