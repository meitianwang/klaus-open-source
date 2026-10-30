import { desktopDistribution } from '../app/distribution'

export type TranslateAccountLoginError = (key: string) => string

/** Turn host error codes into user-facing copy without exposing gateway response bodies. */
export function accountLoginErrorText(error: string | undefined, t: TranslateAccountLoginError, serverUrl = desktopDistribution().serverUrl): string {
  if (!error) return t('login_unknown_error')
  if (error === 'login_service_unavailable') return t('login_service_unavailable')
  if (error === 'login_server_unreachable') return t('login_server_unreachable')
  if (error === 'login_timed_out') return t('login_timed_out')
  if (error === 'login_invalid_payload') return t('login_invalid_payload')
  if (error.startsWith('login_poll_rejected:')) {
    // A 403 here is not the server refusing the login: it is a proxy or
    // firewall on the user's network answering the poll, so the copy has to
    // point at the network instead of saying "try again".
    return error.split(':')[1] === '403'
      ? t('login_poll_forbidden').replace('{domain}', new URL(serverUrl).host)
      : t('login_poll_rejected')
  }
  return t('login_unknown_error')
}
