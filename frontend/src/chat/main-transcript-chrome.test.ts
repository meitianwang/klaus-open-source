import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import type { TranscriptChromeState } from './transcript/chrome-state'

const source = createSourceFile('chat.ts', readFileSync(new URL('./chat.ts', import.meta.url), 'utf8'), ScriptTarget.Latest, true)
const functions = source.statements.filter(node => isFunctionDeclaration(node)
  && ['syncMainTranscriptChrome', 'syncCurrentTranscriptChrome'].includes(node.name?.text || ''))
const code = transpileModule(`let mainTranscriptChromeSessionId: string | null = null;\n${functions.map(node => node.getText(source)).join('\n')}\n({ update: syncMainTranscriptChrome, notify: syncCurrentTranscriptChrome })`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

function fixture() {
  let state: TranscriptChromeState = 'transcript', contextSyncs = 0, measurements = 0
  const mounted: string[] = [], attributes = new Set<string>()
  const context = {
    window: { currentSessionId: 'first' as string | null },
    messagesEl: { style: { display: 'none' }, hasAttribute: (name: string) => attributes.has(name),
      toggleAttribute: (name: string, enabled: boolean) => { if (enabled) attributes.add(name); else attributes.delete(name) } },
    welcomeEl: { style: { display: 'flex' } },
    syncComposerContextRowVisibility: () => { contextSyncs++ },
    mainTranscriptChromeState: () => state,
    mountReactTranscript: (id: string) => { mounted.push(id) },
    syncTopModeButtons() {}, updateScrollToBottomBtn: () => { measurements++ },
  }
  const api = runInNewContext(code, context) as { update(): void; notify(state: unknown, previous: unknown): void }
  return { context, mounted, attributes, ...api, state: (next: TranscriptChromeState) => { state = next },
    counts: () => ({ contextSyncs, measurements }) }
}

describe('main transcript chrome updates', () => {
  test('background stream updates do not invoke the current surface presentation', () => {
    const f = fixture(), active = {}
    let previous = { sessions: { first: active, background: {} } }
    for (let i = 0; i < 1000; i++) {
      const next = { sessions: { first: active, background: {} } }
      f.notify(next, previous)
      previous = next
    }
    expect(f.counts()).toEqual({ contextSyncs: 0, measurements: 0 })
    const next = { sessions: { first: {}, background: previous.sessions.background } }
    f.notify(next, previous)
    expect(f.counts()).toEqual({ contextSyncs: 1, measurements: 1 })
  })

  test('streaming and background notifications do not remount or measure an unchanged surface', () => {
    const f = fixture()
    for (let i = 0; i < 1000; i++) f.update()
    expect(f.mounted.length).toBe(1)
    expect(f.mounted[0]).toBe('first')
    expect(f.counts()).toEqual({ contextSyncs: 1000, measurements: 1 })
  })

  test('switching conversations binds the new transcript even with the same visible state', () => {
    const f = fixture()
    f.update()
    f.context.window.currentSessionId = 'second'
    f.update()
    expect(f.mounted).toEqual(['first', 'second'])
  })

  test('loading, submitted content and empty history apply their visibility and busy state', () => {
    const f = fixture()
    f.state('loading'); f.update()
    expect(f.attributes.has('aria-busy')).toBe(true)
    f.state('transcript'); f.update()
    expect(f.attributes.has('aria-busy')).toBe(false)
    expect(f.context.messagesEl.style.display).toBe('block')
    f.state('welcome'); f.update()
    expect(f.context.messagesEl.style.display).toBe('none')
    expect(f.context.welcomeEl.style.display).toBe('flex')
    f.state('transcript'); f.update()
    expect(f.context.messagesEl.style.display).toBe('block')
  })

  test('reopening the same conversation restores a surface hidden by new-chat navigation', () => {
    const f = fixture()
    f.update()
    f.context.window.currentSessionId = null
    f.context.messagesEl.style.display = 'none'
    f.context.welcomeEl.style.display = 'flex'
    f.update()
    f.context.window.currentSessionId = 'first'
    f.update()
    expect(f.context.messagesEl.style.display).toBe('block')
    expect(f.mounted).toEqual(['first', 'first'])
  })
})
