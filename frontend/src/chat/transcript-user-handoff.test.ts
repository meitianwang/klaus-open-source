import { describe, expect, test } from 'bun:test'
import { mergeSubmittedUserHistory, retainUnownedLiveUnits } from './transcript-user-handoff'
import placementVectors from '../../../contracts/vectors/question-answer-placement-vectors.json'
import { TranscriptRenderIdentity } from './transcript/transcript-render-identity'
import { mergeSubmittedAttachments } from './transcript/submitted-message-content'

const submitted = { role: 'user', uuid: 'pending', turnId: 'turn', text: 'A request', localRender: { displayText: 'A request' } }
const live = [{ type: 'live-user', key: 'local-user', turnId: 'turn', msg: submitted }]

describe('submitted history ownership', () => {
  for (const row of placementVectors.cases) test(row.name, () => {
    const input = JSON.stringify(row)
    const units = row.live.map(msg => ({ type: 'live-user', key: msg.uuid, turnId: msg.turnId, msg }))
    const result = mergeSubmittedUserHistory(row.history, units, row.previous ?? [])
    expect(result.map(message => message.uuid)).toEqual(row.expected)
    expect(new Set(result.map(message => message.uuid)).size).toBe(result.length)
    expect(JSON.stringify(row)).toBe(input)
  })
  test('a live message identity locates the answer before a saved final block without timestamps', () => {
    const answer = { role: 'user', uuid: 'answer', turnId: 'turn', text: 'A reply', steered: true, questionAnswer: { turnId: 'turn' } }
    const final = { role: 'assistant', uuid: 'saved-envelope', turnId: 'turn', contentBlocks: [{ phase: 'final_answer', messageId: 'final-message' }] }
    const rows = mergeSubmittedUserHistory([submitted, final], [
      { type: 'live-user', key: 'answer', turnId: 'turn', msg: answer },
      { type: 'live-text', key: 'text', messageId: 'final-message', turnId: 'turn', phase: 'final_answer' },
    ], [])
    expect(rows.map(row => row.uuid)).toEqual(['pending', 'answer', 'saved-envelope'])
  })
  test('an answer timestamp does not imply it arrived after an untimestamped final', () => {
    const answer = { role: 'user', uuid: 'answer', turnId: 'turn', timestamp: 2000, questionAnswer: { turnId: 'turn' } }
    const final = { role: 'assistant', uuid: 'final', turnId: 'turn', isFinalReply: true }
    const rows = mergeSubmittedUserHistory([{ ...submitted, timestamp: 1000 }, final], [{ ...live[0], msg: answer }], [])
    expect(rows.map(row => row.uuid)).toEqual(['pending', 'answer', 'final'])
  })
  test('an incomplete saved turn leaves its opener to the live layer', () => {
    // Inserting a local opener into saved rows was the pre-alignment contract:
    // it fabricated a second history row whenever the read lagged. The turn now
    // owns its input row — the store keeps the live units until saved history
    // holds any row of that turn, and the merge never inserts an opener.
    const reply = { role: 'assistant', turnId: 'turn', uuid: 'reply', text: 'Answer' }
    const rows = mergeSubmittedUserHistory([reply], live, [])
    expect(rows.map(row => row.uuid)).toEqual(['reply'])
    const unowned = retainUnownedLiveUnits(live, [], { turn: 1000 }, false)
    expect(unowned.retained).toBe(1)
    expect(unowned.units[0].turnId).toBe('turn')
    const owned = retainUnownedLiveUnits(live, [reply], { turn: 1000 }, false)
    expect(owned.retained).toBe(0)
    expect(owned.units).toEqual([])
  })
  test('a saved opener replaces the snapshot once, including its actual message uuid', () => {
    const snapshotRow = [{ ...submitted, userRenderSnapshot: true }]
    expect(mergeSubmittedUserHistory([], live, [])).toEqual([])
    const saved = { ...submitted, uuid: 'saved', localRender: undefined }
    const rows = mergeSubmittedUserHistory([saved], [], snapshotRow)
    expect(rows).toHaveLength(1)
    expect(rows[0].uuid).toBe('saved')
    expect(rows[0].userRenderSnapshot).toBeUndefined()
    expect(rows[0].localRender).toEqual(submitted.localRender)
  })
  test('a steer stays live until saved owns its turn; an answer is inserted', () => {
    const steer = { ...submitted, uuid: 'steer', text: 'A follow-up', steered: true }
    expect(mergeSubmittedUserHistory([submitted], [{ ...live[0], msg: steer }], []).map(row => row.uuid)).toEqual(['pending'])
    const answer = { ...submitted, uuid: 'steer', text: 'A follow-up', questionAnswer: { turnId: 'turn' } }
    expect(mergeSubmittedUserHistory([submitted], [{ ...live[0], msg: answer }], []).map(row => row.uuid)).toEqual(['pending', 'steer'])
    const legacy = { role: 'user', text: steer.text }
    expect(mergeSubmittedUserHistory([legacy], [{ ...live[0], msg: steer }], [])).toHaveLength(1)
  })
  test('an unambiguous legacy saved row replaces the submitted snapshot', () => {
    const rows = mergeSubmittedUserHistory([{ role: 'user', text: submitted.text }], live, [])
    expect(rows).toHaveLength(1)
    expect(rows[0].localRender).toEqual(submitted.localRender)
    expect(rows[0].userRenderSnapshot).toBeUndefined()
  })
  test('an identity-less render snapshot never paints beside its saved row', () => {
    const savedUser = { ...submitted, uuid: 'saved-1', turnId: 'turn-1' }
    const savedReply = { role: 'assistant', uuid: 'reply-1', turnId: 'turn-1', isFinalReply: true, text: 'Answer' }
    const snapshot = { role: 'user', text: submitted.text, timestamp: 1000, userRenderSnapshot: true, localRender: submitted.localRender }
    // Carried corruption from an earlier handoff must heal on the next read.
    expect(mergeSubmittedUserHistory([savedUser, savedReply], [], [snapshot]).map(row => row.uuid))
      .toEqual(['saved-1', 'reply-1'])
    // The same shape arriving straight from the live layer must not insert either.
    const liveNoIdentity = [{ type: 'live-user', key: 'u-1', msg: { role: 'user', text: submitted.text, timestamp: 1000, localRender: submitted.localRender } }]
    const merged = mergeSubmittedUserHistory([savedUser, savedReply], liveNoIdentity, [])
    expect(merged.map(row => row.uuid)).toEqual(['saved-1', 'reply-1'])
    expect(merged[0].localRender).toEqual(submitted.localRender)
  })
  test('an identity-less snapshot stays when its text is ambiguous in saved history', () => {
    const twin = { role: 'user', uuid: 'twin', turnId: 'turn-1', text: submitted.text }
    const snapshot = { role: 'user', text: submitted.text, timestamp: 1000, userRenderSnapshot: true }
    // Ambiguous text neither merges nor inserts: the snapshot simply stays out
    // of history, and the store's turn ownership decides whether it renders.
    expect(mergeSubmittedUserHistory([twin, { ...twin, uuid: 'twin-2' }], [], [snapshot])).toHaveLength(2)
  })
  test('an identity-less snapshot merges into the turn its send opened', () => {
    const savedUser = { role: 'user', uuid: 'saved-1', turnId: 'turn-1', text: '/expand me' }
    const savedReply = { role: 'assistant', uuid: 'reply-1', turnId: 'turn-1', isFinalReply: true, text: 'Answer' }
    const snapshot = { role: 'user', text: '/expand me with later wording', timestamp: 1900, userRenderSnapshot: true }
    const rows = mergeSubmittedUserHistory([savedUser, savedReply], [], [snapshot], { 'turn-1': 2000, 'turn-2': 9000 })
    expect(rows.map(row => row.uuid)).toEqual(['saved-1', 'reply-1'])
  })
  test('a send that never became a turn is not committed as history', () => {
    const savedUser = { role: 'user', uuid: 'saved-1', turnId: 'turn-1', text: 'Earlier request' }
    const snapshot = { role: 'user', text: 'Refused request', timestamp: 9000, userRenderSnapshot: true }
    const refused = [{ type: 'live-user', key: 'u', msg: snapshot }, { type: 'live-error', key: 'e', text: 'refused' }]
    expect(mergeSubmittedUserHistory([savedUser], refused, [], { 'turn-1': 2000 }).map(row => row.uuid)).toEqual(['saved-1'])
    // A lagging read no longer inserts the opener either: retention moved to
    // the store's turn ownership, so the merge stays out of history entirely.
    const lagging = mergeSubmittedUserHistory([savedUser], [{ type: 'live-user', key: 'u', msg: snapshot }], [], { 'turn-1': 2000 })
    expect(lagging).toHaveLength(1)
    // The lagging flush (read brought no new saved rows) keeps the retryable send
    // visible in the live layer; an advancing read drops it.
    expect(retainUnownedLiveUnits([{ type: 'live-user', key: 'u', msg: snapshot }], [savedUser], { 'turn-1': 2000 }, false, false).retained).toBe(1)
    expect(retainUnownedLiveUnits([{ type: 'live-user', key: 'u', msg: snapshot }], [savedUser], { 'turn-1': 2000 }, false, true).retained).toBe(0)
  })
  test('matching text never merges separate identified turns or ambiguous legacy rows', () => {
    const other = { ...submitted, uuid: 'other', turnId: 'other-turn' }
    // The live opener is not inserted into history any more; the store keeps it
    // in the live layer until saved history owns its turn.
    expect(mergeSubmittedUserHistory([other], live, [])).toHaveLength(1)
    expect(retainUnownedLiveUnits(live, [other], { turn: 1000 }, false).retained).toBe(1)
    const legacy = { role: 'user', text: submitted.text }
    expect(mergeSubmittedUserHistory([legacy, { ...legacy }], live, [])).toHaveLength(2)
  })
  test('changed saved text does not inherit an older authored display snapshot', () => {
    const rows = mergeSubmittedUserHistory([{ ...submitted, text: 'Edited request', localRender: undefined }], live, [])
    expect(rows[0].localRender).toBeUndefined()
    expect(rows[0].text).toBe('Edited request')
  })
  test('a saved row keeps its local display envelope across repeated history refreshes', () => {
    const saved = { ...submitted, localRender: undefined }
    const first = mergeSubmittedUserHistory([saved], live, [])
    expect(first).toEqual([submitted])
    expect(mergeSubmittedUserHistory([saved], [], first)).toEqual(first)
    expect(mergeSubmittedUserHistory([], [], first)).toEqual([])
  })
  test('retained saved display metadata cannot override authoritative metadata or changed text', () => {
    const saved = { ...submitted, localRender: { displayText: 'Saved display' } }
    expect(mergeSubmittedUserHistory([saved], [], [submitted])).toEqual([saved])
    const edited = { ...submitted, text: 'Changed request', localRender: undefined }
    expect(mergeSubmittedUserHistory([edited], [], [submitted])).toEqual([edited])
    const other = { ...submitted, uuid: 'other', turnId: 'other-turn', localRender: undefined }
    expect(mergeSubmittedUserHistory([other], [], [submitted])).toEqual([other])
  })
})

