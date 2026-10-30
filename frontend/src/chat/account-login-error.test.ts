import { describe, expect, test } from 'bun:test'
import { accountLoginErrorText } from './account-login-error'

const t = (key: string): string => ({
  login_service_unavailable: 'The sign-in service is temporarily unavailable. Please try again.',
  login_server_unreachable: 'We could not reach the Klaus sign-in server. Check your network and try again.',
  login_timed_out: 'Sign-in took too long and was cancelled. Please try again.',
  login_poll_forbidden: 'Your network blocked the sign-in check. Try another network or allow klaus-ai.cn.',
  login_poll_rejected: 'The sign-in server rejected this attempt. Please try again.',
  login_invalid_payload: 'The sign-in server sent an unexpected response. Please try again.',
  login_unknown_error: 'Please try again.',
}[key] || key)

describe('account login error copy', () => {
  test('maps a transient gateway failure to product copy', () => {
    expect(accountLoginErrorText('login_service_unavailable', t)).toBe(
      'The sign-in service is temporarily unavailable. Please try again.',
    )
  })

  test('maps transport, timeout and payload failures to product copy', () => {
    expect(accountLoginErrorText('login_server_unreachable', t)).toBe(
      'We could not reach the Klaus sign-in server. Check your network and try again.',
    )
    expect(accountLoginErrorText('login_timed_out', t)).toBe(
      'Sign-in took too long and was cancelled. Please try again.',
    )
    expect(accountLoginErrorText('login_invalid_payload', t)).toBe(
      'The sign-in server sent an unexpected response. Please try again.',
    )
  })

  test('separates a network-blocked poll from a plain server rejection', () => {
    expect(accountLoginErrorText('login_poll_rejected:403:forbidden', t)).toBe(
      'Your network blocked the sign-in check. Try another network or allow klaus-ai.cn.',
    )
    expect(accountLoginErrorText('login_poll_rejected:403', t)).toBe(
      'Your network blocked the sign-in check. Try another network or allow klaus-ai.cn.',
    )
    expect(accountLoginErrorText('login_poll_rejected:401', t)).toBe(
      'The sign-in server rejected this attempt. Please try again.',
    )
  })

  test('never shows a raw host string and has an empty fallback', () => {
    expect(accountLoginErrorText('login returned invalid payload', t)).toBe('Please try again.')
    expect(accountLoginErrorText(undefined, t)).toBe('Please try again.')
  })
})
