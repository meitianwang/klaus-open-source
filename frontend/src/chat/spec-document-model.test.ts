import { describe, expect, test } from 'bun:test'
import { SpecDocumentModel, findSpecMatches, isNearSpecBottom, partialJsonString } from './spec-document-model'
import { submitSpecAnnotationDraft, type SpecAnnotation } from './spec-document-annotations'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Spec document registry', () => {
  test('deduplicates by session and path while preserving multiple documents', () => {
    const model = new SpecDocumentModel({ read: async () => ({ content: '' }) })
    model.register('a', '/project/.klaus/specs/first.md', { content: 'one' })
    model.register('a', '/project/.klaus/specs/second.md', { content: 'two' })
    model.register('a', '/project//.klaus/specs/first.md', { content: 'updated' })
    model.register('b', '/project/.klaus/specs/first.md', { content: 'other session' })
    expect(model.list('a').map(document => document.content)).toEqual(['updated', 'two'])
    expect(model.list('b').map(document => document.content)).toEqual(['other session'])
    model.dispose()
  })

  test('refreshes the same path and rejects an older read completing afterwards', async () => {
    const first = deferred<{ content: string }>()
    let calls = 0
    const model = new SpecDocumentModel({ read: () => ++calls === 1 ? first.promise : Promise.resolve({ content: 'latest' }) })
    model.register('a', '/spec.md')
    const stale = model.refresh('a', '/spec.md')
    await model.refresh('a', '/spec.md')
    first.resolve({ content: 'old' })
    await stale
    expect(model.get('a', '/spec.md')?.content).toBe('latest')
    expect(calls).toBe(2)
    model.dispose()
  })

  test('a stale read cannot replace content received from a tool delta', async () => {
    const read = deferred<{ content: string }>()
    const model = new SpecDocumentModel({ read: () => read.promise, schedulePoll: () => () => {} })
    model.register('a', '/project/.klaus/specs/a.md')
    const pending = model.refresh('a', '/project/.klaus/specs/a.md')
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'write', toolName: 'write_file', args: { path: '/project/.klaus/specs/a.md', content: '# Latest' } })
    read.resolve({ content: '# Old' })
    await pending
    expect(model.get('a', '/project/.klaus/specs/a.md')?.content).toBe('# Latest')
    expect(model.get('a', '/project/.klaus/specs/a.md')?.streaming).toBe(true)
    model.dispose()
  })

  test('streams partial JSON and performs a final authoritative read', async () => {
    const discovered: string[] = []
    const model = new SpecDocumentModel({ read: async () => ({ content: '# Saved\nFinal' }), onDiscover: document => discovered.push(document.path), schedulePoll: () => () => {} })
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'write', toolName: 'write', args: {} })
    model.onEvent({ type: 'tool_input_delta', sessionId: 'a', toolCallId: 'write', delta: '{"path":"/project/.klaus/specs/a' })
    expect(model.list('a')).toHaveLength(0)
    model.onEvent({ type: 'tool_input_delta', sessionId: 'a', toolCallId: 'write', delta: '.md","content":"# Draft\\nFir' })
    expect(model.list('a')[0].content).toBe('# Draft\nFir')
    model.onEvent({ type: 'tool_input_delta', sessionId: 'a', toolCallId: 'write', delta: 'st"}' })
    expect(model.list('a')[0].content).toBe('# Draft\nFirst')
    model.onEvent({ type: 'tool_end', sessionId: 'a', toolCallId: 'write' })
    await Promise.resolve()
    expect(model.list('a')[0].content).toBe('# Saved\nFinal')
    expect(model.list('a')[0].streaming).toBe(false)
    expect(discovered).toEqual(['/project/.klaus/specs/a.md'])
    model.dispose()
  })

  test('replaces complete host argument snapshots as their content grows', () => {
    const model = new SpecDocumentModel({ read: async () => ({ content: 'disk' }) })
    const path = '/project/.klaus/specs/a.md'
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'write', toolName: 'write', args: {} })
    model.onEvent({ type: 'tool_input_delta', sessionId: 'a', toolCallId: 'write', delta: JSON.stringify({ path, content: '# First' }) })
    expect(model.get('a', path)?.content).toBe('# First')
    model.onEvent({ type: 'tool_input_delta', sessionId: 'a', toolCallId: 'write', delta: JSON.stringify({ content: '# First\nSecond', path }) })
    expect(model.get('a', path)?.content).toBe('# First\nSecond')
    expect(model.list('a')).toHaveLength(1)
    expect(model.get('a', path)?.streaming).toBe(true)
    model.dispose()
  })

  test('resolves relative tool paths in their own sessions before deduplication and reads', async () => {
    const reads: string[] = []
    const directories: Record<string, string> = { a: '/project-a', b: '/project-b' }
    const model = new SpecDocumentModel({
      read: async path => { reads.push(path); return { content: 'saved' } },
      resolvePath: (sessionId, path) => path.startsWith('/') || !directories[sessionId] ? path : `${directories[sessionId]}/${path}`,
    })
    for (const sessionId of ['a', 'b']) model.onEvent({ type: 'tool_start', sessionId, toolCallId: 'write', toolName: 'write', args: { path: '.klaus/specs/a.md', content: sessionId } })
    model.register('a', '/project-a/.klaus/specs/a.md')
    expect(model.list('a')).toHaveLength(1)
    expect(model.get('a', '.klaus/specs/a.md')?.content).toBe('a')
    expect(model.list('b')[0].path).toBe('/project-b/.klaus/specs/a.md')
    expect(model.resolvePath('unknown', '.klaus/specs/a.md')).toBe('.klaus/specs/a.md')
    model.onEvent({ type: 'tool_end', sessionId: 'a', toolCallId: 'write' })
    await Promise.resolve()
    expect(reads).toEqual(['/project-a/.klaus/specs/a.md'])
    expect(model.get('a', '.klaus/specs/a.md')?.content).toBe('saved')
    expect(model.get('b', '.klaus/specs/a.md')?.content).toBe('b')
    model.dispose()
  })

  test('discovery may reopen and refresh without recursively discovering or replacing a live draft', async () => {
    let discoveries = 0
    const reads: Promise<void>[] = []
    const model = new SpecDocumentModel({
      read: async () => ({ content: 'old disk' }),
      onDiscover: document => {
        discoveries++
        model.register(document.sessionId, document.path)
        reads.push(model.refresh(document.sessionId, document.path))
      },
    })
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'write', toolName: 'write', args: { path: '/project/.klaus/specs/a.md', content: '# New draft' } })
    await Promise.all(reads)
    expect(discoveries).toBe(1)
    expect(model.list('a')[0].content).toBe('# New draft')
    expect(model.list('a')[0].streaming).toBe(true)
    model.dispose()
  })

  test('ordinary tools do not discover a panel and edits of known paths do refresh', async () => {
    let discoveries = 0
    const reads: string[] = []
    const model = new SpecDocumentModel({ read: async path => { reads.push(path); return { content: 'edited' } }, onDiscover: () => discoveries++, schedulePoll: () => () => {} })
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'read', toolName: 'read_file', args: { path: '/project/.klaus/specs/a.md' } })
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'write', toolName: 'write', args: { path: '/project/README.md', content: 'normal' } })
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'shell', toolName: 'bash', args: { path: '/project/.klaus/specs/a.md' } })
    expect(discoveries).toBe(0)
    expect(model.list('a')).toHaveLength(0)
    model.register('a', '/project/custom.md')
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'edit', toolName: 'edit_file', args: { path: '/project/custom.md', new_string: 'edited' } })
    await Promise.resolve()
    expect(reads).toEqual(['/project/custom.md'])
    expect(model.get('a', '/project/custom.md')?.content).toBe('edited')
    model.dispose()
  })

  test('polls only active writes and stops on interruption', async () => {
    let poll: (() => void) | undefined
    let stopped = 0
    let reads = 0
    const model = new SpecDocumentModel({ read: async () => { reads++; return { content: 'disk' } }, schedulePoll: callback => { poll = callback; return () => { stopped++ } } })
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'edit', toolName: 'edit_file', args: { path: '/project/.klaus/specs/a.md' } })
    await Promise.resolve()
    expect(poll).toBeDefined()
    poll?.()
    await Promise.resolve()
    expect(reads).toBe(2)
    model.onEvent({ type: 'interrupted', sessionId: 'a' })
    await Promise.resolve()
    expect(stopped).toBe(1)
    expect(model.list('a')[0].streaming).toBe(false)
    const count = reads
    poll?.()
    expect(reads).toBe(count)
    model.dispose()
  })

  test('identical tool IDs in different sessions do not cross update documents', () => {
    const model = new SpecDocumentModel({ read: async () => ({ content: '' }), schedulePoll: () => () => {} })
    for (const sessionId of ['a', 'b']) model.onEvent({ type: 'tool_start', sessionId, toolCallId: 'same', toolName: 'write', args: { path: '/project/.klaus/specs/a.md', content: sessionId } })
    model.onEvent({ type: 'tool_input_delta', sessionId: 'b', toolCallId: 'same', delta: '{"content":"only b"}' })
    expect(model.list('a')[0].content).toBe('a')
    expect(model.list('b')[0].content).toBe('only b')
    model.dispose()
  })

  test('a patch refreshes only Spec or explicitly known document paths', async () => {
    const reads: string[] = []
    let polls = 0
    let stops = 0
    const model = new SpecDocumentModel({ read: async path => { reads.push(path); return { content: 'patched' } }, schedulePoll: () => { polls++; return () => { stops++ } } })
    model.register('a', '/project/custom.md')
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'patch', toolName: 'functions.apply_patch', args: { patch: '*** Begin Patch\n*** Add File: /project/.klaus/specs/new.md\n+# New\n*** Update File: /project/custom.md\n@@\n+Change\n*** Update File: /project/README.md\n@@\n+Ordinary\n*** End Patch' } })
    await Promise.resolve()
    expect(reads).toEqual(['/project/.klaus/specs/new.md', '/project/custom.md'])
    expect(model.list('a')).toHaveLength(2)
    expect(polls).toBe(1)
    model.onEvent({ type: 'tool_end', sessionId: 'a', toolCallId: 'patch' })
    await Promise.resolve()
    expect(model.list('a').every(document => !document.streaming)).toBe(true)
    expect(stops).toBe(1)
    model.dispose()
  })

  test('a transient error does not stop an active document refresh', () => {
    let stopped = 0
    const model = new SpecDocumentModel({ read: async () => ({ content: 'disk' }), schedulePoll: () => () => { stopped++ } })
    model.onEvent({ type: 'tool_start', sessionId: 'a', toolCallId: 'edit', toolName: 'edit', args: { path: '/project/.klaus/specs/a.md' } })
    model.onEvent({ type: 'api_error', sessionId: 'a', terminal: false })
    expect(stopped).toBe(0)
    expect(model.list('a')[0].streaming).toBe(true)
    model.onEvent({ type: 'api_error', sessionId: 'a', terminal: true })
    expect(stopped).toBe(1)
    model.dispose()
  })

  test('read failures preserve last content and are cleared by a successful retry', async () => {
    let fail = true
    const model = new SpecDocumentModel({ read: async () => fail ? { error: 'Read failed' } : { content: 'recovered' } })
    model.register('a', '/spec.md', { content: 'prior' })
    await model.refresh('a', '/spec.md')
    expect(model.list('a')[0].content).toBe('prior')
    expect(model.list('a')[0].error).toBe('Read failed')
    fail = false
    await model.refresh('a', '/spec.md')
    expect(model.list('a')[0].content).toBe('recovered')
    expect(model.list('a')[0].error).toBe('')
    model.dispose()
  })

  test('disposed read completions do not publish', async () => {
    const read = deferred<{ content: string }>()
    let changes = 0
    const model = new SpecDocumentModel({ read: () => read.promise, onChange: () => changes++ })
    model.register('a', '/spec.md')
    const pending = model.refresh('a', '/spec.md')
    model.dispose()
    read.resolve({ content: 'late' })
    await pending
    expect(changes).toBe(1)
  })
})