describe('turn-keyed live retention', () => {
  const opener = { type: 'live-user', key: 'u1', turnId: 'turn-2', msg: { role: 'user', text: 'A request', timestamp: 4900 } }
  const work = { type: 'live-tools', key: 't1', turnId: 'turn-2', order: [], startedAtMs: 5000 }
  test('live units of a turn saved history owns are dropped', () => {
    const saved = [{ role: 'user', uuid: 's', turnId: 'turn-2', text: 'A request' }]
    const result = retainUnownedLiveUnits([opener, work], saved, { 'turn-2': 5000 }, false)
    expect(result.retained).toBe(0)
    expect(result.units).toEqual([])
  })
  test('live units of a turn saved history lacks are retained', () => {
    const result = retainUnownedLiveUnits([opener, work], [], { 'turn-2': 5000 }, false)
    expect(result.retained).toBe(2)
  })
  test('an unstamped opener is attributed to the turn its send opened and stamped', () => {
    const unstamped = { type: 'live-user', key: 'u1', msg: { role: 'user', text: 'A request', timestamp: 4900 } }
    const result = retainUnownedLiveUnits([unstamped], [], { 'turn-1': 1000, 'turn-2': 5000 }, false)
    expect(result.retained).toBe(1)
    expect(result.units[0].turnId).toBe('turn-2')
  })
  test('a refused send is dropped, never retained as history', () => {
    const refused = { type: 'live-user', key: 'u1', msg: { role: 'user', text: 'Nope', timestamp: 9000 } }
    const result = retainUnownedLiveUnits([refused], [{ role: 'user', uuid: 's', turnId: 'turn-1' }], { 'turn-1': 1000 }, true)
    expect(result.retained).toBe(0)
  })
  test('an unstamped unit without a terminal word survives a lagging admission read', () => {
    const unstamped = { type: 'live-user', key: 'u1', msg: { role: 'user', text: 'A request', timestamp: 9000 } }
    const result = retainUnownedLiveUnits([unstamped], [{ role: 'user', uuid: 's', turnId: 'turn-1' }], { 'turn-1': 1000 }, false, false)
    expect(result.retained).toBe(1)
  })
})

