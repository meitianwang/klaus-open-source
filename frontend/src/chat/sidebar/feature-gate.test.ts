import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  CLIENT_DEFAULTS,
  featureEnabled,
  initFeatureGates,
  shouldShowTeamCollaborationEntry,
  type FeatureGateDeps,
  type FeatureGateSnapshot,
} from './feature-gate'

function fakeDeps(initial: FeatureGateSnapshot | null = null): {
  deps: FeatureGateDeps
  calls: { visible: boolean[]; disabled: number; enabled: number }
  push(payload: FeatureGateSnapshot): void
  resolveSnapshot(value: FeatureGateSnapshot): void
} {
  const calls = { visible: [] as boolean[], disabled: 0, enabled: 0 }
  let onUpdated: ((payload: FeatureGateSnapshot) => void) | undefined
  let resolveSnapshot!: (value: FeatureGateSnapshot) => void
  const pending = new Promise<FeatureGateSnapshot>(resolve => { resolveSnapshot = resolve })
  const deps: FeatureGateDeps = {
    snapshot: () => pending,
    onUpdated: handler => { onUpdated = handler; return () => { onUpdated = undefined } },
    setEntryVisible: visible => { calls.visible.push(visible) },
    onTeamCollaborationDisabled: () => { calls.disabled += 1 },
    onTeamCollaborationEnabled: () => { calls.enabled += 1 },
    log: () => {},
  }
  if (initial) resolveSnapshot(initial)
  return {
    deps,
    calls,
    push: payload => onUpdated?.(payload),
    resolveSnapshot,
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('gate resolution', () => {
  test('teamCollaboration defaults closed (fail-closed before any server answer)', () => {
    expect(CLIENT_DEFAULTS.teamCollaboration).toBe(false)
    expect(featureEnabled(null, 'teamCollaboration')).toBe(false)
    expect(featureEnabled(undefined, 'teamCollaboration')).toBe(false)
    expect(featureEnabled({ features: {} }, 'teamCollaboration')).toBe(false)
    expect(shouldShowTeamCollaborationEntry(null)).toBe(false)
  })

  test('an explicit server value wins over the default, both ways', () => {
    expect(featureEnabled({ features: { teamCollaboration: true } }, 'teamCollaboration')).toBe(true)
    expect(featureEnabled({ features: { teamCollaboration: false } }, 'teamCollaboration')).toBe(false)
  })

  test('non-boolean server values are ignored, keeping the fail-closed default', () => {
    const snapshot = { features: { teamCollaboration: 'yes' } } as unknown as FeatureGateSnapshot
    expect(featureEnabled(snapshot, 'teamCollaboration')).toBe(false)
  })
})

describe('initFeatureGates wiring', () => {
  test('hides the entry synchronously at init, before the snapshot resolves', () => {
    const fake = fakeDeps()
    initFeatureGates(fake.deps)
    // The very first apply() runs synchronously with no snapshot: fail-closed.
    expect(fake.calls.visible[0]).toBe(false)
    expect(fake.calls.disabled).toBeGreaterThanOrEqual(1)
  })

  test('an entitled snapshot reveals the entry and fires the open transition once', async () => {
    const fake = fakeDeps()
    const controller = initFeatureGates(fake.deps)
    fake.resolveSnapshot({ features: { teamCollaboration: true } })
    await flush()
    expect(controller.enabled('teamCollaboration')).toBe(true)
    expect(fake.calls.visible).toContain(true)
    // One closed→open transition only, despite the initial closed apply.
    expect(fake.calls.enabled).toBe(1)
  })

  test('a live update flipping the gate off hides the entry and notifies', async () => {
    const fake = fakeDeps({ features: { teamCollaboration: true } })
    const controller = initFeatureGates(fake.deps)
    await flush()
    expect(controller.enabled('teamCollaboration')).toBe(true)
    const disabledBefore = fake.calls.disabled
    fake.push({ features: { teamCollaboration: false } })
    await flush()
    expect(controller.enabled('teamCollaboration')).toBe(false)
    expect(fake.calls.visible[fake.calls.visible.length - 1]).toBe(false)
    expect(fake.calls.disabled).toBeGreaterThan(disabledBefore)
  })

  test('a live update flipping the gate on re-fires the open transition', async () => {
    const fake = fakeDeps({ features: { teamCollaboration: false } })
    const controller = initFeatureGates(fake.deps)
    await flush()
    expect(fake.calls.enabled).toBe(0)
    fake.push({ features: { teamCollaboration: true } })
    await flush()
    expect(controller.enabled('teamCollaboration')).toBe(true)
    expect(fake.calls.enabled).toBe(1)
  })

  test('a malformed push keeps the last known good state', async () => {
    const fake = fakeDeps({ features: { teamCollaboration: true } })
    const controller = initFeatureGates(fake.deps)
    await flush()
    fake.push(null as unknown as FeatureGateSnapshot)
    await flush()
    // normalize() rejected it; the controller still reports the prior value.
    expect(controller.enabled('teamCollaboration')).toBe(true)
  })

  test('dispose stops tracking further pushes', async () => {
    const fake = fakeDeps({ features: { teamCollaboration: false } })
    const controller = initFeatureGates(fake.deps)
    await flush()
    controller.dispose()
    fake.push({ features: { teamCollaboration: true } })
    await flush()
    expect(controller.enabled('teamCollaboration')).toBe(false)
  })
})

describe('sidebar entry CSS', () => {
  const styles = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')

  test('the flex nav item suppresses the hidden attribute like the menu rows do', () => {
    expect(styles).toMatch(/\.sidebar-nav-item\[hidden\]\s*\{\s*display:\s*none;/)
  })

  test('the team collaboration button starts hidden so it never flashes', () => {
    expect(html).toMatch(/id="btn-team-collaboration"\s+hidden/)
  })
})