describe('Spec find and annotation drafts', () => {
  test('partial JSON leaves unfinished escapes pending', () => {
    expect(partialJsonString('{"content":"a\\n\\u4e2d\\u', 'content')).toBe('a\n中')
    expect(partialJsonString('{"content":"quote: \\"', 'content')).toBe('quote: "')
  })

  test('find matches literal text without regex syntax and measures the bottom threshold', () => {
    expect(findSpecMatches('A [x] a [x]', '[x]')).toEqual([{ start: 2, end: 5 }, { start: 8, end: 11 }])
    expect(findSpecMatches('Plan PLAN', 'plan')).toHaveLength(2)
    expect(findSpecMatches('Plan', '')).toEqual([])
    expect(isNearSpecBottom(1000, 500, 488)).toBe(true)
    expect(isNearSpecBottom(1000, 500, 487)).toBe(false)
  })

  test('rejected or failed attachment submission keeps drafts; acceptance clears them', async () => {
    let items: SpecAnnotation[] = [{ content: 'one', comment: 'change' }]
    const handle = { count: () => items.length, peek: () => [...items], clear: () => { items = [] }, destroy: () => {} }
    expect(await submitSpecAnnotationDraft(handle, () => false)).toBe(false)
    expect(items).toHaveLength(1)
    let error = ''
    try { await submitSpecAnnotationDraft(handle, () => { throw new Error('offline') }) } catch (failure) { error = String(failure) }
    expect(error).toContain('offline')
    expect(items).toHaveLength(1)
    expect(await submitSpecAnnotationDraft(handle, () => true)).toBe(true)
    expect(items).toHaveLength(0)
  })

  test('a new annotation added during submission is not erased', async () => {
    let items: SpecAnnotation[] = [{ content: 'one', comment: 'change' }]
    const accepted = deferred<boolean>()
    const handle = { count: () => items.length, peek: () => [...items], clear: () => { items = [] }, destroy: () => {} }
    const pending = submitSpecAnnotationDraft(handle, () => accepted.promise)
    items.push({ content: 'two', comment: 'another' })
    accepted.resolve(true)
    await pending
    expect(items).toHaveLength(2)
  })
})
