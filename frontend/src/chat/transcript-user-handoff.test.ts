import { describe, expect, test } from 'bun:test'
import { mergeSubmittedUserHistory } from './transcript-user-handoff'
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
  test('an incomplete saved turn retains its submitted opener before its reply', () => {
    const reply = { role: 'assistant', turnId: 'turn', uuid: 'reply', text: 'Answer' }
    const rows = mergeSubmittedUserHistory([reply], live, [])
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant'])
    expect(rows[0].userRenderSnapshot).toBe(true)
    expect(mergeSubmittedUserHistory([reply], [], rows)).toEqual(rows)
  })
  test('a saved opener replaces the snapshot once, including its actual message uuid', () => {
    const snapshot = mergeSubmittedUserHistory([], live, [])
    const saved = { ...submitted, uuid: 'saved', localRender: undefined }
    const rows = mergeSubmittedUserHistory([saved], [], snapshot)
    expect(rows).toHaveLength(1)
    expect(rows[0].uuid).toBe('saved')
    expect(rows[0].userRenderSnapshot).toBeUndefined()
    expect(rows[0].localRender).toEqual(submitted.localRender)
  })
  test('a steer or question answer never takes the opener slot', () => {
    for (const extra of [{ steered: true }, { questionAnswer: { turnId: 'turn' } }]) {
      const steer = { ...submitted, uuid: 'steer', text: 'A follow-up', ...extra }
      const rows = mergeSubmittedUserHistory([submitted], [{ ...live[0], msg: steer }], [])
      expect(rows.map(row => row.uuid)).toEqual(['pending', 'steer'])
      const legacy = { role: 'user', text: steer.text }
      expect(mergeSubmittedUserHistory([legacy], [{ ...live[0], msg: steer }], [])).toHaveLength(2)
    }
  })
  test('an unambiguous legacy saved row replaces the submitted snapshot', () => {
    const rows = mergeSubmittedUserHistory([{ role: 'user', text: submitted.text }], live, [])
    expect(rows).toHaveLength(1)
    expect(rows[0].localRender).toEqual(submitted.localRender)
    expect(rows[0].userRenderSnapshot).toBeUndefined()
  })
  test('matching text never merges separate identified turns or ambiguous legacy rows', () => {
    const other = { ...submitted, uuid: 'other', turnId: 'other-turn' }
    expect(mergeSubmittedUserHistory([other], live, [])).toHaveLength(2)
    const legacy = { role: 'user', text: submitted.text }
    expect(mergeSubmittedUserHistory([legacy, { ...legacy }], live, [])).toHaveLength(3)
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
