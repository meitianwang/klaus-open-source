import { expect, test } from 'bun:test'
import vector from '../../../../contracts/vectors/windows-sandbox-preparation.json'
import protocol from '../../../../contracts/vectors/runtime-windows-sandbox.json'
import { presetRuntimePolicy } from '../../../../contracts/runtime-settings'
import { WindowsSandboxController, WINDOWS_SETUP_TIMING, needsNativeWindowsSetup, windowsSetupAppDependencies, windowsSetupCwd, windowsSetupError, type WindowsReadiness, type WindowsSetupCompleted, type WindowsSetupDependencies } from './windows-sandbox-controller'

const native = { platform: 'win32', local: true }
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
class Clock {
  now = 0
  private nextId = 0
  readonly jobs = new Map<number, { at: number; callback(): void }>()
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.nextId
    this.jobs.set(id, { at: this.now + delay, callback })
    return () => { this.jobs.delete(id) }
  }
  advance(delay: number) {
    this.now += delay
    for (;;) {
      const job = [...this.jobs].find(([, job]) => job.at <= this.now)
      if (!job) return
      this.jobs.delete(job[0]); job[1].callback()
    }
  }
}
function fixture(overrides: Partial<WindowsSetupDependencies> = {}) {
  const clock = new Clock(), calls: unknown[] = []
  let completed: ((event: WindowsSetupCompleted) => void) | undefined
  let status: WindowsReadiness = 'notConfigured'
  let subscriptions = 0
  const controller = new WindowsSandboxController({
    readiness: async () => { calls.push('readiness'); return { status } },
    start: async args => { calls.push({ start: args }); return { started: true } },
    onCompleted: handler => { completed = handler; subscriptions++; return () => { completed = undefined; subscriptions-- } },
    readMode: async () => null,
    writeMode: async mode => { calls.push({ writeMode: mode }); return { ok: true } },
    selectRequestApproval: async () => { calls.push({ permission: vector.enablePolicy.preset }); return { ok: true } },
    refreshPermissions: () => { calls.push('refresh-permissions') },
    now: () => clock.now, schedule: clock.schedule, ...overrides,
  })
  return { controller, clock, calls, emit: (event: WindowsSetupCompleted) => completed?.(event), status: (value: WindowsReadiness) => { status = value }, subscriptions: () => subscriptions }
}

test('only local native Windows checks readiness and caches successful or failed reads until retry', async () => {
  for (const environment of vector.environment) {
    expect(needsNativeWindowsSetup(environment)).toBe(environment.eligible)
    const f = fixture(); await f.controller.check(environment)
    expect(f.calls).toEqual(environment.eligible ? ['readiness'] : [])
    expect(f.subscriptions()).toBe(environment.eligible ? 1 : 0); f.controller.dispose()
  }
  let reads = 0
  const f = fixture({ readiness: async () => { if (++reads === 1) throw Error('read failed'); return { status: 'ready' } } })
  await f.controller.check(native); expect(f.controller.snapshot().readinessError).toBe(true)
  await f.controller.check(native); expect(reads).toBe(1)
  await f.controller.check(native, true); expect(reads).toBe(2); expect(f.controller.snapshot().readinessError).toBe(false)
  await f.controller.check(native); expect(reads).toBe(2); f.controller.dispose()
})

test('public readiness values and nullable projectless cwd retain their exact domain', async () => {
  for (const status of protocol.readinessStatuses) {
    const f = fixture(); f.status(status as WindowsReadiness); await f.controller.check(native)
    expect(f.controller.snapshot().readiness).toBe(status); f.controller.dispose()
  }
  expect(windowsSetupCwd(null)).toBeNull(); expect(windowsSetupCwd('/')).toBeNull()
  expect(windowsSetupCwd('C:\\work')).toBe('C:\\work')
  expect(WINDOWS_SETUP_TIMING).toEqual(vector.timingMs)
})

test('early completion is captured before the start acknowledgement and enable preserves operation order', async () => {
  let emit!: (event: WindowsSetupCompleted) => void
  const f = fixture({ start: async args => { f.calls.push({ start: args }); emit({ mode: args.mode, success: true, error: null }); return { started: true } } })
  emit = f.emit
  await f.controller.check(native)
  const operation = f.controller.continue('/')
  await flush()
  expect(f.calls).toEqual(['readiness', { start: { mode: 'elevated', cwd: null } }, { writeMode: 'elevated' }, { permission: 'default' }])
  expect(f.controller.snapshot().success).toBe(false)
  f.clock.advance(499); await flush(); expect(f.controller.snapshot().success).toBe(false)
  f.clock.advance(1); await operation
  expect(f.calls.at(-1)).toBe('refresh-permissions'); expect(f.controller.snapshot().success).toBe(true)
  expect(vector.enablePolicy.approvalsReviewer).toBe('user')
  f.clock.advance(4999); expect(f.controller.snapshot().retained).toBe(true)
  f.clock.advance(1); expect(f.controller.snapshot().retained).toBe(false); f.controller.dispose()
})

