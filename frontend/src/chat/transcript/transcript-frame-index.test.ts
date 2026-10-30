import { describe, expect, test } from 'bun:test'
import { TranscriptFrameIndex } from './transcript-frame-index'
import { TranscriptRenderIdentity } from './transcript-render-identity'

interface Group { key: string; turnId?: string; opener?: { uuid: string } }

describe('saved frame projection ownership', () => {
  test('text-only live updates reuse the historical index without revisiting saved openers', () => {
    const identity = new TranscriptRenderIdentity()
    const index = new TranscriptFrameIndex<Group>()
    const groups = Array.from({ length: 5000 }, (_, row) => ({ key: `group-${row}`, turnId: `turn-${row}` }))
    let reads = 0
    const opener = (group: Group) => { reads++; return group.opener }
    const first = index.read(groups, identity, opener)
    for (let update = 0; update < 120; update++) expect(index.read(groups, identity, opener)).toBe(first)
    expect(reads).toBe(5000)
    expect(first.frames.slice(4998).map(frame => frame.saved.turnId)).toEqual(['turn-4998', 'turn-4999'])
    expect(first.byKey.get(first.frames[4999].key)?.index).toBe(4999)
  })

  test('optimistic, acknowledged and saved frames retain the same identity after paging', () => {
    const identity = new TranscriptRenderIdentity()
    const index = new TranscriptFrameIndex<Group>()
    const local = identity.turn(undefined, 'local-user', { uuid: 'pending' })
    expect(identity.turn('turn-a', 'local-user', { uuid: 'saved-user' })).toBe(local)
    const group: Group = { key: 'saved-group', turnId: 'turn-a', opener: { uuid: 'saved-user' } }
    const first = index.read([group], identity, row => row.opener)
    expect(first.frames[0].key).toBe(local)
    const older: Group = { key: 'older', turnId: 'older-turn' }
    const paged = index.read([older, group], identity, row => row.opener)
    expect(paged.frames[1].key).toBe(local)
    expect(paged.frames[1].saved).toBe(group)
    expect(paged.byKey.get(local)?.index).toBe(1)
  })

  test('message aliases do not invalidate history but newly observed turn aliases do', () => {
    const identity = new TranscriptRenderIdentity()
    const index = new TranscriptFrameIndex<Group>()
    const groups: Group[] = [{ key: 'saved', turnId: 'turn-a' }]
    const first = index.read(groups, identity, row => row.opener)
    identity.message(first.frames[0].key, { uuid: 'message-a' }, 'message-source', true)
    expect(index.read(groups, identity, row => row.opener)).toBe(first)
    identity.turn('turn-a', 'new-live-source')
    const refreshed = index.read(groups, identity, row => row.opener)
    expect(refreshed).not.toBe(first)
    expect(refreshed.frames[0].key).toBe(first.frames[0].key)
    expect(index.read(groups, identity, row => row.opener)).toBe(refreshed)
  })

  test('separate segments of one owner stay distinct and an empty history drops old frames', () => {
    const identity = new TranscriptRenderIdentity()
    const index = new TranscriptFrameIndex<Group>()
    const groups: Group[] = [
      { key: 'first', turnId: 'turn-a', opener: { uuid: 'first-message' } },
      { key: 'second', turnId: 'turn-a', opener: { uuid: 'second-message' } },
    ]
    const first = index.read(groups, identity, row => row.opener)
    expect(new Set(first.frames.map(frame => frame.key)).size).toBe(2)
    expect(first.frames.map(frame => frame.saved.opener?.uuid)).toEqual(['first-message', 'second-message'])
    const empty = index.read([], identity, row => row.opener)
    expect(empty.frames).toEqual([])
    expect(empty.byKey.size).toBe(0)
    expect(empty.structure).toBe('')
  })
})
