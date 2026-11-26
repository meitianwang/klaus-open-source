import { describe, expect, test } from 'bun:test'
import {
  buildCronChannelSelectState, cronExecutionMode, resolveCronChannelBindingSelection, selectedCronChannelId,
  compileSchedule, cronDeleteSucceeded, cronExecutionTarget, cronExecutionValue, cronPermissionPreset, cronRunErrorText,
  effectiveCronRunStatus, navigateToCronRunSession, parseCronExecutionValue, parseSchedule,
  resolvedCronTaskTimezone, retainedCronTaskFields,
} from './data'
import type { CronTask } from './data'
import { I18N } from '../../i18n/messages'
import statusVectors from '../../../../contracts/vectors/cron-run-status-vectors.json'

describe('scheduled-task page host contracts', () => {
  test('presents a model total timeout as localized guidance and preserves other errors', () => {
    const raw = 'stream total timeout: model response exceeded 1200000ms'
    for (const language of ['en', 'zh'] as const) {
      const translate = (key: string) => I18N[language][key]
      expect(cronRunErrorText(raw, translate)).toBe(translate('cron_run_model_timeout'))
      expect(cronRunErrorText(raw.toUpperCase(), translate)).toBe(translate('cron_run_model_timeout'))
      expect(cronRunErrorText('provider rejected the request', translate)).toBe('provider rejected the request')
    }
  })

  test('accepts the Electron and compatibility delete result shapes', () => {
    expect(cronDeleteSucceeded({ deleted: true, sessionCount: 2 })).toBe(true)
    expect(cronDeleteSucceeded({ ok: true })).toBe(true)
    expect(cronDeleteSucceeded(true)).toBe(true)
    expect(cronDeleteSucceeded({ deleted: false })).toBe(false)
    expect(cronDeleteSucceeded(null)).toBe(false)
  })

  test('opens a run through the exported Electron session navigator', async () => {
    const calls: string[] = []
    await navigateToCronRunSession({
      klausSwitchSession: async (id: string) => { calls.push(`klaus:${id}`) },
      switchSession: async (id: string) => { calls.push(`legacy:${id}`) },
    }, 'session-1')
    expect(calls).toEqual(['klaus:session-1'])
  })

  test('editing retains paused state and fields that the form does not expose', () => {
    expect(retainedCronTaskFields({
      id: 'task-1',
      enabled: false,
      description: 'context',
      thinking: 'high',
      model: 'codex:fixture',
      workdir: '/tmp/proj',
    })).toEqual({
      enabled: false, description: 'context', thinking: 'high',
      model: 'codex:fixture', workdir: '/tmp/proj', workspaceId: null,
      executionMode: 'default', permissionPreset: 'bypassPermissions', notificationPolicy: 'failed_runs_only',
    })
    expect(retainedCronTaskFields({ id: 'task-1', enabled: false, description: 'context', thinking: 'high' })).toEqual({
      enabled: false, description: 'context', thinking: 'high',
      model: null, workdir: null, workspaceId: null, executionMode: 'default', permissionPreset: 'bypassPermissions',
      notificationPolicy: 'failed_runs_only',
    })
    expect(retainedCronTaskFields(null)).toEqual({
      enabled: true, executionMode: 'default', permissionPreset: 'bypassPermissions', notificationPolicy: 'failed_runs_only',
    })
    expect(retainedCronTaskFields({
      id: 'task-2', workspaceId: 'workspace-1', permissionPreset: 'auto',
    })).toMatchObject({ workspaceId: 'workspace-1', permissionPreset: 'auto', workdir: null })
    expect(resolvedCronTaskTimezone({ id: 'task-1', timezone: 'Asia/Shanghai' }, false, '')).toBe('Asia/Shanghai')
    expect(resolvedCronTaskTimezone(null, true, ' America/Los_Angeles ')).toBe('America/Los_Angeles')
  })

  test('keeps execution locations mutually exclusive and defaults legacy permissions open', () => {
    expect(cronExecutionTarget({ workdir: '/tmp/proj', workspaceId: null })).toEqual({ kind: 'project', root: '/tmp/proj' })
    expect(cronExecutionTarget({ workdir: '/tmp/proj', workspaceId: 'ws-1' })).toEqual({ kind: 'workspace', id: 'ws-1' })
    expect(cronExecutionTarget({ workdir: null, workspaceId: null })).toEqual({ kind: 'none' })
    expect(cronExecutionValue({ workdir: '/tmp/proj' })).toBe('project:/tmp/proj')
    expect(parseCronExecutionValue('workspace:ws-1')).toEqual({ kind: 'workspace', id: 'ws-1' })
    expect(parseCronExecutionValue('project:/tmp/proj')).toEqual({ kind: 'project', root: '/tmp/proj' })
    expect(parseCronExecutionValue('')).toEqual({ kind: 'none' })
    expect(cronPermissionPreset(undefined)).toBe('bypassPermissions')
    expect(cronPermissionPreset('bogus')).toBe('bypassPermissions')
    expect(cronPermissionPreset('default')).toBe('default')
    expect(cronPermissionPreset('auto')).toBe('auto')
  })

  test('keeps non-zero hourly cron expressions lossless and classifies soft failures', () => {
    expect(parseSchedule('0 * * * *', false)).toEqual({ freq: 'hourly' })
    expect(parseSchedule('30 * * * *', false)).toBeNull()
    expect(effectiveCronRunStatus({ status: 'success', error: 'tool failed' })).toBe('failed')
    expect(effectiveCronRunStatus({ status: 'success' })).toBe('success')
  })

  test('classifies intentional stops and execution failures using the shared status vectors', () => {
    for (const vector of statusVectors.cases) {
      expect(effectiveCronRunStatus(vector)).toBe(vector.expected)
    }
  })

  test('compiles and round-trips the weekdays preset', () => {
    expect(compileSchedule({ freq: 'weekdays', hour: 9, minute: 30 })).toBe('30 9 * * 1-5')
    expect(parseSchedule('30 9 * * 1-5', false)).toEqual({ freq: 'weekdays', hour: '9', minute: '30' })
    expect(compileSchedule({ freq: 'daily', hour: 9, minute: 0 })).toBe('0 9 * * *')
    expect(parseSchedule('0 9 * * *', false)).toEqual({ freq: 'daily', hour: '9', minute: '0' })
  })

  test('notification policy normalizes to the two retained states', () => {
    expect(retainedCronTaskFields({
      id: 't',
      // Legacy rows may carry an unknown policy value through the any-typed
      // bridge; the store-side normalizer still pins it to the default.
      notificationPolicy: 'bogus',
    } as unknown as CronTask).notificationPolicy).toBe('failed_runs_only')
    expect(retainedCronTaskFields({ id: 't', notificationPolicy: 'all_runs' }).notificationPolicy).toBe('all_runs')
    expect(retainedCronTaskFields({ id: 't' }).notificationPolicy).toBe('failed_runs_only')
  })

  test('falls back to the historical navigator and rejects a missing bridge', async () => {
    const calls: string[] = []
    await navigateToCronRunSession({ switchSession: (id: string) => { calls.push(id) } }, 'session-2')
    expect(calls).toEqual(['session-2'])
    let message = ''
    try { await navigateToCronRunSession({}, 'session-3') }
    catch (error) { message = error instanceof Error ? error.message : String(error) }
    expect(message).toBe('Session navigation is unavailable')
  })
})

