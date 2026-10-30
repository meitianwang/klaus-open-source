// Which sent message an edit may target, and how the row hands that target to the
// composer. Both halves are load-bearing and neither is visible to the other tests:
//
// - `editTargetFor` is the only thing stopping an older message from offering Edit, and
//   the only thing that keeps Edit alive after a stop (a stopped turn's bubble lives in the
//   live layer, which the history-only version of this rule could not see).
// - `editTargetFromRow` is the only thing carrying a turn id from the render to the
//   delegate, which is how a bubble with no uuid is still editable.
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'

// The stream store touches `window` at module scope, so the shim has to exist BEFORE
// anything that imports `TranscriptView` — the same ordering the other transcript
// tests use. Importing statically at the top loads the store with no window and dies.
;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en' }
if (typeof Element === 'undefined') (globalThis as any).Element = class FixtureElement {}
const { configureInlineUserEditing, inlineUserEdits } = await import('./inline-user-edit')
const { renderMsgActionsHtml, userBubbleEditable } = await import('./factories')
const {
  editTargetFor, isEditTarget, rowIsEditTarget, liveUserRenderUnits, editTargetFromRow,
  makeTranscriptClickHandler, makeTranscriptDblClickHandler, UserMessageRow,
} = await import('./TranscriptView')
type Unit = import('./TranscriptView').Unit

const userUnit = (uuid: string, turnId = 't1'): Unit => ({ type: 'user', key: uuid, msg: { uuid, text: 'hi' }, turnId } as any)
const assistantUnit = (uuid: string): Unit => ({ type: 'text', key: uuid, msg: { uuid }, segment: { kind: 'text', text: 'reply' }, turnId: 't1' } as any)
const forkUnit = (uuid: string): Unit => ({ type: 'fork', key: uuid, msg: { uuid, text: '<fork-boilerplate>x</fork-boilerplate> y' }, turnId: 't1' } as any)
const uuidlessUnit = (): Unit => ({ type: 'user', key: 'i-0', msg: { text: 'no uuid' }, turnId: 't1' } as any)
/** The optimistic bubble a send paints: no uuid, because the engine assigns it. */
const liveUser = (turnId?: string) => ({ type: 'live-user', key: `u-${turnId ?? 'x'}`, turnId, msg: { uuid: undefined } })

describe('which message can be edited', () => {
  test('the newest user message is the editable one', () => {
    const units = [userUnit('a'), assistantUnit('r1'), userUnit('b'), assistantUnit('r2')]
    expect(editTargetFor(units, [])).toEqual({ uuid: 'b', turnId: 't1' })
  })

  test('an assistant reply never becomes the editable message', () => {
    // Walking from the end and stopping at the first `user` unit is what makes this
    // true. Taking the last unit of any kind would return the reply.
    const units = [userUnit('a'), assistantUnit('r1')]
    expect(editTargetFor(units, [])?.uuid).toBe('a')
  })

  test('a transcript with no user message is not editable', () => {
    expect(editTargetFor([], [])).toBeNull()
    expect(editTargetFor([assistantUnit('r1')], [])).toBeNull()
  })

  test('a uuid-less history row is skipped rather than offered as a dead entry point', () => {
    // `unitsFromMessages` falls back to a positional `i-N` key when a message has no
    // uuid. Such a row cannot be named as a target, so offering Edit on it would produce
    // a button that always fails. Skipping it keeps the offer on the newest row that can
    // be edited.
    const units = [userUnit('a'), uuidlessUnit()]
    expect(editTargetFor(units, [])?.uuid).toBe('a')
  })

  test('a fork bubble is not treated as an editable user message', () => {
    // Fork / teammate / delegation bubbles are protocol wrappers folded to the sender's
    // prose; editing one would rewrite a marker the model depends on. They are separate
    // unit types, so they are skipped.
    const units = [userUnit('a'), forkUnit('f1')]
    expect(editTargetFor(units, [])?.uuid).toBe('a')
  })

  test('a steered follow-up row is skipped, and the opener before it stays the target', () => {
    // The host marks a mid-turn follow-up at submit time and the projection carries the
    // flag here. Edit is offered on the last turn opener only: a steer is an injection
    // into a turn that was already running, so it is neither the target nor a blocker.
    const steered = { ...userUnit('s1'), steered: true } as Unit
    const units = [userUnit('a'), assistantUnit('r1'), steered]
    expect(editTargetFor(units, [])).toEqual({ uuid: 'a', turnId: 't1' })
  })

  test('a steered live bubble does not become the target either', () => {
    const steeredLive = { type: 'live-user', key: 'u-s', turnId: 'turn-9', msg: { uuid: 'u-steer', steered: true } }
    expect(editTargetFor([userUnit('a')], [steeredLive])).toEqual({ uuid: 'a', turnId: 't1' })
  })
})

