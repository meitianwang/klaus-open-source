import { describe, expect, test } from 'bun:test'
import { TranscriptRenderIdentity } from './transcript-render-identity'

describe('submitted render identity', () => {
  test('pending and canonical inputs retain both turn and message keys through UUID assignment', () => {
    const identity = new TranscriptRenderIdentity()
    const local = { uuid: 'client:input', localRender: { clientMessageId: 'client:input' } }
    const canonical = { uuid: 'server-input', clientMessageId: 'client:input' }
    const turn = identity.turn(undefined, 'pending-frame', local)
    const message = identity.message(turn, local, 'pending-input', true)
    expect(identity.turn('actual-turn', 'saved-frame', canonical)).toBe(turn)
    expect(identity.message(turn, canonical, 'saved-input', true)).toBe(message)
    expect(identity.turn('actual-turn', 'later-history-page')).toBe(turn)
  })

  test('modern inputs never borrow reused source, opener or protocol UUID aliases from another client identity', () => {
    const identity = new TranscriptRenderIdentity()
    const first = { uuid: 'server', clientMessageId: 'client:first', text: 'same words' }
    const second = { uuid: 'server', clientMessageId: 'client:second', text: 'same words' }
    const a = identity.turn('turn-a', 'reused-frame', first)
    const b = identity.turn('turn-b', 'reused-frame', second)
    expect(b).not.toBe(a)
    const ma = identity.message(a, first, 'reused-source', true)
    const mb = identity.message(b, second, 'reused-source', true)
    expect(mb).not.toBe(ma)
    expect(identity.message(a, first, 'another-page', true)).toBe(ma)
    expect(identity.turn('turn-a', 'another-frame', first)).toBe(a)
  })

  test('steering segments retain their own identity without replacing the owner turn key', () => {
    const identity = new TranscriptRenderIdentity()
    const opener = { uuid: 'opener', clientMessageId: 'client:opener' }
    const turn = identity.turn('actual-turn', 'opener-frame', opener)
    const steer = { uuid: 'steer', clientMessageId: 'steer', steered: true }
    expect(identity.turn('actual-turn', 'steer-frame', steer)).toBe(turn)
    const segment = identity.turn('actual-turn', 'steer-segment', steer, true)
    expect(segment).not.toBe(turn)
    expect(identity.turn('actual-turn', 'saved-segment', { ...steer, uuid: 'canonical-steer' }, true)).toBe(segment)
    expect(identity.turn('actual-turn', 'history-owner')).toBe(turn)
  })
})
