// The follow-up queue bar is drawn from the host-owned client queue. This test
// executes the PRODUCTION ingress (`applyClientQueueSnapshot` /
// `applyQueuedFollowUpDispatched`, extracted from chat.ts by AST) against the
// committed vectors, with only UI effects stubbed, so the assertions cover real
// renderer code rather than a copy of it.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { ClientQueueSnapshotEvent, ClientQueueRow, ClientQueueSnapshot, QueuedFollowUpDispatchedEvent } from './engine-events'
import { browserTabMentionUri, type BrowserTabMention } from '../../../shared/browser-tab-mention'
import { browserTabReference } from './composer/browser-tab-reference'

interface ExpectRow { id: string; pausedReason: string | null; dispatching: boolean; createdAt: number; preview: string }
const vectors = JSON.parse(readFileSync(new URL('../../../contracts/vectors/client-queue-snapshot-vectors.json', import.meta.url), 'utf8')) as {
  vectors: Array<{ name: string; event: ClientQueueSnapshotEvent; expect: { revision: number; interrupted: boolean; rows: ExpectRow[] } }>
  staleRevision: { name: string; event: ClientQueueSnapshotEvent; expect: { revision: number; rows: ExpectRow[] } }
  dispatched: { name: string; event: QueuedFollowUpDispatchedEvent; expect: { text: string } }
}