test('one shared pending operation ignores wrong-mode completion and duplicate starts', async () => {
  const f = fixture(); await f.controller.check(native)
  const pending = f.controller.continue('C:\\work'); await flush()
  await f.controller.continue('D:\\other')
  f.emit({ mode: 'unelevated', success: true, error: null }); await flush()
  expect(f.controller.snapshot().phase).toBe('waitingElevated')
  expect(f.calls.filter(call => typeof call === 'object' && call && 'start' in call)).toHaveLength(1)
  f.emit({ mode: 'elevated', success: true, error: null }); await flush(); f.clock.advance(500); await pending
  expect(f.calls).toContainEqual({ writeMode: 'elevated' }); f.controller.dispose()
})

test('elevated setup failure offers the unelevated path while update never changes mode or permissions', async () => {
  const f = fixture(); await f.controller.check(native)
  const first = f.controller.continue('C:\\work'); await flush()
  f.emit({ mode: 'elevated', success: false, error: 'orchestrator_helper_launch_canceled: approval canceled' }); await first
  expect(f.controller.snapshot().phase).toBe('retryUnelevated'); expect(f.controller.snapshot().error).toBe('uac_canceled')
  const second = f.controller.continue('C:\\work'); await flush()
  expect(f.calls).toContainEqual({ start: { mode: 'unelevated', cwd: 'C:\\work' } })
  f.emit({ mode: 'unelevated', success: true, error: null }); await flush(); f.clock.advance(500); await second
  expect(f.calls).toContainEqual({ writeMode: 'unelevated' }); f.controller.dispose()
  const update = fixture(); update.status('updateRequired'); await update.controller.check(native)
  const attempt = update.controller.continue(null); await flush()
  update.emit({ mode: 'elevated', success: false, error: 'helper_user_provision_failed: access denied' }); await attempt
  expect(update.controller.snapshot().phase).toBe('failed')
  const retry = update.controller.continue(null); await flush()
  expect(update.calls.at(-1)).toEqual({ start: { mode: 'elevated', cwd: null } })
  update.emit({ mode: 'elevated', success: true, error: null }); await retry
  expect(update.calls).not.toContainEqual({ writeMode: 'elevated' }); expect(update.calls).not.toContainEqual({ permission: 'default' })
  expect(update.calls).not.toContain('refresh-permissions')
  expect(update.controller.snapshot().readiness).toBe('ready'); update.controller.dispose()
})

test('completion timeout retains the exact same-mode cooling period and late completion clears it', async () => {
  const f = fixture(); f.status('updateRequired'); await f.controller.check(native)
  const pending = f.controller.continue(null); await flush()
  f.clock.advance(WINDOWS_SETUP_TIMING.completion); await pending
  expect(f.controller.snapshot().error).toBe('setup_timeout')
  await f.controller.continue(null); expect(f.calls.filter(call => typeof call === 'object' && call && 'start' in call)).toHaveLength(1)
  expect(f.controller.snapshot().error).toBe('setup_failed')
  f.emit({ mode: 'elevated', success: true, error: null })
  expect(f.controller.snapshot().success).toBe(false)
  const retry = f.controller.continue(null); await flush()
  expect(f.calls.filter(call => typeof call === 'object' && call && 'start' in call)).toHaveLength(2)
  f.emit({ mode: 'elevated', success: true, error: null }); await retry; f.controller.dispose()
  const expiry = fixture(); expiry.status('updateRequired'); await expiry.controller.check(native)
  const first = expiry.controller.continue(null); await flush(); expiry.clock.advance(1_200_000); await first
  expiry.clock.advance(300_000)
  const afterExpiry = expiry.controller.continue(null); await flush(); expiry.emit({ mode: 'elevated', success: true, error: null }); await afterExpiry
  expect(expiry.controller.snapshot().success).toBe(true); expiry.controller.dispose()
})

test('configuration failure restores the cached mode without reporting successful preparation', async () => {
  const f = fixture({ readMode: async () => 'unelevated', writeMode: async () => { throw Error('disk failed') } })
  await f.controller.check(native)
  const pending = f.controller.continue(null); await flush(); f.emit({ mode: 'elevated', success: true, error: null }); await pending
  expect(f.controller.snapshot()).toMatchObject({ phase: 'failed', error: 'config_write', mode: 'unelevated', success: false })
  expect(f.calls).not.toContainEqual({ permission: 'default' }); f.controller.dispose()
})

test('a refused start and disposal cannot publish mode or permission changes', async () => {
  const refused = fixture({ start: async () => ({ started: false }) }); await refused.controller.check(native); await refused.controller.continue(null)
  expect(refused.controller.snapshot().phase).toBe('retryUnelevated'); expect(refused.calls).toEqual(['readiness']); refused.controller.dispose()
  const f = fixture(); await f.controller.check(native)
  const pending = f.controller.continue(null); await flush(); f.controller.dispose(); await pending
  expect(f.subscriptions()).toBe(0); expect(f.clock.jobs.size).toBe(0)
  expect(f.calls).not.toContainEqual({ writeMode: 'elevated' }); expect(f.calls).not.toContainEqual({ permission: 'default' })
})