describe('scheduled execution mode', () => {
  test('normalizes and retains supported modes, defaulting unknown values', () => {
    for (const [value, expected] of [[null, 'default'], ['default', 'default'], ['orchestrate', 'orchestrate'], ['parallel', 'parallel'], ['invalid', 'default']] as const) {
      expect(cronExecutionMode(value)).toBe(expected)
      expect(retainedCronTaskFields({ id: 'task', executionMode: value } as CronTask).executionMode).toBe(expected)
    }
  })
})

describe('scheduled channel picker', () => {
  const labelOf = (id: string) => id.toUpperCase()
  const translate = (key: string) => key.replace('cron_form_channel_', '')
  const connected = { id: 'chat', connected: true, ownerId: 'owner' }
  const direct = { channelId: 'chat', targetId: 'owner' }
  const group = { ...direct, chatType: 'group', threadId: 'thread', accountId: 'other' }
  const build = (binding: Parameters<typeof buildCronChannelSelectState>[0], channels: Parameters<typeof buildCronChannelSelectState>[1]) =>
    buildCronChannelSelectState(binding, channels, translate, labelOf)

  test('offers a ready DM without selecting it for an unbound task', () => {
    expect(build(null, [connected])).toEqual({ options: [{ value: '', label: 'none' }, { value: 'dm:chat', label: 'CHAT · me' }], initialValue: '', pendingDmLabels: [] })
  })

  test('selects a matching DM without duplicating the option', () => {
    expect(build(direct, [connected]).initialValue).toBe('dm:chat')
    expect(build(direct, [connected]).options.map(option => option.value)).toEqual(['', 'dm:chat'])
  })

  test('preserves disconnected, group, and unloaded bindings', () => {
    expect(build(direct, []).options[1]).toEqual({ value: '__existing__', label: 'CHAT · me (disconnected)' })
    expect(build(group, [connected])).toMatchObject({ initialValue: '__existing__', options: [
      { value: '', label: 'none' }, { value: '__existing__', label: 'CHAT · groupowner' }, { value: 'dm:chat', label: 'CHAT · me' },
    ] })
    expect(build(direct, null)).toMatchObject({ initialValue: '__existing__', options: [
      { value: '', label: 'none' }, { value: '__existing__', label: 'CHAT · me' },
    ] })
  })

  test('reports connected channels pending a DM target', () => {
    expect(build(null, [{ ...connected, ownerId: ' ' }, { id: 'offline', connected: false }]).pendingDmLabels).toEqual(['CHAT'])
  })

  test('resolves clearing, copying a saved binding, and selecting a DM', () => {
    const owners = { chat: 'owner' }
    const resolve = (selection: string) => resolveCronChannelBindingSelection(selection, group, owners, labelOf)
    expect(resolve('')).toBeNull()
    expect(resolve('__existing__')).toEqual(group)
    expect(resolve('__existing__')).not.toBe(group)
    expect(resolve('dm:chat')).toEqual({ ...direct, accountId: 'default', chatType: 'direct', label: 'CHAT' })
    expect(resolve('dm:missing')).toBeNull()
    expect(selectedCronChannelId('__existing__', group)).toBe('chat')
    expect(selectedCronChannelId('__existing__', null)).toBe('')
    expect(selectedCronChannelId('dm:other', group)).toBe('other')
    expect(selectedCronChannelId('', group)).toBe('')
  })
})