describe('a stopped turn stays editable', () => {
  // THE regression this suite exists for. A turn the user stopped keeps its partial output
  // in the live layer and deliberately never reloads history, so the newest bubble on
  // screen is the optimistic one. Reading only the history layer named the PREVIOUS
  // message, which is why Edit vanished — or landed on the wrong bubble — after every stop.

  test('a live bubble with a turn id is the target, addressed by turn', () => {
    expect(editTargetFor([userUnit('settled')], [liveUser('turn-9')])).toEqual({ uuid: '', turnId: 'turn-9' })
  })

  test('the live layer wins over history, because it is newer', () => {
    // The history layer still ends at the PREVIOUS message here. Naming that one would
    // offer to truncate a turn that is already on screen.
    const history = [userUnit('previous'), assistantUnit('r1')]
    expect(editTargetFor(history, [liveUser('turn-9')])?.uuid).toBe('')
    expect(editTargetFor(history, [liveUser('turn-9')])?.turnId).toBe('turn-9')
  })

  test('a live bubble that did learn its uuid is addressed by uuid', () => {
    // A steer's bubble carries the message id the host returned, so it needs no turn
    // lookup.
    const live = { type: 'live-user', key: 'u-1', turnId: 'turn-9', msg: { uuid: 'u-steer' } }
    expect(editTargetFor([userUnit('previous')], [live])).toEqual({ uuid: 'u-steer', turnId: 'turn-9' })
  })

  test('a live bubble with neither uuid nor turn id is not offered', () => {
    // Nothing to address it by: an Edit that cannot name its target would be a dead
    // button. History then keeps the offer, as before.
    expect(editTargetFor([userUnit('settled')], [liveUser(undefined)])).toEqual({ uuid: 'settled', turnId: 't1' })
  })

  test('a client-only submission id falls back to the turn handle', () => {
    // The composer names its optimistic bubble with `submission:<random>` until the
    // engine assigns the real uuid. Sending that id to the host would return
    // `uuid-not-found`, so the turn is the only usable handle.
    const live = { type: 'live-user', key: 'u-pending', turnId: 'turn-9', msg: { uuid: 'submission:abc' } }
    expect(editTargetFor([userUnit('settled')], [live])).toEqual({ uuid: '', turnId: 'turn-9' })
  })

  test('the newest live bubble is the one addressed', () => {
    expect(editTargetFor([], [liveUser('turn-1'), liveUser('turn-2')])?.turnId).toBe('turn-2')
  })
})

describe('isEditTarget matches a row by uuid, else by turn', () => {
  test('a uuid target matches only that uuid', () => {
    const ref = { uuid: 'u1', turnId: 't1' }
    expect(isEditTarget(ref, 'u1', 't1')).toBe(true)
    // Turn alone must not match: several messages share a turn, and only one is the
    // target. Matching by turn here would light up the wrong bubble.
    expect(isEditTarget(ref, 'other', 't1')).toBe(false)
    expect(isEditTarget(ref, undefined, 't1')).toBe(false)
  })

  test('a turn-addressed target matches only that turn', () => {
    const ref = { uuid: '', turnId: 'turn-9' }
    expect(isEditTarget(ref, undefined, 'turn-9')).toBe(true)
    expect(isEditTarget(ref, undefined, 'turn-8')).toBe(false)
    // A row with no turn of its own cannot be the target.
    expect(isEditTarget(ref, undefined, undefined)).toBe(false)
  })

  test('no target names nothing', () => {
    expect(isEditTarget(null, 'u1', 't1')).toBe(false)
  })
})

describe('a steered row never wears the edit handle', () => {
  // Regression: a steer shares its turn id with the opener, so a turn-addressed target
  // matches the injection too. Resolving that match lands on the OPENER's uuid, so the
  // click would succeed while silently rewriting the wrong message. The row's own flag
  // has to veto the turn half.
  const target = { uuid: '', turnId: 'turn-9' }

  test('the turn handle cannot match a steered row', () => {
    expect(rowIsEditTarget(target, undefined, 'turn-9', true)).toBe(false)
    expect(rowIsEditTarget(target, undefined, 'turn-9', false)).toBe(true)
  })

  test('a steered row is refused even when it somehow carries a uuid', () => {
    expect(rowIsEditTarget({ uuid: 'u1', turnId: 't1' }, 'u1', 't1', true)).toBe(false)
  })
})

