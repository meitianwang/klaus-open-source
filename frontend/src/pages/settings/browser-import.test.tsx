import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { importRetrySelection, mergeImportSummary } from './browser-import-model'
import type { BrowserImportJobSnapshot } from '../../../../contracts/browser-import-jobs'
import discoveryVectors from '../../../../contracts/vectors/browser-profile-discovery-vectors.json'

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
async function waitForReveal(_milliseconds = 0) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

const saved = new Map<string, PropertyDescriptor | undefined>()
beforeAll(async () => {
  happyWindow = new Window({ url: 'http://localhost/' })
  happyWindow.currentLang = 'en'
  const values: Record<string, any> = { window: happyWindow, document: happyWindow.document, navigator: happyWindow.navigator, HTMLElement: happyWindow.HTMLElement, Node: happyWindow.Node, Event: happyWindow.Event, MouseEvent: happyWindow.MouseEvent, CustomEvent: happyWindow.CustomEvent, MutationObserver: happyWindow.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(values)) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  const { I18N } = await import('../../i18n')
  Object.assign(I18N.en, {
    browser_import_title: 'Import browser data',
    browser_import_desc: 'Bring passwords and other data from another browser.',
    browser_import_action: 'Import',
    browser_import_retry: 'Retry',
    browser_import_done: 'Done',
    browser_import_discovering: 'Discovering browser profiles…',
    browser_import_discovery_failed: 'Browser profiles could not be loaded.',
    browser_import_discovery_partial: 'Some browser profiles could not be read.',
    browser_import_no_profiles: 'No supported browser profiles were found.',
    browser_import_permission_denied: 'Your system blocked access to browser profiles.',
    browser_import_permission_settings: 'Open System Settings',
    browser_import_permission_settings_failed: 'System Settings could not be opened.',
    browser_import_start_failed: 'Import could not be started.',
    browser_import_cancel_failed: 'Import could not be cancelled.',
    browser_import_cancelling: 'Cancelling…',
    browser_import_progress_title: 'Importing browser data',
    browser_import_progress_desc: 'Importing selected data…',
    browser_import_complete_title: 'Import complete',
    browser_import_complete_desc: 'Selected browser data was imported.',
    browser_import_partial_desc: 'Some browser data could not be imported.',
    browser_import_failed_title: 'Import failed',
    browser_import_failed_desc: 'Browser data could not be imported.',
    browser_import_cancelled_title: 'Import cancelled',
    browser_import_cancelled_desc: 'The import was cancelled.',
    browser_import_extensions_confirm_title: 'Import unverified extensions?',
    browser_import_extensions_confirm_desc: 'Extensions can access browser data.',
    browser_import_extensions_confirm_action: 'Import extensions',
    browser_import_close_source: 'Close {source} before importing.',
    browser_import_count: '{count} imported',
    browser_import_source: 'Profile',
    browser_import_cookies: 'Cookies',
    browser_import_passwords: 'Passwords',
    browser_import_history: 'History',
    browser_import_extensions: 'Extensions',
    browser_import_cookies_failed: 'Some cookies failed',
    browser_import_passwords_failed: 'Some passwords failed',
    browser_import_history_failed: 'Some history failed',
    browser_import_extensions_failed: 'Some extensions failed',
    cancel: 'Cancel',
  })
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
  test('discovery results distinguish an empty list, access errors and readable sources', async () => {
    for (const row of discoveryVectors.outcomes) {
      const root = await mount(makeApi({
        discover: async () => ({ profiles: row.hasProfile ? profiles : [], errors: row.codes.map(code => ({ sourceId: 'edge', code, message: 'Synthetic discovery issue' })) }),
      }))
      const body = happyWindow.document.body.textContent
      expect(button('Import').disabled).toBe(!row.canImport)
      expect(Boolean(button('Retry'))).toBe(row.canRetry)
      expect(body.includes('No supported browser profiles were found.')).toBe(row.state === 'empty')
      expect(body.includes('Your system blocked access to browser profiles.')).toBe(row.state === 'permission' || row.state === 'partial')
      expect(body.includes('Browser profiles could not be loaded.')).toBe(row.state === 'failed')
      expect(body.includes('Some browser profiles could not be read.')).toBe(row.state === 'partial')
      await unmount(root)
    }
  })

  test('a denied discovery offers explicit settings navigation and a user-driven retry', async () => {
    let reads = 0, opened = 0
    const root = await mount(makeApi({
      discover: async () => ++reads === 1
        ? { profiles: [], errors: [{ sourceId: 'chrome', code: 'source_permission_denied', message: 'Synthetic access denial' }] }
        : { profiles, errors: [] },
      openPermissionSettings: async () => { opened++ },
    }))
    expect(happyWindow.document.body.textContent).toContain('Your system blocked access to browser profiles.')
    expect(happyWindow.document.body.textContent).toContain('source_permission_denied: Synthetic access denial')
    expect(button('Import').disabled).toBe(true)
    expect(reads).toBe(1)
    expect(opened).toBe(0)
    await click(button('Open System Settings'))
    expect(opened).toBe(1)
    expect(reads).toBe(1)
    await click(button('Retry'))
    expect(reads).toBe(2)
    expect(button('Import').disabled).toBe(false)
    expect(button('Open System Settings')).toBeUndefined()
    await unmount(root)
  })

  test('a retry exception does not reuse the previous permission diagnosis', async () => {
    let reads = 0
    const root = await mount(makeApi({
      discover: async () => {
        if (++reads > 1) throw new Error('Synthetic discovery failure')
        return { profiles: [], errors: [{ sourceId: 'chrome', code: 'source_permission_denied', message: 'Synthetic access denial' }] }
      },
    }))
    await click(button('Retry'))
    expect(happyWindow.document.body.textContent).toContain('Browser profiles could not be loaded.')
    expect(happyWindow.document.body.textContent).not.toContain('Your system blocked access to browser profiles.')
    expect(button('Import').disabled).toBe(true)
    await unmount(root)
  })

  test('profile_permission_denied uses the same generic denial without losing the issue', async () => {
    const root = await mount(makeApi({
      discover: async () => ({
        profiles: [],
        errors: [{ sourceId: 'chrome', code: 'profile_permission_denied', message: 'Synthetic profile denial' }],
      }),
    }))
    expect(happyWindow.document.body.textContent).toContain('Your system blocked access to browser profiles.')
    expect(happyWindow.document.body.textContent).toContain('profile_permission_denied: Synthetic profile denial')
    expect(happyWindow.document.body.textContent).not.toContain('macOS blocked')
    await unmount(root)
  })

  test('failed settings navigation preserves the denied state and exposes the error', async () => {
    const root = await mount(makeApi({
      discover: async () => ({ profiles: [], errors: [{ sourceId: 'chrome', code: 'source_permission_denied', message: 'Synthetic access denial' }] }),
      openPermissionSettings: async () => { throw new Error('Synthetic settings navigation failure') },
    }))
    await click(button('Open System Settings'))
    expect(happyWindow.document.body.textContent).toContain('System Settings could not be opened.')
    expect(button('Import').disabled).toBe(true)
    await unmount(root)
  })

  test('the single profile has no picker and defaults match the import contract', async () => {
    requests = []; cancelled = []; closed = 0
    const root = await mount(makeApi())
    expect(happyWindow.document.querySelector('select')).toBeNull()
    expect(Array.from(happyWindow.document.querySelectorAll('input')).map((input: any) => input.checked)).toEqual([true, true, true, false])
    await click(button('Import'))
    expect(requests[0].categories).toEqual({ cookies: true, passwords: true, history: true, extensions: false })
    expect(happyWindow.document.querySelector('[aria-busy="true"]')).not.toBeNull()
    const cancel = button('Cancel')
    expect(cancel).toBeDefined()
    await act(async () => { happyWindow.document.dispatchEvent(new happyWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(closed).toBe(0)
    await click(happyWindow.document.querySelector('.kls-modal-overlay'))
    expect(closed).toBe(0)

    await click(cancel)
    await click(cancel)
    expect(cancelled).toEqual(['job'])
    expect(button('Done')).toBeUndefined()
    await push(snapshot('job', { stage: 'importing', revision: 2 }))
    expect(button('Done')).toBeUndefined()
    await push(snapshot('job', { stage: 'cancelled', revision: 3 }))
    await waitForReveal()
    expect(button('Done')).toBeDefined()
    expect(happyWindow.document.body.textContent).toContain('Import cancelled')
    await unmount(root)
    expect(cancelled).toEqual(['job'])
  })

  test('multiple profiles use the keyboard and portal RuntimeChoice instead of a native select', async () => {
    const second = { ...profiles[0], profileId: 'Profile 2', displayName: 'Work', lastUsed: false }
    const root = await mount(makeApi({
      discover: async () => ({ profiles: [profiles[0], second], errors: [] }),
    }))
    expect(happyWindow.document.querySelector('select')).toBeNull()
    const trigger = happyWindow.document.querySelector('[role="combobox"]') as any
    expect(trigger).not.toBeNull()
    expect(trigger.getAttribute('aria-label')).toBe('Profile')
    await click(trigger)
    const options = Array.from(happyWindow.document.querySelectorAll('[role="option"]')) as any[]
    expect(options.length).toBe(2)
    await click(options[1])
    expect(happyWindow.document.querySelector('[role="combobox"]').textContent).toContain('Work')
    await unmount(root)
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

  test('cancelling before start returns cancels the late job immediately', async () => {
    requests = []; cancelled = []; closed = 0
    let resolveStart: any
    const root = await mount(makeApi({ start: (request: any) => {
      requests.push(request)
      return new Promise(done => { resolveStart = done })
    } }))
    await click(button('Import'))
    await click(button('Cancel'))
    expect(cancelled).toEqual([])
    expect(button('Done')).toBeUndefined()
    await act(async () => { resolveStart({ jobId: 'late', snapshot: snapshot('late', { stage: 'importing', revision: 1 }) }) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(cancelled).toEqual(['late'])
    expect(button('Done')).toBeUndefined()
    await push(snapshot('late', { stage: 'cancelled', revision: 2 }))
    await waitForReveal()
    expect(button('Done')).toBeDefined()
    await unmount(root)
    expect(cancelled).toEqual(['late'])
  })

})
