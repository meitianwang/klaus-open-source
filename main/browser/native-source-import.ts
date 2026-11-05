import { randomUUID } from 'node:crypto';
import type { BrowserDiscoveryResult, BrowserImportRequest, BrowserImportResult } from '../../contracts/browser-import';
import type { BrowserProfileImportBackend } from '../../contracts/browser-import-jobs';
import { BrowserError } from './types';

export interface NativeSourceImportHandle {
  listImportableProfiles(requestId: string): Promise<BrowserDiscoveryResult>;
  importProfile(requestId: string, request: BrowserImportRequest): Promise<BrowserImportResult>;
  cancelProfileImport(requestId: string): void;
}

/** Forward cancellation without abandoning the receipt for in-flight native writes. */
export function nativeSourceImportBackend(
  profile: NativeSourceImportHandle,
  projectionFailure: (requestId: string) => string | undefined = () => undefined,
): BrowserProfileImportBackend {
  for (const method of ['listImportableProfiles', 'importProfile', 'cancelProfileImport'] as const) {
    if (typeof profile[method] !== 'function') {
      throw new BrowserError('unavailable', 'The native runtime does not provide browser profile import.');
    }
  }
  const operation = async <T>(id: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const cancel = (): void => { profile.cancelProfileImport(id); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const pending = run();
      if (signal.aborted) cancel();
      return await pending;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
  return {
    discover: async signal => {
      const discoveryId = randomUUID();
      const result = await operation(discoveryId, signal, () => profile.listImportableProfiles(discoveryId));
      signal.throwIfAborted();
      return result;
    },
    importProfile: async (id, request, signal) => {
      const result = await operation(id, signal, () => profile.importProfile(id, request));
      const failure = projectionFailure(id);
      if (!failure || !result || !Array.isArray(result.errors)) return result;
      return { ...result, ok: false, errors: [...result.errors, { category: 'history', code: 'history_projection_failed', message: failure }] };
    },
  };
}