describe('a live bubble keeps the turn handle the render needs', () => {
  // THE regression this pair exists for. A stopped turn keeps its optimistic bubble in the
  // live layer and never reloads history; the bubble has no uuid, so the turn is the only
  // handle Edit can use. The id is stamped on the live UNIT by `patchSession`, but the row
  // renders the re-projected unit, which only reads the wrapped message — dropping the id
  // there made Edit vanish on exactly the message the feature was built for.
  test('the live unit turn id is carried onto the projected unit', () => {
    const units = liveUserRenderUnits({ turnId: 'turn-9', msg: { role: 'user', text: 'hi' } })
    expect(units.map(u => u.turnId)).toEqual(['turn-9'])
    // And it is still reachable as the edit target end to end.
    expect(editTargetFor([], [{ type: 'live-user', turnId: 'turn-9', msg: { uuid: undefined } }])).toEqual({ uuid: '', turnId: 'turn-9' })
  })

  test('a projected unit that already knows its own turn keeps it', () => {
    // A channel-origin row carries a turn id on the message itself; the live id must not
    // overwrite it.
    const units = liveUserRenderUnits({ turnId: 'live-turn', msg: { role: 'user', text: 'hi', turnId: 'own-turn' } })
    expect(units.map(u => u.turnId)).toEqual(['own-turn'])
  })

  test('a live unit with no turn leaves the projected unit without one', () => {
    const units = liveUserRenderUnits({ turnId: undefined, msg: { role: 'user', text: 'hi' } })
    expect(units.map(u => u.turnId)).toEqual([undefined])
  })
})

describe('the Edit entry point in the action bar', () => {
  const spec = (over: Partial<Parameters<typeof renderMsgActionsHtml>[0]> = {}) =>
    renderMsgActionsHtml({ ts: 0, copyText: 'hi', uuid: 'u1', kind: 'user', archived: false, running: false, ...over })

  test('appears only on the message the transcript says is last', () => {
    expect(spec({ canEdit: true })).toContain('data-action="edit"')
    expect(spec({ canEdit: false })).not.toContain('data-action="edit"')
    expect(spec({})).not.toContain('data-action="edit"')
  })

  test('is the last control, after copy', () => {
    const html = spec({ canEdit: true })
    expect(html.indexOf('data-action="edit"')).toBeGreaterThan(html.indexOf('aria-label="Copy"'))
  })

  test('disappears while the turn runs', () => {
    // The gate is `turn.status === 'inProgress' ? undefined : handler`: the pencil
    // is not rendered at all while the turn it would truncate is live, and the host-side
    // `turn-in-progress` refusal is only the race guard. The sibling rewind/delete
    // controls disable instead; edit hides, because a hidden entry point cannot be
    // clicked into a refusal the user then has to read.
    expect(spec({ canEdit: true, running: true })).not.toContain('data-action="edit"')
    expect(spec({ canEdit: true, running: false })).toContain('data-action="edit"')
  })

  test('the editable gate is one predicate shared by the button and the bubble', () => {
    // `userBubbleEditable` is the single place the four refusals live: the action bar
    // and the row's `data-editable` marker (the double-click target) both read it, so
    // the two entry points can never disagree about which bubble is editable.
    expect(userBubbleEditable(true, false, false, false)).toBe(true)
    expect(userBubbleEditable(true, true, false, false)).toBe(false)
    expect(userBubbleEditable(true, false, true, false)).toBe(false)
    expect(userBubbleEditable(true, false, false, true)).toBe(false)
    expect(userBubbleEditable(false, false, false, false)).toBe(false)
    expect(userBubbleEditable(undefined, false, false, false)).toBe(false)
  })

  test('an archived or read-only transcript offers no edit at all', () => {
    expect(spec({ canEdit: true, archived: true })).not.toContain('data-action="edit"')
    expect(spec({ canEdit: true, readOnly: true })).not.toContain('data-action="edit"')
  })

  test('an assistant reply is never editable', () => {
    expect(renderMsgActionsHtml({ ts: 0, copyText: 'x', kind: 'assistant', archived: false, running: false, canEdit: true }))
      .not.toContain('data-action="edit"')
  })

  test('a bubble with no uuid still gets the pencil when it has a turn', () => {
    // The regression a real-DOM run caught: a stopped turn's optimistic bubble has no uuid,
    // and gating the pencil on `uuid` meant the exact message the user wanted to edit had
    // no button. The turn is a valid handle because the host resolves it through the
    // engine's history.
    const html = renderMsgActionsHtml({ ts: 0, copyText: 'hi', kind: 'user', archived: false, running: false, canEdit: true, editTurn: 'turn-9' })
    expect(html).toContain('data-action="edit"')
  })

  test('a bubble with neither uuid nor turn offers no pencil', () => {
    // Nothing to address the target by, so the button would always fail. A dead entry
    // point is worse than none.
    expect(renderMsgActionsHtml({ ts: 0, copyText: 'hi', kind: 'user', archived: false, running: false, canEdit: true }))
      .not.toContain('data-action="edit"')
  })

  test('a turn handle unlocks edit only, never the uuid-bound controls', () => {
    // rewind / fork all go to host methods that take a messageUuid, and the
    // optimistic bubble has none to give them. Only edit can be resolved by turn, so it is
    // the only control a turn handle may unlock.
    const html = renderMsgActionsHtml({ ts: 0, copyText: 'hi', kind: 'user', archived: false, running: false, canEdit: true, editTurn: 'turn-9' })
    expect(html).toContain('data-action="edit"')
    expect(html).not.toContain('data-action="rewind"')
    expect(html).not.toContain('data-action="branch"')
  })
})