describe('render identity aliases', () => {
  test('turn, message and saved-history aliases keep the original local identities', () => {
    const ids = new TranscriptRenderIdentity()
    const initial = ids.turn(undefined, 'local-user', submitted)
    const row = ids.message(initial, submitted, 'local-user:0', true)
    expect(ids.turn('turn', 'local-user', { ...submitted, uuid: 'saved' })).toBe(initial)
    expect(ids.turn('turn', 'history-group', { ...submitted, uuid: 'saved' })).toBe(initial)
    expect(ids.message(initial, { ...submitted, uuid: 'saved' }, 'saved', true)).toBe(row)
    expect(ids.message(initial, { ...submitted, uuid: 'steer', steered: true }, 'steer', false)).not.toBe(row)
  })
  test('separate segments of one owner keep distinct frame identities', () => {
    const ids = new TranscriptRenderIdentity()
    const first = ids.turn('turn', 'first', submitted)
    const second = ids.turn('turn', 'second', { uuid: 'follow-up' }, true)
    expect(second).not.toBe(first)
    expect(ids.turn('turn', 'saved-second', { uuid: 'follow-up' }, true)).toBe(second)
  })
})

describe('submitted attachment reconciliation', () => {
  test('persisted image blocks replace previews while preserving names and authored order', () => {
    const local = [{ type: 'image', name: 'same.png', path: '/upload/a', src: 'blob:a' },
      { type: 'image', name: 'same.png', path: '/upload/b', src: 'blob:b' }]
    const replay = [{ type: 'image', name: 'hash-a.png', path: '/pool/a', src: 'media:a' },
      { type: 'image', name: 'hash-b.png', path: '/pool/b', src: 'media:b' }]
    const rows = mergeSubmittedAttachments(local, replay)
    expect(rows.map(row => [row.name, row.path, row.src])).toEqual([['same.png', '/pool/a', 'media:a'], ['same.png', '/pool/b', 'media:b']])
  })
  test('repeated file blocks deduplicate by path while different files remain separate', () => {
    const a = { type: 'file', name: 'report.pdf', path: '/upload/a' }
    const b = { ...a, path: '/upload/b' }
    expect(mergeSubmittedAttachments([a], [a, b])).toEqual([a, b])
  })
})

