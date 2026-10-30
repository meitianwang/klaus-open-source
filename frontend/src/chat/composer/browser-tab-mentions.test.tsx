import { beforeEach, describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient } from '@tanstack/react-query'
import { browserTabMentionUri, type BrowserTabMention } from '../../../../shared/browser-tab-mention'
import { browserTabDetail, browserTabReference, normalizeBrowserTabMention, safeBrowserTabFavicon } from './browser-tab-reference'
import { BrowserTabIcon, browserTabIconHtml, installBrowserTabFaviconFallback } from './browser-tab-icon'
import { browserTabMentionSection } from './browser-tab-section'
import { browserTabsQueryKey, browserTabsQueryOptions, fetchBrowserTabRows, projectBrowserTabRows, subscribeBrowserTabMentionChanges } from './mention-queries'
import { mentionRows, reconcileMentionActiveIndex, selectableEntries } from './mention-sections'
import { normalizeComposerReferences, replaceComposerReferenceRange, syncComposerReferences } from './reference-token'
import { createComposerDraft, normalizeComposerDraft } from './slash-draft'
import { renderReferencePreview } from './reference-preview'

;(globalThis as any).window = { addEventListener: () => {} }
const { I18N } = await import('../../i18n/messages')
const { queuedComposerReferences } = await import('./queue-row-content')

function tab(overrides: Partial<BrowserTabMention> = {}): BrowserTabMention {
  const row = { source: 'extension' as const, browserId: 'chrome:profile-a', tabId: '42', title: 'Project notes',
    url: 'https://example.com/notes', browserName: 'Chrome', lastOpened: 123, ...overrides }
  return { ...row, mention: overrides.mention ?? browserTabMentionUri(row) }
}

beforeEach(() => { (globalThis as any).window = {} })

describe('browser tab candidate query', () => {
  test('passes the conversation and query to the host and keeps partial failures beside healthy rows', async () => {
    const row = tab()
    const calls: unknown[] = []
    ;(globalThis as any).window.klaus = { browserUse: { mentionTabs: async (request: unknown) => {
      calls.push(request)
      return { ok: true, tabs: [row], errors: [{ browserId: 'chrome:offline', message: 'Reconnect Chrome' }] }
    } } }
    expect(await fetchBrowserTabRows('conversation-a', ' notes ')).toEqual({ tabs: [row], errors: [{ browserId: 'chrome:offline', message: 'Reconnect Chrome' }] })
    expect(calls).toEqual([{ sessionId: 'conversation-a', query: 'notes' }])
  })

  test('a new conversation still lists external browser tabs with a null session', async () => {
    let received: unknown
    ;(globalThis as any).window.klaus = { browserUse: { mentionTabs: async (request: unknown) => {
      received = request
      return { ok: true, tabs: [tab()], errors: [] }
    } } }
    expect((await fetchBrowserTabRows(null, '')).tabs).toHaveLength(1)
    expect(received).toEqual({ sessionId: null, query: '' })
  })

  test('retains stable provider codes for localized presentation without inventing a code', async () => {
    const errors = [{ browserId: 'iab', message: 'Browser Use is disabled', code: 'browser_disabled' },
      { browserId: 'chrome:offline', message: 'Handshake rejected', code: 42 },
      { browserId: 'chrome:other', message: 'Other provider failure' }]
    ;(globalThis as any).window.klaus = { browserUse: { mentionTabs: async () => ({ ok: true, tabs: [], errors }) } }
    expect((await fetchBrowserTabRows(null, '')).errors).toEqual([
      errors[0], { browserId: 'chrome:offline', message: 'Handshake rejected' }, errors[2],
    ])
  })

  test('an unavailable or failed host API is an error, rather than a false empty result', async () => {
    await rejects(fetchBrowserTabRows(null, ''), /browser_tab_mentions_unavailable/)
    ;(globalThis as any).window.klaus = { browserUse: { mentionTabs: async () => ({ ok: false, error: 'Extension unavailable' }) } }
    await rejects(fetchBrowserTabRows(null, ''), /Extension unavailable/)
  })

  test('rejects malformed or mismatched snapshot rows without replacing their identity', async () => {
    const row = tab()
    ;(globalThis as any).window.klaus = { browserUse: { mentionTabs: async () => ({ ok: true,
      tabs: [null, { ...row, url: 'https://replacement.test' }, { ...row, browserId: 'chrome:other' }, row], errors: [] }) } }
    expect((await fetchBrowserTabRows('a', '')).tabs).toEqual([row])
  })

  test('distinct conversation and search keys never reuse capped candidates from another query', async () => {
    expect(browserTabsQueryKey('a', ' notes ')).toEqual(browserTabsQueryKey('a', 'notes'))
    expect(browserTabsQueryKey('a', '')).not.toEqual(browserTabsQueryKey('a', 'older'))
    expect(browserTabsQueryKey('a', '')).not.toEqual(browserTabsQueryKey('b', ''))
    const calls: string[] = []
    ;(globalThis as any).window.klaus = { browserUse: { mentionTabs: async ({ query }: { query: string }) => {
      calls.push(query)
      return { ok: true, tabs: [tab({ title: query || 'Recent' })], errors: [] }
    } } }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect((await client.fetchQuery(browserTabsQueryOptions('a', ''))).tabs[0].title).toBe('Recent')
    expect((await client.fetchQuery(browserTabsQueryOptions('a', 'older'))).tabs[0].title).toBe('older')
    expect(calls).toEqual(['', 'older'])
    client.clear()
  })

  test('every open refreshes immediately, polls live tabs, and refreshes when the window regains focus', () => {
    const options = browserTabsQueryOptions('a', '')
    expect(options.staleTime).toBe(0)
    expect(options.refetchOnMount).toBe('always')
    expect(options.refetchInterval).toBe(5_000)
    expect(options.refetchIntervalInBackground).toBe(true)
    expect(options.refetchOnWindowFocus).toBe(true)
  })

  test('IAB changes refresh only the owning picker and unsubscribe when it closes', () => {
    let listener: ((state: { conversationId?: string; tabInventoryChanged?: boolean }) => void) | undefined
    let focusListener: (() => void) | undefined
    let refreshes = 0
    const api = { on: { browserUseState: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } } } }
    const focusWindow = { addEventListener: (_name: string, callback: any) => { focusListener = callback }, removeEventListener: () => { focusListener = undefined } }
    const unsubscribe = subscribeBrowserTabMentionChanges(api, 'a', () => { refreshes++ }, focusWindow as unknown as Window)
    listener?.({ conversationId: 'other' })
    expect(refreshes).toBe(0)
    listener?.({ conversationId: 'a' })
    listener?.({})
    expect(refreshes).toBe(2)
    listener?.({ conversationId: 'other', tabInventoryChanged: true })
    expect(refreshes).toBe(3)
    focusListener?.()
    expect(refreshes).toBe(4)
    unsubscribe?.()
    expect(listener).toBeUndefined()
    expect(focusListener).toBeUndefined()
  })
})