describe('message rewind scope contract', () => {
  const vectors = JSON.parse(readFileSync(fileURLToPath(new URL(
    '../../../../contracts/vectors/message-rewind-scope-vectors.json', import.meta.url,
  )), 'utf8')) as Array<{ name: string; confirmed: boolean; expectedCalls: string[] }>

  for (const vector of vectors) test(vector.name, async () => {
    const window = (globalThis as any).window
    const previous = { klaus: window.klaus, klausDialog: window.klausDialog, tt: window.tt }
    const calls: string[] = []
    let finish!: () => void
    const completed = new Promise<void>(resolve => { finish = resolve })
    try {
      window.tt = (key: string) => key
      window.klaus = { chat: {
        rewindFrom: async (...args: string[]) => {
          calls.push(`rewind:${args.join(':')}`)
          throw Error('test request captured')
        },
      } }
      window.klausDialog = {
        confirm: async ({ message }: { message: string }) => {
          calls.push(`confirm:${message}`)
          if (!vector.confirmed) finish()
          return vector.confirmed
        },
        alert: async () => { finish() },
      }
      const group: any = { dataset: { uuid: 'u1' } }
      const button: any = { dataset: { action: 'rewind' }, disabled: false, closest: (selector: string) =>
        selector === '.msg-action-btn' ? button : selector === '.msg-group' ? group : null }
      makeTranscriptClickHandler('s1')({ target: button, stopPropagation: () => {} } as unknown as Event)
      await completed
      expect(calls).toEqual(vector.expectedCalls)
    } finally {
      Object.assign(window, previous)
    }
  })
})

describe('complete rewind draft restoration', () => {
  const drafts = JSON.parse(readFileSync(fileURLToPath(new URL(
    '../../../../contracts/vectors/message-rewind-scope-vectors.json', import.meta.url,
  )), 'utf8'))[0].restoredDrafts as Array<{ name: string; draft: Record<string, any> }>

  for (const vector of drafts) test(vector.name, async () => {
    const store = await import('../stream-store')
    const window = (globalThis as any).window
    const previous = { klaus: window.klaus, klausDialog: window.klausDialog, restoreRewoundMessage: window.restoreRewoundMessage, setComposerText: window.setComposerText }
    const sessionId = `rewind-draft-${vector.name}`
    const calls: string[] = []
    const response = { ok: true, ...vector.draft }
    try {
      window.klaus = {
        chat: { rewindFrom: async () => { calls.push('rewind'); return response } },
        session: { history: async () => { calls.push('history'); return { messages: [] } } },
      }
      window.klausDialog = { confirm: async () => true, alert: async (message: string) => { throw Error(message) } }
      window.setComposerText = () => { throw Error('complete restoration must not also overwrite the body separately') }
      window.restoreRewoundMessage = async (target: string, draft: object) => {
        expect(target).toBe(sessionId)
        expect(draft).toBe(response)
        calls.push('restore-full-draft')
      }
      await store.loadSessionHistory(sessionId)
      calls.length = 0
      const group: any = { dataset: { uuid: 'u1' } }
      const button: any = { dataset: { action: 'rewind' }, closest: (selector: string) =>
        selector === '.msg-action-btn' ? button : selector === '.msg-group' ? group : null }
      makeTranscriptClickHandler(sessionId)({ target: button, stopPropagation: () => {} } as unknown as Event)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toEqual(['rewind', 'restore-full-draft', 'history'])
    } finally { Object.assign(window, previous) }
  })

  test('failed composer restoration still reconciles already-truncated history', async () => {
    const store = await import('../stream-store')
    const window = (globalThis as any).window
    const previous = { klaus: window.klaus, klausDialog: window.klausDialog, restoreRewoundMessage: window.restoreRewoundMessage }
    const sessionId = 'rewind-restore-failure'
    const calls: string[] = []
    try {
      window.klaus = {
        chat: { rewindFrom: async () => ({ ok: true, text: '', attachments: [] }) },
        session: { history: async () => { calls.push('history'); return { messages: [] } } },
      }
      window.klausDialog = { confirm: async () => true, alert: async (message: string) => { calls.push(`alert:${message}`) } }
      window.restoreRewoundMessage = async () => { throw Error('fixture restore failed') }
      await store.loadSessionHistory(sessionId)
      calls.length = 0
      const group: any = { dataset: { uuid: 'u1' } }
      const button: any = { dataset: { action: 'rewind' }, closest: (selector: string) =>
        selector === '.msg-action-btn' ? button : selector === '.msg-group' ? group : null }
      makeTranscriptClickHandler(sessionId)({ target: button, stopPropagation: () => {} } as unknown as Event)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toEqual(['history', 'alert:fixture restore failed'])
      expect(store.getSessionStream(sessionId).history).toEqual([])
    } finally { Object.assign(window, previous) }
  })
})

