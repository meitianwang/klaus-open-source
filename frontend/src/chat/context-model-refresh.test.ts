import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { contextUsageEn, contextUsageZh } from '../i18n/context-usage-messages'
import { nextModelUpdate } from './model-inference'
import vectors from '../../../contracts/vectors/context-statistics-vectors.json'
import { contextStats } from '../../../main/sessions/context-stats'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true)
const names = new Set(['contextUsageView', 'ctxPieSvg', 'renderContextChip', 'hideCtxPop', 'scheduleShowCtxPop', 'positionCtxPop', 'ensureCtxPop',
  'showCtxPop', 'renderContextPanel', 'fetchContextStats', 'refreshContextAfterModelUpdate', 'refreshContextStatsThrottled'])
const declarations = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text || ''))
const listener = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'handleChatEvent') as ts.FunctionDeclaration
const body = listener.body!
const refreshIndex = body.statements.findIndex(statement => statement.getText(parsed).includes('refreshContextAfterModelUpdate('))
if (refreshIndex < 0) throw new Error('Model acknowledgements must refresh context in the chat event listener')
const listenerPrefix = body.statements.slice(0, refreshIndex + 1).map(statement => statement.getText(parsed)).join('\n')
const bindings = parsed.statements.find(statement => ts.isBlock(statement)
  && statement.getText(parsed).includes("const ctxChipEl = document.getElementById('ctx-usage-chip')"))!
