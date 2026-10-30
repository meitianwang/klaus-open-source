export const APP_SCHEME = 'klaus-app';
export const APP_HOST = 'app';

export function isTrustedAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST &&
      url.port === '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