describe('message rewind after an interrupted turn', () => {
  for (const { name, confirmed, result, cleared, unattributedSurvivor } of [
    { name: 'successful rewind', confirmed: true, result: { ok: true, text: 'first' }, cleared: true, unattributedSurvivor: true },
    { name: 'already removed target', confirmed: true, result: { ok: false, reason: 'uuid-not-found' }, cleared: true },
    { name: 'canceled rewind', confirmed: false, result: { ok: true, text: 'first' }, cleared: false },
    { name: 'unrelated refusal', confirmed: true, result: { ok: false, reason: 'session-running' }, cleared: false },
  ] as Array<{ name: string; confirmed: boolean; result: any; cleared: boolean; unattributedSurvivor?: boolean }>) {
    test(`${name} reconciles only when authoritative history changed`, async () => {
      const store = await import('../stream-store')
      const window = (globalThis as any).window
      const previous = { klaus: window.klaus, klausDialog: window.klausDialog, tt: window.tt, setComposerText: window.setComposerText }
      const sessionId = `rewind-interrupted-history-${name}`
      const calls: string[] = []
      // Saved history legitimately contains rows the engine has no turn id for
      // (imported messages, compaction and auxiliary rows). A confirmed rewind must
      // still discard the stopped tail held by the live layer when one of those rows
      // survives the rewrite, or the rewound bubble stays on screen after its text
      // returns. The unconfirmed resync below keeps the strict attribution rule.
      const original = [
        ...(unattributedSurvivor ? [{ uuid: 'u0', role: 'user', text: 'older' }] : []),
        { uuid: 'u1', role: 'user', text: 'first', turnId: 't1' },
      ]
      let rewound = false
      try {
        window.tt = (key: string) => key
        window.klaus = {
          session: { history: async () => {
            calls.push('history')
            return { messages: rewound ? original.filter(message => message.uuid !== 'u1') : original }
          } },
          chat: { rewindFrom: async () => { rewound = cleared; calls.push('rewind'); return result } },
        }
        window.klausDialog = { confirm: async () => confirmed, alert: async (message: string) => { calls.push(`alert:${message}`) } }
        window.setComposerText = (text: string) => { calls.push(`composer:${text}`) }
        await store.loadSessionHistory(sessionId)
        store.ingestLocalUserTurn(sessionId, { text: 'second' })
        store.ingestChatEvent({ type: 'stream_mode', sessionId, turnId: 't2', mode: 'requesting' })
        store.ingestChatEvent({ type: 'text_delta', sessionId, turnId: 't2', text: 'partial answer' })
        store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 't2' }, { userInterrupted: true })
        const before = store.getSessionStream(sessionId)
        expect(before.interruptedLiveTurn).toEqual({ turnId: 't2' })
        const group: any = { dataset: { uuid: 'u1' } }
        const button: any = { dataset: { action: 'rewind' }, disabled: false, closest: (selector: string) =>
          selector === '.msg-action-btn' ? button : selector === '.msg-group' ? group : null }
        makeTranscriptClickHandler(sessionId)({ target: button, stopPropagation: () => {} } as unknown as Event)
        await new Promise(resolve => setTimeout(resolve, 0))
        const state = store.getSessionStream(sessionId)
        if (cleared) {
          const vectors = JSON.parse(readFileSync(fileURLToPath(new URL(
            '../../../../contracts/vectors/message-rewind-scope-vectors.json', import.meta.url,
          )), 'utf8'))
          const { history: expectedHistory, ...afterSuccess } = vectors[0].expectedAfterSuccess
          expect(state).toMatchObject(afterSuccess)
          expect(state.history?.map((message: any) => message.uuid)).toEqual(expectedHistory.length
            ? expectedHistory.map((message: any) => message.uuid)
            : (unattributedSurvivor ? ['u0'] : []))
        } else {
          expect(state.history).toBe(before.history)
          expect(state.liveUnits).toBe(before.liveUnits)
          expect(state.interruptedLiveTurn).toEqual({ turnId: 't2' })
        }
        expect(calls).toEqual([
          'history', ...(confirmed ? ['rewind'] : []),
          ...(result.ok && confirmed ? ['composer:first'] : []),
          ...(cleared ? ['history'] : []),
          ...(!result.ok && confirmed ? [`alert:${result.reason === 'uuid-not-found' || result.reason === 'turn-not-in-history' ? 'msg_rewind_stale' : `撤销失败：${result.reason}`}`] : []),
        ])
      } finally {
        Object.assign(window, previous)
      }
    })
  }
})

