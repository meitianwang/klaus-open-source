import { focusComposerAfterTurn, focusComposerInput } from './focus'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { goalSurfaceControlsAvailable, goalSurfaceEligible, removeSideWorkflowControls } from './workflow-surface'

for (const session of [null, { role: 'main' }, { role: 'main', threadSource: 'user' }]) test(`local and new-worktree drafts allow Goal: ${JSON.stringify(session)}`, () => {
  expect(goalSurfaceEligible(session, false)).toBe(true)
})
for (const session of [{ role: 'side_task' }, { archived: true }, { threadSource: 'automation' }]) test(`ineligible conversation has no Goal mutation surface: ${JSON.stringify(session)}`, () => {
  expect(goalSurfaceEligible(session, false)).toBe(false)
})
test('external-channel rows have no local Goal writer', () => { expect(goalSurfaceEligible({ role: 'main' }, true)).toBe(false) })

for (const session of [{ threadSource: 'friend' }, { friendGroupId: 'friendship' }, { hostMetadata: { threadSource: 'friend' } }, { hostMetadata: { friendTask: { taskId: 'bounded-task' } } }, { goalPursuitEligible: false }]) test(`bounded goals retain legacy controls without pursuit: ${JSON.stringify(session)}`, () => {
  expect(goalSurfaceEligible(session, false)).toBe(false)
  expect(goalSurfaceControlsAvailable(session, false)).toBe(true)
})


function deferredComposerFocus() {
  const timers: Array<() => void> = [], frames: Array<() => void> = [], events: unknown[] = []
  let modal = false
  const input = {
    value: 'abcdef',
    ownerDocument: {
      querySelector: () => modal ? {} : null,
      defaultView: {
        setTimeout(callback: () => void) { timers.push(callback) },
        requestAnimationFrame(callback: () => void) { frames.push(callback) },
      },
    },
    focus() { events.push('focus') },
    setSelectionRange(start: number, end: number) { events.push([start, end]) },
  } as unknown as HTMLTextAreaElement
  return { input, timers, frames, events, openModal() { modal = true } }
}

test('deferred composer focus yields to a modal opened before its timer or selection frame', () => {
  const beforeTimer = deferredComposerFocus()
  focusComposerInput(beforeTimer.input, 2, 4)
  beforeTimer.openModal()
  beforeTimer.timers.shift()!()
  expect(beforeTimer.events).toEqual([])
  expect(beforeTimer.frames).toEqual([])
  const beforeFrame = deferredComposerFocus()
  focusComposerInput(beforeFrame.input, 2, 4)
  beforeFrame.timers.shift()!()
  beforeFrame.openModal()
  beforeFrame.frames.shift()!()
  expect(beforeFrame.events).toEqual(['focus'])
})

test('ordinary deferred composer focus still restores its exact selection', () => {
  const fixture = deferredComposerFocus()
  focusComposerInput(fixture.input, 2, 4)
  fixture.timers.shift()!()
  fixture.frames.shift()!()
  expect(fixture.events).toEqual(['focus', [2, 4]])
})

function slashInsertionFocus() {
  const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true)
  const declaration = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'focusComposerInputAfterSlashInsert')
  if (!declaration) throw new Error('The slash insertion focus helper is missing')
  const script = transpileModule(`${declaration.getText(ast)}\nfocusComposerInputAfterSlashInsert`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  const frames: Array<() => void> = [], events: string[] = []
  const doc = { activeElement: null as object | null, querySelector: () => null }
  const input = { focus: () => { doc.activeElement = input; events.push('focus') } }
  const focus = runInNewContext(script, {
    document: doc,
    inputEl: input,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    normalizeSlashCommandSelection: () => events.push('normalize'),
    renderSelectedSlashCommand: () => events.push('render'),
  }) as () => void
  return { doc, input, frames, events, focus }
}

test('deferred slash insertion preserves a later explicit control focus', () => {
  const fixture = slashInsertionFocus()
  fixture.focus()
  const badge = { id: 'goal-mode-badge' }
  fixture.doc.activeElement = badge
  fixture.frames.shift()?.()
  expect(fixture.doc.activeElement).toBe(badge)
  expect(fixture.events).toEqual(['focus', 'render'])
})

test('deferred slash insertion still normalizes the active composer selection', () => {
  const fixture = slashInsertionFocus()
  fixture.focus()
  fixture.frames.shift()?.()
  expect(fixture.doc.activeElement).toBe(fixture.input)
  expect(fixture.events).toEqual(['focus', 'render', 'focus', 'normalize', 'render'])
})

for (const owner of ['plan-feedback-textarea', 'goal-objective-editor', 'goal-mode-badge']) test(`turn completion preserves ${owner} focus`, () => {
  const active = { id: owner }, body = {}
  const doc = { activeElement: active as object, body }
  let calls = 0
  const input = { ownerDocument: doc, focus: () => { calls++; doc.activeElement = input } }
  focusComposerAfterTurn(input as unknown as HTMLElement)
  expect(doc.activeElement).toBe(active)
  expect(calls).toBe(0)
})

for (const owner of ['body', 'composer']) test(`turn completion retains ordinary ${owner} handoff`, () => {
  const body = {}, doc = { activeElement: body as object, body }
  let calls = 0
  const input = { ownerDocument: doc, focus: () => { calls++; doc.activeElement = input } }
  if (owner === 'composer') doc.activeElement = input
  focusComposerAfterTurn(input as unknown as HTMLElement)
  expect(doc.activeElement).toBe(input)
  expect(calls).toBe(1)
})


test('a cloned composer cannot retain another conversation implementation decision', () => {
  const ids = new Set(['side-planning-decision-panel', 'side-plan-mode-badge', 'side-input'])
  const root = { querySelectorAll(selector: string) {
    return selector.split(',').map(item => item.trim().slice(1)).filter(id => ids.has(id)).map(id => ({ remove() { ids.delete(id) } }))
  } } as unknown as ParentNode
  removeSideWorkflowControls(root)
  expect(ids.has('side-planning-decision-panel')).toBe(false)
  expect(ids.has('side-plan-mode-badge')).toBe(false)
  expect(ids.has('side-input')).toBe(true)
})
