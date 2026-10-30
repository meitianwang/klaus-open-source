import { expect, test } from 'bun:test'
import { createUltraSelection, requiresUltraAccessConfirmation, type UltraAccessDecision } from './ultra-selection'
import { createPreferenceSaver } from './preference-save'
import type { PermissionPreset } from './permission-select'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ sessionId = 'main' as string | undefined, permission = 'bypassPermissions' as PermissionPreset } = {}) {
  let selection = { sessionId, enabled: false, model: 'codex:model' }
  let mode = permission
  let confirmations = 0
  const decision = deferred<UltraAccessDecision>()
  const errors: unknown[] = []
  const writes: unknown[][] = []
  let persist: () => Promise<void> = async () => {}
  const saver = createPreferenceSaver({ getSessionId: () => selection.sessionId,
    getValue: () => selection.enabled, setValue: enabled => { selection = { ...selection, enabled } },
    onError: error => errors.push(error) })
  const controller = createUltraSelection({ getSelection: () => selection,
    getPermission: async () => ({ mode }),
    confirm: () => { confirmations++; return decision.promise },
    save: (level, id, permissionMode) => saver.save(level, async value => {
      writes.push([value, id, permissionMode])
      await persist()
      if (permissionMode) mode = permissionMode
    }), onError: error => errors.push(error),
  })
  return { controller, decision, writes, errors, level: () => selection.enabled, permission: () => mode,
    confirmations: () => confirmations,
    update: (next: Partial<typeof selection>) => { selection = { ...selection, ...next } },
    persist: (next: () => Promise<void>) => { persist = next },
  }
}

test('only entering Ultra with Full access asks for confirmation', () => {
  expect(requiresUltraAccessConfirmation(true, false, 'bypassPermissions')).toBe(true)
  for (const mode of ['default', 'default'] as PermissionPreset[]) expect(requiresUltraAccessConfirmation(true, false, mode)).toBe(false)
  expect(requiresUltraAccessConfirmation(true, true, 'bypassPermissions')).toBe(false)
  expect(requiresUltraAccessConfirmation(false, true, 'bypassPermissions')).toBe(false)
})

test('cancel does not change reasoning or permissions', async () => {
  const f = fixture()
  const selected = f.controller.choose(true)
  await Promise.resolve()
  expect(f.level()).toBe(false)
  f.decision.resolve('cancel')
  await selected
  expect(f.writes).toEqual([])
  expect(f.level()).toBe(false)
  expect(f.permission()).toBe('bypassPermissions')
})

test('Continue saves Ultra and restricted permission in one host request', async () => {
  const f = fixture()
  f.decision.resolve('restricted')
  await f.controller.choose(true)
  expect(f.writes).toEqual([[true, 'main', 'default']])
  expect(f.level()).toBe(true)
  expect(f.permission()).toBe('default')
})

test('Use Full access keeps the existing permission without another permission write', async () => {
  const f = fixture()
  f.decision.resolve('full-access')
  await f.controller.choose(true)
  expect(f.writes).toEqual([[true, 'main', undefined]])
  expect(f.permission()).toBe('bypassPermissions')
})

test('a failed combined save restores the original selection and permission', async () => {
  const f = fixture()
  const error = new Error('configuration rejected')
  f.persist(async () => { throw error })
  f.decision.resolve('restricted')
  await f.controller.choose(true)
  expect(f.level()).toBe(false)
  expect(f.permission()).toBe('bypassPermissions')
  expect(f.errors).toEqual([error])
})

test('draft and side sessions save to their captured scope without prompting in restricted mode', async () => {
  for (const sessionId of [undefined, 'side']) {
    const f = fixture({ sessionId, permission: 'default' })
    if (sessionId === undefined) f.update({ sessionId })
    await f.controller.choose(true)
    expect(f.writes).toEqual([[true, sessionId, undefined]])
    expect(f.confirmations()).toBe(0)
  }
})

test('a confirmation opened in another session cannot save to the new session', async () => {
  const f = fixture()
  const selected = f.controller.choose(true)
  await Promise.resolve()
  f.update({ sessionId: 'side' })
  f.decision.resolve('restricted')
  await selected
  expect(f.writes).toEqual([])
  expect(f.permission()).toBe('bypassPermissions')
})

test('model changes and invalidation make an outstanding confirmation inert', async () => {
  for (const invalidate of [false, true]) {
    const f = fixture()
    const selected = f.controller.choose(true)
    await Promise.resolve()
    if (invalidate) f.controller.invalidate()
    else f.update({ model: 'custom:other' })
    f.decision.resolve('full-access')
    await selected
    expect(f.writes).toEqual([])
  }
})

test('switching models while Ultra is already selected does not ask again', async () => {
  const f = fixture()
  f.update({ enabled: true, model: 'custom:no-reasoning' })
  await f.controller.choose(true)
  expect(f.confirmations()).toBe(0)
  expect(f.writes).toEqual([[true, 'main', undefined]])
})
