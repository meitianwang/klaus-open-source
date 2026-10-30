import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import vectors from '../../../../contracts/vectors/side-task-feedback-vectors.json'
import deletionVectors from '../../../../contracts/vectors/session-deletion-vectors.json'
import routingVectors from '../../../../contracts/vectors/side-task-quote-routing-vectors.json'
import * as quoteRouting from '../../../../contracts/side-task-quotes'
import { createPanelTabsFixture } from './panel-tabs-quote-routing.test'
import { createSideComposerFixture, deferred, settle } from '../side-composer-drafts.test'
import { chatRunnerStubs } from '../test-support/chat-runner-stubs'

const script = transpileModule(`${chatRunnerStubs}${readFileSync(new URL('./side-tasks.ts', import.meta.url), 'utf8')}`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

type Task = { id: string; parentSessionId: string; createdAt: number; expiresAt: number; title?: string;
  initialTitleIndex?: number | null; sideTaskStatus?: 'starting' | 'active' | 'closing' | 'failed' }
const task = (id: string, parentSessionId = 'main', patch: Partial<Task> = {}): Task => ({ id, parentSessionId, createdAt: 1, expiresAt: Date.now() + 60_000, ...patch })

class Element {
  hidden = false
  textContent = ''
  private attributes = new Map<string, string>()
  private classes = new Set<string>()
  classList = { contains: (name: string) => this.classes.has(name), add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  addEventListener() {}
}

function fixture(options: { loaded?: boolean | null; tasks?: ReturnType<typeof task>[] } = {}) {
  const composer = createSideComposerFixture()
  const elements = new Map<string, Element>()
  for (const id of ['artifacts-panel', 'side-chat-panel', 'side-messages', 'side-composer-host', 'side-chat-empty', 'side-chat-expired', 'side-chat-recreate', 'side-task-new']) elements.set(id, new Element())
  elements.get('artifacts-panel')!.classList.add('collapsed')
  const events = new Map<string, Array<(event: any) => void>>()
  const calls = { history: [] as string[], list: [] as string[], create: [] as string[], close: [] as string[], touch: [] as string[], opens: 0 }
  const messages: string[] = []
  let rows = options.tasks || []
  const api = { session: {
    listSideTasks: async (id: string) => { calls.list.push(id); return rows },
    history: async (id: string) => { calls.history.push(id); return { messages: [{ role: 'user' }] } },
    createSideTask: async (id: string, options?: { initialTitleIndex: number }) => { calls.create.push(id); return task('created', id, { initialTitleIndex: options?.initialTitleIndex }) },
    closeSideTask: async (id: string) => { calls.close.push(id); return { ok: true } },
    touchSideTask: async (id: string) => { calls.touch.push(id); return { ok: true } },
  } }
  const window: any = Object.assign(composer.window, {
    currentSessionId: 'main' as string | null,
    klaus: api,
    tt: (key: string) => key,
    getCurrentSessionId: () => window.currentSessionId,
    getKnownSessionInfo: () => ({ engine: 'klaus' }),
    klausSideTaskHasUserMessage: () => options.loaded ?? null,
    openArtifactsPanel: (mode: string) => { calls.opens++; elements.get('artifacts-panel')!.setAttribute('data-mode', mode); elements.get('artifacts-panel')!.classList.remove('collapsed') },
    klausDialog: { alert: (message: string) => { messages.push(message) } },
    addEventListener: (name: string, handler: (event: any) => void) => { events.set(name, [...events.get(name) || [], handler]) },
    setInterval() {},
    KlausSideTasks: undefined as any,
  })
  const panelTabs = createPanelTabsFixture(window, elements.get('artifacts-panel'))
  const state = { get tabs(): Array<{ id: string; title: string; badge: string }> {
    return panelTabs.snapshot().tabs.filter((tab: any) => tab.kind === 'side-task').map((tab: any) => ({ id: tab.key, title: tab.title, badge: tab.badge }))
  }, get active(): string | null { return window.KlausPanelTabs.sideTaskQuotePanels()[0].activeId },
    get bound() { return composer.context.sideSurfaceSessionId }, set bound(id: string | null) { composer.context.sideSurfaceSessionId = id } }
  runInNewContext(script, { window, document: { getElementById: (id: string) => elements.get(id) }, exports: {},
    require: (name: string) => {
      if (name === '../../../../contracts/side-task-quotes') return quoteRouting
      if (name === '../stream-store') return { prepareEphemeralSessionStream() {} }
      throw new Error(`Unexpected side-tasks import: ${name}`)
    } })
  const emit = (name: string, event: any = {}) => { for (const handler of events.get(name) || []) handler(event) }
  return { window, api, calls, state, elements, messages, composer, panelTabs, emit, actions: window.KlausSideTasks,
    setRows: (next: typeof rows) => { rows = next },
    switchTo(id: string | null) { window.currentSessionId = id; emit('klaus:session-change', { detail: { sessionId: id } }) },

  }
}

for (const stage of ['list', 'history'] as const) {
  test(`an abandoned side-task ${stage} failure cannot alert after navigation`, async () => {
    const f = fixture()
    const pending = deferred<any>()
    if (stage === 'list') f.api.session.listSideTasks = id => id === 'deleted' ? pending.promise : Promise.resolve([])
    else f.api.session.history = id => id === 'deleted' ? pending.promise : Promise.resolve({ messages: [] })
    f.switchTo('deleted')
    await settle()
    f.switchTo(null)
    // Even returning to the same ID cannot grant an older listing ownership.
    if (stage === 'list') f.api.session.listSideTasks = async () => []
    else f.api.session.history = async () => ({ messages: [] })
    f.switchTo(stage === 'list' ? 'deleted' : 'other')
    await settle()
    pending.reject(new Error('The conversation was deleted'))
    await settle()
    expect(f.messages).toHaveLength(deletionVectors.navigation.abandonedRefreshAlerts)
  })
}

test('closing a side tab waits for its voice call and retains the tab after a stop failure', async () => {
  const f = fixture({ loaded: true, tasks: [task('side-one')] });
  await f.actions.openFromRail();
  const stopped = deferred<void>();
  const voiceTargets: string[] = [];
  f.window.klausStopVoiceChatForSession = (id: string) => { voiceTargets.push(id); return stopped.promise };
  const closing = f.actions.closeById('side-one');
  await settle();
  expect(voiceTargets).toEqual(['side-one']);
  expect(f.calls.close).toEqual([]);
  stopped.reject(new Error('Voice is still active'));
  const failure = await closing.then(() => null, (error: unknown) => error);
  expect(String(failure)).toContain('Voice is still active');
  expect(f.state.tabs.some(tab => tab.id === 'side-one')).toBe(true);
  f.window.klausStopVoiceChatForSession = async () => {};
  await f.actions.closeById('side-one');
  expect(f.calls.close).toEqual(['side-one']);
});

test('a side-task refresh failure still alerts for the current conversation', async () => {
  const f = fixture()
  f.api.session.listSideTasks = async () => { throw new Error('Current conversation unavailable') }
  f.switchTo('current')
  await settle()
  expect(f.messages).toHaveLength(deletionVectors.navigation.currentRefreshAlerts)
  expect(f.messages[0]).toBe('Current conversation unavailable')
})

test('cold rail entry presents the full composer before listing and coalesces creation without extra labels', async () => {
  const f = fixture()
  const listing = deferred<ReturnType<typeof task>[]>(), fork = deferred<ReturnType<typeof task>>()
  f.api.session.listSideTasks = () => listing.promise
  f.api.session.createSideTask = id => { f.calls.create.push(id); return fork.promise }
  const first = f.actions.openFromRail()
  const repeated = f.actions.openFromRail()
  expect(f.elements.get('artifacts-panel')!.getAttribute('data-mode')).toBe('side-chat')
  expect(f.state.tabs[0].badge).toBe(vectors.pending.badge)
  expect(f.elements.get('side-composer-host')!.hidden).toBe(vectors.pending.composerHidden)
  expect(f.elements.get('side-messages')!.hidden).toBe(vectors.pending.transcriptHidden)
  expect(f.elements.get('side-chat-empty')!.hidden).toBe(vectors.pending.emptyHidden)
  f.composer.setText('A draft while listing')
  f.composer.window.klausSideComposerAddSelection('Quoted passage')
  const draft = f.composer.input.value
  expect(f.composer.button.disabled).toBe(vectors.pending.sendDisabled)
  expect(f.composer.model.disabled).toBe(vectors.pending.modelDisabled)
  const pendingId = f.state.active
  listing.resolve([])
  await settle()
  expect(f.state.tabs.at(-1)!.badge).toBe(vectors.pending.badge)
  expect(f.state.active === pendingId).toBe(vectors.creating.reusesOpeningTab)
  expect(f.composer.input.value).toBe(draft)
  const duplicateCreate = f.actions.create()
  expect(f.calls.create).toHaveLength(vectors.creating.hostCreates)
  fork.resolve(task('created'))
  await Promise.all([first, repeated, duplicateCreate])
  expect(f.state.bound).toBe('created')
  expect(f.state.tabs.map(tab => tab.id)).toEqual(['created'])
  expect(f.elements.get('side-composer-host')!.hidden).toBe(vectors.activated.composerHidden)
  expect(f.composer.input.value).toBe(draft)
  expect(f.composer.quotes()).toEqual(vectors.selection.quotes)
  expect(f.composer.calls.submissions).toHaveLength(vectors.selection.automaticSubmissions)
})

test('an explicit create during rail refresh keeps the pending tab and cannot be replaced by the old listing', async () => {
  const f = fixture({ loaded: true, tasks: [task('one')] })
  await f.actions.refresh('main')
  const listing = deferred<ReturnType<typeof task>[]>(), fork = deferred<ReturnType<typeof task>>()
  f.api.session.listSideTasks = () => listing.promise
  f.api.session.createSideTask = id => { f.calls.create.push(id); return fork.promise }
  const opening = f.actions.openFromRail()
  const pendingId = f.state.tabs.at(-1)!.id
  const creating = f.actions.create()
  expect(f.state.active).toBe(pendingId)
  listing.resolve([task('one')])
  await settle()
  expect(f.state.active).toBe(pendingId)
  expect(f.state.bound).toBeNull()
  fork.resolve(task('created'))
  await Promise.all([opening, creating])
  expect(f.calls.create).toEqual(['main'])
  expect(f.calls.close).toEqual([])
  expect(f.state.bound).toBe('created')
  expect(f.state.tabs.map(tab => tab.id)).toEqual(['one', 'created'])
})

test('an already known active family opens immediately while its listing is still pending', async () => {
  const f = fixture({ loaded: true, tasks: [task('one')] })
  await f.actions.refresh('main')
  await f.actions.activateById('one')
  f.composer.setText('Existing draft')
  const listing = deferred<ReturnType<typeof task>[]>()
  f.api.session.listSideTasks = () => listing.promise
  f.elements.get('artifacts-panel')!.classList.add('collapsed')
  let opened = false
  const opening = f.actions.openFromRail().then(() => { opened = true })
  await settle()
  expect(opened).toBe(true)
  expect(f.state.bound).toBe('one')
  expect(f.composer.input.value).toBe('Existing draft')
  expect(f.state.tabs.map(tab => tab.id)).toEqual(['one'])
  expect(f.elements.get('side-composer-host')!.hidden).toBe(false)
  expect(f.calls.create).toEqual([])
  listing.resolve([task('one')])
  await opening
})

test('a known empty family starts one fork without waiting for another listing', async () => {
  const f = fixture({ loaded: true })
  await f.actions.refresh('main')
  const fork = deferred<ReturnType<typeof task>>()
  f.api.session.createSideTask = id => { f.calls.create.push(id); return fork.promise }
  const first = f.actions.openFromRail(), repeated = f.actions.openFromRail()
  expect(f.calls.list).toEqual(['main'])
  expect(f.calls.create).toEqual(['main'])
  fork.resolve(task('created'))
  await Promise.all([first, repeated])
  expect(f.state.bound).toBe('created')
})

test('cold listing promotion merges the existing saved draft and pending quotes without seeding the parent source', async () => {
  const f = fixture({ loaded: true })
  const modelReads: Array<boolean | undefined> = []
  f.composer.context.mainModelCatalogCache.set('other', [{ value: 'other:fixture', label: 'Other model' }])
  f.composer.context.klausApi.session.getMainModel = async (id, options) => {
    f.composer.calls.models.push(id)
    modelReads.push(options?.resolve)
    return { source: 'other', mode: 'other:fixture', resolvedMode: 'other:fixture' }
  }
  f.composer.window.klausSideComposerBind('one')
  f.composer.setText('Existing draft')
  f.composer.window.klausSideComposerAddSelection('Existing quote')
  const existing = f.composer.input.value
  f.composer.window.klausSideComposerBind(null)
  const listing = deferred<ReturnType<typeof task>[]>()
  f.api.session.listSideTasks = () => listing.promise
  const opening = f.actions.openFromRail()
  f.composer.setText('Pending draft')
  f.composer.window.klausSideComposerAddSelection('Quoted passage')
  const pending = f.composer.input.value
  const quote = f.composer.context.sidePendingFiles.at(-1)!
  const oldStart = (quote.range as { start: number }).start
  const historyResets = f.composer.calls.historyResets
  listing.resolve([task('one')])
  await opening
  await settle()
  expect(f.composer.input.value).toBe(`${existing}\n${pending}`)
  expect(f.composer.quotes()).toEqual(['Existing quote', 'Quoted passage'])
  expect((quote.range as { start: number }).start).toBe(oldStart + existing.length + 1)
  expect(f.composer.api.sideComposedInputText()).toContain('Existing draft')
  expect(f.composer.api.sideComposedInputText()).toContain('Pending draft')
  expect(f.composer.calls.historyResets).toBe(historyResets + 1)
  expect(modelReads[0]).toBe(false)
  expect(new Set(f.composer.calls.remembered)).toEqual(new Set(['one:other']))
  expect(f.composer.model.value).toBe('other:fixture')
  expect(f.composer.calls.submissions).toEqual([])
  expect(f.calls.create).toEqual([])
  expect(f.state.bound).toBe('one')
})

for (const cancellation of ['close', 'switch', 'collapse'] as const) {
  test(`${cancellation} during creation closes the late task and does not bind its composer`, async () => {
    const f = fixture({ loaded: true })
    await f.actions.refresh('main')
    const fork = deferred<ReturnType<typeof task>>()
    f.api.session.createSideTask = id => { f.calls.create.push(id); return fork.promise }
    const pending = f.actions.askWithSelection('Quoted passage')
    const pendingId = f.state.active!
    if (cancellation === 'close') await f.actions.closeById(pendingId)
    if (cancellation === 'switch') { f.switchTo('other'); await settle() }
    if (cancellation === 'collapse') f.elements.get('artifacts-panel')!.classList.add('collapsed')
    const opens = f.calls.opens
    fork.resolve(task('late'))
    expect(await pending).toBe(false)
    expect(f.calls.close).toEqual(['late'])
    expect(f.state.bound).toBe(vectors.cancelled.activeSideId)
    expect(f.calls.opens).toBe(opens)
    expect(f.composer.quotes()).toEqual([])
    expect(f.composer.context.sideDrafts.has(pendingId)).toBe(false)
  })
}

test('tab activation binds synchronously and ignores an older delayed renewal failure', async () => {
  const f = fixture({ loaded: true, tasks: [task('one'), task('two')] })
  await f.actions.refresh('main')
  const renewal = deferred<{ ok: boolean }>()
  f.api.session.touchSideTask = id => { f.calls.touch.push(id); return id === 'one' ? renewal.promise : Promise.resolve({ ok: true }) }
  const first = f.actions.activateById('one')
  expect(f.state.bound).toBe('one')
  expect(f.elements.get('side-composer-host')!.hidden).toBe(false)
  await first
  await f.actions.activateById('two')
  renewal.resolve({ ok: false })
  await settle()
  expect(f.state.bound).toBe('two')
  expect(f.actions.find('one')).not.toBeNull()
  expect(f.messages).toEqual([])
})

test('an activation failure after a session switch cannot restore the previous family', async () => {
  const f = fixture({ loaded: true, tasks: [task('one')] })
  await f.actions.refresh('main')
  const activation = deferred<void>()
  f.window.klausSideSurfaceActivate = (id: string) => { f.state.bound = id; return activation.promise }
  const active = f.actions.activateById('one')
  f.setRows([])
  f.switchTo('other')
  await settle()
  activation.reject(new Error('old activation failed'))
  await active
  expect(f.state.bound).toBeNull()
  expect(f.state.active).toBeNull()
  expect(f.messages).toEqual([])
})

test('the gate reuses loaded user history and latches a successful fallback without repeating full history', async () => {
  const loaded = fixture({ loaded: true })
  await loaded.actions.refresh('main')
  await loaded.actions.refresh('main')
  expect(loaded.calls.history).toHaveLength(vectors.eligibility.loadedHistoryReads)
  expect(loaded.actions.canCreate()).toBe(true)
  const fallback = fixture()
  await fallback.actions.refresh('main')
  await fallback.actions.refresh('main')
  expect(fallback.calls.history).toHaveLength(vectors.eligibility.positiveFallbackReads)
  const empty = fixture({ loaded: false })
  await empty.actions.refresh('main')
  expect(empty.actions.canCreate()).toBe(false)
  empty.actions.onEngineEvent({ type: 'user_message', sessionId: 'main' })
  expect(empty.actions.canCreate()).toBe(true)
  empty.setRows(Array.from({ length: vectors.eligibility.maximumTasks }, (_, index) => task(`task-${index}`)))
  await empty.actions.refresh('main')
  expect(empty.actions.canCreate()).toBe(false)
})

test('a quote handoff only prepares the side draft', async () => {
  const f = fixture({ loaded: true })
  await f.actions.refresh('main')
  expect(await f.actions.askWithSelection('Quoted passage')).toBe(true)
  expect(f.composer.quotes()).toEqual(vectors.selection.quotes)
  expect(f.state.bound).toBe('created')
})

test('a quote handoff inserts its quote immediately while creation is delayed and retains it on promotion', async () => {
  const f = fixture({ loaded: true })
  await f.actions.refresh('main')
  const fork = deferred<ReturnType<typeof task>>()
  f.api.session.createSideTask = id => { f.calls.create.push(id); return fork.promise }
  const quote = f.actions.askWithSelection('Quoted passage')
  expect(f.composer.quotes()).toEqual(vectors.selection.quotes)
  f.composer.setText(f.composer.input.value + 'My follow-up')
  const draft = f.composer.input.value
  expect(f.composer.calls.submissions).toHaveLength(vectors.selection.automaticSubmissions)
  fork.resolve(task('created'))
  expect(await quote).toBe(true)
  expect(f.composer.input.value).toBe(draft)
  expect(f.composer.quotes()).toEqual(vectors.selection.quotes)
})

test('creation failure releases the pending draft and restores a usable previous side tab', async () => {
  const f = fixture({ loaded: true, tasks: [task('one')] })
  await f.actions.refresh('main')
  await f.actions.activateById('one')
  const fork = deferred<ReturnType<typeof task>>()
  f.api.session.createSideTask = () => fork.promise
  const creating = f.actions.create()
  fork.reject(new Error('fork failed'))
  expect(await creating.then(() => '', (error: Error) => error.message)).toBe('fork failed')
  expect(f.state.bound).toBe('one')
  expect(f.state.tabs.map(tab => tab.id)).toEqual(['one'])
  expect(f.elements.get('side-chat-panel')!.getAttribute('aria-busy')).toBe('false')
})

test('ordinary pending entry retains the full composer contract before any quote is added', async () => {
  const f = fixture({ loaded: true })
  await f.actions.refresh('main')
  const fork = deferred<Task>()
  f.api.session.createSideTask = () => fork.promise
  const opening = f.actions.openFromRail()
  expect(f.state.tabs[0].title).toBe(routingVectors.initialTitle.first)
  expect(f.state.tabs[0].badge).toBe(vectors.pending.badge)
  expect(f.elements.get('side-composer-host')!.hidden).toBe(vectors.pending.composerHidden)
  expect(f.composer.button.disabled).toBe(vectors.pending.sendDisabled)
  expect(f.composer.model.disabled).toBe(vectors.pending.modelDisabled)
  expect(f.composer.quotes()).toEqual([])
  f.composer.setText('Unquoted draft')
  fork.resolve(task('created', 'main', { initialTitleIndex: 1 }))
  await opening
  expect(f.composer.input.value).toBe('Unquoted draft')
  expect(f.composer.quotes()).toEqual([])
  expect(f.composer.calls.submissions).toHaveLength(routingVectors.handoff.automaticSubmissions)
})

test('quotes reuse the active real tab, then the actual reordered strip when a non-side tab is active', async () => {
  const f = fixture({ loaded: true, tasks: [task('one'), task('two'), task('three')] })
  await f.actions.refresh('main')
  await f.actions.activateById('two')
  f.composer.setText('Keep this active draft')
  f.panelTabs.move('three', 'one')
  expect(await f.actions.askWithSelection('Active quote')).toBe(true)
  expect(f.state.bound).toBe('two')
  expect(f.composer.input.value).toContain('Keep this active draft')
  expect(f.composer.quotes()).toEqual(['Active quote'])
  f.window.klausSideSurfaceClear()
  f.elements.get('artifacts-panel')!.setAttribute('data-mode', 'workspace')
  f.panelTabs.actions.onModeChanged('workspace')
  expect(f.state.active).toBeNull()
  expect(f.state.tabs.map(tab => tab.id)).toEqual(['three', 'one', 'two'])
  expect(await f.actions.askWithSelection('Ordered quote')).toBe(true)
  expect(f.state.bound).toBe('three')
  expect(f.composer.quotes()).toEqual(['Ordered quote'])
  expect(f.calls.create).toEqual([])
  await f.actions.activateById('two')
  expect(f.composer.quotes()).toEqual(['Active quote'])
})

test('an unavailable active task is skipped and eight live tasks still allow quote reuse', async () => {
  const f = fixture({ loaded: true, tasks: [task('closing', 'main', { sideTaskStatus: 'closing' }),
    task('starting', 'main', { sideTaskStatus: 'starting' }), task('failed', 'main', { sideTaskStatus: 'failed' }),
    ...Array.from({ length: routingVectors.handoff.maximumTasks - 3 }, (_, index) => task(`ready-${index}`, 'main', { sideTaskStatus: 'active' }))] })
  await f.actions.refresh('main')
  await f.actions.activateById('closing')
  expect(f.actions.canCreate()).toBe(false)
  expect(await f.actions.askWithSelection('Reuse at the limit')).toBe(true)
  expect(f.state.bound).toBe('ready-0')
  expect(f.calls.create).toEqual([])
  expect(f.composer.quotes()).toEqual(['Reuse at the limit'])
})

test('quotes arriving during a cold listing and its fork share one pending draft and one creation', async () => {
  const f = fixture({ loaded: true })
  const listing = deferred<Task[]>(), fork = deferred<Task>()
  f.api.session.listSideTasks = () => listing.promise
  f.api.session.createSideTask = id => { f.calls.create.push(id); return fork.promise }
  const opening = f.actions.openFromRail()
  const pendingId = f.state.active!
  f.composer.setText('Keep pending draft')
  const first = f.actions.askWithSelection('During listing')
  expect(f.composer.quotes()).toEqual(['During listing'])
  expect(f.state.tabs.map(tab => tab.id)).toEqual([pendingId])
  listing.resolve([])
  await settle()
  const second = f.actions.askWithSelection('During creation')
  expect(f.state.active).toBe(pendingId)
  expect(f.composer.quotes()).toEqual(['During listing', 'During creation'])
  expect(f.calls.create).toHaveLength(routingVectors.handoff.pendingForks)
  fork.resolve(task('created'))
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  await opening
  expect(f.state.bound).toBe('created')
  expect(f.composer.input.value).toContain('Keep pending draft')
  expect(f.composer.quotes()).toEqual(['During listing', 'During creation'])
  expect(f.composer.calls.submissions).toHaveLength(routingVectors.handoff.automaticSubmissions)
})

test('quoting a pending tab after visiting a non-side panel rebinds and preserves its draft', async () => {
  const f = fixture({ loaded: true })
  await f.actions.refresh('main')
  const fork = deferred<Task>()
  f.api.session.createSideTask = () => fork.promise
  const opening = f.actions.openFromRail()
  f.composer.setText('Saved pending draft')
  f.window.klausSideComposerAddSelection('Saved pending quote')
  f.window.klausSideSurfaceClear()
  f.elements.get('artifacts-panel')!.setAttribute('data-mode', 'workspace')
  f.panelTabs.actions.onModeChanged('workspace')
  const quote = f.actions.askWithSelection('Return quote')
  expect(f.composer.input.value).toContain('Saved pending draft')
  expect(f.composer.quotes()).toEqual(['Saved pending quote', 'Return quote'])
  fork.resolve(task('created'))
  expect(await quote).toBe(true)
  await opening
  expect(f.state.bound).toBe('created')
  expect(f.composer.quotes()).toEqual(['Saved pending quote', 'Return quote'])
})

for (const cancellation of ['close', 'switch'] as const) {
  test(`${cancellation} during queued side creation cancels the target without quoting its request`, async () => {
    const f = fixture({ loaded: true })
    await f.actions.refresh('main')
    const fork = deferred<Task>()
    f.api.session.createSideTask = () => fork.promise
    const opening = f.actions.createForQueued('main')
    await settle()
    const pendingId = f.state.active!
    expect(f.composer.quotes()).toEqual([])
    if (cancellation === 'close') await f.actions.closeById(pendingId)
    else { f.switchTo('other'); await settle() }
    fork.resolve(task('late'))
    expect(await opening).toBeNull()
    expect(f.calls.close).toEqual(['late'])
    expect(f.composer.context.sideDrafts.has(pendingId)).toBe(false)
  })
}

test('queued requests create a fresh side conversation instead of reusing the active draft', async () => {
  const f = fixture({ loaded: true, tasks: [task('existing')] })
  await f.actions.refresh('main')
  await f.actions.activateById('existing')
  f.composer.setText('Preserve this existing draft')
  const fork = deferred<Task>()
  f.api.session.createSideTask = () => fork.promise
  const opening = f.actions.createForQueued('main')
  await settle()
  expect(f.state.active).not.toBe('existing')
  fork.resolve(task('created'))
  expect(await opening).toBe('created')
  expect(f.state.bound).toBe('created')
  expect(f.composer.quotes()).toEqual([])
  await f.actions.activateById('existing')
  expect(f.composer.input.value).toContain('Preserve this existing draft')
})

test('title events update active and inactive tabs immediately and survive a stale in-flight listing', async () => {
  const f = fixture({ loaded: true, tasks: [task('one', 'main', { initialTitleIndex: 1 }), task('two', 'main', { initialTitleIndex: 2 })] })
  await f.actions.refresh('main')
  await f.actions.activateById('one')
  f.panelTabs.move('two', 'one')
  const listing = deferred<Task[]>()
  f.api.session.listSideTasks = () => listing.promise
  const refreshing = f.actions.refresh('main')
  f.actions.onEngineEvent({ sessionId: 'one', type: 'session_title_updated', title: 'Active question' })
  f.actions.onEngineEvent({ sessionId: 'two', type: 'session_title_updated', title: 'Inactive question' })
  expect(f.state.tabs.map(tab => [tab.id, tab.title])).toEqual([['two', 'Inactive question'], ['one', 'Active question']])
  listing.resolve([task('one', 'main', { initialTitleIndex: 1 }), task('two', 'main', { initialTitleIndex: 2 })])
  await refreshing
  expect(f.state.tabs.map(tab => [tab.id, tab.title])).toEqual([['two', 'Inactive question'], ['one', 'Active question']])
  expect(f.actions.find('two').initialTitleIndex).toBeNull()
  f.window.tt = (key: string) => key === 'side_task_untitled' ? 'Localized side chat' : key
  f.emit('klaus:lang-change')
  expect(f.state.tabs.map(tab => tab.title)).toEqual(['Inactive question', 'Active question'])
  f.actions.onEngineEvent({ sessionId: 'unrelated', type: 'session_title_updated', title: 'Unrelated' })
  expect(f.state.tabs).toHaveLength(2)
})

test('a pending title captures the real strip count despite reorder and numbering gaps and remains localized', async () => {
  const f = fixture({ loaded: true, tasks: [task('one', 'main', { initialTitleIndex: 1 }), task('two', 'main', { initialTitleIndex: 7 })] })
  await f.actions.refresh('main')
  f.panelTabs.move('two', 'one')
  const fork = deferred<Task>()
  let captured: { initialTitleIndex: number } | undefined
  f.api.session.createSideTask = (_id, options) => { captured = options; return fork.promise }
  const creating = f.actions.create()
  expect(captured).toEqual({ initialTitleIndex: 3 })
  expect(f.state.tabs.at(-1)!.title).toBe(routingVectors.initialTitle.third)
  f.window.tt = (key: string) => key === 'side_task_untitled' ? 'Localized side chat' : key
  f.emit('klaus:lang-change')
  expect(f.state.tabs.map(tab => tab.title)).toEqual(['Localized side chat 7', 'Localized side chat', 'Localized side chat 3'])
  fork.resolve(task('created', 'main', { initialTitleIndex: 3 }))
  await creating
  expect(f.state.tabs.at(-1)!.title).toBe('Localized side chat 3')
})

test('a new family title arriving before listing or eligibility history survives its default rows', async () => {
  const f = fixture({ tasks: [task('old-side')] })
  await f.actions.refresh('main')
  await f.actions.activateById('old-side')
  const listing = deferred<Task[]>(), history = deferred<{ messages: Array<{ role: string }> }>()
  f.api.session.listSideTasks = id => { f.calls.list.push(id); return listing.promise }
  f.api.session.history = id => { f.calls.history.push(id); return history.promise }
  f.switchTo('other')
  f.actions.onEngineEvent({ sessionId: 'other-one', type: 'session_title_updated', title: 'Before listing' })
  listing.resolve([task('other-one', 'other', { initialTitleIndex: 1 }), task('other-two', 'other', { initialTitleIndex: 2 })])
  await settle()
  expect(f.calls.history).toEqual(['main', 'other'])
  f.actions.onEngineEvent({ sessionId: 'other-two', type: 'session_title_updated', title: 'Before history' })
  history.resolve({ messages: [{ role: 'user' }] })
  await settle()
  expect(f.state.tabs.map(tab => [tab.id, tab.title])).toEqual([['other-one', 'Before listing'], ['other-two', 'Before history']])
  expect(f.state.active).toBeNull()
  expect(f.state.bound).toBeNull()
})
