import { MediaGenerationError } from './errors';
import { object, type JsonObject } from '../service-types';
import { LIMITS } from './contract';

export class TransportFailure extends MediaGenerationError {}
export function endpoint(raw: string, fallback?: string): string {
  let url: URL;
  try { url = new URL(raw || fallback || ''); } catch { throw new MediaGenerationError('Invalid media provider URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new MediaGenerationError('Invalid media provider URL.');
  return url.href.replace(/\/+$/, '');
}
export function base64Bytes(raw: unknown, maximum: number): Buffer {
  if (typeof raw !== 'string' || !raw.length || raw.length > Math.ceil(maximum / 3) * 4 || raw.length % 4 !== 0) throw new MediaGenerationError('The media provider returned invalid or oversized base64.');
  const bytes = Buffer.from(raw, 'base64');
  // Re-encoding rejects noncanonical input without a repeated-group regex,
  // which can exhaust the regexp stack on multi-megabyte media payloads.
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== raw) throw new MediaGenerationError('The media provider returned invalid or oversized base64.');
  return bytes;
}
export async function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export class MediaHttp {
  constructor(readonly fetcher: typeof fetch = fetch, readonly requestMs: number = LIMITS.requestMs) {}
  private async bytes(url: string, init: RequestInit, signal: AbortSignal, maximum: number, allowError: boolean, deadlineMs = this.requestMs): Promise<{ status: number; bytes: Buffer }> {
    signal.throwIfAborted();
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new MediaGenerationError('Media provider request timed out.')), deadlineMs);
    try {
      let response: Response;
      try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: combined }); }
      catch { signal.throwIfAborted(); throw new TransportFailure(controller.signal.aborted ? 'The media provider request timed out.' : 'The media provider could not be reached.'); }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try {
        if (Number(response.headers.get('content-length') ?? 0) > maximum) throw new MediaGenerationError('The media provider response is too large.');
        if (reader) for (;;) {
          combined.throwIfAborted();
          let next: Awaited<ReturnType<typeof reader.read>>;
          try { next = await reader.read(); } catch { signal.throwIfAborted(); throw new TransportFailure('The media provider response was interrupted.'); }
          if (next.done) break;
          length += next.value.byteLength;
          if (length > maximum) throw new MediaGenerationError('The media provider response is too large.');
          chunks.push(next.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      combined.throwIfAborted();
      if (!allowError && !response.ok) throw new MediaGenerationError(`Media provider HTTP ${response.status}.`);
      return { status: response.status, bytes: Buffer.concat(chunks) };
    } finally { clearTimeout(timer); }
  }
  async json(url: string, init: RequestInit, signal: AbortSignal, maximum = 16 * 1024 ** 2, allowError = false, deadlineMs?: number): Promise<{ status: number; body: JsonObject }> {
    const reply = await this.bytes(url, init, signal, maximum, allowError, deadlineMs);
    let parsed: unknown;
    try { parsed = JSON.parse(reply.bytes.toString('utf8')); } catch { throw new MediaGenerationError('The media provider returned invalid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MediaGenerationError('The media provider returned invalid JSON.');
    const body = object(parsed);
    // Upstream error text may echo credentials or source contents. Only the status
    // crosses the model boundary; request bodies and headers are never logged.
    if (!allowError && body.error != null) throw new MediaGenerationError(`The media provider rejected the request (HTTP ${reply.status}).`);
    return { status: reply.status, body };
  }
  async download(url: string, init: RequestInit, signal: AbortSignal, maximum: number): Promise<Buffer> {
    return (await this.bytes(url, init, signal, maximum, false)).bytes;
  }
}
export const jsonPost = (body: JsonObject, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