const code = ts.transpileModule(`
  let ctxPopEl = null, ctxPopShowTimer = null;
  ${declarations.map(statement => statement.getText(parsed)).join('\n')}
  ${bindings.getText(parsed)}
  ({ fetchContextStats, renderContextPanel, showCtxPop, refreshContextStatsThrottled,
     budget: () => budgetCapUsd,
     onEvent: event => { ${listenerPrefix} } })
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function deferred() {
  let resolve!: (value: any) => void
  let reject!: (error: Error) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(deferBudgets = false) {
  const requests: Array<ReturnType<typeof deferred> & { sessionId: string }> = []
  const budgets: Array<ReturnType<typeof deferred>> = []
  const ctxPanel = { sessions: new Map(), inflight: new Map(), pending: new Map(), loading: new Set() }
  const streams = new Map<string, { modelUpdate: ReturnType<typeof nextModelUpdate> }>()
  const retired = new Set<string>()
  const timers = new Map<number, { run: () => void; due: number }>()
  let timerId = 0, renders = 0, now = 0
  const target = () => {
    const handlers = new Map<string, Array<(event: any) => void>>()
    return {
      addEventListener: (name: string, handler: (event: any) => void) => {
        if (!handlers.has(name)) handlers.set(name, [])
        handlers.get(name)!.push(handler)
      },
      dispatch: (name: string, event: any = {}) => handlers.get(name)?.forEach(handler => handler(event)),
    }
  }
  const element = () => ({ ...target(), hidden: true, innerHTML: '', className: '', id: '', style: {} as Record<string, string>,
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) { this.attributes.set(name, value) },
    removeAttribute(name: string) { this.attributes.delete(name) },
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 200, top: 500, bottom: 512, width: 12, height: 12 }),
  })
  const chip = element(), popovers: ReturnType<typeof element>[] = []
  const window = { ...target(), currentSessionId: 'active', currentLang: 'en', innerWidth: 1000, innerHeight: 800 }
  const document = { ...target(), getElementById: () => chip, createElement: element,
    body: { appendChild: (el: any) => popovers.push(el) } }
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.run() }
  }
  const getSessionStream = (id: string) => {
    if (!streams.has(id)) streams.set(id, { modelUpdate: null })
    return streams.get(id)!
  }
  const api = runInNewContext(code, {
    ctxPanel, window, busy: false, budgetCapUsd: 0, commandStateListeners: new Set(),
    document,
    getSessionStream, isSessionStreamRetired: (id: string) => retired.has(id), isStoppedTurnFrame: () => false,
    ingestChatFrameEvent: (event: any) => {
      const stream = getSessionStream(event.sessionId)
      stream.modelUpdate = nextModelUpdate(stream.modelUpdate, event)
    },
    userInterruptedSessions: new Set(), isRunActivityEvent: () => false,
    contextPieSvg: (percentage: number) => `<svg data-used-percent="${percentage}"/>`, escapeHtml: String,
    tt: (key: string) => (window.currentLang === 'zh' ? contextUsageZh : contextUsageEn)[key as keyof typeof contextUsageEn] || key,
    refreshBudgetBanner: () => { renders++ }, console: { warn() {} },
    clearTimeout: (id: number) => timers.delete(id), setTimeout: (run: () => void, delay: number) => { timers.set(++timerId, { run, due: now + delay }); return timerId },
    klausApi: { engine: { contextStats: (sessionId: string) => {
      const request = { ...deferred(), sessionId }; requests.push(request); return request.promise
    } }, settings: { kv: { get: () => {
      if (!deferBudgets) return Promise.resolve(0)
      const read = deferred(); budgets.push(read); return read.promise
    } } } },
  }) as { fetchContextStats: (id: string) => Promise<any>; renderContextPanel: () => void; showCtxPop: () => void;
    onEvent: (event: any) => void; refreshContextStatsThrottled: (id: string) => void; budget: () => number }
  const stats = (rawMaxTokens: number) => contextStats({ context: {
    totalTokens: vectors.modelRefresh.tokens, contextWindow: rawMaxTokens,
    outputReserveTokens: rawMaxTokens * 0.05, compactThresholdTokens: rawMaxTokens * 0.9,
  } })
  ctxPanel.sessions.set('active', stats(vectors.modelRefresh.previousWindow))
  const update = (status: string, changeId = 'new', preferenceRevision = 1, sessionId = 'active', revision = preferenceRevision) =>
    api.onEvent({ type: 'model_update', sessionId, status, changeId, preferenceRevision, revision })
  return { ...api, ctxPanel, requests, budgets, retired, timers, window, document, advance, chip, popovers, stats, update, renders: () => renders }
}

const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

describe('context refresh on model publication', () => {
  test('an open popover changes from the previous window to the acknowledged model window', async () => {
    const f = fixture()
    f.renderContextPanel(); f.showCtxPop()
    expect(f.popovers[0].innerHTML).toContain('200k / 475k')
    f.update('preparing')
    expect(f.requests).toHaveLength(0)
    f.update('ready')
    f.requests[0].resolve(f.stats(vectors.modelRefresh.targetWindow)); await settle()
    expect(f.popovers[0].hidden).toBe(false)
    expect(f.popovers[0].innerHTML).toContain('200k / 243k')
    expect(f.popovers[0].innerHTML).toContain('82%')
  })

  test('a late previous-model response cannot replace the new context snapshot', async () => {
    const f = fixture(), old = f.fetchContextStats('active')
    f.update('ready')
    f.requests[1].resolve(f.stats(256000)); await settle()
    f.requests[0].resolve(f.stats(500000)); await old
    expect(f.ctxPanel.sessions.get('active').rawMaxTokens).toBe(256000)
  })

  test('a retired read cannot clear the new in-flight request or its loading state', async () => {
    const f = fixture(), old = f.fetchContextStats('active')
    f.update('ready')
    const current = f.ctxPanel.inflight.get('active')
    f.requests[0].resolve(f.stats(500000)); await old
    expect(f.ctxPanel.inflight.get('active')).toBe(current)
    expect(f.ctxPanel.loading.has('active')).toBe(true)
    f.requests[1].resolve(f.stats(256000)); await settle()
    expect(f.ctxPanel.loading.has('active')).toBe(false)
  })

  test('superseded acknowledgements and duplicate ready events do not trigger reads', async () => {
    const f = fixture()
    f.update('preparing', 'first', 1); f.update('preparing', 'second', 2)
    f.update('ready', 'first', 1)
    expect(f.requests).toHaveLength(0)
    f.update('ready', 'second', 2); f.update('ready', 'second', 2)
    expect(f.requests).toHaveLength(1)
    f.requests[0].resolve(f.stats(256000)); await settle()
  })

  test('a model acknowledgement cancels a pending debounced read', async () => {
    const f = fixture()
    f.refreshContextStatsThrottled('active')
    expect(f.timers.size).toBe(1)
    f.update('ready')
    expect(f.timers.size).toBe(0)
    expect(f.requests).toHaveLength(1)
    f.requests[0].resolve(f.stats(256000)); await settle()
  })

  test('background acknowledgements refresh their cache without repainting the visible conversation', async () => {
    const f = fixture()
    f.renderContextPanel(); f.showCtxPop()
    const visible = f.popovers[0].innerHTML
    f.update('ready', 'background-change', 1, 'background')
    expect(f.requests[0].sessionId).toBe('background')
    f.requests[0].resolve(f.stats(256000)); await settle()
    expect(f.ctxPanel.sessions.get('background').rawMaxTokens).toBe(256000)
    expect(f.ctxPanel.sessions.get('active').rawMaxTokens).toBe(500000)
    expect(f.popovers[0].innerHTML).toBe(visible)
    f.window.currentSessionId = 'background'; f.renderContextPanel(); f.showCtxPop()
    expect(f.popovers[0].innerHTML).toContain('243k')
  })

  test('retiring and reopening a session does not admit the old response', async () => {
    const f = fixture(), old = f.fetchContextStats('active')
    f.retired.add('active'); f.ctxPanel.sessions.delete('active'); f.ctxPanel.inflight.delete('active')
    f.retired.delete('active')
    const current = f.fetchContextStats('active')
    f.requests[1].resolve(f.stats(256000)); await current
    f.requests[0].resolve(f.stats(500000)); await old
    expect(f.ctxPanel.sessions.get('active').rawMaxTokens).toBe(256000)
  })

  test('a failed refresh keeps the last measured context', async () => {
    const f = fixture()
    f.update('ready')
    f.requests[0].reject(new Error('session query unavailable')); await settle()
    expect(f.ctxPanel.sessions.get('active').rawMaxTokens).toBe(500000)
    expect(f.ctxPanel.inflight.size).toBe(0)
    expect(f.ctxPanel.loading.size).toBe(0)
  })

  test('a superseded settings response cannot restore an old spend limit', async () => {
    const f = fixture(true), old = f.fetchContextStats('active')
    f.update('ready')
    f.requests[1].resolve(f.stats(256000)); f.budgets[1].resolve(100); await settle()
    expect(f.budget()).toBe(100)
    f.requests[0].resolve(f.stats(500000)); f.budgets[0].resolve(5); await old
    expect(f.budget()).toBe(100)
  })

  test('a response cannot rehydrate a retired conversation', async () => {
    const f = fixture(), read = f.fetchContextStats('active')
    f.retired.add('active'); f.ctxPanel.sessions.delete('active')
    f.requests[0].resolve(f.stats(256000)); await read
    expect(f.ctxPanel.sessions.has('active')).toBe(false)
    expect(f.chip.hidden).toBe(true)
  })
})


describe('usable context usage', () => {
  for (const vector of vectors.usageDisplay) {
    test(vector.name, () => {
      const f = fixture()
      f.ctxPanel.sessions.set('active', contextStats(vector.input))
      f.renderContextPanel(); f.showCtxPop()
      expect(f.popovers[0].innerHTML).toContain(vector.tokensText + ' tokens used')
      expect(f.popovers[0].innerHTML).toContain(`${vector.percentageText} full`)
      expect(f.chip.innerHTML).toContain(`data-used-percent="${vector.percentage}"`)
    })
  }

  test('zero usable capacity hides the display even when raw capacity is positive', () => {
    const f = fixture()
    f.ctxPanel.sessions.set('active', contextStats({ totalTokens: 0, contextWindow: 500000, outputReserveTokens: 500000 }))
    f.renderContextPanel(); f.showCtxPop()
    expect(f.chip.hidden).toBe(true)
    expect(f.popovers).toHaveLength(0)
  })
})


describe('context indicator interaction', () => {
  test('hover waits before opening and leaving cancels the pending tooltip', () => {
    const f = fixture()
    f.renderContextPanel(); f.chip.dispatch('mouseenter')
    f.advance(vectors.indicator.hoverDelayMs - 1)
    expect(f.popovers).toHaveLength(0)
    f.chip.dispatch('mouseleave'); f.advance(1)
    expect(f.popovers).toHaveLength(0)
    f.chip.dispatch('mouseenter'); f.advance(vectors.indicator.hoverDelayMs)
    expect(f.popovers[0].hidden).toBe(false)
    expect(f.popovers[0].attributes.get('role')).toBe('tooltip')
    expect(f.chip.attributes.get('aria-describedby')).toBe('ctx-usage-tooltip')
    f.chip.dispatch('mouseleave')
    expect(f.popovers[0].hidden).toBe(true)
    expect(f.chip.attributes.has('aria-describedby')).toBe(false)
  })

  test('click dismisses without requesting a context refresh', () => {
    const f = fixture()
    f.renderContextPanel(); f.showCtxPop(); f.chip.dispatch('click')
    expect(f.popovers[0].hidden).toBe(true)
    expect(f.requests).toHaveLength(0)
    expect(f.timers.size).toBe(0)
  })

  for (const event of ['escape', 'blur']) {
    test(`${event} cancels both pending and visible details`, () => {
      const f = fixture()
      const dismiss = () => event === 'escape' ? f.document.dispatch('keydown', { key: 'Escape' }) : f.window.dispatch('blur')
      f.renderContextPanel(); f.chip.dispatch('mouseenter'); dismiss(); f.advance(200)
      expect(f.popovers).toHaveLength(0)
      f.showCtxPop(); dismiss()
      expect(f.popovers[0].hidden).toBe(true)
    })
  }

  for (const vector of vectors.indicator.status) {
    for (const language of ['en', 'zh'] as const) {
      test(`${vector.name} in ${language}`, () => {
        const f = fixture()
        f.window.currentLang = language
        f.ctxPanel.sessions.set('active', { tokens: vector.tokens, maxTokens: vector.capacity })
        f.renderContextPanel(); f.showCtxPop()
        const html = f.popovers[0].innerHTML
        expect(html).toContain(vector[language])
        expect(html.includes('ctx-pop-status-full')).toBe(vector.muted)
        expect(html).not.toContain('<button')
        expect(f.chip.attributes.get('aria-label')).toContain(`${vector.percent}%`)
      })
    }
  }

  test('a small measured usage is not inflated to a minimum visible fraction', () => {
    const f = fixture()
    f.ctxPanel.sessions.set('active', { tokens: 1, maxTokens: 1000 })
    f.renderContextPanel(); f.showCtxPop()
    expect(f.chip.innerHTML).toContain('data-used-percent="0.1"')
    expect(f.popovers[0].innerHTML).toContain('0% used (100% left)')
  })

  test('language changes update visible details and the accessible name without a new read', () => {
    const f = fixture()
    f.renderContextPanel(); f.showCtxPop()
    expect(f.popovers[0].innerHTML).toContain('Context window:')
    expect(f.chip.attributes.get('aria-label')).toBe('Context usage: 42%')
    f.window.currentLang = 'zh'; f.window.dispatch('klaus:lang-change')
    expect(f.popovers[0].innerHTML).toContain('背景信息窗口：')
    expect(f.popovers[0].innerHTML).toContain('已用 200k 标记，共 475k')
    expect(f.chip.attributes.get('aria-label')).toBe('上下文用量：42%')
    expect(f.requests).toHaveLength(0)
  })

  test('invalid measurements hide a previously visible indicator and tooltip', () => {
    for (const stats of [{ tokens: -1, maxTokens: 1000 }, { maxTokens: 1000 },
      { tokens: NaN, maxTokens: 1000 }, { tokens: 1, maxTokens: Infinity }]) {
      const f = fixture()
      f.renderContextPanel(); f.showCtxPop()
      f.ctxPanel.sessions.set('active', stats); f.renderContextPanel()
      expect(f.chip.hidden).toBe(true)
      expect(f.popovers[0].hidden).toBe(true)
      expect(f.chip.attributes.has('aria-label')).toBe(false)
    }
  })

  test('open details follow layout changes and stay inside viewport edges', () => {
    const f = fixture()
    f.renderContextPanel(); f.showCtxPop()
    f.popovers[0].getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 68, width: 176, height: 68 })
    f.chip.getBoundingClientRect = () => ({ left: 990, top: 500, bottom: 512, width: 12, height: 12 })
    f.window.dispatch('scroll')
    expect(f.popovers[0].style.left).toBe('816px')
    expect(f.popovers[0].style.top).toBe('428px')
    expect(f.popovers[0].hidden).toBe(false)
    f.chip.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 12, width: 12, height: 12 })
    f.window.dispatch('resize')
    expect(f.popovers[0].style.left).toBe('8px')
    expect(f.popovers[0].style.top).toBe('16px')
  })
})
