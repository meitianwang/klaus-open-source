import { describe, expect, test } from 'bun:test'
import { WorkspaceDocument, type DocumentWriteResult } from './workspace-document'

describe('workspace document persistence', () => {
  test('writes the newest revision after an edit arrives during a pending save', async () => {
    const writes: Array<{ content: string; mtime: number | null }> = []
    let complete!: (result: DocumentWriteResult) => void
    const document = new WorkspaceDocument({ content: 'base', mtimeMs: 1, delay: 60_000, onChange() {}, write(content, mtime) {
      writes.push({ content, mtime })
      if (writes.length === 1) return new Promise(resolve => { complete = resolve })
      return Promise.resolve({ ok: true, mtimeMs: 3 })
    } })
    document.update('first')
    const save = document.flush()
    document.update('second')
    complete({ ok: true, mtimeMs: 2 })
    expect(await save).toBe(true)
    expect(writes).toEqual([{ content: 'first', mtime: 1 }, { content: 'second', mtime: 2 }])
    expect(document.snapshot.savedContent).toBe('second')
    expect(document.dirty).toBe(false)
    await document.dispose()
  })

  test('closing waits for a reverted draft to replace an in-flight write', async () => {
    const writes: string[] = []
    let complete!: (result: DocumentWriteResult) => void
    const document = new WorkspaceDocument({ content: 'base', delay: 60_000, onChange() {}, write(content) {
      writes.push(content)
      return writes.length === 1 ? new Promise(resolve => { complete = resolve }) : Promise.resolve({ ok: true, mtimeMs: 3 })
    } })
    document.update('pending')
    void document.flush()
    document.update('base')
    expect(document.dirty).toBe(false)
    expect(document.snapshot.saving).toBe(true)
    const close = document.dispose()
    complete({ ok: true, mtimeMs: 2 })
    expect(await close).toBe(true)
    expect(writes).toEqual(['pending', 'base'])
    expect(document.snapshot.savedContent).toBe('base')
  })

  test('failed saves preserve the draft and retry using the original disk revision', async () => {
    let attempt = 0
    const revisions: Array<number | null> = []
    const document = new WorkspaceDocument({ content: 'base', mtimeMs: 4, delay: 60_000, onChange() {}, async write(_content, mtime) {
      revisions.push(mtime)
      return ++attempt === 1 ? { ok: false, error: 'write failed' } : { ok: true, mtimeMs: 5 }
    } })
    document.update('draft')
    expect(await document.flush()).toBe(false)
    expect(document.dirty).toBe(true)
    expect(document.snapshot.content).toBe('draft')
    expect(document.snapshot.error).toBe('write failed')
    expect(await document.flush()).toBe(true)
    expect(revisions).toEqual([4, 4])
    await document.dispose()
  })

  test('external edits pause writes until a user chooses which content to retain', async () => {
    const writes: string[] = []
    const document = new WorkspaceDocument({ content: 'base', mtimeMs: 1, delay: 60_000, onChange() {}, async write(content, expected) {
      writes.push(`${expected}:${content}`)
      return { ok: true, mtimeMs: 3 }
    } })
    document.update('local')
    document.syncExternal('external', 2)
    expect(await document.flush()).toBe(false)
    expect(writes).toEqual([])
    document.resolveConflict('local')
    expect(await document.flush()).toBe(true)
    expect(writes).toEqual(['2:local'])
    await document.dispose()
  })

  test('disk conflict responses keep local content and can accept the external document', async () => {
    const document = new WorkspaceDocument({ content: 'base', mtimeMs: 1, onChange() {}, async write() { return { ok: false, conflict: true, content: 'external', mtimeMs: 2 } } })
    document.update('local')
    expect(await document.flush()).toBe(false)
    expect(document.snapshot.content).toBe('local')
    document.resolveConflict('disk')
    expect(document.snapshot.content).toBe('external')
    expect(document.dirty).toBe(false)
    await document.dispose()
  })

  test('autosave writes after the debounce interval without a save command', async () => {
    const writes: string[] = []
    const document = new WorkspaceDocument({ content: 'base', delay: 5, onChange() {}, async write(content) { writes.push(content); return { ok: true } } })
    document.update('automatic')
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(writes).toEqual(['automatic'])
    await document.dispose()
  })
})
