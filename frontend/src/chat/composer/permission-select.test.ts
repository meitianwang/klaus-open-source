import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore } from 'zustand/vanilla'
import { PermissionSelectCaret, PermissionSelectMenu, isDangerPermissionPreset, permissionPresetFromResponse } from './permission-select'
import type { RuntimeConfigSnapshot } from '../../../../contracts/runtime-settings'
import windowsPreparation from '../../../../contracts/vectors/windows-sandbox-preparation.json'

let previousWindow: PropertyDescriptor | undefined
beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} })
})
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('permission selector renders the shared downward caret', () => {
  const markup = renderToStaticMarkup(createElement(PermissionSelectCaret))

  expect(markup).toContain('<svg')
  expect(markup).toContain('class="kls-select-caret')
  expect(markup).toContain('width="12"')
  expect(markup).toContain('height="12"')
})

test('the full-access preset marks its menu row and trigger with the danger class', () => {
  expect(isDangerPermissionPreset('bypassPermissions')).toBe(true)
  expect(isDangerPermissionPreset('acceptEdits')).toBe(false)
  expect(isDangerPermissionPreset('default')).toBe(false)

  const store = createStore(() => ({ value: 'bypassPermissions' as const, open: true }))
  const markup = renderToStaticMarkup(createElement(PermissionSelectMenu, {
    store, rootEl: null as unknown as HTMLElement, getSessionId: () => null,
  }))

  // The bypass row is the only danger row, and the closed trigger carries the
  // same flag plus the shield glyph so the unlocked state stays visible.
  expect(markup.match(/kls-select-item[^"]*is-danger/g)).toHaveLength(1)
  expect(markup).toContain('kls-select-trigger is-danger')
  expect(markup).toContain('kls-select-trigger-icon')
  // Every preset row keeps a leading glyph; the bypass one is the shield.
  expect(markup.match(/kls-select-icon/g)).toHaveLength(3)
})

test('a normal preset leaves the trigger unmarked', () => {
  const store = createStore(() => ({ value: 'auto' as const, open: true }))
  const markup = renderToStaticMarkup(createElement(PermissionSelectMenu, {
    store, rootEl: null as unknown as HTMLElement, getSessionId: () => null,
  }))

  expect(markup).not.toContain('kls-select-trigger is-danger')
  expect(markup.match(/kls-select-item[^"]*is-danger/g)).toHaveLength(1)
})

test('the permission menu keeps its choices without a heading or help row', () => {
  const store = createStore(() => ({ value: 'auto' as const, open: true }))
  const markup = renderToStaticMarkup(createElement(PermissionSelectMenu, {
    store, rootEl: null as unknown as HTMLElement, getSessionId: () => null,
  }))
  expect(markup).toContain('perm_menu_title')
  expect(markup).not.toContain('permission-select-heading')
  expect(markup).not.toContain('perm_learn_more')
  expect(markup.match(/role="menuitemradio"/g)).toHaveLength(3)
  expect(markup.match(/aria-checked="true"/g)).toHaveLength(1)
  expect(markup).toContain('data-preset="auto"')
  expect(markup).not.toContain('perm_accept_edits')
  expect(markup).not.toContain('title=')
})

test('unknown and unmatched permission policies remain unselected without changing their data', () => {
  const response = { mode: 'default', preset: null, policy: { approvalPolicy: 'never', sandboxMode: 'read-only' } }
  const original = structuredClone(response)
  expect(permissionPresetFromResponse(response)).toBeNull()
  expect(permissionPresetFromResponse({ mode: 'acceptEdits' })).toBeNull()
  expect(permissionPresetFromResponse({ mode: 'custom' })).toBeNull()
  expect(permissionPresetFromResponse({ mode: 'default', preset: 'custom' })).toBeNull()
  expect(permissionPresetFromResponse({ mode: 'default', preset: 'unknown' })).toBeNull()
  expect(permissionPresetFromResponse(null)).toBeNull()
  expect(permissionPresetFromResponse(undefined)).toBeNull()
  expect(permissionPresetFromResponse({ mode: 'auto', preset: 'auto' })).toBe('auto')
  expect(permissionPresetFromResponse({ mode: 'default' })).toBe('default')
  expect(response).toEqual(original)

  const store = createStore(() => ({ value: null, open: true }))
  const markup = renderToStaticMarkup(createElement(PermissionSelectMenu, {
    store, rootEl: null as unknown as HTMLElement, getSessionId: () => null,
  }))
  expect(markup).toContain('<span class="kls-select-text">permission_mode</span>')
  expect(markup.match(/role="menuitemradio"/g)).toHaveLength(3)
  expect(markup).not.toContain('aria-checked="true"')
  expect(markup).not.toContain('data-preset="custom"')
  expect(markup).not.toContain('perm_custom')
  expect(markup).not.toContain('role="alert"')
})

test('a failed permission read keeps three disabled presets and an explicit retry action', () => {
  const store = createStore(() => ({ value: null, open: true, unavailable: true }))
  const markup = renderToStaticMarkup(createElement(PermissionSelectMenu, {
    store, rootEl: null as unknown as HTMLElement, getSessionId: () => null,
  }))
  expect(markup).toContain('<span class="kls-select-text">perm_unavailable</span>')
  expect(markup.match(/role="menuitemradio"/g)).toHaveLength(3)
  expect(markup.match(/aria-checked="false" disabled=""/g)).toHaveLength(3)
  expect(markup).toContain('perm_read_error')
  expect(markup).toContain('auth_status_retry')
  expect(markup).not.toContain('data-preset="custom"')
})

test('temporary read-only execution displays Request approval and restores the saved choice when ready', () => {
  const presentation = windowsPreparation.permissionPresentation
  for (const preset of presentation.savedPresets) {
    const response = { mode: preset, preset, effectiveMode: presentation.pendingEffectiveMode }
    const saved = { ...response }
    const pending = permissionPresetFromResponse(response)
    expect(pending).toBe(presentation.pendingDisplay as ReturnType<typeof permissionPresetFromResponse>)
    expect(response).toEqual(saved)
    const ready = { ...response, effectiveMode: preset }
    expect(permissionPresetFromResponse(ready)).toBe(preset as ReturnType<typeof permissionPresetFromResponse>)
  }
  const unmatched = { mode: null, preset: null, effectiveMode: presentation.pendingEffectiveMode }
  expect(permissionPresetFromResponse(unmatched)).toBe(presentation.pendingDisplay)
  expect(permissionPresetFromResponse({ ...unmatched, effectiveMode: null })).toBe(presentation.unmatchedDisplay)
  const value = permissionPresetFromResponse({ mode: 'bypassPermissions', preset: 'bypassPermissions', effectiveMode: 'read-only' })
  const store = createStore(() => ({ value, open: true }))
  const markup = renderToStaticMarkup(createElement(PermissionSelectMenu, {
    store, rootEl: null as unknown as HTMLElement, getSessionId: () => null,
  }))
  expect(markup).toContain('<span class="kls-select-text">perm_manual</span>')
  expect(markup).not.toContain('kls-select-trigger is-danger')
  expect(markup).toContain('data-preset="default" class="kls-select-item is-selected" role="menuitemradio" aria-checked="true"')
  expect(markup.match(/role="menuitemradio"/g)).toHaveLength(3)
  expect(markup.match(/aria-checked="true"/g)).toHaveLength(1)
  expect(markup).not.toContain('data-preset="read-only"')
  expect(markup).not.toContain('data-preset="custom"')
})

test('granular settings retain their typed data while the existing approval control uses its string fallback', async () => {
  const events = new EventTarget()
  Object.assign(window, { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) })
  const { RUNTIME_ROWS, RuntimeChoice, runtimeSettingValue } = await import('../../pages/settings/runtime-tab')
  const granular = { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: true, mcp_elicitations: true } }
  const values = { 'klaus.approvalPolicy': granular, 'klaus.sandboxMode': 'workspace-write', 'klaus.sandbox.networkAllowed': 'off',
    'klaus.modelVerbosity': null, 'klaus.reasoningSummary': 'auto', 'klaus.webSearch.access': 'cached', 'klaus.subagentModelCatalog': 'off' }
  const snapshot: RuntimeConfigSnapshot = { scope: { kind: 'user' }, path: '/config.toml', version: '1', values: { ...values }, effective: { ...values }, sources: {} }
  const original = structuredClone(snapshot)
  expect(runtimeSettingValue(snapshot, 'klaus.approvalPolicy')).toBe('on-request')
  const approval = RUNTIME_ROWS.find(row => row.key === 'klaus.approvalPolicy')!
  expect(approval.values).toEqual(['on-request', 'never'])
  const markup = renderToStaticMarkup(createElement(RuntimeChoice, { id: 'approval', label: 'Approval', value: runtimeSettingValue(snapshot, approval.key),
    options: [{ value: 'on-request', label: 'On request' }, { value: 'never', label: 'Never' }], onChange: () => {} }))
  expect(markup).toContain('On request')
  expect(markup).not.toContain('[object Object]')
  expect(snapshot).toEqual(original)
  snapshot.effective['klaus.approvalPolicy'] = 'never'
  expect(runtimeSettingValue(snapshot, approval.key)).toBe('never')
  snapshot.values['klaus.approvalPolicy'] = 'untrusted'
  expect(runtimeSettingValue(snapshot, approval.key)).toBe('untrusted')
})

test('Plan and Goal badges share the position immediately after the permission selector', () => {
  const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')

  expect(chat).toContain("const permissionSelect = inputRow.querySelector('#permission-select')")
  expect(chat).toContain('badge.previousElementSibling !== permissionSelect')
  expect(chat).toContain('inputRow.insertBefore(badge, permissionSelect.nextSibling)')
  expect(chat.match(/placeComposerModeBadge\(inputRow, badge\)/g)).toHaveLength(4)
  expect(css).not.toContain('.input-row .goal-mode-badge:not(.spec-mode-badge) { margin-left: auto; }')
})