describe('rewind of an optimistic row carries the turn handle', () => {
  test('a stopped turn bubble sends its live turn id alongside the client-only uuid', async () => {
    const store = await import('../stream-store')
    const window = (globalThis as any).window
    const previous = { klaus: window.klaus, klausDialog: window.klausDialog, tt: window.tt }
    const sessionId = 'rewind-optimistic-turn-handle'
    const calls: string[] = []
    try {
      window.tt = (key: string) => key
      window.klaus = {
        session: { history: async () => ({ messages: [] }) },
        chat: { rewindFrom: async (...args: string[]) => { calls.push(args.join(':')); return { ok: true, text: 'second' } } },
      }
      window.klausDialog = { confirm: async () => true, alert: async (message: string) => { calls.push(`alert:${message}`) } }
      store.ingestLocalUserTurn(sessionId, { text: 'second', uuid: 'submission:abc123' })
      store.ingestChatEvent({ type: 'stream_mode', sessionId, turnId: 't2', mode: 'requesting' })
      store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 't2' }, { userInterrupted: true })
      const group: any = { dataset: { uuid: 'submission:abc123' } }
      const button: any = { dataset: { action: 'rewind' }, disabled: false, closest: (selector: string) =>
        selector === '.msg-action-btn' ? button : selector === '.msg-group' ? group : null }
      makeTranscriptClickHandler(sessionId)({ target: button, stopPropagation: () => {} } as unknown as Event)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls[0]).toBe(`${sessionId}:submission:abc123:t2`)
    } finally { Object.assign(window, previous) }
  })

  test('a saved row without a live unit keeps the two-argument call', async () => {
    const window = (globalThis as any).window
    const previous = { klaus: window.klaus, klausDialog: window.klausDialog, tt: window.tt }
    const sessionId = 'rewind-saved-row-two-args'
    const calls: string[] = []
    try {
      window.tt = (key: string) => key
      window.klaus = {
        session: { history: async () => ({ messages: [] }) },
        chat: { rewindFrom: async (...args: string[]) => { calls.push(args.join(':')); return { ok: true, text: 'x' } } },
      }
      window.klausDialog = { confirm: async () => true, alert: async () => {} }
      const group: any = { dataset: { uuid: 'u1' } }
      const button: any = { dataset: { action: 'rewind' }, disabled: false, closest: (selector: string) =>
        selector === '.msg-action-btn' ? button : selector === '.msg-group' ? group : null }
      makeTranscriptClickHandler(sessionId)({ target: button, stopPropagation: () => {} } as unknown as Event)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls[0]).toBe(`${sessionId}:u1`)
    } finally { Object.assign(window, previous) }
  })
})

describe('rewind history reconciliation races', () => {
  test('a new turn started during reconciliation keeps its live output', async () => {
    const store = await import('../stream-store')
    const window = (globalThis as any).window
    const previous = window.klaus
    const sessionId = 'rewind-new-turn-race'
    let resolveRead!: (value: unknown) => void
    try {
      window.klaus = { session: { history: async () => ({ messages: [{ uuid: 'u1', role: 'user', text: 'first', turnId: 't1' }] }) } }
      await store.loadSessionHistory(sessionId)
      store.ingestLocalUserTurn(sessionId, { text: 'second' })
      store.ingestChatEvent({ type: 'stream_mode', sessionId, turnId: 't2', mode: 'requesting' })
      store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 't2' }, { userInterrupted: true })
      window.klaus.session.history = () => new Promise(resolve => { resolveRead = resolve })
      const reconciled = store.loadSessionHistory(sessionId, { reconcile: true })
      store.ingestLocalUserTurn(sessionId, { text: 'third' })
      store.ingestChatEvent({ type: 'stream_mode', sessionId, turnId: 't3', mode: 'requesting' })
      store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'new answer' })
      const before = store.getSessionStream(sessionId)
      resolveRead({ messages: [] })
      await reconciled
      const after = store.getSessionStream(sessionId)
      expect(after.running).toBe(true)
      expect(after.activeTurnId).toBe('t3')
      expect(after.liveUnits).toBe(before.liveUnits)
      expect(after.historyStale).toBe(true)
    } finally { window.klaus = previous }
  })

  test('waits for an older read before fetching the post-rewind snapshot', async () => {
    const store = await import('../stream-store')
    const window = (globalThis as any).window
    const previous = window.klaus
    const sessionId = 'rewind-pending-read'
    const original = [{ uuid: 'u1', role: 'user', text: 'first', turnId: 't1' }]
    let resolveOld!: (value: unknown) => void
    let reads = 0
    try {
      window.klaus = { session: { history: async () => {
        reads++
        if (reads === 1) return { messages: original }
        if (reads === 2) return new Promise(resolve => { resolveOld = resolve })
        return { messages: [] }
      } } }
      await store.loadSessionHistory(sessionId)
      const olderRead = store.loadSessionHistory(sessionId)
      store.ingestLocalUserTurn(sessionId, { text: 'second' })
      store.ingestChatEvent({ type: 'stream_mode', sessionId, turnId: 't2', mode: 'requesting' })
      store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'partial' })
      store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 't2' }, { userInterrupted: true })
      const reconciled = store.loadSessionHistory(sessionId, { reconcile: true })
      expect(reads).toBe(2)
      resolveOld({ messages: original })
      await Promise.all([olderRead, reconciled])
      expect(reads).toBe(3)
      expect(store.getSessionStream(sessionId).history).toEqual([])
      expect(store.getSessionStream(sessionId).liveUnits).toEqual([])
    } finally { window.klaus = previous }
  })

  test('preserves a stopped turn that fresh history still contains while removing earlier stale rows', async () => {
    const store = await import('../stream-store')
    const window = (globalThis as any).window
    const previous = window.klaus
    const sessionId = 'rewind-preserved-stop'
    let fresh = false
    try {
      window.klaus = { session: { history: async () => ({ messages: fresh
        ? [{ uuid: 'u2', role: 'user', text: 'second', turnId: 't2' }]
        : [{ uuid: 'u1', role: 'user', text: 'first', turnId: 't1' }] }) } }
      await store.loadSessionHistory(sessionId)
      store.ingestLocalUserTurn(sessionId, { text: 'second' })
      store.ingestChatEvent({ type: 'stream_mode', sessionId, turnId: 't2', mode: 'requesting' })
      store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'partial' })
      store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 't2' }, { userInterrupted: true })
      const before = store.getSessionStream(sessionId)
      fresh = true
      await store.loadSessionHistory(sessionId, { reconcile: true })
      const after = store.getSessionStream(sessionId)
      expect(after.history).toEqual([])
      expect(after.liveUnits).toBe(before.liveUnits)
      expect(after.interruptedLiveTurn).toEqual({ turnId: 't2' })
      expect(after.historyStale).toBe(false)
    } finally { window.klaus = previous }
  })
})