test('mode reading accepts only setup modes and error messages map by their exact public shape', async () => {
  const f = fixture({ readMode: async () => 'mxc' }); await f.controller.check(native); expect(f.controller.snapshot().mode).toBeNull(); f.controller.dispose()
  for (const { message, category } of vector.errorCases) {
    expect(windowsSetupError(Error(message))).toBe(category as ReturnType<typeof windowsSetupError>)
    expect(windowsSetupError(message)).toBe(category as ReturnType<typeof windowsSetupError>)
  }
  expect(windowsSetupError({ data: { reason: 'configLoad', detail: 'Invalid value' } })).toBe('config_load')
  expect(windowsSetupError({ data: { reason: 'configLoad', detail: 'Invalid value', filePath: 'C:\\config.toml', line: 1, column: 2 } })).toBe('config_load')
  expect(windowsSetupError({ data: { reason: 'configLoad', detail: 'Invalid value', line: 0 } })).toBe('setup_failed')
  expect(windowsSetupError({ data: { reason: 'configLoad' } })).toBe('setup_failed')
  expect(windowsSetupError({ message: 'orchestrator_helper_launch_failed: access denied' })).toBe('helper_launch')
  expect(windowsSetupError(Error('failed to load configuration: invalid'), 'config_write')).toBe('config_write')
  for (const value of [null, {}, '', ' ', { message: 123 }, 'helper_user_provision_failed']) expect(windowsSetupError(value)).toBe('setup_failed')
})

test('the application adapter uses the existing named setup calls and the global Request approval tuple', async () => {
  const calls: unknown[] = []
  const dependencies = windowsSetupAppDependencies({
    settings: { runtime: {
      windowsSandboxReadiness: async () => { calls.push({ readinessArguments: [] }); return { status: 'ready' } },
      startWindowsSandboxSetup: async args => { calls.push(args); return { started: true } },
      onWindowsSandboxSetupCompleted: handler => { calls.push(typeof handler); return () => {} },
    }, kv: { get: async key => { calls.push({ get: key }); return null }, set: async (key, value) => { calls.push({ set: key, value }); return { ok: true } } } },
    session: { setPermissionMode: async mode => { calls.push({ permission: mode }); return { ok: true } } },
  }, () => {})
  await dependencies.readiness(); await dependencies.readMode(); await dependencies.start({ mode: 'unelevated', cwd: null })
  await dependencies.writeMode('unelevated'); await dependencies.selectRequestApproval()
  expect(calls).toEqual([{ readinessArguments: [] }, { get: 'klaus.windows.sandbox' }, { mode: 'unelevated', cwd: null }, { set: 'klaus.windows.sandbox', value: 'unelevated' }, { permission: 'default' }])
  const policy = presetRuntimePolicy('default')
  expect({ preset: 'default', approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxMode: policy.sandboxMode, networkAllowed: policy.sandboxNetworkAllowed }).toEqual(vector.enablePolicy)
})

test('a permission publication failure cannot turn a completed helper into a successful enable', async () => {
  const f = fixture({ selectRequestApproval: async () => { throw Error('Publication failed') } })
  await f.controller.check(native)
  const attempt = f.controller.continue(null); await flush(); f.emit({ mode: 'elevated', success: true, error: null }); await attempt
  expect(f.calls).toContainEqual({ writeMode: 'elevated' })
  expect(f.controller.snapshot()).toMatchObject({ phase: 'failed', success: false, readiness: 'notConfigured' })
  f.controller.dispose()
})

test('retrying a failed enable finalization uses the non-admin setup path without displaying elevated-failure state', async () => {
  let writes = 0
  const f = fixture({ writeMode: async mode => { f.calls.push({ writeMode: mode }); if (++writes === 1) throw Error('disk failed'); return { ok: true } } })
  await f.controller.check(native)
  const first = f.controller.continue(null); await flush(); f.emit({ mode: 'elevated', success: true, error: null }); await first
  expect(f.controller.snapshot()).toMatchObject({ phase: 'failed', error: 'config_write', success: false })
  const retry = f.controller.continue('C:\\work'); await flush()
  expect(f.calls.at(-1)).toEqual({ start: { mode: 'unelevated', cwd: 'C:\\work' } })
  f.emit({ mode: 'unelevated', success: true, error: null }); await flush(); f.clock.advance(500); await retry
  expect(f.controller.snapshot()).toMatchObject({ mode: 'unelevated', readiness: 'ready', success: true }); f.controller.dispose()
})

test('disposing during finalization clears its delay without refreshing a removed composer', async () => {
  const f = fixture(); await f.controller.check(native)
  const attempt = f.controller.continue(null); await flush(); f.emit({ mode: 'elevated', success: true, error: null }); await flush()
  expect(f.calls).toContainEqual({ permission: 'default' })
  expect(f.clock.jobs.size).toBe(1)
  f.controller.dispose(); await attempt
  expect(f.clock.jobs.size).toBe(0); expect(f.calls).not.toContain('refresh-permissions')
})