describe('running turn retention', () => {
  test('a running turn keeps its stamped live units after its input row flushes', () => {
    const savedUserRow = { role: 'user', uuid: 'saved-user', turnId: 'turn-run', text: 'go', timestamp: 1000 }
    const stamped = [{ type: 'live-text', key: 't1', turnId: 'turn-run', text: 'streaming' }]
    // Settled: saved owns the whole turn, the live tail hands off.
    expect(retainUnownedLiveUnits(stamped, [savedUserRow], {}, false, true, null).retained).toBe(0)
    // Still running: the flushed input row proves nothing about the work.
    expect(retainUnownedLiveUnits(stamped, [savedUserRow], {}, false, true, 'turn-run').retained).toBe(1)
  })
  test('an optimistic send whose turn already flushed its input row survives while running', () => {
    const savedUserRow = { role: 'user', uuid: 'saved-user', turnId: 'turn-new', text: 'next', timestamp: 5000 }
    const optimistic = [{ type: 'live-user', key: 'opt', msg: { role: 'user', uuid: 'opt', text: 'next', timestamp: 5000 } }]
    const clock = { 'turn-new': 5000 }
    expect(retainUnownedLiveUnits(optimistic, [savedUserRow], clock, false, true, null).retained).toBe(0)
    expect(retainUnownedLiveUnits(optimistic, [savedUserRow], clock, false, true, 'turn-new').retained).toBe(1)
  })
})

describe('flush-lag retention', () => {
  test('a settled turn whose work has not flushed is not owned by its input row', () => {
    const savedUserRow = { role: 'user', uuid: 'saved-user', turnId: 'turn-lag', text: 'go', timestamp: 1000 }
    const stamped = [{ type: 'live-text', key: 't1', turnId: 'turn-lag', text: 'work' }]
    expect(retainUnownedLiveUnits(stamped, [savedUserRow], {}, false, true, null, new Set(['turn-lag'])).retained).toBe(1)
    expect(retainUnownedLiveUnits(stamped, [savedUserRow], {}, false, true, null, new Set()).retained).toBe(0)
  })
})
