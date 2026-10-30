import { strict as assert } from 'node:assert'
import { describe, it as test } from 'node:test'
import { RunPreview, RUN_PREVIEW_TOOL_SPEC } from '../main/browser/run-preview'
import { BrowserError } from '../main/browser/types'

function fixture() {
  let revision = 4
  let current = 's1'
  let created = 0
  let navigated = 0
  let failNext = false
  const pages = new Map<string, { id: string; owner: string; url: string }>()
  const changed: string[] = []
  const browser = {
    get conversationId() { return current },
    get focusRevision() { return revision },
    assertNavigation(value: unknown) {
      if (typeof value !== 'string') throw new BrowserError('invalid_request', 'A URL is required.')
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol)) throw new BrowserError('refused_by_policy', 'Unsupported URL.')
      return url.href
    },
    async createPreviewTab(sessionId: string) {
      const page = { id: `iab-${++created}`, owner: sessionId, url: 'about:blank' }
      pages.set(page.id, page)
      return page
    },
    async navigate(page: { id: string; url: string }, url: string) {
      navigated++
      if (failNext) { failNext = false; throw new Error('Connection refused') }
      page.url = url
    },
    page(sessionId: string, id: string) {
      const page = pages.get(id)
      if (!page || page.owner !== sessionId) throw new BrowserError('not_found', 'No such tab.')
      return page
    },
  }
  const preview = new RunPreview(browser as any, (sessionId, callId) => changed.push(`${sessionId}:${callId}`))
  return { preview, browser, pages, changed, setFail: () => { failNext = true }, switchTo: (id: string) => { current = id; revision++ }, get created() { return created }, get navigated() { return navigated } }
}

const scope = { sessionId: 's1', toolCallId: 'call-1', focusRevision: 4 }
const args = { url: 'http://127.0.0.1:3210/', name: 'Local app' }

describe('run_preview host tool', () => {
  test('registers a real tool with an explicit URL and optional name', () => {
    const spec = RUN_PREVIEW_TOOL_SPEC as { name: string; inputSchema: { required: string[] } }
    assert.equal(spec.name, 'run_preview')
    assert.deepEqual(spec.inputSchema.required, ['url'])
  })

  test('creates one session-owned background page without selecting it', async () => {
    const f = fixture()
    const result = await f.preview.start(args, 's1', 'call-1', () => {}) as any
    assert.equal(result.success, true)
    assert.equal(f.created, 1)
    assert.deepEqual(
      (({ url, name, tabId, status }) => ({ url, name, tabId, status }))(f.preview.state(scope)),
      { url: args.url, name: args.name, tabId: 'iab-1', status: 'ready' },
    )
    await f.preview.start(args, 's1', 'call-1', () => {})
    await f.preview.start({ url: args.url }, 's1', 'call-2', () => {})
    assert.equal(f.preview.state({ ...scope, toolCallId: 'call-2' }).name, args.url)
    assert.equal(f.created, 1)
    assert.equal(f.navigated, 1)
  })

  test('rejects untrusted URLs, conflicting calls and stale or foreign scope', async () => {
    const f = fixture()
    await assert.rejects(f.preview.start({ ...args, url: 'file:///tmp/a' }, 's1', 'bad', () => {}))
    await assert.rejects(f.preview.start({ ...args, url: 'javascript:alert(1)' }, 's1', 'bad', () => {}))
    await assert.rejects(f.preview.start({ ...args, url: 'https://user:secret@example.com/' }, 's1', 'bad', () => {}))
    assert.equal(f.created, 0)
    await f.preview.start(args, 's1', 'call-1', () => {})
    await assert.rejects(f.preview.start({ ...args, url: 'https://example.com/' }, 's1', 'call-1', () => {}))
    assert.throws(() => f.preview.state({ ...scope, sessionId: 's2' }))
    f.switchTo('s2')
    assert.throws(() => f.preview.state(scope))
    await assert.rejects(f.preview.open({ ...scope, ...args }))
  })

  test('retries a failed navigation without rerunning the tool', async () => {
    const f = fixture()
    f.setFail()
    const result = await f.preview.start(args, 's1', 'call-1', () => {}) as any
    assert.equal(result.success, false)
    assert.equal(f.preview.state(scope).status, 'failed')
    assert.equal(f.preview.state(scope).error, 'Connection refused')
    const retry = await f.preview.retry(scope)
    assert.equal(retry.status, 'ready')
    assert.equal(retry.tabId, 'iab-1')
    assert.equal(f.created, 1)
    assert.equal(f.navigated, 2)
  })

  test('a closed page can be recreated only by an explicit open; historical state never opens it', async () => {
    const f = fixture()
    await f.preview.start(args, 's1', 'call-1', () => {})
    f.pages.delete('iab-1')
    assert.equal(f.preview.state(scope).status, 'failed')
    assert.equal(f.created, 1)
    const reopened = await f.preview.open({ ...scope, ...args })
    assert.equal(reopened.status, 'ready')
    assert.equal(reopened.tabId, 'iab-2')
    assert.equal(f.created, 2)
    f.preview.releaseSession('s1')
    assert.throws(() => f.preview.state(scope))
    const fromHistory = await f.preview.open({ ...scope, ...args })
    assert.equal(fromHistory.status, 'ready')
    assert.equal(fromHistory.tabId, 'iab-3')
    assert.equal(f.created, 3)
  })
})
