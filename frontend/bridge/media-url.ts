/** Builds a local media URL; the protocol rechecks the conversation's file scope on every request. */
export function localMediaUrl(filePath: string, sessionId?: string, cacheKey?: string): string {
  if (!filePath) return '';
  const bytes = new TextEncoder().encode(filePath);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const segment = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const scope = sessionId ?? (window as unknown as { currentSessionId?: string }).currentSessionId ?? '';
  const query = scope ? `?s=${encodeURIComponent(scope)}` : '';
  const url = /Windows/i.test(navigator.userAgent) && location.protocol !== 'klaus-app:' ? `http://klaus-media.localhost/${segment}${query}` : `klaus-media://localhost/${segment}${query}`;
  return cacheKey ? appendLocalMediaCacheKey(url, cacheKey) : url;
}

export function normalizeMediaCacheToken(cacheKey?: string): string {
  if (!cacheKey) return '';
  if (/^[A-Za-z0-9._-]{1,48}$/.test(cacheKey)) return cacheKey;
  let a = 0x811c9dc5, b = 0x811c9dc5;
  for (let i = 0; i < cacheKey.length; i++) {
    a = Math.imul(a ^ cacheKey.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ cacheKey.charCodeAt(cacheKey.length - 1 - i), 0x01000193);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${cacheKey.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 24)}-${hex(a)}${hex(b)}`;
}

export function appendLocalMediaCacheKey(url: string, cacheKey?: string): string {
  if (!url.startsWith('klaus-media://localhost/') && !url.startsWith('http://klaus-media.localhost/')) return url;
  const token = normalizeMediaCacheToken(cacheKey);
  if (!token) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('v', token);
    return parsed.href;
  } catch {
    return `${url}${url.includes('?') ? '&' : '?'}v=${token}`;
  }
}

export function stampLocalMediaHtml(html: string, cacheKey?: string): string {
  if (!html || !cacheKey || !html.includes('klaus-media')) return html;
  return html.replace(/(\s)(src|data-media-src)="((?:klaus-media:\/\/localhost\/|http:\/\/klaus-media\.localhost\/)[^"]+)"/g,
    (_, space: string, attr: string, url: string) => `${space}${attr}="${appendLocalMediaCacheKey(url.replaceAll('&amp;', '&'), cacheKey).replaceAll('&', '&amp;')}"`);
}
