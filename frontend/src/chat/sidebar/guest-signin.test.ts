import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { guestSigninRows, initialGuestSigninState, type GuestSigninState } from './guest-signin'

const signedIn: GuestSigninState = { guest: false, waiting: false, pendingUrl: '' }
const styles = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')

describe('guest sign-in row visibility', () => {
  test('a signed-in user keeps the logout row and sees no sign-in block', () => {
    expect(guestSigninRows(signedIn)).toEqual({
      login: false,
      loginDisabled: false,
      loginLabelKey: 'menu_login',
      copyLink: false,
      cancel: false,
      logout: true,
    })
  })

  test('an idle guest swaps logout for a clickable sign-in row', () => {
    const rows = guestSigninRows({ ...initialGuestSigninState, guest: true })
    expect(rows.login).toBe(true)
    expect(rows.loginDisabled).toBe(false)
    expect(rows.loginLabelKey).toBe('menu_login')
    expect(rows.copyLink).toBe(false)
    expect(rows.cancel).toBe(false)
    expect(rows.logout).toBe(false)
  })

  test('a waiting guest gets the status label plus cancel, and copy only with a URL', () => {
    const waiting: GuestSigninState = { guest: true, waiting: true, pendingUrl: '' }
    const rows = guestSigninRows(waiting)
    expect(rows.loginDisabled).toBe(true)
    expect(rows.loginLabelKey).toBe('menu_login_waiting')
    expect(rows.cancel).toBe(true)
    expect(rows.copyLink).toBe(false)
    expect(rows.logout).toBe(false)

    const withUrl = guestSigninRows({ ...waiting, pendingUrl: 'https://klaus-ai.cn/authorize?x=1' })
    expect(withUrl.copyLink).toBe(true)
  })

  test('a stale waiting flag on a signed-in session renders nothing extra', () => {
    // klausAuth:updated with a user clears guest; even if a waiting flag raced
    // in, signed-in users must never see the guest block or lose logout.
    const rows = guestSigninRows({ guest: false, waiting: true, pendingUrl: 'https://x' })
    expect(rows.login).toBe(false)
    expect(rows.copyLink).toBe(false)
    expect(rows.cancel).toBe(false)
    expect(rows.logout).toBe(true)
  })

  test('the hidden logout row wins over the menu flex layout', () => {
    expect(styles).toMatch(/#menu-logout\[hidden\]\s*\{\s*display:\s*none;/)
  })
})
