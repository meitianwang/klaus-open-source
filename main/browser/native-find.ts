import {
  NATIVE_CONTENT_FIND_SELECTION,
  type NativeFindMatch,
  type NativeFindOptions,
  type NativeFindPage,
} from '../app/native-content-find';

/**
 * The native debugger channel used only to read the current selection. Mainline
 * may pass a prepared evaluate function instead when it already owns a
 * PageDebugger.
 */
export interface NativeFindDebugger {
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

/**
 * The real native page surface. `find` and `stopFind` must be backed by
 * find_in_page::FindTabHelper on the page's active WebContents; this adapter
 * never creates or impersonates an Electron WebContents.
 */
export interface NativeFindHandle {
  isDestroyed(): boolean;
  find(query: string, options: Required<NativeFindOptions>): Promise<NativeFindMatch>;
  stopFind(clear: boolean): void;
  readonly debugger: NativeFindDebugger;
  on(event: 'did-navigate', listener: (event: unknown, url: string) => void): unknown;
  on(event: 'destroyed', listener: (event: unknown) => void): unknown;
  removeListener(event: 'did-navigate', listener: (event: unknown, url: string) => void): unknown;
  removeListener(event: 'destroyed', listener: (event: unknown) => void): unknown;
}

export interface NativeFindPageOptions {
  evaluate?(expression: string): Promise<unknown>;
}

const activeFinds = new WeakMap<NativeFindHandle, object>();

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/** Read a value through the page's own debugger without detaching it. */
async function evaluateWithDebugger(handle: NativeFindHandle, expression: string): Promise<unknown> {
  const channel = handle.debugger;
  if (!channel.isAttached()) channel.attach('1.3');
  const answer = object(await channel.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }));
  const exception = object(answer?.exceptionDetails);
  if (exception) {
    const description = object(exception.exception)?.description;
    throw new Error(typeof description === 'string' ? description : String(exception.text ?? 'Native selection evaluation failed.'));
  }
  return object(answer?.result)?.value ?? null;
}

/** Adapt a real native page to the narrow find session surface. */
export function nativeFindPage(handle: NativeFindHandle, options: NativeFindPageOptions = {}): NativeFindPage {
  const evaluate = options.evaluate ?? ((expression: string) => evaluateWithDebugger(handle, expression));
  return {
    identity: handle,
    isDestroyed: () => handle.isDestroyed(),
    find: async (query, findOptions, signal) => {
      signal?.throwIfAborted();
      const request = {};
      activeFinds.set(handle, request);
      const aborted = (): void => {
        if (activeFinds.get(handle) !== request) return;
        activeFinds.delete(handle);
        if (!handle.isDestroyed()) handle.stopFind(false);
      };
      signal?.addEventListener('abort', aborted, { once: true });
      try {
        return await handle.find(query, findOptions);
      } finally {
        signal?.removeEventListener('abort', aborted);
        if (activeFinds.get(handle) === request) activeFinds.delete(handle);
      }
    },
    stopFind: clear => handle.stopFind(clear),
    readSelection: async () => {
      const selected = await evaluate(NATIVE_CONTENT_FIND_SELECTION);
      return typeof selected === 'string' ? selected : '';
    },
    onDestroyed: listener => {
      handle.on('destroyed', listener);
      return () => { handle.removeListener('destroyed', listener); };
    },
    onDidNavigate: listener => {
      handle.on('did-navigate', listener);
      return () => { handle.removeListener('did-navigate', listener); };
    },
  };
}
