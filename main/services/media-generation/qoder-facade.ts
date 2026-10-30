import type { AppServerClient } from '../../engine/client';
import type { Json } from '../../ipc/contract';
import { object, type JsonObject } from '../service-types';
import type { MediaGenerationDeps } from './service';

export interface QoderMediaEngine {
  generation: number;
  client: Pick<AppServerClient, 'isClosed' | 'requestWithTimeout'>;
}

/** Cancellation ends host observation; the named Qoder RPC has no remote cancellation method. */
export function createQoderMediaFacade(getEngine: () => QoderMediaEngine | undefined): MediaGenerationDeps['qoder'] {
  async function request(method: string, params: JsonObject, timeoutMs: number, signal: AbortSignal): Promise<Json> {
    signal.throwIfAborted();
    const engine = getEngine();
    if (!engine || engine.client.isClosed()) throw new Error('The Qoder engine connection is unavailable.');
    const { client, generation } = engine;
    const current = (): void => {
      signal.throwIfAborted();
      const active = getEngine();
      if (!active || active.client !== client || active.generation !== generation || client.isClosed()) throw new Error('The Qoder engine connection changed.');
    };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    // Both outcomes stay observed after cancellation. The engine client retains
    // its own RPC deadline, so a late reply cannot hold a session open or escape
    // as an unhandled rejection, and is never retried on a replacement client.
    const pending = Promise.resolve().then(() => { current(); return client.requestWithTimeout(method, params, timeoutMs); });
    try {
      const value = await Promise.race([pending, cancelled]);
      current(); return value as Json;
    } catch (error) {
      current();
      if (object(error).kind === 'timeout') throw new Error('The Qoder request timed out. An accepted remote job may still finish.');
      throw new Error('The Qoder request failed.');
    } finally { signal.removeEventListener('abort', cancel); }
  }
  return {
    status: signal => request('qoder/status', {}, 15_000, signal),
    generate: (params, signal) => request('qoder/generateImage', params, 300_000, signal),
  };
}