describe('the row marks what the delegates may open', () => {
  // `data-editable` is the contract between the render and the double-click delegate, and
  // `data-edit-turn` carries the turn handle the uuid-less bubble needs. The row computes
  // the gate once and stamps both, so neither delegate re-derives recency, running,
  // archived or read-only state of its own.
  const renderRow = (over: Partial<Parameters<typeof UserMessageRow>[0]> = {}) =>
    renderToStaticMarkup(<UserMessageRow
      msg={{ uuid: 'u1', text: 'hi', timestamp: 0 }} composerAuthored archived={false} running={false}
      canEdit turnId="t1" {...over}
    />)

  test('an editable bubble carries the marker and its turn', () => {
    expect(renderRow()).toContain('data-editable="true"')
    expect(renderRow()).toContain('data-edit-turn="t1"')
  })

  test('a running turn, an archived or a read-only transcript leaves the markers off', () => {
    for (const over of [{ running: true }, { archived: true }, { readOnly: true }, { canEdit: false }]) {
      const html = renderRow(over)
      expect(html).not.toContain('data-editable')
      expect(html).not.toContain('data-edit-turn')
    }
  })

  test('the marker and the pencil agree on every gate', () => {
    for (const over of [{}, { running: true }, { archived: true }, { readOnly: true }, { canEdit: false }]) {
      const html = renderRow(over)
      expect(html.includes('data-editable="true"')).toBe(html.includes('data-action="edit"'))
    }
  })

  test('an editable bubble with no turn of its own carries no turn handle', () => {
    // Nothing to address it by beyond the uuid, which is already on the row.
    expect(renderRow({ turnId: undefined })).not.toContain('data-edit-turn')
    expect(renderRow({ turnId: undefined })).toContain('data-editable="true"')
  })

  test('a client-only submission uuid is not handed to the editor as a message uuid', () => {
    const html = renderRow({ msg: { uuid: 'submission:abc', text: 'hi', timestamp: 0 } })
    expect(html).toContain('data-uuid="submission:abc"')
    expect(html).toContain('data-edit-uuid=""')
    expect(html).toContain('data-edit-turn="t1"')
  })
})

describe('editTargetFromRow reads whichever handle the row carries', () => {
  test('a settled row yields its uuid', () => {
    expect(editTargetFromRow({ dataset: { uuid: 'u1', editTurn: 't1' } } as any)).toEqual({ uuid: 'u1', turnId: 't1' })
  })

  test('an optimistic row uses the resolved handle even when its display uuid is client-only', () => {
    expect(editTargetFromRow({ dataset: { uuid: 'submission:abc', editUuid: '', editTurn: 'turn-9' } } as any))
      .toEqual({ uuid: '', turnId: 'turn-9' })
  })

  test('an optimistic row yields its turn and an empty uuid', () => {
    // The whole point of the second handle: the engine assigned a uuid and never reported
    // it, so the turn is all the row has.
    expect(editTargetFromRow({ dataset: { uuid: undefined, editTurn: 'turn-9' } } as any)).toEqual({ uuid: '', turnId: 'turn-9' })
  })

  test('a row with neither handle yields nothing', () => {
    expect(editTargetFromRow({ dataset: {} } as any)).toBeNull()
  })
})

