import type { AppServerClient } from '../../engine/client';
import type { Json } from '../../ipc/contract';
import { object, string, type JsonObject } from '../service-types';
import type { MediaGenerationDeps } from './service';

export interface MinimaxMediaEngine {
  generation: number;
  client: Pick<AppServerClient, 'isClosed' | 'requestWithTimeout'>;
}

export interface MinimaxCredential { apiKey: string; baseUrl: string; region: string }

/**
 * Resolve the MiniMax M Plan subscription credential for the video route.
 *
 * The plan's video API is the service's own async task protocol, which the host runs
 * directly so it can reuse the existing task polling, container validation, size caps
 * and cancellation rather than a second copy inside the engine. That needs the stored
 * subscription key, and the engine — which owns the credential file — hands it over
 * through a named method, on the same precedent as `model/credential/read`.
 *
 * Cancellation discipline matches the Qoder/QwenWork facades: ending host observation
 * does not retry on a replacement client, and a late reply cannot hold a session open.
 *
 * The credential is used to build one request and is never returned to a renderer or
 * written into a tool result. A signed-out source answers `undefined`, which the
 * service turns into a "not configured" notice rather than an error.
 */
export function createMinimaxMediaFacade(
  getEngine: () => MinimaxMediaEngine | undefined,
): MediaGenerationDeps['minimax'] {
  async function request(method: string, params: JsonObject, timeoutMs: number, signal: AbortSignal): Promise<Json> {
    signal.throwIfAborted();
    const engine = getEngine();
    if (!engine || engine.client.isClosed()) throw new Error('The MiniMax engine connection is unavailable.');
    const { client, generation } = engine;
    const current = (): void => {
      signal.throwIfAborted();
      const active = getEngine();
      if (!active || active.client !== client || active.generation !== generation || client.isClosed()) throw new Error('The MiniMax engine connection changed.');
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
      if (object(error).kind === 'timeout') throw new Error('The MiniMax request timed out.');
      throw new Error('The MiniMax request failed.');
    } finally { signal.removeEventListener('abort', cancel); }
  }
  return {
    credential: async (signal): Promise<MinimaxCredential | undefined> => {
      const reply = object(await request('minimax/mediaCredential', {}, 15_000, signal));
      if (reply.ok !== true) return undefined;
      const apiKey = string(reply.apiKey), baseUrl = string(reply.baseUrl);
      if (!apiKey || !baseUrl) return undefined;
      return { apiKey, baseUrl, region: string(reply.region) || 'cn' };
    },
  };
}
