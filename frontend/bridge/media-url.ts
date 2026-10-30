/** Builds a local media URL; the protocol rechecks the conversation's file scope on every request. */
export function localMediaUrl(filePath: string, sessionId?: string): string {
  if (!filePath) return '';
  const bytes = new TextEncoder().encode(filePath);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const segment = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const scope = sessionId ?? (window as unknown as { currentSessionId?: string }).currentSessionId ?? '';
  const query = scope ? `?s=${encodeURIComponent(scope)}` : '';
  return /Windows/i.test(navigator.userAgent) && location.protocol !== 'klaus-app:' ? `http://klaus-media.localhost/${segment}${query}` : `klaus-media://localhost/${segment}${query}`;
}
