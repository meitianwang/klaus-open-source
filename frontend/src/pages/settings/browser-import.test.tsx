import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { importRetrySelection, mergeImportSummary } from './browser-import-model'
import type { BrowserImportJobSnapshot } from '../../../../contracts/browser-import-jobs'

const all = { cookies: true, passwords: true, history: true, extensions: true }
const one = { cookies: true, passwords: false, history: false, extensions: false }
function snapshot(jobId: string, overrides: Partial<BrowserImportJobSnapshot> = {}): BrowserImportJobSnapshot {
  return { jobId, sourceId: 'chrome', profileId: 'Default', stage: 'completed', revision: 4, counts: { cookies: 5, passwords: 3, history: 10, extensions: 1 }, errors: [], startedAt: 1, updatedAt: 2, ...overrides }
}

describe('browser import outcomes', () => {
  test('retry preserves successful categories and replaces retried counts', () => {
    const first = mergeImportSummary(null, all, snapshot('one', { stage: 'failed', errors: [{ category: 'cookies', code: 'row_failed', message: 'Some rows failed.' }] }))
    expect(importRetrySelection(first)).toEqual(one)
    const next = mergeImportSummary(first, one, snapshot('two', { counts: { cookies: 7, passwords: 0, history: 0, extensions: 0 } }))
    expect(next.counts).toEqual({ cookies: 7, passwords: 3, history: 10, extensions: 1 })
    expect(next.errors).toEqual([])
  })

  test('a profile failure applies only to the requested categories', () => {
    const first = mergeImportSummary(null, one, snapshot('one', { errors: [{ category: 'profile', code: 'unavailable', message: 'The source is unavailable.' }] }))
    expect(importRetrySelection(first)).toEqual(one)
    expect(first.errors).toEqual([{ category: 'cookies', code: 'unavailable', message: 'The source is unavailable.' }])
  })
})

let React: any
let act: any
let createRoot: any
let BrowserImportDialog: any
let happyWindow: any
const roots: any[] = []
const profiles = [{ sourceId: 'chrome', sourceLabel: 'Chrome', profileId: 'Default', displayName: 'Personal', lastUsed: true, ...all }]
const subscriptions = new Set<(value: BrowserImportJobSnapshot) => void>()
let requests: any[]
let cancelled: string[]
let closed: number

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    discover: async () => ({ profiles, errors: [] }),
    subscribe: (callback: (value: BrowserImportJobSnapshot) => void) => { subscriptions.add(callback); return () => { subscriptions.delete(callback) } },
    start: async (request: unknown) => { requests.push(request); return { jobId: 'job', snapshot: snapshot('job', { stage: 'importing', revision: 1 }) } },
    cancel: async (jobId: string) => { cancelled.push(jobId) },
    ...overrides,
  }
}
function button(label: string) { return Array.from(happyWindow.document.querySelectorAll('button')).find((node: any) => node.textContent.trim() === label) as any }
async function click(node: any) {
  expect(Boolean(node)).toBe(true)
  await act(async () => { node.dispatchEvent(new happyWindow.MouseEvent('click', { bubbles: true })) })
}
async function mount(api: any) {
  const container = happyWindow.document.createElement('div')
  happyWindow.document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(React.createElement(BrowserImportDialog, { api, onClose: () => { closed++ } })) })
  return root
}
async function unmount(root: any) {
  roots.splice(roots.indexOf(root), 1)
  await act(async () => { root.unmount() })
}
async function push(value: BrowserImportJobSnapshot) {
  await act(async () => { for (const callback of subscriptions) callback(value) })
}
async function waitForReveal(milliseconds = 1900) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)) })
}

const saved = new Map<string, PropertyDescriptor | undefined>()
beforeAll(async () => {
  happyWindow = new Window({ url: 'http://localhost/' })
  happyWindow.currentLang = 'en'
  const values: Record<string, any> = { window: happyWindow, document: happyWindow.document, navigator: happyWindow.navigator, HTMLElement: happyWindow.HTMLElement, Node: happyWindow.Node, Event: happyWindow.Event, MouseEvent: happyWindow.MouseEvent, CustomEvent: happyWindow.CustomEvent, MutationObserver: happyWindow.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(values)) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  React = await import('react')
  act = React.act
  createRoot = (await import('react-dom/client')).createRoot
  BrowserImportDialog = (await import('./browser-import-dialog')).BrowserImportDialog
})
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  happyWindow.document.body.innerHTML = ''
  subscriptions.clear()
})
afterAll(() => {
  happyWindow.close()
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key] }
})