describe('browser tab menu state and keyboard identity', () => {
  test('the tab section keeps all host search results without the other groups four-row cap', () => {
    const tabs = Array.from({ length: 100 }, (_, index) => tab({ tabId: String(index + 1) }))
    const section = browserTabMentionSection({ data: { tabs, errors: [] }, isError: false, isFetching: false, refetch: () => {} })
    expect(selectableEntries(mentionRows([section]))).toHaveLength(100)
  })

  test('partial errors preserve healthy rows and expose a working independent retry', () => {
    let retried = 0
    const section = browserTabMentionSection({ data: { tabs: [tab()], errors: [{ browserId: 'chrome:offline', message: 'Reconnect Chrome' }] },
      isError: false, isFetching: false, refetch: () => { retried++ } })
    const rows = mentionRows([section])
    expect(rows.map(row => row.kind)).toEqual(['heading', 'item', 'state'])
    const state = rows.find(row => row.kind === 'state')!
    expect(state.kind === 'state' && state.detail).toBe('Reconnect Chrome')
    if (state.kind === 'state') state.retry?.()
    expect(retried).toBe(1)
    expect(selectableEntries(rows)).toHaveLength(1)
  })

  test('initial loading stays within the Tabs section and a failed refresh retains cached candidates', () => {
    expect(browserTabMentionSection({ isError: false, isFetching: true, refetch: () => {} }).state?.kind).toBe('loading')
    const failed = browserTabMentionSection({ data: { tabs: [tab()], errors: [] }, error: new Error('Browser disabled'), isError: true, isFetching: false, refetch: () => {} })
    expect(failed.rows).toHaveLength(1)
    expect(failed.state?.kind).toBe('error')
    expect(failed.state?.detail).toBe('Browser disabled')
  })

  test('projects stable disabled notices in the active language while preserving provider diagnostics', () => {
    const result = { data: { tabs: [tab()], errors: [
      { browserId: 'iab', code: 'browser_disabled', message: 'Browser Use is disabled' },
      { browserId: 'chrome:offline', code: 'external_browser_unavailable', message: 'Profile handshake rejected' },
      { browserId: 'unknown', code: 'new_provider_error', message: 'Provider-specific detail' },
    ] }, isError: false, isFetching: false, refetch: () => {} }
    const en = browserTabMentionSection(result, key => I18N.en[key])
    const zh = browserTabMentionSection(result, key => I18N.zh[key])
    expect(en.state?.detail).toContain('Enable Browser in Settings')
    expect(zh.state?.detail).toContain('请在设置中开启浏览器')
    expect(zh.state?.detail).not.toContain('Browser Use is disabled')
    for (const section of [en, zh]) {
      expect(section.state?.detail).toContain('Profile handshake rejected')
      expect(section.state?.detail).toContain('Provider-specific detail')
      expect(section.rows).toHaveLength(1)
    }
  })

  test('an absent bridge renders a localized unavailable notice without protocol text', () => {
    const result = { error: new Error('browser_tab_mentions_unavailable'), isError: true, isFetching: false, refetch: () => {} }
    expect(browserTabMentionSection(result, key => I18N.zh[key]).state?.detail).toBe(I18N.zh.mention_browser_unavailable)
  })

  test('keyboard selection follows the same browser tab across recency reorder and updated snapshots', () => {
    const first = tab({ tabId: '1' }), second = tab({ tabId: '2' })
    const previous = projectBrowserTabRows([first, second])
    const next = projectBrowserTabRows([tab({ tabId: '2', title: 'Renamed', url: 'https://example.com/new' }), first])
    expect(reconcileMentionActiveIndex(previous, next, 1)).toBe(0)
    expect(reconcileMentionActiveIndex(previous, projectBrowserTabRows([first]), 1)).toBe(-1)
    expect(reconcileMentionActiveIndex([], next, 0)).toBe(0)
  })

  test('display metadata uses the supplied browser identity and page host', () => {
    expect(browserTabDetail(tab())).toBe('example.com · Chrome')
    const row = tab({ source: 'iab', browserId: 'conversation-a', browserName: 'Klaus' })
    expect(projectBrowserTabRows([row])[0]).toEqual({ name: row.title, path: row.mention, rel: 'example.com · Klaus',
      isDir: false, kind: 'browser-tab', browserTab: row })
  })
})

