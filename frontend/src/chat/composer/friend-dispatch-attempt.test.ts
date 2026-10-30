import { expect, test } from 'bun:test'
import { friendDispatchAttempts } from './friend-dispatch-attempt'

test('a lost receipt survives reload and a confirmed new send receives another identity', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  for (const scope of ['main', 'side']) {
    const first = friendDispatchAttempts(storage, scope).acquire('session:immutable-payload')
    const restored = friendDispatchAttempts(storage, scope).acquire('session:immutable-payload')
    expect(restored.id).toBe(first.id)
    expect(friendDispatchAttempts(storage, scope).acquire('other-session:immutable-payload').id).not.toBe(first.id)
    friendDispatchAttempts(storage, scope).accepted(restored)
    expect(friendDispatchAttempts(storage, scope).acquire('session:immutable-payload').id).not.toBe(first.id)
  }
})