describe('the Edit button and double-click start an independent message edit', () => {
  // The action bar is raw HTML from `renderMsgActionsHtml`, so it has no React onClick:
  // the container delegate in `makeTranscriptClickHandler` is its ONLY click path. A wrong
  // selector there would leave a button that looks live and does nothing.
  //
  const calls: Array<{ sessionId: string; handle: { uuid: string; turnId: string } }> = []
  configureInlineUserEditing({ prepare: (sessionId, handle) => { calls.push({sessionId, handle}); return new Promise(() => {}) },
    submit: async () => {}, failure: String, commands: async () => [], matches: () => true,
    menuActions: () => ({} as any), reference: async () => null })
  beforeEach(() => { calls.length = 0; inlineUserEdits.forgetSession('s1') })

  function editClick(dataset: Record<string, string | undefined>): { stopped: boolean } {
    calls.length = 0
    let stopped = false
    const group: any = { dataset }
    const button: any = {
      dataset: { action: 'edit' },
      disabled: false,
      closest: (asked: string) => asked === '.msg-action-btn' ? button
        : asked === '.msg-actions' ? { dataset: { copyText: 'unused now' } }
          : asked === '.msg-group' ? group : null,
    }
    makeTranscriptClickHandler('s1')({ target: button, stopPropagation: () => { stopped = true } } as unknown as Event)
    return { stopped }
  }

  function dblClickOn(target: any, sessionId = 's1'): void {
    calls.length = 0
    makeTranscriptDblClickHandler(sessionId)({ target, stopPropagation: () => {} } as unknown as Event)
  }

  test('clicking Edit opens the exact message editor', () => {
    const { stopped } = editClick({ uuid: 'u1', editTurn: 't1' })
    expect(stopped).toBe(true)
    expect(calls).toEqual([{ sessionId: 's1', handle: { uuid: 'u1', turnId: 't1' } }])
  })

  test('clicking Edit on an optimistic bubble hands the turn target over', () => {
    editClick({ uuid: undefined, editTurn: 'turn-9' })
    expect(calls).toEqual([{ sessionId: 's1', handle: { uuid: '', turnId: 'turn-9' } }])
  })

  test('a row with no handle does not start an edit', () => {
    editClick({})
    expect(calls.length).toBe(0)
  })

  test('a read-only transcript has no delegate to open an edit with', () => {
    // makeTranscriptClickHandler('') is how the static view builds its delegate.
    calls.length = 0
    const group: any = { dataset: { uuid: 'u1' } }
    const button: any = { dataset: { action: 'edit' }, disabled: false,
      closest: (asked: string) => asked === '.msg-action-btn' ? button : asked === '.msg-actions' ? null : asked === '.msg-group' ? group : null }
    makeTranscriptClickHandler('')({ target: button, stopPropagation: () => {} } as unknown as Event)
    expect(calls.length).toBe(0)
  })

  test('double-click on an editable bubble hands the same target over', () => {
    const group: any = { dataset: { uuid: 'u1', editTurn: 't1' } }
    const child: any = { closest: (asked: string) => asked === '.msg-group.user[data-editable="true"]' ? group : null }
    dblClickOn(child)
    expect(calls).toEqual([{ sessionId: 's1', handle: { uuid: 'u1', turnId: 't1' } }])
  })

  test('double-click on an optimistic bubble hands its turn over', () => {
    const group: any = { dataset: { uuid: undefined, editTurn: 'turn-9' } }
    const child: any = { closest: (asked: string) => asked === '.msg-group.user[data-editable="true"]' ? group : null }
    dblClickOn(child)
    expect(calls).toEqual([{ sessionId: 's1', handle: { uuid: '', turnId: 'turn-9' } }])
  })

  test('a row the render did not mark editable ignores the double-click', () => {
    dblClickOn({ closest: () => null })
    expect(calls.length).toBe(0)
  })

  test('a double-click on a control inside the bubble is not an edit', () => {
    // Selecting text in a code block, or pressing a button twice, must not grab the
    // composer under the user's hands.
    const button: any = { closest: (asked: string) => asked === 'button' ? button : null }
    dblClickOn(button)
    expect(calls.length).toBe(0)
  })

  test('a double-click on the action bar belongs to the bar, not the bubble', () => {
    const bar: any = { closest: (asked: string) => asked === '.msg-actions' ? bar : null }
    dblClickOn(bar)
    expect(calls.length).toBe(0)
  })

  test('a read-only transcript registers no double-click edit', () => {
    const group: any = { dataset: { uuid: 'u1' } }
    const child: any = { closest: (asked: string) => asked === '.msg-group.user[data-editable="true"]' ? group : null }
    dblClickOn(child, '')
    expect(calls.length).toBe(0)
  })
})