describe('browser tab references survive the composer lifecycle', () => {
  test('whitespace-only titles use a readable URL label while keeping the original snapshot', () => {
    const row = tab({ title: '\r\n  ' })
    const reference = browserTabReference(row)
    expect(reference.name).toBe(row.url)
    const token = { ...reference, range: { start: 0, end: reference.value.length } }
    expect(normalizeComposerReferences(reference.value, [token])[0].browserTab?.title).toBe('\r\n  ')
  })
  test('inserts an escaped Markdown reference while preserving its exact browser tab snapshot', () => {
    const row = tab({ title: 'Spec [draft] \\ notes' })
    const inserted = replaceComposerReferenceRange('read @spec now', 5, 10, '', browserTabReference(row))
    expect(inserted.text).toContain('[Spec \\[draft\\] \\\\ notes](plugin://browser@klaus-bundled?mention=tab-v1&source=extension&browserId=chrome%3Aprofile-a&tabId=42')
    expect(normalizeComposerReferences(inserted.text, [inserted.reference])[0].browserTab).toEqual(row)
    expect(inserted.text.slice(inserted.reference.range.start, inserted.reference.range.end)).toBe(inserted.reference.value)
  })

  test('draft and queue serialization preserve browser, favicon, URI and range together', () => {
    const row = tab({ faviconUrl: 'data:image/png;base64,AAAA' })
    const inserted = replaceComposerReferenceRange('@tab inspect', 0, 4, '', browserTabReference(row))
    const draft = createComposerDraft(inserted.text, null, null, [inserted.reference])
    expect(draft.references).toHaveLength(1)
    expect(normalizeComposerDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft)
    const queued = JSON.parse(JSON.stringify({ displayText: inserted.text, composerReferences: draft.references }))
    expect(normalizeComposerReferences(queued.displayText, queued.composerReferences)).toEqual(draft.references)
  })

  test('queued previews retain chip identity after whitespace trimming and hide the protocol URI', () => {
    const selected = browserTabReference(tab())
    const original = `  read ${selected.value} now  `
    const token = { ...selected, range: { start: 7, end: 7 + selected.value.length } }
    const preview = original.trim()
    const references = queuedComposerReferences({ displayText: original, composerReferences: [token] }, preview)
    expect(references).toHaveLength(1)
    expect(references[0].range.start).toBe(5)
    const html = renderReferencePreview(preview, references, text => text, reference => `<span class="chip">${reference.name}</span>`)
    expect(html).toBe('read <span class="chip">Project notes</span> now')
    expect(html).not.toContain('plugin://')
  })

  test('editing surrounding text moves the range; editing the tab reference drops its stale metadata', () => {
    const row = tab(), reference = browserTabReference(row)
    const text = `${reference.value} inspect`
    const tokens = normalizeComposerReferences(text, [{ ...reference, range: { start: 0, end: reference.value.length } }])
    const moved = syncComposerReferences(text, `please ${text}`, tokens)
    expect(moved[0].range).toEqual({ start: 7, end: 7 + reference.value.length })
    expect(moved[0].browserTab).toEqual(row)
    // Retargeting the link drops the stale snapshot; the edited link text still
    // names an exact tab, so the chip comes back from the text alone.
    const edited = text.replace('tabId=42', 'tabId=43')
    const rescanned = normalizeComposerReferences(edited, [])
    expect(rescanned).toHaveLength(1)
    expect(rescanned[0].browserTab?.tabId).toBe('43')
    expect(rescanned[0].browserTab?.lastOpened).toBe(0)
    expect(syncComposerReferences(text, edited, tokens)).toEqual(rescanned)
  })

  test('an authored submission keeps exact browser snapshot, whitespace and reference ranges', () => {
    const row = tab(), reference = browserTabReference(row)
    const text = `\n  ${reference.value} inspect  `
    const token = { ...reference, range: { start: 3, end: 3 + reference.value.length } }
    const references = normalizeComposerReferences(text, [token])
    expect(references).toHaveLength(1)
    expect(references[0].range).toEqual({ start: 3, end: 3 + reference.value.length })
    expect(references[0].browserTab).toEqual(row)
    expect(text.slice(references[0].range.start, references[0].range.end)).toBe(reference.value)
    expect(token.range.start).toBe(3)
  })

  test('rejects mismatched stored snapshots and token links instead of silently changing the target', () => {
    const row = tab(), reference = browserTabReference(row)
    const token = { ...reference, range: { start: 0, end: reference.value.length } }
    // A mismatched stored snapshot is rejected, but the link text itself still
    // names an exact tab, so the chip is restored from the text with the
    // snapshot the link carries rather than the rejected one.
    for (const stale of [{ ...row, title: 'Changed' }, { ...row, tabId: '43' }]) {
      const restored = normalizeComposerReferences(reference.value, [{ ...token, browserTab: stale }])
      expect(restored).toHaveLength(1)
      // The link carries no friendly browser name or open time, so the
      // restored snapshot falls back to the instance id.
      expect(restored[0].browserTab).toEqual({ ...row, lastOpened: 0, browserName: row.browserId })
    }
    expect(normalizeBrowserTabMention({ ...row, mention: row.mention + '&extra=1' })).toBeNull()
  })
})

