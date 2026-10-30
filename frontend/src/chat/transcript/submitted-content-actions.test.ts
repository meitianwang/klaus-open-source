import { afterEach, expect, test } from 'bun:test'
import { openSubmittedFile, openSubmittedReference, resolveSubmittedPath } from './submitted-content-actions'
import type { ComposerReferenceToken } from '../composer/reference-token'
import { skillReference, referencesFromEditor } from '../composer/resource-reference'

const previousWindow = globalThis.window
;(globalThis as any).window = previousWindow || { addEventListener: () => {} }
const { renderComposerReferencePillHtml } = await import('../composer/reference-pill')
afterEach(() => { globalThis.window = previousWindow })

test('reference previews stay inert unless submitted actions and a supported destination are explicit', () => {
  const skill = skillReference({ name: 'review', path: '/profile/skills/review/SKILL.md', definitionPreview: true })
  const reference = { ...skill, range: { start: 0, end: skill.value.length } }
  expect(renderComposerReferencePillHtml(reference)).not.toContain('<button')
  expect(renderComposerReferencePillHtml(reference, true)).toContain('data-submitted-reference-kind="skill"')
  expect(renderComposerReferencePillHtml({ ...reference, skillPreview: false }, true)).not.toContain('<button')
  expect(referencesFromEditor(skill.value, [{ start: 0, end: skill.value.length, value: skill.value, data: reference }])[0].skillPreview).toBe(true)
})

test('submitted files resolve their owning directory and preserve exact paths', async () => {
  const calls: unknown[] = []
  ;(globalThis as any).window = { currentSessionId: 'unrelated', klaus: {
    session: { getResolvedWorkdir: async (id: string) => { calls.push(['cwd', id]); return { workdir: '/owner/project' } } },
    artifacts: { openWindow: async (...args: unknown[]) => { calls.push(['open', ...args]); return { ok: true } } },
  } }
  await openSubmittedFile('owner', 'src/a b.ts', 'A file')
  await openSubmittedFile('owner', '/uploads/hash.bin', 'Original name.pdf')
  expect(calls).toEqual([
    ['cwd', 'owner'], ['open', 'owner', '/owner/project/src/a b.ts', 'A file'],
    ['open', 'owner', '/uploads/hash.bin', 'Original name.pdf'],
  ])
})

test('submitted directory attachments reveal the retained native path without opening a file preview', async () => {
  const calls: string[] = []
  ;(globalThis as any).window = { klaus: { artifacts: {
    reveal: async (path: string) => { calls.push(path); return { ok: true } },
    openWindow: () => { throw Error('A directory is not a file preview') },
  } } }
  await openSubmittedFile('owner', '/outside/workspace/images.png/', 'images.png')
  expect(calls).toEqual(['/outside/workspace/images.png/'])
})

test('unbound and refused submitted previews surface errors instead of borrowing current scope', async () => {
  const opened: unknown[] = []
  ;(globalThis as any).window = { currentSessionId: 'other', klaus: {
    session: { getResolvedWorkdir: async () => ({}) },
    artifacts: { openWindow: async (...args: unknown[]) => { opened.push(args); return { error: 'file not found' } } },
  } }
  const failure = (operation: Promise<unknown>) => operation.then(() => '', error => error.message)
  expect(await failure(resolveSubmittedPath('owner', './notes.txt'))).toContain('directory is unavailable')
  expect(await failure(openSubmittedFile('owner', '/gone.txt'))).toBe('file not found')
  expect(await failure(openSubmittedFile('', '/exists.txt'))).toBe('Invalid file reference')
  expect(opened).toEqual([['owner', '/gone.txt', undefined]])
})

test('folder and conversation references use their exact retained identity', async () => {
  const calls: unknown[] = []
  ;(globalThis as any).window = { klausSwitchSession: async (id: string) => { calls.push(['conversation', id]) }, klaus: {
    session: { getResolvedWorkdir: async (id: string) => { calls.push(['cwd', id]); return { workdir: '/owner' } } },
    workspace: { reveal: async (...args: unknown[]) => { calls.push(['reveal', ...args]); return { ok: true } } },
  } }
  const reference = (kind: ComposerReferenceToken['kind'], data: object) => ({ kind, name: 'Name', value: '@name', range: { start: 0, end: 5 }, ...data })
  await openSubmittedReference('owner', reference('folder', { rel: 'src/' }))
  await openSubmittedReference('owner', reference('conversation', { id: 'exact-chat' }))
  await openSubmittedReference('owner', reference('mcp', { id: 'server' }))
  expect(calls).toEqual([['cwd', 'owner'], ['reveal', 'owner', '/owner/src/'], ['conversation', 'exact-chat']])
})
