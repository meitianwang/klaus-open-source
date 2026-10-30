import type { AppServerClient } from '../../engine/client';
import type { Json } from '../../ipc/contract';
import { object, type JsonObject } from '../service-types';
import type { MediaGenerationDeps } from './service';

export interface QoderworkMediaEngine {
  generation: number;
  client: Pick<AppServerClient, 'isClosed' | 'requestWithTimeout'>;
}

/** Same shape as the Qoder facade: cancellation ends host observation while
 *  the named RPC stays bounded on its original engine client. */
export function createQoderworkMediaFacade(getEngine: () => QoderworkMediaEngine | undefined): MediaGenerationDeps['qoderwork'] {
  async function request(method: string, params: JsonObject, timeoutMs: number, signal: AbortSignal): Promise<Json> {
    signal.throwIfAborted();
    const engine = getEngine();
    if (!engine || engine.client.isClosed()) throw new Error('The QoderWork engine connection is unavailable.');
    const { client, generation } = engine;
    const current = (): void => {
      signal.throwIfAborted();
      const active = getEngine();
      if (!active || active.client !== client || active.generation !== generation || client.isClosed()) throw new Error('The QoderWork engine connection changed.');
    };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const pending = Promise.resolve().then(() => { current(); return client.requestWithTimeout(method, params, timeoutMs); });
    try {
      const value = await Promise.race([pending, cancelled]);
      current(); return value as Json;
    } catch (error) {
      current();
      if (object(error).kind === 'timeout') throw new Error('The QoderWork request timed out. An accepted remote job may still finish.');
      throw new Error('The QoderWork request failed.');
    } finally { signal.removeEventListener('abort', cancel); }
  }
  return {
    status: signal => request('qoderwork/status', {}, 15_000, signal),
    generate: (params, signal) => request('qoderwork/generateImage', params, 300_000, signal),
  };
}