const source = ts.createSourceFile('chat.ts', readFileSync(new URL('./chat.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)

const PRODUCTION = ['asQueuedItem', 'clientQueueFor', 'clientQueueSnapshotFor', 'clientQueueMutationKey', 'applyClientQueueSnapshot', 'applyQueuedFollowUpDispatched', 'sentUserDisplayMetadata', 'steerFollowUp', 'takeEditedQueueReinsert', 'noteLocallySentSteer', 'forgetEditedQueueReinsert', 'persistEditedQueueReinsert']
const code = ts.transpileModule(
  PRODUCTION.map(name => {
    const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    if (!node) throw new Error(`The production queue ingress must be identifiable: ${name}`)
    return node.getText(source)
  }).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText

interface Ingress {
  applyClientQueueSnapshot(sessionId: string, snapshot: unknown, options?: { replace?: boolean }): boolean
  applyQueuedFollowUpDispatched(event: QueuedFollowUpDispatchedEvent): void
  steerFollowUp(sessionId: string, payload: unknown, options?: { quietError?: boolean }): Promise<boolean>
  takeEditedQueueReinsert(sessionId: string | null): { afterId: string | null; beforeId: string | null }
}

/** One renderer, isolated per test so a revision guard cannot leak across them. */
function renderer(currentSessionId = 'conversation', options: { sideSessionId?: string | null } = {}) {
  const cache = new Map<string, ClientQueueSnapshot>()
  const bubbles: Array<{ sessionId: string; text: string }> = []
  const notices: Array<{ error?: string }> = []
  const steerRequests: unknown[][] = []
  // What the engine's steer replies with; a test flips this to model a refusal.
  let steerReply: { ok?: boolean; messageId?: string; error?: string; unconfirmed?: boolean; removed?: boolean } = { ok: true, messageId: 'steered-1' }
  let renders = 0
  let sideRenders = 0
  let sideScrolls = 0
  let mainScrolls = 0
  let sideSessionId = options.sideSessionId ?? null
  const sideSurfaces = new Set<string>(sideSessionId ? [sideSessionId] : [])
  // The ingress functions are added by runInNewContext, so the sandbox starts as a
  // plain record holding only the stubbed collaborators; the typed accessors below
  // read the functions back off it after evaluation.
  //
  // `repaintQueueIslands` is stubbed rather than left to the real one because it
  // routes to two islands that each pull in the whole composer; the ROUTING rule it
  // encodes is what this test asserts, and a stub that records which island was asked
  // to repaint is the direct way to observe it.
  const sandbox: Record<string, unknown> = {
    clientQueueBySession: cache,
    persistLocalValue: () => true,
    clientQueueMutationsInFlight: new Set<string>(),
    window: { currentSessionId },
    findKnownSession: () => undefined,
    renderFollowUpQueue: () => { renders++ },
    renderSideFollowUpQueue: () => { sideRenders++ },
    repaintQueueIslands: (sessionId: string | null) => {
      if (sessionId && sessionId === currentSessionId) renders++
      if (sessionId && sessionId === sideSessionId) sideRenders++
    },
    isSideChatSession: (sessionId: string | null | undefined) => !!sessionId && sideSurfaces.has(sessionId),
    renderLocalUserPayload: (_sessionId: string, payload: { finalText?: string; displayText?: string }) => {
      bubbles.push({ sessionId: _sessionId, text: String(payload?.displayText || payload?.finalText || '') })
    },
    scrollToBottom: () => { mainScrolls++ },
    sideSticker: { scrollToBottom: () => { sideScrolls++ }, resumeFollowing: () => {} },
    get sideSurfaceSessionId() { return sideSessionId },
    setSideSession: (id: string | null) => {
      sideSessionId = id
      if (id) sideSurfaces.add(id)
      else sideSurfaces.clear()
    },
    tt: (key: string) => key,
    // Collaborators for steerFollowUp / takeEditedQueueReinsert.
    editedQueueReinsertBySession: new Map<string, { afterId: string | null; beforeId: string | null }>(),
    // steerFollowUp records the bubble it drew here; the queue bar reads it back.
    locallySentSteerIdsBySession: new Map<string, Set<string>>(),
    klausApi: { chat: { followUp: async (...request: unknown[]) => { steerRequests.push(request); return steerReply } } },
    ingestChatEvent: (event: { error?: string }) => { notices.push(event) },
  }
  runInNewContext(code, sandbox)
  const ingress = sandbox as unknown as Ingress
  const project = (row: ClientQueueRow): ExpectRow => ({
    id: row.id,
    pausedReason: row.pausedReason,
    dispatching: row.dispatching,
    createdAt: row.createdAt,
    // The row's own text; what the bar renders from it (markdown plus the
    // attachment summaries) is pinned by queue-row-content.test.ts, not here.
    preview: String(row.item.displayText || row.item.finalText || ''),
  })
  return {
    cache,
    bubbles,
    notices,
    steerRequests,
    renders: () => renders,
    sideRenders: () => sideRenders,
    sideScrolls: () => sideScrolls,
    mainScrolls: () => mainScrolls,
    /** Close or open the side tab, as the surface activate/remove hooks do. */
    setSideSession: (id: string | null) => (sandbox as { setSideSession(v: string | null): void }).setSideSession(id),
    apply: (sessionId: string, snapshot: unknown, replace = false) => ingress.applyClientQueueSnapshot(sessionId, snapshot, { replace }),
    dispatch: (event: QueuedFollowUpDispatchedEvent) => ingress.applyQueuedFollowUpDispatched(event),
    /** Drive a steer exactly as the side and main follow-up paths do. */
    steer: (sessionId: string, payload: unknown) => ingress.steerFollowUp(sessionId, payload, { quietError: true }),
    setSteerReply: (reply: { ok?: boolean; messageId?: string; error?: string; unconfirmed?: boolean; removed?: boolean }) => { steerReply = reply },
    setAnchor: (sessionId: string, anchors: { afterId?: string | null; beforeId?: string | null }) => {
      (sandbox.editedQueueReinsertBySession as Map<string, { afterId: string | null; beforeId: string | null }>)
        .set(sessionId, { afterId: anchors.afterId ?? null, beforeId: anchors.beforeId ?? null })
    },
    takeAnchor: (sessionId: string | null) => ingress.takeEditedQueueReinsert(sessionId),
    rows: (sessionId: string) => (cache.get(sessionId)?.rows ?? []).map(project),
  }
}

describe('host-owned client queue ingress', () => {
  // One test per committed vector so a failing snapshot is named on its own line
  // (bun's `expect` takes no message argument, and a loop would hide which one broke).
  for (const vector of vectors.vectors) {
    test(`installs ${vector.name}`, () => {
      const r = renderer()
      // Every vector is one host republish; the renderer installs it outright.
      expect(r.apply(vector.event.sessionId, vector.event, true)).toBe(true)
      const snapshot = r.cache.get(vector.event.sessionId)
      expect(snapshot?.revision).toBe(vector.expect.revision)
      expect(snapshot?.interrupted).toBe(vector.expect.interrupted)
      expect(r.rows(vector.event.sessionId)).toEqual(vector.expect.rows)
      // The visible session re-renders exactly once for its accepted push.
      expect(r.renders()).toBe(vector.event.sessionId === 'conversation' ? 1 : 0)
    })
  }

  test('an out-of-order older push cannot restore a consumed row', () => {
    const r = renderer()
    const { event } = vectors.staleRevision
    const consumed = { ...event, sessionId: 'background', revision: 2, items: [] }
    expect(r.apply('background', consumed, true)).toBe(true)
    // The late revision-1 push must be rejected outright, not merged over it.
    expect(r.apply('background', event)).toBe(false)
    expect(r.cache.get('background')?.revision).toBe(vectors.staleRevision.expect.revision)
    expect(r.rows('background')).toEqual([])
    expect(r.renders()).toBe(0)
  })

  test('a host dispatch draws its own user bubble from the stored payload', () => {
    const r = renderer()
    r.dispatch(vectors.dispatched.event)
    expect(r.bubbles).toEqual([{ sessionId: vectors.dispatched.event.sessionId, text: vectors.dispatched.expect.text }])
  })

  test('an image-only queued message is kept, not dropped as a lost payload', () => {
    // REGRESSION: an image-only message has empty `displayText`/`finalText` by
    // construction (the image rides in `media`), and the ingress guard used to
    // require one of those texts. It dropped the row, so the queue never showed it
    // and the dispatch never drew its bubble — a pure-image follow-up silently
    // vanished while text or text+image went through.
    const r = renderer()
    const imageOnly = vectors.vectors.find(vector => vector.name.includes('image-only'))
    // The vector must exist for the assertions below to mean anything.
    expect(!!imageOnly).toBe(true)
    expect(r.apply(imageOnly!.event.sessionId, imageOnly!.event, true)).toBe(true)
    expect(r.rows(imageOnly!.event.sessionId).map(row => row.id)).toEqual(imageOnly!.expect.rows.map(row => row.id))
    // The row has no words of its own, so its preview is empty — the queue bar
    // describes it via the attachment summary instead (queue-row-content.test.ts).
    expect(r.rows(imageOnly!.event.sessionId).every(row => row.preview === '')).toBe(true)
  })

  test('an image-only dispatch still draws its user bubble', () => {
    // The bubble carries the image through `liveAttachments`; its text is empty,
    // which is correct — what matters is that a bubble is drawn at all rather than
    // the dispatch being dropped before it reaches the transcript.
    const r = renderer()
    r.dispatch({
      type: 'queued_follow_up_dispatched',
      sessionId: 'conversation',
      id: 'image-only',
      item: {
        id: 'image-only',
        displayText: '',
        finalText: '',
        media: [{ type: 'image', path: '/uploads/shot.png', name: 'shot.png' }],
        liveAttachments: [{ type: 'image', name: 'shot.png', src: 'blob:shot' }],
      },
    } as QueuedFollowUpDispatchedEvent)
    expect(r.bubbles).toEqual([{ sessionId: 'conversation', text: '' }])
  })

  test('a dispatch for another conversation still draws its bubble but does not scroll', () => {
    const r = renderer('conversation')
    r.dispatch({ ...vectors.dispatched.event, sessionId: 'background' })
    expect(r.bubbles.map(bubble => bubble.sessionId)).toEqual(['background'])
    expect(r.mainScrolls()).toBe(0)
    expect(r.sideScrolls()).toBe(0)
  })

  test('a side chat’s queue repaints its own island and never the main one', () => {
    // The side composer is reused across side tabs and reads one shared cache, so a
    // push for the OPEN side chat must repaint the side island. Checking only the
    // main session id is how a side queue silently freezes.
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    expect(r.apply('side-1', vectors.vectors[0]!.event, true)).toBe(true)
    expect(r.sideRenders()).toBeGreaterThan(0)
    expect(r.renders()).toBe(0)
    expect(r.rows('side-1').length).toBe(vectors.vectors[0]!.expect.rows.length)
  })

  test('a push for neither open conversation repaints no island', () => {
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    expect(r.apply('background', vectors.vectors[0]!.event, true)).toBe(true)
    // Stored, so switching to it later paints correctly — but nothing visible moves.
    expect(r.rows('background').length).toBe(1)
    expect(r.renders()).toBe(0)
    expect(r.sideRenders()).toBe(0)
  })

  test('a dispatch into the open side chat scrolls the side panel, not the main transcript', () => {
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    r.dispatch({ ...vectors.dispatched.event, sessionId: 'side-1' })
    expect(r.bubbles.map(bubble => bubble.sessionId)).toEqual(['side-1'])
    expect(r.sideScrolls()).toBe(1)
    expect(r.mainScrolls()).toBe(0)
  })

  test('a dispatch into a hidden side chat draws the bubble without moving any panel', () => {
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    // The tab was closed while the queued message was still being dispatched.
    r.setSideSession(null)
    r.dispatch({ ...vectors.dispatched.event, sessionId: 'side-1' })
    expect(r.bubbles.map(bubble => bubble.sessionId)).toEqual(['side-1'])
    expect(r.sideScrolls()).toBe(0)
    expect(r.mainScrolls()).toBe(0)
  })
})

describe('steering scrolls the surface that owns the conversation', () => {
  test('a browser tab steer passes its display snapshot to the host', async () => {
    const r = renderer('conversation')
    const row = { source: 'extension', browserId: 'chrome:profile-a', tabId: '42', title: 'Project notes',
      url: 'https://example.com/notes', browserName: 'Chrome', lastOpened: 123 } as BrowserTabMention
    row.mention = browserTabMentionUri(row)
    const reference = browserTabReference(row)
    const composerReferences = [{ ...reference, range: { start: 0, end: reference.value.length } }]
    expect(await r.steer('conversation', { finalText: reference.value, displayText: reference.value, media: [], liveAttachments: [], composerReferences })).toBe(true)
    expect((r.steerRequests[0][3] as any).composerReferences).toEqual(composerReferences)
    expect(r.bubbles[0].text).toBe(reference.value)
  })
  // REGRESSION: the side composer had no follow-up path at all until the queue bar
  // was extended to it, and `steerFollowUp` unconditionally scrolled the MAIN
  // sticker. Opening that path without routing the scroll would yank the main
  // transcript to its bottom on every side-chat steer, while the side panel — where
  // the message actually appeared — stayed scrolled away from it.
  test('a steer in the main conversation scrolls the main transcript', async () => {
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    expect(await r.steer('conversation', { finalText: 'also check tests', media: [] })).toBe(true)
    expect(r.bubbles.map(bubble => bubble.sessionId)).toEqual(['conversation'])
    expect(r.mainScrolls()).toBe(1)
    expect(r.sideScrolls()).toBe(0)
  })

  test('a steer in the open side chat scrolls the side panel only', async () => {
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    expect(await r.steer('side-1', { finalText: 'also check tests', media: [] })).toBe(true)
    expect(r.bubbles.map(bubble => bubble.sessionId)).toEqual(['side-1'])
    expect(r.sideScrolls()).toBe(1)
    expect(r.mainScrolls()).toBe(0)
  })

  test('a steer into a hidden side chat moves no panel', async () => {
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    r.setSideSession(null)
    expect(await r.steer('side-1', { finalText: 'also check tests', media: [] })).toBe(true)
    expect(r.sideScrolls()).toBe(0)
    expect(r.mainScrolls()).toBe(0)
  })

  test('uncertain admission consumes the submitted draft while delivery remains observable', async () => {
    const r = renderer('conversation')
    r.setSteerReply({ ok: false, unconfirmed: true, messageId: 'uncertain-stable-id', error: 'Admission timed out' })
    expect(await r.steer('conversation', { finalText: 'already issued', media: [] })).toBe(true)
    expect(r.bubbles).toEqual([{ sessionId: 'conversation', text: 'already issued' }])
    expect(r.notices).toEqual([])
  })

  test('confirmed removal during admission consumes the draft without restoring or drawing it', async () => {
    const r = renderer('conversation')
    r.setSteerReply({ ok: false, removed: true, messageId: 'removed-stable-id' })
    expect(await r.steer('conversation', { finalText: 'owner removed input', media: [] })).toBe(true)
    expect(r.bubbles).toEqual([])
    expect(r.notices).toEqual([])
  })

  test('a refused steer reports failure without drawing a bubble', async () => {
    const r = renderer('conversation')
    r.setSteerReply({ ok: false, error: 'This input cannot join the running turn' })
    // quietError is what both follow-up paths pass, so the refusal is the caller's
    // to surface; what must NOT happen is an optimistic bubble for a message the
    // engine never accepted.
    expect(await r.steer('conversation', { finalText: 'also check tests', media: [] })).toBe(false)
    expect(r.bubbles.length).toBe(0)
    expect(r.notices.length).toBe(0)
  })
})

describe('the edit re-insert anchor', () => {
  // Edit takes a queued message out and remembers BOTH neighbours so the message
  // lands back in the same place. That position belongs to ONE submit: a stale
  // anchor silently inserts a later, unrelated message in the middle of the queue.
  const NONE = { afterId: null, beforeId: null }

  test('anchors are handed out once and then forgotten', () => {
    const r = renderer('conversation')
    r.apply('conversation', vectors.vectors[0]!.event, true)
    r.setAnchor('conversation', { beforeId: 'queued-one' })
    expect(r.takeAnchor('conversation')).toEqual({ afterId: null, beforeId: 'queued-one' })
    // A submit consumed them; nothing may inherit the position.
    expect(r.takeAnchor('conversation')).toEqual(NONE)
  })

  test('anchors belong to the conversation that created them', () => {
    const r = renderer('conversation', { sideSessionId: 'side-1' })
    // The anchor row must actually be in the side chat's queue for the position to
    // be honoured, so seed side-1 with a row named by the anchor.
    r.apply('side-1', { ...vectors.vectors[0]!.event, sessionId: 'side-1' }, true)
    r.setAnchor('side-1', { beforeId: 'queued-one' })
    // The main composer must not inherit a position the user chose in a side chat.
    expect(r.takeAnchor('conversation')).toEqual(NONE)
    expect(r.takeAnchor('side-1')).toEqual({ afterId: null, beforeId: 'queued-one' })
  })

  test('an anchor whose row is no longer queued is dropped, so the row appends', () => {
    const r = renderer('conversation')
    r.apply('conversation', vectors.vectors[0]!.event, true)
    // The row the message was supposed to land in front of was dispatched or
    // deleted while the user was editing, so there is no position left to honour.
    r.setAnchor('conversation', { beforeId: 'already-gone' })
    expect(r.takeAnchor('conversation')).toEqual(NONE)
  })

  test('a surviving predecessor keeps the position when the successor is gone', () => {
    // The reason both neighbours are captured. While the user edits, the row that
    // FOLLOWED can be dispatched; the row that PRECEDED still places the message
    // correctly, instead of degrading straight to append.
    const r = renderer('conversation')
    r.apply('conversation', {
      ...vectors.vectors[0]!.event,
      items: [{ id: 'queued-one', createdAt: 1, item: { id: 'queued-one', displayText: 'a', finalText: 'a', media: [], liveAttachments: [] } }],
    }, true)
    r.setAnchor('conversation', { afterId: 'queued-one', beforeId: 'already-gone' })
    expect(r.takeAnchor('conversation')).toEqual({ afterId: 'queued-one', beforeId: null })
  })

  test('no anchor means append', () => {
    const r = renderer('conversation')
    expect(r.takeAnchor('conversation')).toEqual(NONE)
    expect(r.takeAnchor(null)).toEqual(NONE)
  })
})
