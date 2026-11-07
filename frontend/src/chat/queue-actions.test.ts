import { createComposerDraft } from './composer/slash-draft'
import { referencesFromEditor as documentReferencesFromEditor } from './composer/resource-reference'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { pendingEntriesFromPrepare } from './composer/sent-message-edit'
import { encodeSelectedTextEnvelope, parseSelectedTextEnvelope } from './selected-text-envelope'
import { GoalSnapshots } from './goals/snapshots'
import { createQueueRemovalRequest, removeQueuedWithReceipt } from '../../bridge/queue-removal'
import { addQueuedWithReceipt } from '../../bridge/queue-addition'

// Execute the production action seams with a durable-queue boundary and UI effects
// substituted. State transitions and rollback decisions remain production code.
const source = ts.createSourceFile('chat.ts', readFileSync(new URL('./chat.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const names = ['asQueuedItem', 'clientQueueFor', 'clientQueueSnapshotFor', 'clientQueueMutationKey',
  'applyClientQueueSnapshot', 'runClientQueueMutation', 'queueRowAnchors', 'removeQueuedFollowUp',
  'restoreQueuedFollowUp', 'deliverQueuedFollowUp', 'buildFollowUpQueueHandlers',
  'loadPendingQueueAdditions', 'persistPendingQueueAdditions', 'forgetPendingQueueAddition', 'takeEditedQueueReinsert',
  'reconcilePendingQueueAdditions', 'recoverRefusedQueueAddition', 'loadEditedQueueReinsert', 'persistQueuedEditDraft',
  'hydrateQueuedEditDrafts', 'queuedPendingFiles']
const productionCode = (names: string[]) => ts.transpileModule([...new Set([...names,
  'persistEditedQueueReinsert', 'setEditedQueueReinsert', 'forgetEditedQueueReinsert', 'reconcileQueuedEdit', 'reconcileQueueTransfer',
  ...source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && node.name?.text === 'clientQueueMutationPending').map(node => node.name!.text),
])].map(name => {
  let node: ts.FunctionDeclaration | undefined
  const visit = (candidate: ts.Node) => {
    if (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) node = candidate
    ts.forEachChild(candidate, visit)
  }
  visit(source)
  if (!node) throw Error(`Missing production queue function: ${name}`)
  return node.getText(source)
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const code = productionCode(names)

type Item = Record<string, any>
type Row = { id: string; item: Item; createdAt: number; pausedReason: string | null; dispatching?: boolean; unconfirmed?: boolean }
type Snapshot = { revision: number; interrupted?: boolean; items: Row[] }
type Call = { method: string; sessionId: string; args: any[] }
type AddMode = 'accept' | 'refuse' | 'uncertain-saved' | 'uncertain-absent' | 'uncertain-unreadable' | 'uncertain-consumed'
type DeliveryMode = 'accept' | 'refuse' | 'uncertain'
const clone = <T,>(value: T): T => structuredClone(value)
const sourceId = 'source-session'
const targetId = 'side-session'
const payload: Item = {
  id: 'moving', displayText: 'Review the attached result', finalText: 'Review the attached result\n\nAttached:\n- /uploads/report.pdf',
  media: [{ type: 'image', path: '/uploads/diagram.png', name: 'diagram.png' }],
  liveAttachments: [{ type: 'image', path: '/uploads/diagram.png', name: 'diagram.png', src: 'blob:original-preview' }, { type: 'file', path: '/uploads/report.pdf', name: 'report.pdf' }],
  selectedTextAttachments: [{ text: 'Selected passage', previewText: 'Selected passage', quoteId: 'quote-one', requestOffset: 3, displayOrder: 1 }],
  pastedCards: [{ text: 'Complete pasted instructions', previewText: 'Complete pasted instructions', requestOffset: 0, displayOrder: 0 }],
  composerReferences: [{ kind: 'file', name: 'workflow.ts', value: 'src/workflow.ts', range: { start: 0, end: 15 } }],
  displayMetadata: { browserTabs: [{ tabId: 'tab-42', url: 'https://example.test/notes', title: 'Notes' }], sentSlashCommand: '/review' },
  sentSlashCommand: { name: 'review', description: 'Review changes' }, source: 'local', editing: false,
}
const makeRow = (id: string, item: Item = { id, displayText: id, finalText: id, media: [], liveAttachments: [] }): Row => ({ id, item: clone(item), createdAt: 100, pausedReason: null })

function renderer() {
  const stores = new Map<string, { revision: number; rows: Row[] }>([
    [sourceId, { revision: 7, rows: [makeRow('before'), makeRow('moving', payload), makeRow('after')] }],
    [targetId, { revision: 0, rows: [] }],
  ])
  const cache = new Map<string, any>()
  const calls: Call[] = []
  const storage = new Map<string, string>(), pending = new Map(), edits = new Map()
  const additionReceipts = new Set<string>(), removalReceipts = new Map<string, Row | undefined>()
  const removalRequests: unknown[] = []
  let storageFails = false, sourceRemovalUnknown = false, failAfterRemoval = false
  const toasts: string[] = []
  const toastActions: Array<() => void> = []
  const restoredDrafts: Item[] = []
  const ingested: any[] = []
  let settled = 0
  let repaints = 0
  let current = sourceId
  let createMode: 'accept' | 'refuse' | 'throw' = 'accept'
  let addMode: AddMode = 'accept'
  let deliveryMode: DeliveryMode = 'accept'
  let refuseSourceRemove = false
  let refuseTargetRemove = false
  let loseTargetRemovalReply = false
  let delaySourceRemove = false
  let releaseRemove: (() => void) | undefined
  let draftCurrent = true
  let engineRows: unknown[] = []
  const store = (sessionId: string) => stores.get(sessionId)!
  const snapshot = (sessionId: string): Snapshot => ({ revision: store(sessionId).revision, items: clone(store(sessionId).rows) })
  const record = (method: string, sessionId: string, args: any[]) => { calls.push({ method, sessionId, args: clone(args) }) }
  const chat = {
    async clientQueueRemove(sessionId: string, id: string, expectedRevision?: number, identity?: any) {
      record('remove', sessionId, [id, expectedRevision])
      removalRequests.push(clone({ sessionId, id, expectedRevision, ...identity }))
      const receiptKey = identity?.clientMutationId
      if (receiptKey && removalReceipts.has(receiptKey)) {
        if (sourceRemovalUnknown) throw Error('Source remove reply lost')
        return { ok: true, removed: clone(removalReceipts.get(receiptKey)), snapshot: snapshot(sessionId), replayed: true }
      }
      if ((sessionId === sourceId && refuseSourceRemove) || (sessionId === targetId && refuseTargetRemove)) return { ok: false, error: 'Queue changed', snapshot: snapshot(sessionId) }
      const index = store(sessionId).rows.findIndex(row => row.id === id)
      const removed = index >= 0 ? store(sessionId).rows.splice(index, 1)[0] : undefined
      store(sessionId).revision++
      const reply = { ok: true, removed: clone(removed), snapshot: snapshot(sessionId) }
      if (receiptKey) removalReceipts.set(receiptKey, clone(removed))
      if (failAfterRemoval) storageFails = true
      if (sourceRemovalUnknown) throw Error('Source remove reply lost')
      if (sessionId === targetId && loseTargetRemovalReply) throw Error('Removal reply lost after persistence')
      if (sessionId === sourceId && delaySourceRemove) await new Promise<void>(resolve => { releaseRemove = resolve })
      return reply
    },
    async clientQueueRestore(sessionId: string, row: Row, anchors: { afterId?: string; beforeId?: string }) {
      record('restore', sessionId, [row, anchors])
      const rows = store(sessionId).rows
      const before = rows.findIndex(candidate => candidate.id === anchors.beforeId)
      const after = rows.findIndex(candidate => candidate.id === anchors.afterId)
      rows.splice(before >= 0 ? before : after >= 0 ? after + 1 : rows.length, 0, clone(row))
      store(sessionId).revision++
      return { ok: true, snapshot: snapshot(sessionId) }
    },
    async clientQueueAdd(sessionId: string, id: string, item: Item, anchors: unknown) {
      record('add', sessionId, [id, item, anchors])
      if (addMode === 'refuse' && !additionReceipts.has(id)) return { ok: false, error: 'Target queue is full', snapshot: snapshot(sessionId) }
      const replayed = additionReceipts.has(id)
      if (!replayed && addMode !== 'uncertain-absent') {
        additionReceipts.add(id)
        if (addMode !== 'uncertain-consumed') store(sessionId).rows.push(makeRow(id, item))
        store(sessionId).revision++
      }
      if (addMode.startsWith('uncertain')) throw Error('Target add reply was lost')
      return { ok: true, replayed, snapshot: snapshot(sessionId) }
    },
    async clientQueueDeliver(sessionId: string, id: string, options: unknown) {
      record('deliver', sessionId, [id, options])
      if (deliveryMode === 'uncertain') throw Error('Delivery reply was lost')
      if (deliveryMode === 'refuse') return { ok: false, error: 'Turn admission refused', snapshot: snapshot(sessionId) }
      store(sessionId).rows = store(sessionId).rows.filter(row => row.id !== id)
      store(sessionId).revision++
      return { ok: true, snapshot: snapshot(sessionId) }
    },
    async clientQueueSnapshot(sessionId: string) {
      record('snapshot', sessionId, [])
      if (sessionId === targetId && addMode === 'uncertain-unreadable') throw Error('Target queue unavailable')
      return { ok: true, snapshot: snapshot(sessionId) }
    },
  }
  const running = new Set<string>()
  const sandbox: Record<string, any> = {
    clientQueueBySession: cache, clientQueueMutationsInFlight: new Set<string>(),
    editedQueueReinsertBySession: edits, pendingQueueAdditions: pending, engineQueueBySession: new Map(), runningSessions: running,
    createQueueRemovalRequest, localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    persistLocalValue: (key: string, value: string) => { if (storageFails) return false; storage.set(key, value); return true },
    sessionDrafts: new Map(), sessionPendingFiles: new Map(), pendingEntriesFromPrepare, parseSelectedTextEnvelope,
    buildOutgoingPayload: (text: string, _files: unknown[], _command: unknown, _sessionId: string, references: unknown[], document: unknown) =>
      ({ ...clone(payload), displayText: text, finalText: text, composerReferences: references, composerDocument: document }),
    normalizeComposerReferences: (_text: string, references: unknown[]) => references,
    window: { get currentSessionId() { return current }, KlausSideTasks: {
      async createForQueued(parentId: string) {
        record('create', parentId, [])
        if (createMode === 'throw') throw Error('Side conversation could not be created')
        return createMode === 'refuse' ? null : targetId
      },
    } }, klausApi: { chat }, tt: (key: string) => key,
    getSessionStream: () => ({ activeTurnId: 'active-turn-9' }),
    renderFollowUpQueue() {}, repaintQueueIslands() { repaints++ },
    showToast(message: string, options?: { onClick?: () => void }) { toasts.push(message); if (options?.onClick) toastActions.push(options.onClick) }, ingestChatEvent(event: unknown) { ingested.push(event) },
    refreshClientQueue: async (sessionId: string) => { record('refresh', sessionId, []) },
    engineFollowUpRows: () => engineRows,
    requestTurnContinue(sessionId: string) { record('continue', sessionId, []) },
    resumeClientQueue(sessionId: string, dispatch = true) { record('resume', sessionId, [dispatch]) },
    removeEngineFollowUp() {}, reorderQueuedFollowUp() {},
  }
  runInNewContext(code, sandbox)
  for (const sessionId of stores.keys()) sandbox.applyClientQueueSnapshot(sessionId, snapshot(sessionId))
  const handlers = sandbox.buildFollowUpQueueHandlers(() => current, {
    capture: () => ({ restore() {}, isCurrent: () => draftCurrent }),
    restoreForEdit: (item: Item) => restoredDrafts.push(clone(item)), settle: () => { settled++ },
  })
  return {
    calls, cache, toasts, restoredDrafts, ingested, running, handlers, storage, pending, edits, removalRequests,
    failStorage: () => { storageFails = true },
    recoverStorage: () => { storageFails = false },
    unknownSourceRemoval: (value = true) => { sourceRemovalUnknown = value },
    failAfterRemoval: () => { failAfterRemoval = true },
    reload: () => {
      pending.clear(); for (const [key, value] of sandbox.loadPendingQueueAdditions()) pending.set(key, value)
      edits.clear(); for (const [key, value] of sandbox.loadEditedQueueReinsert()) edits.set(key, value)
    },
    reconcile: (sessionId = sourceId) => sandbox.reconcilePendingQueueAdditions(sessionId),
    takeEdit: () => sandbox.takeEditedQueueReinsert(sourceId),
    saveEdit: (draft: unknown) => sandbox.persistQueuedEditDraft(sourceId, draft, []),
    hydrateEdits: () => { sandbox.hydrateQueuedEditDrafts(); return { draft: sandbox.sessionDrafts.get(sourceId), files: sandbox.sessionPendingFiles.get(sourceId) } },
    undo: () => toastActions.at(-1)?.(), consumeEdit: () => sandbox.editedQueueReinsertBySession.delete(sourceId),
    loseRollbackReply: () => { loseTargetRemovalReply = true },
    setCurrent: (sessionId: string) => { current = sessionId },
    setCreate: (mode: typeof createMode) => { createMode = mode },
    setAdd: (mode: AddMode) => { addMode = mode },
    setDelivery: (mode: DeliveryMode) => { deliveryMode = mode },
    refuseSourceRemoval: () => { refuseSourceRemove = true }, refuseTargetRemoval: () => { refuseTargetRemove = true },
    delayRemoval: () => { delaySourceRemove = true },
    changeDraft: () => { draftCurrent = false },
    setEngineRows: (rows: unknown[]) => { engineRows = rows },
    releaseRemoval: async () => {
      for (let attempt = 0; !releaseRemove && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
      if (!releaseRemove) throw Error('No source removal is pending')
      releaseRemove()
    },
    ids: (sessionId: string) => store(sessionId).rows.map(row => row.id),
    row: (sessionId: string, id = 'moving') => store(sessionId).rows.find(row => row.id === id),
    settled: () => settled, repaints: () => repaints,
    apply: (sessionId: string, snapshot: Snapshot, replace = false): boolean => sandbox.applyClientQueueSnapshot(sessionId, snapshot, { replace }),
    deliver: (row = store(sourceId).rows[1]): Promise<void> => sandbox.deliverQueuedFollowUp(sourceId, row),
  }
}

describe('queued delivery guards', () => {
  test('delivery carries the observed queue revision and running turn fence', async () => {
    const r = renderer()
    r.running.add(sourceId)
    await r.deliver()
    expect(r.calls.find(call => call.method === 'deliver')).toEqual({ method: 'deliver', sessionId: sourceId, args: ['moving', { expectedRevision: 7, expectedTurnId: 'active-turn-9', requireExpectedTurn: true }] })
  })

  test('idle delivery ignores a retained previous turn identity', async () => {
    const r = renderer()
    await r.deliver()
    expect(r.calls.find(call => call.method === 'deliver')?.args[1]).toEqual({ expectedRevision: 7, expectedTurnId: undefined, requireExpectedTurn: false })
  })

  for (const mark of ['row', 'payload'] as const) test(`unknown delivery recorded on the ${mark} is never resubmitted`, async () => {
    const r = renderer()
    const row = clone(r.row(sourceId)!)
    if (mark === 'row') row.unconfirmed = true
    else row.item.followUpState = 'unconfirmed'
    await r.deliver(row)
    expect(r.calls.filter(call => call.method === 'deliver')).toEqual([])
    expect(r.toasts).toEqual(['follow_up_delivery_unknown'])
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
  })

  test('a stale authoritative response cannot overwrite a newer snapshot even with replacement requested', () => {
    const r = renderer()
    expect(r.apply(sourceId, { revision: 9, items: [] }, true)).toBe(true)
    const repaints = r.repaints()
    expect(r.apply(sourceId, { revision: 8, items: [makeRow('moving', payload)] }, true)).toBe(false)
    expect(r.cache.get(sourceId).revision).toBe(9)
    expect(r.cache.get(sourceId).rows).toEqual([])
    expect(r.repaints()).toBe(repaints)
  })
})

describe('queued edit navigation', () => {
  for (const surface of ['main', 'side'] as const) test(`${surface} production edit restoration cancels a submit parked on the replaced draft`, () => {
    let restore: ts.PropertyAssignment | undefined
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'restoreForEdit'
        && node.initializer.getText(source).includes(surface === 'main' ? 'pendingFiles = queuedPendingFiles' : 'sidePendingFiles = queuedPendingFiles')) restore = node
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (!restore) throw Error(`Missing ${surface} queue edit restoration`)
    const file = { uploadPath: '/uploads/queued.pdf' }
    const sandbox: Record<string, any> = {
      window: { currentSessionId: sourceId }, sideSurfaceSessionId: sourceId,
      pendingSendAfterUpload: { invertFollowUp: false }, sidePendingSendAfterUpload: { invertFollowUp: false },
      pendingFiles: [], sidePendingFiles: [], sideInput: { value: 'Old pending upload' },
      sideSend: { classList: { remove() {} } }, sideComposerControl: { resetHistory() {} },
      queuedPendingFiles: () => [file], composerDraftFromDisplayMetadata: () => null,
      setComposerText() {}, sideSetComposerDraft() {}, restoreSideDisplayCards() {}, restoreDisplayCardsToComposer() {}, renderPreviews() {}, sideRenderPreviews() {},
    }
    runInNewContext(ts.transpileModule(`globalThis.restore = ${restore.initializer.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox)
    sandbox.restore({ displayText: 'Queued message', finalText: 'Queued message', liveAttachments: [], media: [] })
    expect(surface === 'main' ? sandbox.pendingSendAfterUpload : sandbox.sidePendingSendAfterUpload).toBeNull()
    expect(surface === 'main' ? sandbox.pendingFiles : sandbox.sidePendingFiles).toEqual([file])
  })

  for (const surface of ['main', 'side'] as const) test(`${surface} production edit capture detects text, attachment and owner drift`, () => {
    let captureProperty: ts.PropertyAssignment | undefined
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'capture'
        && node.initializer.getText(source).includes(surface === 'main' ? 'composedInputDraft' : 'sideDraftUnchanged')) captureProperty = node
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (!captureProperty) throw Error(`Missing ${surface} queue edit capture`)
    let draft = { text: 'Original draft', references: [{ kind: 'file', value: 'src/main.ts' }] }
    const file = { uploadPath: '/uploads/original.pdf' }
    const sandbox: Record<string, any> = {
      window: { currentSessionId: sourceId }, sideSurfaceSessionId: sourceId,
      pendingSendAfterUpload: null, sidePendingSendAfterUpload: null,
      pendingFiles: [file], sidePendingFiles: [file], sideInput: { value: draft.text }, sideLastComposerInputValue: draft.text,
      sideComposerControl: null, sideBindingRevision: 1,
      sideSetComposerDraft: (value: any) => { sandbox.sideInput.value = value.text },
      composedInputDraft: () => clone(draft), setComposerText: (value: typeof draft) => { draft = clone(value) },
      renderPreviews() {}, sideRenderPreviews() {},
    }
    const script = ts.transpileModule(`globalThis.capture = ${captureProperty.initializer.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    runInNewContext(productionCode(['sideDraftUnchanged']) + '\n' + script, sandbox)
    const captured = sandbox.capture()
    expect(captured.isCurrent()).toBe(true)
    if (surface === 'main') draft.text = 'New text'
    else sandbox.sideInput.value = 'New text'
    expect(captured.isCurrent()).toBe(false)
    captured.restore()
    expect(captured.isCurrent()).toBe(true)
    if (surface === 'main') sandbox.pendingFiles = [{ uploadPath: '/uploads/new.pdf' }]
    else sandbox.sidePendingFiles = [{ uploadPath: '/uploads/new.pdf' }]
    expect(captured.isCurrent()).toBe(false)
    captured.restore()
    expect(captured.isCurrent()).toBe(true)
    if (surface === 'main') sandbox.pendingSendAfterUpload = { invertFollowUp: false }
    else sandbox.sidePendingSendAfterUpload = { invertFollowUp: false }
    expect(captured.isCurrent()).toBe(false)
    sandbox.pendingSendAfterUpload = null; sandbox.sidePendingSendAfterUpload = null
    if (surface === 'main') sandbox.window.currentSessionId = 'other'
    else sandbox.sideSurfaceSessionId = 'other'
    expect(captured.isCurrent()).toBe(false)
  })

  test('a delayed edit preserves a newer draft and restores the complete queued row', async () => {
    const r = renderer()
    r.delayRemoval()
    const edit = r.handlers.onEdit('moving')
    r.changeDraft()
    await r.releaseRemoval()
    await edit
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
    expect(r.row(sourceId)?.item).toEqual(payload)
    expect(r.restoredDrafts).toEqual([])
    expect(r.settled()).toBe(0)
  })

  test('a delayed edit restores its source position if the composer changes conversations', async () => {
    const r = renderer()
    r.delayRemoval()
    const edit = r.handlers.onEdit('moving')
    r.setCurrent('another-session')
    await r.releaseRemoval()
    await edit
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
    expect(r.restoredDrafts).toEqual([])
    expect(r.settled()).toBe(0)
    expect(r.calls.find(call => call.method === 'restore')?.args[0]).toEqual(makeRow('moving', payload))
    expect(r.calls.find(call => call.method === 'restore')?.args[1]).toMatchObject({ afterId: 'before', beforeId: 'after' })
  })

  test('a confirmed edit uses the host returned complete payload', async () => {
    const r = renderer()
    await r.handlers.onEdit('moving')
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.restoredDrafts).toEqual([payload])
    expect(r.settled()).toBe(1)
    expect(r.calls[0]).toEqual({ method: 'remove', sessionId: sourceId, args: ['moving', 7] })
  })
})

test('one resume action reaches the host coordinator when both engine and client rows are paused', () => {
  const r = renderer()
  r.setEngineRows([{ id: 'accepted-engine-input' }])
  r.handlers.onResume()
  expect(r.calls).toEqual([{ method: 'resume', sessionId: sourceId, args: [true] }])
})

// Preserve the real cache-to-row projection and both repaint routes. Only the
// component renderer is substituted, so a missing side repaint leaves the same
// stale mutationPending value that its controls would receive in the application.
function queueIslands() {
  const main = 'main-session', side = 'side-session'
  const clientQueueBySession = new Map<string, any>()
  const engineQueueBySession = new Map<string, any>()
  const pendingQueueAdditions = new Map<string, any>()
  const frames = new Map<string, any[]>()
  const archived = new Set<string>()
  const failures: unknown[] = []
  const engineRemovals: unknown[] = []
  let snapshotFailure = false
  const capture = (sessionId: string) => ({ render(rows: any[] | null) { frames.set(sessionId, clone(rows || [])) } })
  const sandbox: Record<string, any> = {
    clientQueueBySession, engineQueueBySession, pendingQueueAdditions, clientQueueMutationsInFlight: new Set<string>(),
    window: { currentSessionId: main }, sideSurfaceSessionId: side,
    followUpQueueApi: capture(main), sideFollowUpQueueApi: capture(side), followUpQueueMode: 'queue',
    runningSessions: new Set(), findKnownSession: (id: string) => ({ archived: archived.has(id) }),
    queuedRowContent: (item: Item) => ({ text: item.displayText, summary: '', summaryOnly: false, thumbnail: null }),
    queuedComposerReferences: () => [], pastedTextPreview() {}, hiddenLocallySentSteers: () => new Set(),
    engineFollowUpRows: (snapshot: any) => snapshot?.rows || [], tt: (key: string) => key,
    showToast() {}, console: { warn: (...args: unknown[]) => failures.push(args) },
    crypto: { randomUUID: () => 'engine-removal' },
    applyEngineQueueSnapshot(sessionId: string, snapshot: unknown) { engineQueueBySession.set(sessionId, snapshot); sandbox.repaintQueueIslands(sessionId) },
    reconcilePendingQueueAdditions: async () => {},
    persistLocalValue() {},
    klausApi: { chat: {
      async clientQueueSnapshot(sessionId: string) {
        if (snapshotFailure) throw Error('Snapshot transport unavailable')
        return { ok: true, snapshot: { revision: 9, items: [makeRow('moving', payload)] } }
      },
      async queueSnapshot() { if (snapshotFailure) throw Error('Engine snapshot transport unavailable'); return { snapshot: { rows: [] } } },
      async removeQueued(sessionId: string, request: unknown) { engineRemovals.push({ sessionId, request }); return { ok: true } },
    } },
  }
  let paneQueue: ts.VariableDeclaration | undefined
  const findPaneQueue = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'renderSideFollowUpQueue') paneQueue = node
    ts.forEachChild(node, findPaneQueue)
  }
  findPaneQueue(source)
  if (!paneQueue?.initializer) throw Error('Missing pane-local queue renderer')
  runInNewContext(ts.transpileModule(`globalThis.paintPaneQueue = ${paneQueue.initializer.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox)
  const sideRuntime = { sessionId: side, refreshQueue: () => sandbox.paintPaneQueue() }
  sandbox.sidePaneRuntimes = new Map([['right', sideRuntime]])
  sandbox.sideRuntimeForSession = (id: string) => id === sandbox.sideSurfaceSessionId ? sideRuntime : undefined
  runInNewContext(productionCode(['asQueuedItem', 'clientQueueFor', 'clientQueueSnapshotFor', 'clientQueueMutationKey',
    'applyClientQueueSnapshot', 'repaintQueueIslands', 'refreshClientQueue', 'runClientQueueMutation', 'renderQueueInto', 'removeEngineFollowUp',
    'renderFollowUpQueue', 'renderMainFollowUpQueue', 'renderSideFollowUpQueue',
    'forgetPendingQueueAdditionsForSession', 'persistPendingQueueAdditions']), sandbox)
  for (const id of [main, side]) sandbox.applyClientQueueSnapshot(id, { revision: 7, items: [makeRow('moving', payload)] })
  return {
    main, side, frames, archived, failures, engineRemovals, clientQueueBySession, engineQueueBySession, pendingQueueAdditions,
    failSnapshots() { snapshotFailure = true },
    refresh: (id: string, reset = false) => sandbox.refreshClientQueue(id, { reset }),
    mutate: (id: string, callback: () => Promise<unknown>, rowId: string | null = 'moving') => sandbox.runClientQueueMutation(id, rowId, callback),
    removeEngine: (id: string, uuid: string) => sandbox.removeEngineFollowUp(id, uuid),
  }
}

describe('queue island mutation repainting', () => {
  for (const island of ['main', 'side'] as const) {
    for (const outcome of ['success', 'refusal', 'throw'] as const) test(`${island} queue-wide ${outcome} locks every displayed row until settlement`, async () => {
      const r = queueIslands(), sessionId = r[island], otherId = r[island === 'main' ? 'side' : 'main']
      r.engineQueueBySession.set(sessionId, { rows: [{ id: 'accepted-engine-input', text: 'Accepted input', removable: true }] })
      r.clientQueueBySession.get(sessionId).rows.push(makeRow('second-client-row'))
      let settle!: () => void
      const wait = new Promise<void>(resolve => { settle = resolve })
      const mutation = r.mutate(sessionId, async () => {
        await wait
        if (outcome === 'throw') throw Error('Queue-wide mutation transport failed')
        return { ok: outcome === 'success', error: 'Queue changed' }
      }, null)
      const pendingRows = r.frames.get(sessionId)!
      expect(pendingRows.map(row => row.id)).toEqual(['engine:accepted-engine-input', 'moving', 'second-client-row'])
      expect(pendingRows.every(row => row.mutationPending)).toBe(true)
      expect(r.frames.get(otherId)?.some(row => row.mutationPending)).toBe(false)
      if (outcome === 'throw') r.failSnapshots()
      settle()
      await mutation
      await Promise.resolve()
      expect(r.frames.get(sessionId)?.some(row => row.mutationPending)).toBe(false)
    })

    test(`${island} row and engine actions cannot enter while a queue-wide mutation owns the session`, async () => {
      const r = queueIslands(), sessionId = r[island]
      r.engineQueueBySession.set(sessionId, { rows: [{ id: 'accepted-engine-input', text: 'Accepted input', removable: true }] })
      let settle!: () => void, rowCalls = 0
      const wait = new Promise<void>(resolve => { settle = resolve })
      const mutation = r.mutate(sessionId, async () => { await wait; return { ok: true } }, null)
      const result = await r.mutate(sessionId, async () => { rowCalls++; return { ok: true } })
      await r.removeEngine(sessionId, 'accepted-engine-input')
      settle()
      await mutation
      expect(result).toBeUndefined()
      expect(rowCalls).toBe(0)
      expect(r.engineRemovals).toEqual([])
    })

    test(`${island} queue-wide actions cannot enter while a row mutation owns the session`, async () => {
      const r = queueIslands(), sessionId = r[island]
      let settle!: () => void, queueCalls = 0
      const wait = new Promise<void>(resolve => { settle = resolve })
      const mutation = r.mutate(sessionId, async () => { await wait; return { ok: true } })
      const result = await r.mutate(sessionId, async () => { queueCalls++; return { ok: true } }, null)
      settle()
      await mutation
      expect(result).toBeUndefined()
      expect(queueCalls).toBe(0)
    })
  }

  test('a queue-wide mutation leaves independent sessions and independent row actions available', async () => {
    const r = queueIslands()
    let settle!: () => void, sideCalls = 0
    const wait = new Promise<void>(resolve => { settle = resolve })
    const main = r.mutate(r.main, async () => { await wait; return { ok: true } }, null)
    expect(await r.mutate(r.side, async () => { sideCalls++; return { ok: true } })).toEqual({ ok: true })
    expect(sideCalls).toBe(1)
    settle()
    await main
  })

  for (const island of ['main', 'side'] as const) {
    for (const outcome of ['success', 'refusal', 'throw'] as const) test(`${island} controls unlock after ${outcome}`, async () => {
      const r = queueIslands(), sessionId = r[island]
      let settle!: () => void
      const wait = new Promise<void>(resolve => { settle = resolve })
      const mutation = r.mutate(sessionId, async () => {
        await wait
        if (outcome === 'throw') throw Error('Mutation transport failed')
        return { ok: outcome === 'success', error: 'Queue changed', snapshot: { revision: 8, items: [makeRow('moving', payload)] } }
      })
      expect(r.frames.get(sessionId)?.[0].mutationPending).toBe(true)
      if (outcome === 'throw') r.failSnapshots()
      settle()
      await mutation
      // A thrown mutation also starts snapshot reconciliation asynchronously.
      await Promise.resolve()
      expect(r.frames.get(sessionId)?.some(row => row.mutationPending)).toBe(false)
      if (outcome !== 'throw') expect(r.frames.get(sessionId)?.[0].id).toBe('moving')
    })
  }

  test('a reset clears stale side rows even when both snapshot transports fail', async () => {
    const r = queueIslands()
    r.engineQueueBySession.set(r.side, { rows: [{ id: 'engine', text: 'accepted', removable: true }] })
    r.failSnapshots()
    await r.refresh(r.side, true)
    expect(r.clientQueueBySession.has(r.side)).toBe(false)
    expect(r.engineQueueBySession.has(r.side)).toBe(false)
    expect(r.frames.get(r.side)).toEqual([])
    expect(r.failures).toHaveLength(2)
  })

  test('archiving a visible side conversation clears its stale queue without asking the host', async () => {
    const r = queueIslands()
    r.engineQueueBySession.set(r.side, { rows: [{ id: 'engine', text: 'accepted', removable: true }] })
    r.pendingQueueAdditions.set('side-pending', { sessionId: r.side, id: 'pending', item: payload })
    r.archived.add(r.side)
    await r.refresh(r.side)
    expect(r.clientQueueBySession.has(r.side)).toBe(false)
    expect(r.engineQueueBySession.has(r.side)).toBe(false)
    expect(r.frames.get(r.side)).toEqual([])
    expect(r.pendingQueueAdditions.size).toBe(0)
  })
})

describe('queued attachment recovery', () => {
  const context: Record<string, any> = { pendingEntriesFromPrepare, parseSelectedTextEnvelope, window: { klaus: { media: { url: (path: string) => `media:${path}` } } } }
  runInNewContext(productionCode(['queuedPendingFiles']), context)
  const paths = (item: Item): string[] => context.queuedPendingFiles(item, sourceId).map((entry: any) => entry.uploadPath)

  test('ordinary attachment-shaped request text never creates pending files', () => {
    expect(paths({ finalText: 'Attached:\n- /private/user-authored-path.pdf', liveAttachments: [], media: [] })).toEqual([])
    expect(paths({ finalText: 'A pasted example\n\nAttached:\n- /private/user-authored-path.pdf\n\nContinue', liveAttachments: [], media: [] })).toEqual([])
  })

  test('structured files and images are restored once without scanning request text', () => {
    expect(paths({ finalText: 'Attached:\n- /private/fictional.txt', media: [{ path: '/uploads/diagram.png' }],
      liveAttachments: [{ type: 'image', path: '/uploads/diagram.png', name: 'diagram.png' }, { type: 'file', path: '/uploads/report.pdf', name: 'report.pdf' }] })).toEqual(['/uploads/diagram.png', '/uploads/report.pdf'])
  })

  test('serialized queued directory paths remain non-image attachments with their exact spelling', () => {
    const item = JSON.parse(JSON.stringify({ media: [], liveAttachments: [
      { type: 'file', name: 'images.png', path: '/outside/images.png/' },
      { type: 'file', name: 'backslash\\', path: '/outside/backslash\\/' },
    ] }))
    const restored = context.queuedPendingFiles(item, sourceId)
    expect(restored.map((entry: any) => entry.uploadPath)).toEqual(['/outside/images.png/', '/outside/backslash\\/'])
    expect(restored.every((entry: any) => entry.file.type === 'inode/directory' && entry.objectUrl === null && !entry.uploading)).toBe(true)
  })

  test('queue editing preserves authored file and image order before appending missing legacy media', () => {
    expect(paths({ media: [{ path: '/uploads/image.png' }, { path: '/uploads/legacy.png' }], liveAttachments: [
      { type: 'file', path: '/outside/images.png/', name: 'images.png' },
      { type: 'image', path: '/uploads/image.png', name: 'image.png' },
      { type: 'file', path: '/uploads/report.pdf', name: 'report.pdf' },
    ] })).toEqual(['/outside/images.png/', '/uploads/image.png', '/uploads/report.pdf', '/uploads/legacy.png'])
  })

  test('a legacy generated suffix needs matching file descriptors and absolute paths', () => {
    const legacy = { finalText: 'Review\n\nAttached:\n- /uploads/report.pdf', media: [], liveAttachments: [{ type: 'file', name: 'report.pdf' }] }
    expect(paths(legacy)).toEqual(['/uploads/report.pdf'])
    expect(paths({ ...legacy, finalText: 'Review\n\nAttached:\n- /uploads/different.pdf' })).toEqual([])
    expect(paths({ ...legacy, finalText: 'Review\n\nAttached:\n- report.pdf' })).toEqual([])
    expect(paths({ ...legacy, finalText: encodeSelectedTextEnvelope(legacy.finalText, [{ text: 'Selected result', requestOffset: 0 }]) })).toEqual(['/uploads/report.pdf'])
  })
})

function queueSubmission() {
  const calls: Call[] = [], storage = new Map<string, string>(), cache = new Map<string, any>()
  const pending = new Map<string, any>(), toasts: string[] = [], restoredCards: unknown[] = []
  const originalFiles = [{ file: { name: 'diagram.png', type: 'image/png' }, uploadPath: '/uploads/diagram.png' },
    { file: { name: 'report.pdf', type: 'application/pdf' }, uploadPath: '/uploads/report.pdf' }]
  const originalDraft = { text: payload.displayText, references: clone(payload.composerReferences) }
  let draft = clone(originalDraft), mode: 'accept' | 'accept-without-snapshot' | 'refuse' | 'uncertain' | 'consumed' = 'accept'
  let revision = 0, ids = 0, gate: Promise<void> | null = null, release!: () => void, started!: () => void
  let start = new Promise<void>(resolve => { started = resolve })
  const rows: Row[] = []
  const snapshot = () => ({ revision, items: clone(rows) })
  const sandbox: Record<string, any> = {
    clientQueueBySession: cache, clientQueueMutationsInFlight: new Set(), pendingQueueAdditions: pending,
    editedQueueReinsertBySession: new Map(), followUpQueueMode: 'queue',
    window: { currentSessionId: sourceId }, sideSurfaceSessionId: sourceId,
    selectedSlashCommand: null, pendingFiles: [...originalFiles], sidePendingFiles: [...originalFiles], pendingSendAfterUpload: null,
    sideInput: { value: originalDraft.text }, sideLastComposerInputValue: originalDraft.text,
    sideSend: { classList: { remove() {} } }, sidePendingSendAfterUpload: null,
    referencesFromEditor: documentReferencesFromEditor,
    sideDrafts: new Map(), sideComposerControl: { resetHistory() {}, snapshotDocument: () => undefined,
      serializeSubmission: () => ({text: sandbox.sideInput.value, tokens: []}),
      restoreText: (value: string) => { sandbox.sideInput.value = value } },
    inputEl: { focus() {} }, followUpModeHelper: { createId: () => `queued-${++ids}`, resolveSubmitAction: () => 'queue' },
    tt: (key: string) => key, showToast: (message: string) => toasts.push(message),
    repaintQueueIslands() {}, refreshClientQueue: async (sessionId: string) => { calls.push({ method: 'refresh', sessionId, args: [] }) },
    persistLocalValue: (key: string, value: string) => { storage.set(key, value); return true },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    composedInputDraft: () => clone(draft), sideComposedInputText: () => sandbox.sideInput.value,
    sideComposedInputDraft: () => createComposerDraft(sandbox.sideInput.value),
    sideSetComposerDraft: (value: any) => { sandbox.sideInput.value = typeof value === 'string' ? value : value.text },
    setComposerText(value: any) { draft = typeof value === 'string' ? { text: value, references: [] } : clone(value) },
    clearComposerAfterSubmit() { draft = { text: '', references: [] }; sandbox.pendingFiles = [] },
    buildOutgoingPayload: () => clone(payload), sentUserDisplayMetadata: (item: Item) => clone(item.displayMetadata),
    queuedPendingFiles: () => [...originalFiles],
    restoreDisplayCardsToComposer: (...cards: unknown[]) => restoredCards.push(clone(cards)),
    normalizeComposerReferences: () => [], hasUploadInFlight: () => false,
    ensureComposerModelConfigured: async () => true, takeEditedQueueReinsert: () => ({ afterId: 'before', beforeId: 'after' }),
    updateInlineQuoteOffsets() {}, addSessionHistory() {}, resetHistoryBrowsing() {}, renderPreviews() {},
    autoResize() {}, updateSendBtn() {}, sideAutoResize() {}, sideRenderPreviews() {}, updateSideSendButton() {},
    engineQueueBySession: new Map(), draftOnlySessionIds: new Set(), submittedTurnSessionIds: new Set(), clearUnsentSubmission() {}, reloadOnMessageCompleteSessions: new Set(), runningSessions: new Set(),
    sidebarListedWorkingSessions: new Set(), _agentMissingObservations: new Map(), _agentSaveTimers: new Map(), _agentSaveFailures: new Map(),
    retireSessionStream() {}, tasksBySession: new Map(), pendingPermissionsBySession: new Map(), pendingSpecDocByToolCall: new Map(), specDocBySession: new Map(),
    sessionDrafts: new Map(), sessionHistories: new Map(), inlineUserEdits: { forgetSession() {} },
    goalSnapshots: new GoalSnapshots(), goalPursuitEligibility: new Map(),
    goalEditors: new Map(), goalPresentationObjectives: new Map(), openGoalSessionId: null,
    taskPanel: { unavailable: new Set(), metadata: new Map(), requestIds: new Map(), liveVersions: new Map() },
    ctxPanel: { sessions: new Map(), inflight: new Set(), loading: new Set(), pending: new Map() },
    backgroundAgentPoller: { cancel() {} }, forgetLocallySentSteers() {}, forgetRunModeForDraft() {}, forgetTerminalGroup() {},
    forgetSessionInputSnoozes() {}, markSidebarSessionSeen() {}, forgetTaskItems() {}, untrackApprovalRequestsOfSession() {}, dropPendingFilesForSession() {},
    klausApi: { session: { touchSideTask: async () => {} }, chat: {
      async clientQueueAdd(sessionId: string, id: string, item: Item, anchors: unknown) {
        calls.push({ method: 'add', sessionId, args: clone([id, item, anchors]) })
        started()
        if (gate) await gate
        if (mode === 'refuse') return { ok: false, error: 'Admission refused', snapshot: snapshot() }
        if (mode !== 'consumed' && !rows.some(row => row.id === id)) { rows.push(makeRow(id, item)); revision++ }
        if (mode === 'uncertain') throw Error('All acknowledgement replays failed')
        if (mode === 'accept-without-snapshot') return { ok: true }
        return { ok: true, consumed: mode === 'consumed', snapshot: snapshot() }
      },
      async clientQueueRestore(sessionId: string, row: Row, anchors: unknown, options: unknown) {
        calls.push({ method: 'restore', sessionId, args: clone([row, anchors, options]) })
        if (!rows.some(candidate => candidate.id === row.id)) { rows.push(clone(row)); revision++ }
        return { ok: true, snapshot: snapshot() }
      },
    } },
  }
  runInNewContext(productionCode(['asQueuedItem', 'clientQueueFor', 'clientQueueMutationKey', 'applyClientQueueSnapshot',
    'runClientQueueMutation', 'queueFollowUp', 'persistPendingQueueAdditions', 'forgetPendingQueueAddition',
    'loadPendingQueueAdditions', 'reconcilePendingQueueAdditions', 'recoverRefusedQueueAddition',
    'submitRunningFollowUp', 'sideSubmitRunningFollowUp', 'sideDraftUnchanged',
    'forgetSessionLocalState', 'forgetPendingQueueAdditionsForSession', 'retireGoalSessionCaches', 'goalEditorKey']), sandbox)
  return {
    calls, pending, storage, toasts, restoredCards, rows, originalDraft, originalFiles, sandbox,
    mode(value: typeof mode) { mode = value },
    delay() { gate = new Promise<void>(resolve => { release = resolve }); start = new Promise<void>(resolve => { started = resolve }) },
    started: () => start, release: () => { release(); gate = null },
    changeDraft(surface: 'main' | 'side', text = 'Newer authored draft') {
      const files = [{ file: { name: 'new.txt', type: 'text/plain' }, uploadPath: '/uploads/new.txt' }]
      if (surface === 'main') { draft = { text, references: [] }; sandbox.pendingFiles = files }
      else { sandbox.sideInput.value = text; sandbox.sidePendingFiles = files }
    },
    changeMainMetadata() { draft = { text: '', references: [{ kind: 'file', value: 'src/new.ts' }] as any[] } },
    draft: (surface: 'main' | 'side') => surface === 'main' ? draft.text : sandbox.sideInput.value,
    files: (surface: 'main' | 'side') => surface === 'main' ? sandbox.pendingFiles : sandbox.sidePendingFiles,
    submit: (surface: 'main' | 'side') => surface === 'main' ? sandbox.submitRunningFollowUp() : sandbox.sideSubmitRunningFollowUp(sourceId, false),
    reconcile: () => sandbox.reconcilePendingQueueAdditions(sourceId),
    reload: () => sandbox.loadPendingQueueAdditions(),
    forget: () => sandbox.forgetSessionLocalState(sourceId),
  }
}

describe('queued submission recovery', () => {
  for (const surface of ['main', 'side'] as const) test(`${surface} storage failure retains its draft without issuing an addition`, async () => {
    const r = queueSubmission()
    r.sandbox.persistLocalValue = () => false
    await r.submit(surface)
    expect(r.calls.filter(call => call.method === 'add')).toEqual([])
    expect(r.draft(surface)).toBe(r.originalDraft.text)
    expect(r.files(surface)).toEqual(r.originalFiles)
    expect(r.pending.size).toBe(0)
  })

  test('clearing a queued follow-up refreshes the running action before admission returns', async () => {
    const r = queueSubmission()
    const observed: string[] = []
    r.sandbox.updateSendBtn = () => observed.push(r.draft('main'))
    r.delay()
    const sending = r.submit('main')
    await r.started()
    expect(observed).toContain('')
    r.release()
    await sending
  })

  for (const surface of ['main', 'side'] as const) {
    test(`${surface} confirmed admission without a snapshot consumes input without retry or draft restoration`, async () => {
      const r = queueSubmission()
      r.mode('accept-without-snapshot')
      await r.submit(surface)
      expect(r.draft(surface)).toBe('')
      expect(r.files(surface)).toEqual([])
      expect(r.pending.size).toBe(0)
      await r.reconcile()
      expect(r.calls.filter(call => call.method === 'add')).toHaveLength(1)
      expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
      expect(r.rows).toHaveLength(1)
    })

    test(`${surface} admission refusal restores only its unchanged empty draft`, async () => {
      const r = queueSubmission()
      r.mode('refuse')
      await r.submit(surface)
      expect(r.draft(surface)).toBe(r.originalDraft.text)
      expect(r.files(surface)).toEqual(r.originalFiles)
      expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
      expect(r.pending.size).toBe(0)
    })

    test(`${surface} admission refusal preserves newer text and files and recovers the original stable row`, async () => {
      const r = queueSubmission()
      r.mode('refuse'); r.delay()
      const submit = r.submit(surface)
      await r.started()
      r.changeDraft(surface)
      r.release()
      await submit
      expect(r.draft(surface)).toBe('Newer authored draft')
      expect(r.files(surface).map((file: any) => file.uploadPath)).toEqual(['/uploads/new.txt'])
      const add = r.calls.find(call => call.method === 'add')!, restore = r.calls.find(call => call.method === 'restore')!
      expect(restore.args[0].id).toBe(add.args[0])
      expect(restore.args[0].item).toEqual(add.args[1])
      expect(restore.args[0].pausedReason).toBe('follow_up_failed')
      expect(restore.args[1]).toEqual({ afterId: 'before', beforeId: 'after' })
      expect(restore.args[2]).toEqual({ requireRemovedReceipt: false })
      expect(r.pending.size).toBe(0)
    })

    test(`${surface} exhausted acknowledgement uncertainty retains the original payload without draft or new-row duplication`, async () => {
      const r = queueSubmission()
      r.mode('uncertain'); r.delay()
      const submit = r.submit(surface)
      await r.started()
      if (surface === 'main') r.sandbox.window.currentSessionId = 'another-session'
      else r.sandbox.sideSurfaceSessionId = 'another-session'
      r.release()
      await submit
      expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
      expect(r.calls.filter(call => call.method === 'add')).toHaveLength(1)
      expect(r.pending.size).toBe(1)
      expect([...r.pending.values()][0].item).toEqual(r.calls[0].args[1])
      expect([...r.reload().values()]).toEqual([...r.pending.values()])
    })
  }

  test('a later recovery pass replays the same complete request and does not recursively refresh on failure', async () => {
    const r = queueSubmission()
    r.mode('uncertain')
    await r.submit('main')
    const initial = clone(r.calls.find(call => call.method === 'add')!)
    await r.reconcile()
    expect(r.calls.filter(call => call.method === 'add')).toEqual([initial, initial])
    expect(r.calls.filter(call => call.method === 'refresh')).toHaveLength(1)
    expect(r.pending.size).toBe(1)
    r.mode('accept')
    await r.reconcile()
    expect(r.calls.filter(call => call.method === 'add')).toEqual([initial, initial, initial])
    expect(r.rows).toHaveLength(1)
    expect(r.pending.size).toBe(0)
    expect(r.reload().size).toBe(0)
  })

  test('a new main reference with empty typed text owns its draft while the refused request gets recovered', async () => {
    const r = queueSubmission()
    r.mode('refuse'); r.delay()
    const submit = r.submit('main')
    await r.started()
    r.changeMainMetadata()
    r.release()
    await submit
    expect(r.sandbox.composedInputDraft()).toEqual({ text: '', references: [{ kind: 'file', value: 'src/new.ts' }] })
    expect(r.calls.filter(call => call.method === 'restore')).toHaveLength(1)
  })

  test('a new side deferred intent is preserved while the refused request gets recovered', async () => {
    const r = queueSubmission()
    r.mode('refuse'); r.delay()
    const submit = r.submit('side')
    await r.started()
    const deferred = { invertFollowUp: true }
    r.sandbox.sidePendingSendAfterUpload = deferred
    r.release()
    await submit
    expect(r.sandbox.sidePendingSendAfterUpload).toBe(deferred)
    expect(r.draft('side')).toBe('')
    expect(r.calls.filter(call => call.method === 'restore')).toHaveLength(1)
  })

  test('confirmed conversation cleanup removes only its pending recovery records and prevents later replay', async () => {
    const r = queueSubmission()
    r.mode('uncertain')
    await r.submit('main')
    r.pending.set('other', { sessionId: 'other-session', id: 'other', item: payload, anchors: { afterId: null, beforeId: null } })
    r.forget()
    await r.reconcile()
    expect([...r.pending.values()].map(pending => pending.sessionId)).toEqual(['other-session'])
    expect([...r.reload().values()].map((pending: any) => pending.sessionId)).toEqual(['other-session'])
    expect(r.calls.filter(call => call.method === 'add')).toHaveLength(1)
  })

  test('a late addition refusal cannot recreate a conversation after confirmed cleanup', async () => {
    const r = queueSubmission()
    r.mode('refuse'); r.delay()
    const submit = r.submit('main')
    await r.started()
    r.forget()
    r.sandbox.window.currentSessionId = 'other-session'
    r.release()
    await submit
    expect(r.pending.size).toBe(0)
    expect(r.reload().size).toBe(0)
    expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
  })

  test('a replayed acknowledgement for an already consumed addition never creates a recovery row', async () => {
    const r = queueSubmission()
    r.mode('uncertain')
    await r.submit('main')
    r.rows.splice(0)
    r.mode('consumed')
    await r.reconcile()
    expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
    expect(r.rows).toEqual([])
    expect(r.pending.size).toBe(0)
  })
})

test('the widget queue adapter preserves its boolean contract for every queue admission outcome', async () => {
  let queue: ts.PropertyAssignment | undefined
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'queue' && node.initializer.getText(source).includes('queueFollowUp')) queue = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!queue) throw Error('Missing widget queue adapter')
  for (const status of ['queued', 'unconfirmed', 'refused', 'discarded']) {
    const forgotten: unknown[] = []
    const sandbox: Record<string, any> = {
      request: { sessionId: sourceId }, buildOutgoingPayload: () => payload,
      queueFollowUp: async () => ({ status, id: 'queued-id' }),
      forgetPendingQueueAddition: (...args: unknown[]) => forgotten.push(args), showToast() {}, tt: (key: string) => key,
    }
    runInNewContext(ts.transpileModule(`globalThis.queue = ${queue.initializer.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox)
    expect(await sandbox.queue('Request')).toBe(status !== 'refused')
    expect(forgotten).toEqual(status === 'refused' ? [[sourceId, 'queued-id']] : [])
  }
})

describe('queued side conversation transfer', () => {
  test('storage failure blocks source removal and target admission', async () => {
    const r = renderer()
    r.failStorage()
    await r.handlers.onOpenInSideChat('moving')
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
    expect(r.calls.filter(call => call.method === 'remove' || call.method === 'add')).toEqual([])
    expect(r.pending.size).toBe(0)
  })

  test('a failed phase write after source removal preserves its receipt and blocks target admission', async () => {
    const r = renderer()
    r.failAfterRemoval()
    await r.handlers.onOpenInSideChat('moving')
    expect(r.calls.filter(call => call.method === 'add')).toEqual([])
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    r.reload()
    expect([...r.pending.values()][0].transfer.phase).toBe('remove-source')
    r.recoverStorage()
    await r.reconcile()
    expect(r.removalRequests[1]).toEqual(r.removalRequests[0])
    expect(r.ids(targetId)).toEqual(['moving'])
    expect(r.pending.size).toBe(0)
  })

  test('a consumed target with a lost admission acknowledgement is acknowledged by replay without resurrection', async () => {
    const r = renderer()
    r.setAdd('uncertain-consumed')
    await r.handlers.onOpenInSideChat('moving')
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual([])
    const journal = [...r.pending.values()][0]
    expect(journal.item).toEqual(payload)
    expect(journal.transfer.row).toEqual(makeRow('moving', payload))
    expect(journal.transfer.anchors).toEqual({ afterId: 'before', beforeId: 'after' })
    expect(journal.transfer.removal).toMatchObject({ sessionId: sourceId, id: 'moving', expectedRevision: 7 })
    expect(journal.transfer.removal.clientMutationId).toBeString()
    expect(journal.transfer.removal.mutationFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const original = r.calls.find(call => call.method === 'add')
    r.reload()
    expect([...r.pending.values()][0]).toEqual(journal)
    r.setAdd('accept')
    await r.reconcile(targetId)
    expect(r.calls.filter(call => call.method === 'add')).toEqual([original, original])
    expect(r.ids(targetId)).toEqual([])
    expect(r.pending.size).toBe(0)
    expect(r.calls.filter(call => call.method === 'restore' || call.method === 'deliver')).toEqual([])
  })

  test('a lost source removal reply survives reload with its exact receipt identity', async () => {
    const r = renderer()
    r.unknownSourceRemoval()
    await r.handlers.onOpenInSideChat('moving')
    expect(r.calls.filter(call => call.method === 'add')).toEqual([])
    expect([...r.pending.values()][0].transfer.phase).toBe('remove-source')
    r.reload()
    r.unknownSourceRemoval(false)
    await r.reconcile()
    expect(r.removalRequests).toHaveLength(2)
    expect(r.removalRequests[1]).toEqual(r.removalRequests[0])
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual(['moving'])
    expect(r.calls.filter(call => call.method === 'deliver')).toEqual([])
    expect(r.pending.size).toBe(0)
  })

  test('side creation and durable journal precede source removal and complete payload admission', async () => {
    const r = renderer()
    await r.handlers.onOpenInSideChat('moving')
    expect(r.calls.map(call => `${call.method}:${call.sessionId}`)).toEqual([`create:${sourceId}`, `remove:${sourceId}`, `add:${targetId}`, `deliver:${targetId}`, `refresh:${targetId}`])
    expect(r.calls.find(call => call.method === 'add')?.args).toEqual(['moving', payload, { afterId: null, beforeId: null }])
    expect(r.calls.find(call => call.method === 'deliver')?.args).toEqual(['moving', { expectedRevision: 1 }])
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual([])
    expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
  })

  test('refused source removal leaves the complete original message queued and never admits the target', async () => {
    const r = renderer()
    r.refuseSourceRemoval()
    await r.handlers.onOpenInSideChat('moving')
    expect(r.calls.map(call => call.method)).toEqual(['create', 'remove', 'refresh'])
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
    expect(r.row(sourceId)?.item).toEqual(payload)
  })

  for (const failure of ['create-refused', 'create-error', 'add-refused'] as const) test(`${failure} retains the exact row between its former neighbours`, async () => {
    const r = renderer()
    if (failure === 'create-refused') r.setCreate('refuse')
    if (failure === 'create-error') r.setCreate('throw')
    if (failure === 'add-refused') r.setAdd('refuse')
    await r.handlers.onOpenInSideChat('moving')
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
    expect(r.row(sourceId)?.item).toEqual(payload)
    expect(r.ids(targetId)).toEqual([])
    if (failure === 'add-refused') expect(r.calls.find(call => call.method === 'restore')?.args).toEqual([makeRow('moving', payload), { afterId: 'before', beforeId: 'after' }])
    else expect(r.calls.filter(call => call.method === 'remove' || call.method === 'restore')).toEqual([])
  })

  test('a lost successful add reply reconciles target ownership without restoring a duplicate', async () => {
    const r = renderer()
    r.setAdd('uncertain-saved')
    await r.handlers.onOpenInSideChat('moving')
    expect(r.pending.size).toBe(1)
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual(['moving'])
    expect(r.row(targetId)?.item).toEqual(payload)
    expect(r.calls.filter(call => call.method === 'restore' || call.method === 'deliver')).toEqual([])
  })

  test('an empty target after a lost add acknowledgement remains unknown until receipt replay', async () => {
    const r = renderer()
    r.setAdd('uncertain-absent')
    await r.handlers.onOpenInSideChat('moving')
    expect(r.pending.size).toBe(1)
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual([])
    const original = r.calls.find(call => call.method === 'add')
    r.reload()
    r.setAdd('accept')
    await r.reconcile()
    expect(r.calls.filter(call => call.method === 'add')).toEqual([original, original])
    expect(r.ids(targetId)).toEqual(['moving'])
    expect(r.pending.size).toBe(0)
    expect(r.calls.filter(call => call.method === 'deliver' || call.method === 'restore')).toEqual([])
  })

  test('unreadable ownership after a lost add reply never creates a second source copy', async () => {
    const r = renderer()
    r.setAdd('uncertain-unreadable')
    await r.handlers.onOpenInSideChat('moving')
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual(['moving'])
    expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
  })

  test('a lost delivery reply leaves the target as the single recovery owner', async () => {
    const r = renderer()
    r.setDelivery('uncertain')
    await r.handlers.onOpenInSideChat('moving')
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual(['moving'])
    expect(r.row(targetId)?.item).toEqual(payload)
    expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
  })

  test('delivery refusal followed by refused target removal retains the target without a duplicate', async () => {
    const r = renderer()
    r.setDelivery('refuse')
    r.refuseTargetRemoval()
    await r.handlers.onOpenInSideChat('moving')
    expect(r.ids(sourceId)).toEqual(['before', 'after'])
    expect(r.ids(targetId)).toEqual(['moving'])
    expect(r.row(targetId)?.item).toEqual(payload)
    expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
  })
})

describe('durable queue edits', () => {
  test('storage failure prevents an edit from removing its queued input', async () => {
    const r = renderer()
    r.failStorage()
    await r.handlers.onEdit('moving')
    expect(r.calls.filter(call => call.method === 'remove')).toEqual([])
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
    expect(r.restoredDrafts).toEqual([])
  })

  test('edited draft, full original row, both anchors and removal proof survive reload', async () => {
    const r = renderer()
    await r.handlers.onEdit('moving')
    const draft = { text: 'Edited request @workflow.ts', references: clone(payload.composerReferences),
      document: { version: 1, content: [{ type: 'text', text: 'Edited request @workflow.ts' }] } }
    r.saveEdit(draft)
    const before = clone(r.edits.get(sourceId))
    r.reload()
    expect(r.edits.get(sourceId)).toEqual(before)
    expect(r.edits.get(sourceId).row).toEqual(makeRow('moving', payload))
    expect(r.edits.get(sourceId).draft).toEqual(draft)
    expect(r.edits.get(sourceId).removal).toEqual(r.removalRequests[0])
    const hydrated = r.hydrateEdits()
    expect(hydrated.draft).toEqual(draft)
    expect(hydrated.files.map((file: any) => file.uploadPath)).toEqual(['/uploads/diagram.png', '/uploads/report.pdf'])
    const anchors = r.takeEdit()
    expect(anchors).toMatchObject({ afterId: 'before', beforeId: 'after' })
    r.reload()
    expect(r.edits.size).toBe(0)
  })

  test('reload during an unknown edit removal restores only through the same removal receipt', async () => {
    const r = renderer()
    r.unknownSourceRemoval()
    await r.handlers.onEdit('moving')
    expect(r.restoredDrafts).toEqual([])
    r.reload()
    r.unknownSourceRemoval(false)
    await r.reconcile()
    expect(r.removalRequests[1]).toEqual(r.removalRequests[0])
    expect(r.ids(sourceId)).toEqual(['before', 'moving', 'after'])
    expect(r.row(sourceId)?.item).toEqual(payload)
    expect(r.edits.size).toBe(0)
    expect(r.calls.filter(call => call.method === 'add' || call.method === 'deliver')).toEqual([])
  })
})

test('the removal bridge reuses serialized identity and fingerprint across renderer reloads', async () => {
  const input = { sessionId: sourceId, id: 'moving', expectedRevision: 7 }
  const original = await createQueueRemovalRequest(input)
  const requests: unknown[] = []
  const send = async (request: unknown) => { requests.push(request); throw Error('Lost acknowledgement') }
  let failure: Error | undefined
  await removeQueuedWithReceipt(send, input, original).catch(error => { failure = error })
  expect(failure?.message).toBe('Lost acknowledgement')
  const reloaded = JSON.parse(JSON.stringify(original))
  const result = await removeQueuedWithReceipt(async request => { requests.push(request); return { ok: true, replayed: true } }, input, reloaded)
  expect(result).toEqual({ ok: true, replayed: true })
  expect(requests).toEqual([original, original, original, original])
})

test('the addition bridge replays the full payload and both anchors with the same identity after reload', async () => {
  const input = { sessionId: targetId, id: 'moving', item: clone(payload), afterId: 'earlier', beforeId: 'later' }
  const requests: any[] = []
  await addQueuedWithReceipt(async request => { requests.push(request); throw Error('Lost acknowledgement') }, input).catch(() => {})
  await addQueuedWithReceipt(async request => { requests.push(request); return { ok: true, replayed: true } }, JSON.parse(JSON.stringify(input)))
  expect(requests).toHaveLength(4)
  expect(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0]))).toBe(true)
  expect(requests[0]).toMatchObject({ ...input, clientMutationId: 'moving' })
  expect(requests[0].mutationFingerprint).toMatch(/^[a-f0-9]{64}$/)
})
 test('an edit undo expires when the edited request is submitted', async () => {
  const r = renderer()
  await r.handlers.onEdit('moving')
  r.consumeEdit()
  r.undo()
  expect(r.ids(sourceId)).toEqual(['before', 'after'])
  expect(r.calls.filter(call => call.method === 'restore')).toEqual([])
})
 test('delivery refusal leaves the accepted target in place without another removal', async () => {
  const r = renderer()
  r.setDelivery('refuse')
  r.loseRollbackReply()
  await r.handlers.onOpenInSideChat('moving')
  expect(r.ids(sourceId)).toEqual(['before', 'after'])
  expect(r.ids(targetId)).toEqual(['moving'])
  expect(r.calls.filter(call => call.method === 'remove').map(call => call.sessionId)).toEqual([sourceId])
})
