import { MediaGenerationError } from './errors';
import { randomUUID } from 'node:crypto';
import type { AppServerClient } from '../../engine/client';
import type { Json } from '../../ipc/contract';
import { errorMessage, object, type JsonObject } from '../service-types';
import type { MediaGenerationDeps } from './service';

export interface NativeMediaEngine {
  generation: number;
  client: Pick<AppServerClient, 'isClosed' | 'requestWithTimeout'>;
}

export function workbuddyMediaFailure(error: unknown): Error { return nativeMediaFailure(error); }
function nativeMediaFailure(error: unknown): Error {
  const message = errorMessage(error);
  if (/(?:workbuddy|qwenwork|antigravity|trae)_.*(?:auth|credential|signed_out|expired)/i.test(message)) return new MediaGenerationError(`Reconnect the generation account in Settings before generating media.`);
  if (/(?:workbuddy|qwenwork|antigravity|trae)_.*(?:unsupported|unavailable|not_enabled)/i.test(message)) return new MediaGenerationError(`The requested media operation or options are unavailable.`);
  if (/(?:workbuddy|qwenwork|antigravity|trae)_.*(?:rate_limit|quota|credits)/i.test(message)) return new MediaGenerationError(`The generation usage or rate limit was reached. Check the account allowance in Settings before retrying.`);
  if (/(?:workbuddy|qwenwork|antigravity|trae)_.*(?:too_large|invalid)/i.test(message)) return new MediaGenerationError(`The generation service rejected an invalid or oversized media request or response.`);
  if (/(?:workbuddy|qwenwork|antigravity|trae)_.*(?:timeout|timed_out)/i.test(message) || object(error).kind === 'timeout') return new MediaGenerationError(`Media generation timed out. An accepted remote job may still finish.`);
  return new MediaGenerationError(`Media generation failed.`);
}

/** Native operations and cancellation remain bound to their original engine. */
export function createWorkbuddyMediaFacade(getEngine: () => NativeMediaEngine | undefined): NonNullable<MediaGenerationDeps['workbuddy']> { return createNativeMediaFacade('workbuddy', getEngine); }
export function createQwenworkNativeMediaFacade(getEngine: () => NativeMediaEngine | undefined): NonNullable<MediaGenerationDeps['workbuddy']> { return createNativeMediaFacade('qwenwork', getEngine); }
export function createAntigravityMediaFacade(getEngine: () => NativeMediaEngine | undefined): NonNullable<MediaGenerationDeps['antigravity']> { return createNativeMediaFacade('antigravity', getEngine); }
export function createTraeMediaFacade(getEngine: () => NativeMediaEngine | undefined): NonNullable<MediaGenerationDeps['trae']> { return createNativeMediaFacade('trae', getEngine); }
function createNativeMediaFacade(source: 'workbuddy' | 'qwenwork' | 'antigravity' | 'trae', getEngine: () => NativeMediaEngine | undefined): NonNullable<MediaGenerationDeps['workbuddy']> {
  async function request(method: string, params: JsonObject, timeoutMs: number, signal: AbortSignal, cancellable = true): Promise<Json> {
    signal.throwIfAborted();
    const engine = getEngine();
    if (!engine || engine.client.isClosed()) throw new MediaGenerationError(`The media generation connection is unavailable.`);
    const { client, generation } = engine, operationId = randomUUID();
    let submitted = false;
    const cancelRemote = (): void => {
      if (submitted && cancellable && !client.isClosed()) void client.requestWithTimeout(`${source}/cancelOperation`, { operationId }, 3000).catch(() => {});
    };
    const current = (): void => {
      signal.throwIfAborted();
      const active = getEngine();
      if (!active || active.client !== client || active.generation !== generation || client.isClosed()) throw new MediaGenerationError(`The media generation connection changed.`);
    };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => { cancelRemote(); reject(signal.reason); }; });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const pending = Promise.resolve().then(() => {
      current(); submitted = true;
      return client.requestWithTimeout(method, cancellable ? { ...params, operationId } : params, timeoutMs, { signal });
    });
    try { const result = await Promise.race([pending, cancelled]); current(); return result as Json; }
    catch (error) { if (object(error).kind === 'timeout') cancelRemote(); current(); throw nativeMediaFailure(error); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  return {
    status: signal => request(`${source}/status`, {}, 15_000, signal, false),
    capabilities: signal => request(`${source}/capabilities`, {}, 15_000, signal, false),
    image: (params, signal) => request(`${source}/generateImage`, params, 300_000, signal),
    video: (params, signal) => source === 'antigravity' ? Promise.reject(new MediaGenerationError('Video generation is unavailable.')) : request(`${source}/generateVideo`, params, 900_000, signal),
    audio: (params, signal) => source === 'antigravity' || source === 'trae' ? Promise.reject(new MediaGenerationError('Speech and music generation are unavailable.')) : request(`${source}/${source === 'workbuddy' ? 'synthesizeSpeech' : 'generateMusic'}`, params, 300_000, signal),
  };
}
