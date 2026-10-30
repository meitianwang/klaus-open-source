const MAX_FAVICON_DATA_LENGTH = 16_384;
const DATA_IMAGE = /^data:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/;

export function boundedTabFavicon(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_FAVICON_DATA_LENGTH || !DATA_IMAGE.test(value)) return undefined;
  return value.slice(value.indexOf(',') + 1).length % 4 === 0 ? value : undefined;
}

/** Run in an isolated page world to read its existing same-origin image cache only. */
export function cachedTabFaviconScript(url: string): string {
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(url)}, { cache: 'only-if-cached', mode: 'same-origin', signal: AbortSignal.timeout(1000) });
      const mime = (response.headers.get('content-type') || '').split(';')[0];
      if (!response.ok || !['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(mime)) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 12000) { await reader.cancel(); return null; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return 'data:' + mime + ';base64,' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    } catch { return null; }
  })()`;
}
