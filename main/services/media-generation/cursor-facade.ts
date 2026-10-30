import { randomUUID } from 'node:crypto';
import type { AppServerClient } from '../../engine/client';
import type { Json } from '../../ipc/contract';
import { errorMessage, object, type JsonObject } from '../service-types';
import type { MediaGenerationDeps } from './service';

export interface CursorMediaEngine {
  generation: number;
  client: Pick<AppServerClient, 'isClosed' | 'requestWithTimeout'>;
}

/** Only stable provider classifications cross the native media boundary. */
export function cursorMediaFailure(error: unknown): Error {
  const message = errorMessage(error);
  if (/\bcursor_native_capability_not_enabled\b/.test(message)) return new Error('Cursor has not enabled this independent service for the current connection.');
  if (/\bcursor_rate_limit\b/.test(message)) return new Error('Cursor usage or rate limit reached. Check the account allowance before retrying.');
  if (/\bcursor_(?:adopted_credential_needs_reimport|browser_login_expired|credentials_expired|client_metadata_missing)\b/.test(message)) return new Error('Reconnect the Cursor account in Settings before generating media.');
  if (/\bcursor_permission_denied\b/.test(message)) return new Error('Cursor denied this media operation for the signed-in account.');
  if (/\bcursor_native_operation_response_invalid\b/.test(message)) return new Error('Cursor returned an invalid native service response.');
  if (/\bcursor_.*(?:too_large|limit|invalid|unsupported)\b/.test(message)) return new Error('Cursor rejected an unsupported, invalid or oversized media request or response.');
  if (/\bcursor_operation_timed_out\b/.test(message) || object(error).kind === 'timeout') return new Error('Cursor media generation timed out. An accepted remote job may still finish.');
  return new Error('Cursor media generation failed.');
}

/** One native operation stays on its captured engine, including cancellation. */
export function createCursorMediaFacade(getEngine: () => CursorMediaEngine | undefined): NonNullable<MediaGenerationDeps['cursor']> {
  async function request(method: string, params: JsonObject, timeoutMs: number, signal: AbortSignal, cancellable = true): Promise<Json> {
    signal.throwIfAborted();
    const engine = getEngine();
    if (!engine || engine.client.isClosed()) throw new Error('The Cursor engine connection is unavailable.');
    const { client, generation } = engine;
    const operationId = randomUUID();
    let submitted = false;
    const cancelRemote = (): void => {
      if (submitted && cancellable && !client.isClosed()) {
        void client.requestWithTimeout('cursor/cancelOperation', { operationId }, 3000).catch(() => {});
      }
    };
    const current = (): void => {
      signal.throwIfAborted();
      const active = getEngine();
      if (!active || active.client !== client || active.generation !== generation || client.isClosed()) throw new Error('The Cursor engine connection changed.');
    };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        // Cancellation never acquires or retries on a replacement engine.
        cancelRemote();
        reject(signal.reason);
      };
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const pending = Promise.resolve().then(() => {
      current();
      submitted = true;
      return client.requestWithTimeout(method, cancellable ? { ...params, operationId } : params, timeoutMs, { signal });
    });
    try {
      const result = await Promise.race([pending, cancelled]);
      current(); return result as Json;
    } catch (error) {
      if (object(error).kind === 'timeout') cancelRemote();
      current(); throw cursorMediaFailure(error);
    } finally { signal.removeEventListener('abort', cancel); }
  }
  return {
    status: signal => request('cursor/status', {}, 15_000, signal, false),
    image: (params, signal) => request('cursor/generateImage', params, 300_000, signal),
    audio: (params, signal) => request('cursor/generateAudio', params, 300_000, signal),
  };
}