beforeAll(() => { requests = []; cancelled = []; closed = 0 })

describe('browser import dialog lifecycle', () => {
  test('the single profile has no picker and defaults include history', async () => {
    requests = []; cancelled = []; closed = 0
    await mount(makeApi())
    expect(happyWindow.document.querySelector('select')).toBeNull()
    expect(Array.from(happyWindow.document.querySelectorAll('input')).map((input: any) => input.checked)).toEqual([true, true, true, false])
    await click(button('Import'))
    expect(requests[0].categories).toEqual({ cookies: true, passwords: true, history: true, extensions: false })
    expect(happyWindow.document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(button('Cancel')).toBeUndefined()
    await act(async () => { happyWindow.document.dispatchEvent(new happyWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(closed).toBe(0)
    await click(happyWindow.document.querySelector('.kls-modal-overlay'))
    expect(closed).toBe(0)
  })

  test('extensions require a separate confirmation and cancellation returns to the form', async () => {
    requests = []; cancelled = []; closed = 0
    await mount(makeApi())
    await click(happyWindow.document.querySelectorAll('input')[3])
    await click(button('Import'))
    expect(requests.length).toBe(0)
    expect(happyWindow.document.body.textContent).toContain('Import unverified extensions?')
    await click(button('Cancel'))
    expect(happyWindow.document.body.textContent).toContain('Import browser data')
    await click(button('Import'))
    await click(button('Import extensions'))
    expect(requests[0].allowUnverifiedExtensions).toBe(true)
  })

  test('a completion event arriving before start acknowledgement wins over the stale reply', async () => {
    requests = []; cancelled = []; closed = 0
    await mount(makeApi({ start: async (request: unknown) => {
      requests.push(request)
      for (const callback of subscriptions) callback(snapshot('fast'))
      return { jobId: 'fast', snapshot: snapshot('fast', { stage: 'queued', revision: 0 }) }
    } }))
    await click(button('Import'))
    await waitForReveal()
    expect(button('Done')).toBeDefined()
    expect(happyWindow.document.querySelectorAll('[data-state="complete"]').length).toBe(3)
    await push(snapshot('fast', { stage: 'importing', revision: 1 }))
    expect(button('Done')).toBeDefined()
  })

  test('retry requests only failed categories and retains the other counts', async () => {
    requests = []; cancelled = []; closed = 0
    let run = 0
    await mount(makeApi({ start: async (request: any) => {
      requests.push(request)
      const jobId = `retry-${++run}`
      return { jobId, snapshot: snapshot(jobId, run === 1 ? { stage: 'failed', errors: [{ category: 'cookies', code: 'row_failed', message: 'Some rows failed.' }] } : { counts: { cookies: 7, passwords: 0, history: 0, extensions: 0 } }) }
    } }))
    await click(button('Import'))
    await waitForReveal()
    expect(happyWindow.document.querySelector('[data-category="passwords"]').textContent).toContain('3 imported')
    await click(button('Retry'))
    expect(requests[1].categories).toEqual(one)
    await waitForReveal(850)
    expect(happyWindow.document.querySelector('[data-category="cookies"]').textContent).toContain('7 imported')
    expect(happyWindow.document.querySelector('[data-category="passwords"]').textContent).toContain('3 imported')
    expect(button('Retry')).toBeUndefined()
  })

  test('an owner unmount before start acknowledgement cancels the late job', async () => {
    requests = []; cancelled = []; closed = 0
    let resolve!: (value: unknown) => void
    const root = await mount(makeApi({ start: () => new Promise(done => { resolve = done }) }))
    await click(button('Import'))
    await unmount(root)
    resolve({ jobId: 'late', snapshot: snapshot('late') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancelled).toEqual(['late'])
    expect(subscriptions.size).toBe(0)
  })
})
