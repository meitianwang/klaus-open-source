import { readFile } from 'node:fs/promises'
import { expect, test } from 'bun:test'
import type { FriendsRuntimeSnapshot, FriendTaskGrant } from '../../../../shared/friends'
import { I18N } from '../../i18n/messages'
import { enqueueDefaultGrantChange, type GrantViewData } from './default-grant-state'

const initial: FriendTaskGrant = { deviceId: 'fixture-device', mode: 'manual', policy: 'approve', computerUse: false, apps: [], directories: [], remember: false }
const targets = { projects: [], workspaces: [] }
const runtime = (grant: FriendTaskGrant): FriendsRuntimeSnapshot => ({ signedIn: true, currentDeviceId: initial.deviceId,
  receiver: null, tasks: [], templates: [], outgoing: [], defaultGrant: grant, friendFilesRoot: null, executionTargets: targets })

function fixture(save = async (grant: FriendTaskGrant) => runtime(grant)) {
  let data: GrantViewData = { draft: initial, confirmedPersisted: initial, deviceId: initial.deviceId, sharedRoot: null,
    targets, apps: { available: true, apps: [{ id: 'fixture.app', name: 'Fixture' }] } }
  const calls: FriendTaskGrant[] = [], updates: FriendsRuntimeSnapshot[] = []
  return { calls, updates, get data() { return data }, edit(patch: Partial<FriendTaskGrant>) {
    enqueueDefaultGrantChange(draft => ({ ...draft, ...patch }), change => { data = change(data)! }, {
      setDefaultGrant: ({ grant }) => { calls.push(grant); return save(grant) }, onRuntime: snapshot => { updates.push(snapshot) },
    })
    return data.pending?.done
  } }
}

test('default permission settings have no manual save action or save strings', async () => {
  const source = await readFile(new URL('./DefaultFriendGrant.tsx', import.meta.url), 'utf8')
  expect(source).not.toMatch(/grant-settings-actions|friends_default_grant_save|friends_saved/)
  for (const messages of Object.values(I18N)) {
    expect(messages).not.toHaveProperty('friends_default_grant_save')
    expect(messages).not.toHaveProperty('friends_saved')
  }
})

test('each changed permission persists and publishes its runtime', async () => {
  const f = fixture()
  const edits: Partial<FriendTaskGrant>[] = [{ policy: 'auto' }, { mode: 'auto-edit' },
    { target: { kind: 'project', root: '/fixture/project' } }, { network: true },
    { directories: [{ path: '/fixture/docs', access: 'read' }] }, { directories: [{ path: '/fixture/docs', access: 'write' }] }, { directories: [] }]
  for (const [index, edit] of edits.entries()) {
    const done = f.edit(edit)
    expect(f.data.draft).toMatchObject(edit)
    await done
    expect(f.calls).toHaveLength(index + 1)
    expect(f.calls[index]).toMatchObject(edit)
    expect(f.updates[index].defaultGrant).toEqual(f.calls[index])
    expect(f.data.confirmedPersisted).toEqual(f.calls[index])
  }
})

test('empty Computer Use stays expanded without granting application access', async () => {
  const f = fixture()
  expect(f.edit({ computerUse: true })).toBeUndefined()
  expect(f.calls).toHaveLength(0)
  expect(f.data.draft.computerUse).toBe(true)
  await f.edit({ apps: ['fixture.app', 'fixture.app', 'missing.app'] })
  expect(f.calls[0]).toMatchObject({ computerUse: true, apps: ['fixture.app'] })
  await f.edit({ apps: [] })
  expect(f.calls[1]).toMatchObject({ computerUse: false, apps: [] })
  expect(f.data.draft).toMatchObject({ computerUse: true, apps: [] })
})

test('slow saves run serially and coalesce waiting edits', async () => {
  const first = Promise.withResolvers<FriendsRuntimeSnapshot>()
  let submitted = 0
  const f = fixture(async grant => ++submitted === 1 ? first.promise : runtime(grant))
  const done = f.edit({ network: true })
  await Promise.resolve()
  expect(f.calls).toHaveLength(1)
  expect(f.edit({ mode: 'auto-edit' })).toBe(done)
  expect(f.edit({ mode: 'scoped-auto' })).toBe(done)
  expect(f.calls).toHaveLength(1)
  first.resolve(runtime(f.calls[0]))
  await done
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]).toMatchObject({ network: true, mode: 'scoped-auto' })
  expect(f.data.pending).toBeUndefined()
})

test('a rejected save restores the last confirmed grant and exposes the failure', async () => {
  const f = fixture(async grant => {
    if (grant.network) throw new Error('Fixture save rejected')
    return runtime(grant)
  })
  await f.edit({ mode: 'auto-edit' })
  await f.edit({ network: true })
  expect(f.data.draft).toEqual(f.calls[0])
  expect(f.data.confirmedPersisted).toEqual(f.calls[0])
  expect(f.data.error).toBe('Fixture save rejected')
  expect(f.data.saveError).toBe(true)
  expect(f.updates).toHaveLength(1)
})
