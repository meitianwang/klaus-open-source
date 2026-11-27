import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

const browser = new Window({ url: 'https://example.test' })
const globals = new Map<string, PropertyDescriptor | undefined>()
let panel: typeof import('./workspace-panel')
const root = '/workspace/project-a', scope = `__draft_project__:${root}`, path = `${root}/file.txt`
const calls: string[] = [], reads: string[] = []
const tree = [{ path, name: 'file.txt', isDir: false }]
const payload = { root, roots: [root], tree }
let project: string | null = root, group: string | null = null
let list = async (_id: string) => payload
let host: HTMLElement
const context = browser as unknown as { currentSessionId: string | null; klaus: unknown }
let starts = 0

beforeAll(async () => {
  for (const key of new Set([...Object.getOwnPropertyNames(browser).filter(key => /^(HTML|SVG)/.test(key)), 'window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLTemplateElement', 'HTMLStyleElement', 'Document', 'DocumentFragment', 'ShadowRoot', 'CustomEvent', 'Event', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'customElements', 'CSSStyleSheet', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'])) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    const value = key === 'window' ? browser : Reflect.get(browser, key)
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(browser) : value })
  }
  context.currentSessionId = null
  context.klaus = {
    session: { new: () => { starts++; throw new Error('Unexpected session creation') } },
    workspace: { list: (id: string) => { calls.push(id); return list(id) } },
    artifacts: { authorizePreview: async (id: string, file: string) => ({ ok: true, filePath: file }),
      read: async (id: string) => { reads.push(id); return { ok: true, content: 'fixture' } } },
  }
  host = document.body.appendChild(document.createElement('div'))
  panel = await import('./workspace-panel')
  panel.initWorkspacePanel({
    draftProjectWorkdir: () => project, draftWorkspaceId: () => group,
    expectedRootsForScope: () => [root], artifactsList: () => host,
    artifactsPanel: () => null, rememberWorkspaceRoot: () => {},
  } as unknown as Parameters<typeof panel.initWorkspacePanel>[0])
})

beforeEach(() => {
  context.currentSessionId = null
  project = root
  group = null
  list = async () => payload
})

afterAll(() => {
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('draft file browsing and reading do not create conversations', async () => {
  await panel.loadWorkspace(null)
  await panel.loadWorkspaceFile(path)
  expect(calls.at(-1)).toBe(scope)
  expect(reads.at(-1)).toBe(scope)
  group = 'group'
  list = async () => ({ ...payload, roots: [root, '/workspace/project-b'] })
  await panel.loadWorkspace(null)
  expect(calls.at(-1)).toBe('__draft_workspace__:group')
  expect(starts).toBe(0)
  group = null
  list = async () => payload
})

test('same-root switches preserve the mounted tree and reject stale responses', async () => {
  await panel.loadWorkspace(null)
  const mounted = host.firstElementChild
  expect(mounted?.classList.contains('workspace-tree-filter')).toBe(true)
  let finish!: (value: typeof payload) => void
  list = id => id === 'first' ? new Promise(resolve => { finish = resolve }) : Promise.resolve(payload)
  context.currentSessionId = 'first'
  const stale = panel.loadWorkspace('first')
  expect(host.firstElementChild === mounted).toBe(true)
  context.currentSessionId = 'second'
  await panel.loadWorkspace('second')
  await panel.loadWorkspaceFile(path)
  expect(reads.at(-1)).toBe('second')
  finish({ ...payload, root: '/workspace/stale', roots: ['/workspace/stale'] })
  await stale
  expect(host.firstElementChild === mounted).toBe(true)
  context.currentSessionId = null
  await panel.loadWorkspace(null)
  expect(host.firstElementChild === mounted).toBe(true)
})

test('no scope shows the localized empty state without a list request', async () => {
  project = null
  const count = calls.length
  await panel.loadWorkspace(null)
  expect(host.textContent).toContain('Choose a project, workspace, or conversation')
  expect(calls).toHaveLength(count)
})

test('an unsent submission browses its pending project without creating a conversation', async () => {
  const pending = { workdir: '/workspace/pending' }
  project = pending.workdir
  list = async () => ({ ...payload, root: project!, roots: [project!] })
  await panel.loadWorkspace(null)
  expect(calls.at(-1)).toBe(`__draft_project__:${pending.workdir}`)
  expect(starts).toBe(0)
})
