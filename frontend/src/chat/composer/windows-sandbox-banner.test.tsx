import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WindowsSandboxBanner } from './windows-sandbox-banner'
import { I18N } from '../../i18n'
import type { WindowsSetupState } from './windows-sandbox-controller'

let previousWindow: PropertyDescriptor | undefined
beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { currentLang: 'en' } })
})
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
const base: WindowsSetupState = { readiness: 'notConfigured', checking: false, readinessError: false, phase: 'idle', error: null, mode: null, retained: false, success: false }
const markup = (state: Partial<WindowsSetupState> = {}) => renderToStaticMarkup(createElement(WindowsSandboxBanner, {
  state: { ...base, ...state }, onContinue: () => {}, onRetry: () => {}, onDismiss: () => {},
}))

test('setup and retry states expose only their relevant action without a new modal or configuration choice', () => {
  expect(markup()).toContain('Finish Windows setup to continue')
  expect(markup()).toContain('>Continue</button>')
  expect(markup({ phase: 'retryUnelevated', error: 'uac_canceled' })).toContain('Continue without administrator access')
  expect(markup({ phase: 'failed', error: 'config_write' })).toContain('Retry setup')
  expect(markup({ phase: 'failed', error: 'config_write' })).toContain('Failed to write config')
  expect(markup()).not.toContain('role="dialog"')
  expect(markup()).not.toContain('select')
})

test('pending preparation has status semantics and no clickable action', () => {
  const value = markup({ phase: 'waitingElevated', retained: true })
  expect(value).toContain('Finishing Windows setup')
  expect(value).toContain('role="status"')
  expect(value).toContain('aria-live="polite"')
  expect(value).not.toContain('<button')
})

test('readiness errors and successful preparation have distinct retry and accessible dismissal actions', () => {
  expect(markup({ readinessError: true })).toContain('Couldn’t check Windows setup')
  expect(markup({ readinessError: true })).toContain('Try again')
  const success = markup({ readiness: 'ready', retained: true, success: true })
  expect(success).toContain('Windows setup is complete')
  expect(success).toContain('aria-label="Dismiss Windows setup status"')
  expect(markup({ readiness: 'ready' })).toBe('')
  expect(markup({ readiness: null, checking: true })).toBe('')
})

test('update presentation omits the initial setup detail and never offers the non-admin fallback', () => {
  expect(markup({ readiness: 'updateRequired' })).not.toContain('Finish setup before creating files')
  expect(markup({ readiness: 'updateRequired', phase: 'failed' })).not.toContain('Continue without administrator access')
})

test('every Windows setup status and error has complete English and Chinese copy', () => {
  for (const key of Object.keys(I18N.en).filter(key => key.startsWith('windows_setup_'))) {
    expect((I18N.zh as Record<string, string>)[key]).toBeTruthy()
  }
  ;(window as any).currentLang = 'zh'
  expect(markup({ phase: 'retryUnelevated', error: 'uac_canceled' })).toContain('在没有管理员权限的情况下继续')
})
