import { beforeEach, describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import type { FriendSummary } from '../../../../shared/friends'
import { friendMentionValue } from '../../../../shared/friends'
import { fetchFriendRows, projectFriendRows, friendsQueryKey } from './mention-queries'
import { normalizeComposerReferences, replaceComposerReferenceRange, syncComposerReferences } from './reference-token'
import { createComposerDraft, normalizeComposerDraft } from './slash-draft'
import { filterMentionRows, mentionRows, selectableEntries } from './mention-sections'

;(globalThis as any).window = { addEventListener: () => {} }
const { queuedComposerReferences } = await import('./queue-row-content')

const friend = (overrides: Partial<FriendSummary> = {}): FriendSummary => ({
  id: 'friendship-a', userId: 'user-b', displayName: 'Alice', avatarUrl: null, status: 'accepted',
  allowIncomingAgentTasks: false, peerAllowsAgentTasks: true, online: true, ...overrides,
})

beforeEach(() => { (globalThis as any).window = {} })

describe('friend mention recipients', () => {
  test('only accepted relationships appear in the picker; authorization remains directional', async () => {
    const accepted = friend({ allowIncomingAgentTasks: true, peerAllowsAgentTasks: false })
    ;(globalThis as any).window.klaus = { friends: { list: async () => ({ signedIn: true, friends: [
      friend({ id: 'incoming', status: 'pending-incoming' }), friend({ id: 'outgoing', status: 'pending-outgoing' }), accepted,
    ] }) } }
    expect(await fetchFriendRows()).toEqual([accepted])
    const [entry] = projectFriendRows([accepted], key => key)
    expect(entry.friendId).toBe(accepted.id)
    expect(entry.rel).toContain('friends_peer_not_authorized')
    expect(entry.rel).not.toContain('friends_peer_authorized')
  })

  test('signed-out users have no recipients, while transport failure is explicit', async () => {
    ;(globalThis as any).window.klaus = { friends: { list: async () => ({ signedIn: false, friends: [] }) } }
    expect(await fetchFriendRows()).toEqual([])
    ;(globalThis as any).window.klaus.friends.list = async () => { throw new Error('relay unavailable') }
    await rejects(fetchFriendRows(), /relay unavailable/)
    ;(globalThis as any).window.klaus = {}
    await rejects(fetchFriendRows(), /friends_unavailable/)
  })

  test('online and authorization text is translated at projection time and searching retains recipient identity', () => {
    const rows = [friend(), friend({ id: 'friendship-b', displayName: 'Bob', online: false, peerAllowsAgentTasks: false })]
    const projected = projectFriendRows(rows, key => `zh:${key}`)
    expect(projected[1].rel).toBe('zh:friends_offline · zh:friends_peer_not_authorized')
    expect(projectFriendRows(rows, key => `en:${key}`)[1].rel).toBe('en:friends_offline · en:friends_peer_not_authorized')
    const choices = selectableEntries(mentionRows([{ key: 'friends', labelKey: 'mention_group_friends', rows: filterMentionRows(projected, 'BOB') }]))
    expect(choices).toHaveLength(1)
    expect(choices[0].friendId).toBe('friendship-b')
    expect(friendsQueryKey()).toEqual(friendsQueryKey())
  })
})

describe('structured friend mentions survive ordinary conversation editing', () => {
  test('keeps recipient metadata through draft persistence, whitespace preservation and queue previews', () => {
    const id = 'friendship-a'
    const inserted = replaceComposerReferenceRange('  @Alice review this', 2, 8, '', { kind: 'friend', name: 'Alice', id, value: friendMentionValue(id) })
    const draft = normalizeComposerDraft(JSON.parse(JSON.stringify(createComposerDraft(inserted.text, null, null, [inserted.reference]))))
    expect(draft.references[0].id).toBe(id)
    expect(draft.references[0].kind).toBe('friend')
    const references = normalizeComposerReferences(draft.text, draft.references)
    expect(references[0].range.start).toBe(2)
    expect(references[0].value).toBe(friendMentionValue(id))
    const preview = queuedComposerReferences({ displayText: draft.text, composerReferences: references }, draft.text.trim())
    expect(preview[0].range.start).toBe(0)
    expect(preview[0].id).toBe(id)
  })

  test('shifts the reference when text is added before it and removes it when its address is edited', () => {
    const value = friendMentionValue('friendship-a')
    const reference = { kind: 'friend' as const, name: 'Alice', id: 'friendship-a', value, range: { start: 0, end: value.length } }
    const shifted = syncComposerReferences(value, `please ${value}`, [reference])
    expect(shifted[0].range.start).toBe(7)
    expect(shifted[0].id).toBe(reference.id)
    expect(syncComposerReferences(value, friendMentionValue('friendship-b'), [reference])).toEqual([])
  })

  test('rejects plain text, absent recipient IDs, mismatched IDs, invalid IDs and stale ranges', () => {
    const value = friendMentionValue('friendship-a')
    const valid = { kind: 'friend', name: 'Alice', id: 'friendship-a', value, range: { start: 0, end: value.length } }
    expect(normalizeComposerReferences(value, null)).toEqual([])
    for (const invalid of [
      { ...valid, id: undefined }, { ...valid, id: 'friendship-b' }, { ...valid, id: '../friendship-a' },
      { ...valid, range: { start: 1, end: value.length } },
    ]) expect(normalizeComposerReferences(value, [invalid])).toEqual([])
    expect(normalizeComposerReferences(value, [valid])).toHaveLength(1)
  })
})