describe('browser tab favicons', () => {
  test('accepts only bounded image data with canonical base64 padding', () => {
    expect(safeBrowserTabFavicon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(safeBrowserTabFavicon('data:image/avif;base64,AA==')).toBe('data:image/avif;base64,AA==')
    for (const unsafe of ['https://example.com/favicon.ico', 'file:///tmp/favicon.png', 'javascript:alert(1)', 'data:text/html;base64,AAAA',
      'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAA', 'data:image/png;base64,AAAA===', `data:image/png;base64,${'A'.repeat(16_384)}`]) {
      expect(safeBrowserTabFavicon(unsafe)).toBeUndefined()
    }
  })

  test('a missing or unsafe favicon renders the existing browser icon without making a favicon request', () => {
    for (const value of [undefined, 'https://example.com/favicon.ico']) {
      const html = renderToStaticMarkup(<BrowserTabIcon faviconUrl={value} />)
      expect(html).toContain('<svg')
      expect(html).not.toContain('<img')
      expect(browserTabIconHtml(value)).not.toContain('<img')
    }
    expect(renderToStaticMarkup(<BrowserTabIcon faviconUrl="data:image/png;base64,AAAA" />)).toContain('data:image/png;base64,AAAA')
  })

  test('HTML-backed composer and history chips fall back when decoding fails, without inline scripts', () => {
    const handlers = new Map<string, (event: any) => void>()
    const document = { addEventListener: (name: string, callback: any) => handlers.set(name, callback), removeEventListener: (name: string) => handlers.delete(name) }
    const cleanup = installBrowserTabFaviconFallback(document as unknown as Document)
    const fallback = { hidden: false }
    const image = { hidden: true, matches: () => true, parentElement: { querySelector: () => fallback } }
    handlers.get('load')!({ type: 'load', target: image })
    expect(image.hidden).toBe(false)
    expect(fallback.hidden).toBe(true)
    handlers.get('error')!({ type: 'error', target: image })
    expect(image.hidden).toBe(true)
    expect(fallback.hidden).toBe(false)
    expect(browserTabIconHtml('data:image/png;base64,AAAA')).not.toContain('onerror=')
    cleanup()
    expect(handlers.size).toBe(0)
  })
})
