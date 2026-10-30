import type { Row } from './store';

export interface MicrophonePreferences {
  getMediaAccessStatus(mediaType: 'microphone'): 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>;
}

/** OS consent is separate from the trusted-renderer Chromium media permission. */
export async function microphonePermission(preferences: MicrophonePreferences, signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<Row> {
  signal.throwIfAborted();
  if (platform !== 'darwin' && platform !== 'win32') return { ok: false, status: 'unsupported' };
  let status = preferences.getMediaAccessStatus('microphone');
  if (platform === 'darwin' && status === 'not-determined') {
    const granted = await new Promise<boolean>((resolve, reject) => {
      const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      // The system prompt may outlive this operation. Its late answer cannot revive it.
      Promise.resolve().then(() => { signal.throwIfAborted(); return preferences.askForMediaAccess('microphone'); }).then(
        value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
    signal.throwIfAborted();
    status = granted ? 'granted' : 'denied';
  }
  return { ok: status === 'granted', status };
}
