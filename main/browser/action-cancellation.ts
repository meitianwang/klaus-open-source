import { BrowserError } from './types';

export function assertBrowserActionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserError('cancelled', 'The browser action was cancelled.');
}

/** Stop awaiting a transport reply; already submitted browser work cannot be undone. */
export function browserAction<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertBrowserActionActive(signal);
  if (!signal) return work();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      settle();
    };
    const abort = (): void => finish(() => reject(new BrowserError('cancelled', 'The browser action was cancelled.')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { work().then(value => finish(() => resolve(value)), error => finish(() => reject(error))); }
    catch (error) { finish(() => reject(error)); }
  });
}

export function pauseBrowserAction(ms: number, signal?: AbortSignal): Promise<void> {
  assertBrowserActionActive(signal);
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new BrowserError('cancelled', 'The browser action was cancelled.'));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
