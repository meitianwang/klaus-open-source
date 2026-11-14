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

test('all four composer work-mode pills share Goal pill geometry with distinct theme-safe colors', () => {
  const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')
  const themeEngine = readFileSync(new URL('../../app/i18n.ts', import.meta.url), 'utf8')

  expect(css).toContain('color: var(--goal-badge-fg, #2ba67a);')
  expect(css).toContain('--goal-badge-fg: #3ccb8f;')
  expect(css).toContain(':is(#plan-mode-badge, #side-plan-mode-badge, .goal-mode-badge.is-plan) { --goal-badge-fg: #3d82e0; }')
  expect(css).toContain(':is(#orchestrate-mode-badge, #side-orchestrate-mode-badge, .goal-mode-badge.is-orchestrate) { --goal-badge-fg: #8b5cf6; }')
  expect(css).toContain(':is(#ultra-mode-badge, #side-ultra-mode-badge, .goal-mode-badge.is-ultra) { --goal-badge-fg: #d6489a; }')
  expect(css).toContain('[data-theme="dark"] :is(#plan-mode-badge, #side-plan-mode-badge, .goal-mode-badge.is-plan) { --goal-badge-fg: #6aa8ff; }')
  expect(css).toContain('[data-theme="dark"] :is(#orchestrate-mode-badge, #side-orchestrate-mode-badge, .goal-mode-badge.is-orchestrate) { --goal-badge-fg: #a98bff; }')
  expect(css).toContain('[data-theme="dark"] :is(#ultra-mode-badge, #side-ultra-mode-badge, .goal-mode-badge.is-ultra) { --goal-badge-fg: #f07ab8; }')
  expect(css).not.toContain('#plan-mode-badge,\n#orchestrate-mode-badge,\n#ultra-mode-badge {\n  background: transparent;')
  expect(chat).toContain("badge.className = 'goal-mode-badge spec-mode-badge is-plan'")
  expect(chat).toContain("badge.className = 'goal-mode-badge spec-mode-badge is-orchestrate'")
  expect(chat).toContain("badge.className = 'goal-mode-badge spec-mode-badge is-ultra'")
  expect(themeEngine).not.toContain('--goal-badge-fg')
  expect(themeEngine).not.toContain('--goal-badge-bg')
})

test('work-mode switches never open a full-access modal while the permission selector preserves BypassConfirmDialog', () => {
  const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  const modelSelect = readFileSync(new URL('./model-select.tsx', import.meta.url), 'utf8')
  const permissionSelect = readFileSync(new URL('./permission-select.tsx', import.meta.url), 'utf8')
  const bypassDialog = readFileSync(new URL('./bypass-confirm-dialog.tsx', import.meta.url), 'utf8')

  expect(chat).not.toContain('confirmWorkModeFullAccess')
  expect(chat).not.toContain('UltraAccessDialog')
  expect(modelSelect).not.toContain('UltraAccessDialog')
  expect(permissionSelect).toContain('<BypassConfirmDialog onDecision={onBypassDecision} translate={tt} />')
  expect(bypassDialog).toContain("translate('perm_bypass_dialog_title')")
  expect(bypassDialog).toContain("translate('perm_bypass_dialog_confirm')")
})
