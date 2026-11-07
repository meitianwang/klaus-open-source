import { MediaGenerationError } from './errors';
import { object, type JsonObject } from '../service-types';
import { LIMITS } from './contract';

export class TransportFailure extends MediaGenerationError {}

/** Translate recognized upstream diagnostics without exposing echoed prompts, credentials or media. */
export function mediaHttpFailure(status: number, payload?: unknown): MediaGenerationError {
  const body = object(payload), error = object(body.error);
  const raw = error.message ?? body.detail ?? body.message;
  const message = typeof raw === 'string' && raw.length <= 1024 ? raw.trim().replace(/[.!]+$/u, '').toLowerCase() : '';
  const reasons: Record<string, string> = {
    'unsupported content type': 'Unsupported content type',
    'unsupported media type': 'Unsupported media type',
    'invalid image size': 'Invalid image size',
    'invalid image format': 'Invalid image format',
    'invalid image': 'Invalid image data',
    'invalid api key': 'The generation credential was refused',
    'incorrect api key provided': 'The generation credential was refused',
    'rate limit exceeded': 'Generation is rate-limited',
    'insufficient quota': 'No generation allowance remains',
    'model not found': 'The requested generation model is unavailable',
  };
  const codes: Record<string, string> = {
    invalid_request_error: 'invalid_request_error', invalid_value: 'invalid_value',
    unsupported_content_type: 'unsupported_content_type', unsupported_media_type: 'unsupported_media_type',
    invalid_image: 'invalid_image', invalid_image_format: 'invalid_image_format', invalid_image_size: 'invalid_image_size',
    model_not_found: 'model_not_found', rate_limit_exceeded: 'rate_limit_exceeded',
    insufficient_quota: 'insufficient_quota', invalid_api_key: 'invalid_api_key', content_policy_violation: 'content_policy_violation',
  };
  const params = new Set(['size', 'model', 'images', 'image', 'prompt', 'n', 'quality', 'output_format', 'background', 'mask', 'input_fidelity']);
  const rawCode = error.code ?? body.code;
  const code = typeof rawCode === 'string' && Object.hasOwn(codes, rawCode) ? codes[rawCode] : undefined;
  const param = typeof error.param === 'string' && params.has(error.param) ? error.param : undefined;
  let reason = Object.hasOwn(reasons, message) ? reasons[message] : undefined;
  if (/^(?:image )?(?:width and height|dimensions) must be (?:divisible by|multiples of) 16$/u.test(message)) reason = 'Image width and height must be multiples of 16';
  const details = [reason, code ? `code: ${code}` : undefined, param ? `parameter: ${param}` : undefined].filter(Boolean);
  return new MediaGenerationError(`Media provider HTTP ${status}.${details.length ? ` ${details.join('; ')}.` : ''}`);
}
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
      const limit = response.ok ? maximum : Math.min(maximum, 16 * 1024);
      const overflow = (): Error => response.ok ? new MediaGenerationError('The media provider response is too large.') : mediaHttpFailure(response.status);
      try {
        if (Number(response.headers.get('content-length') ?? 0) > limit) throw overflow();
        if (reader) for (;;) {
          combined.throwIfAborted();
          let next: Awaited<ReturnType<typeof reader.read>>;
          try { next = await reader.read(); } catch { signal.throwIfAborted(); throw new TransportFailure('The media provider response was interrupted.'); }
          if (next.done) break;
          length += next.value.byteLength;
          if (length > limit) throw overflow();
          chunks.push(next.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      combined.throwIfAborted();
      if (!allowError && !response.ok) throw new MediaGenerationError(`Media provider HTTP ${response.status}.`);
      return { status: response.status, bytes: Buffer.concat(chunks) };
    } finally { clearTimeout(timer); }
  }
  async json(url: string, init: RequestInit, signal: AbortSignal, maximum = 16 * 1024 ** 2, allowError = false, deadlineMs?: number): Promise<{ status: number; body: JsonObject }> {
    // JSON callers parse bounded error bodies; binary downloads still expose only status.
    const reply = await this.bytes(url, init, signal, maximum, true, deadlineMs);
    let parsed: unknown;
    try { parsed = JSON.parse(reply.bytes.toString('utf8')); } catch {
      if (reply.status < 200 || reply.status >= 300) throw mediaHttpFailure(reply.status);
      throw new MediaGenerationError('The media provider returned invalid JSON.');
    }
    if (!allowError && (reply.status < 200 || reply.status >= 300)) throw mediaHttpFailure(reply.status, parsed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MediaGenerationError('The media provider returned invalid JSON.');
    const body = object(parsed);
    // Only host-authored reason templates and known diagnostic fields cross the boundary.
    if (!allowError && body.error != null) throw mediaHttpFailure(reply.status, body);
    return { status: reply.status, body };
  }
  async download(url: string, init: RequestInit, signal: AbortSignal, maximum: number): Promise<Buffer> {
    return (await this.bytes(url, init, signal, maximum, false)).bytes;
  }
}
export const jsonPost = (body: JsonObject, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
