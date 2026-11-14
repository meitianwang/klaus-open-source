import { expect, test } from 'bun:test'
import { createUltraSelection, requiresUltraAccessConfirmation } from './ultra-selection'
import { createPreferenceSaver } from './preference-save'
import type { PermissionPreset } from './permission-select'

function fixture({ sessionId = 'main' as string | undefined, permission = 'bypassPermissions' as PermissionPreset } = {}) {
  let selection = { sessionId, enabled: false, model: 'codex:model' }
  let mode = permission
  const errors: unknown[] = []
  const writes: unknown[][] = []
  let persist: () => Promise<void> = async () => {}
  const saver = createPreferenceSaver({ getSessionId: () => selection.sessionId,
    getValue: () => selection.enabled, setValue: enabled => { selection = { ...selection, enabled } },
    onError: error => errors.push(error) })
  const controller = createUltraSelection({ getSelection: () => selection,
    save: (level, id, permissionMode) => saver.save(level, async value => {
      writes.push([value, id, permissionMode])
      await persist()
      if (permissionMode) mode = permissionMode
    }), onError: error => errors.push(error),
  })
  return { controller, writes, errors, level: () => selection.enabled, permission: () => mode,
    update: (next: Partial<typeof selection>) => { selection = { ...selection, ...next } },
    persist: (next: () => Promise<void>) => { persist = next },
  }
}

test('entering or leaving Ultra never asks for full-access confirmation', () => {
  for (const mode of ['bypassPermissions', 'auto', 'default'] as PermissionPreset[]) {
    expect(requiresUltraAccessConfirmation(true, false, mode)).toBe(false)
    expect(requiresUltraAccessConfirmation(true, true, mode)).toBe(false)
    expect(requiresUltraAccessConfirmation(false, true, mode)).toBe(false)
  }
})

test('enabling Ultra under Full access saves directly without altering the permission preset', async () => {
  const f = fixture()
  await f.controller.choose(true)
  expect(f.writes).toEqual([[true, 'main', undefined]])
  expect(f.level()).toBe(true)
  expect(f.permission()).toBe('bypassPermissions')
})

test('a failed save restores the original selection and preserves permission', async () => {
  const f = fixture()
  const error = new Error('configuration rejected')
  f.persist(async () => { throw error })
  await f.controller.choose(true)
  expect(f.level()).toBe(false)
  expect(f.permission()).toBe('bypassPermissions')
  expect(f.errors).toEqual([error])
})

test('draft and side sessions save directly to their captured scope', async () => {
  for (const sessionId of [undefined, 'side']) {
    const f = fixture({ sessionId, permission: 'default' })
    if (sessionId === undefined) f.update({ sessionId })
    await f.controller.choose(true)
    expect(f.writes).toEqual([[true, sessionId, undefined]])
  }
})

test('switching models while Ultra is already selected saves directly', async () => {
  const f = fixture()
  f.update({ enabled: true, model: 'custom:no-reasoning' })
  await f.controller.choose(true)
  expect(f.writes).toEqual([[true, 'main', undefined]])
})
