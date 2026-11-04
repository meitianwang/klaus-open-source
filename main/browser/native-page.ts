import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BaseWindow } from 'electron';
import { BrowserError, message, type BrowserBounds } from './types';
import type { PageActivityLease, PageDebuggerChannel, PageTransport } from './page-transport';
import type { BrowserDownloadNetwork } from './native-downloads';

export interface NativeBrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface NativeProfileHeaders {
  url: string;
  status: number;
  headers: Array<[string, string]>;
}

export interface NativeProfileRead {
  done: boolean;
  data?: string;
}

export interface NativePageHandle {
  readonly debugger: PageDebuggerChannel;
  isDestroyed(): boolean;
  beginActivity(): void;
  endActivity(): void;
}

export interface NativeProfileRequestHandle {
  startRequest(id: string, url: string): Promise<NativeProfileHeaders>;
  readRequest(id: string): Promise<NativeProfileRead>;
  cancelRequest(id: string): void;
}

export interface NativeBrowserHandle extends NativePageHandle, NativeProfileRequestHandle {
  close(): void;
  getURL(): string;
  getTitle(): string;
  getState(): NativeBrowserState;
  loadURL(url: string): void;
  setBounds(bounds: BrowserBounds): void;
  getBounds(): BrowserBounds;
  setParent(parent: BaseWindow): void;
  setVisible(visible: boolean): void;
  focus(): void;
  setBubbleAnchor(anchor: unknown): void;
  getBubbleAnchor(): unknown;
  loadExtension(path: string): Promise<void> | void;
  on(event: 'did-navigate' | 'did-navigate-in-page', listener: (url: string) => void): this;
  on(event: 'page-title-updated', listener: (title: string) => void): this;
  on(event: 'render-process-gone', listener: (status: number) => void): this;
  on(event: 'did-start-loading' | 'did-stop-loading' | 'destroyed', listener: () => void): this;
  removeListener(event: 'did-navigate' | 'did-navigate-in-page', listener: (url: string) => void): this;
  removeListener(event: 'page-title-updated', listener: (title: string) => void): this;
  removeListener(event: 'render-process-gone', listener: (status: number) => void): this;
  removeListener(event: 'did-start-loading' | 'did-stop-loading' | 'destroyed', listener: () => void): this;
}

export interface NativeBrowserCreateOptions {
  parent: BaseWindow;
  bounds: BrowserBounds;
  url?: string;
}

export interface NativeBrowserConstructor {
  new (...args: unknown[]): NativeBrowserHandle;
  prototype: object;
}

export interface NativeBrowserBinding {
  NativeBrowser: NativeBrowserConstructor;
  create(options: NativeBrowserCreateOptions): Promise<NativeBrowserHandle>;
}

type LinkedBindingLoader = (name: string) => unknown;

const preparedPrototypes = new WeakSet<object>();

function defaultLinkedBinding(name: string): unknown {
  const runtime = process as unknown as { _linkedBinding?: (name: string) => unknown };
  if (typeof runtime._linkedBinding !== 'function') {
    throw new BrowserError('unavailable', 'The native browser binding is unavailable.');
  }
  return runtime._linkedBinding(name);
}

/**
 * Load the private linked binding and prepare its NativeBrowser prototype for
 * EventEmitter use. No Electron WebContents or Session is created here.
 */
export function loadNativeBrowserBinding(load: LinkedBindingLoader = defaultLinkedBinding): NativeBrowserBinding {
  let raw: unknown;
  try {
    raw = load('electron_browser_native_browser');
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    throw new BrowserError('unavailable', `The native browser binding is unavailable: ${message(error)}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new BrowserError('unavailable', 'The native browser binding did not return an object.');
  }
  const candidate = raw as { NativeBrowser?: unknown; create?: unknown };
  if (typeof candidate.NativeBrowser !== 'function' || typeof candidate.create !== 'function') {
    throw new BrowserError('unavailable', 'The native browser binding is missing NativeBrowser/create.');
  }
  const prototype = (candidate.NativeBrowser as { prototype?: unknown }).prototype;
  if (prototype === null || typeof prototype !== 'object') {
    throw new BrowserError('unavailable', 'The native browser binding has no prototype.');
  }
  if (!preparedPrototypes.has(prototype)) {
    try {
      Object.setPrototypeOf(prototype, EventEmitter.prototype);
    } catch (error) {
      throw new BrowserError('unavailable', `The native browser prototype could not be prepared: ${message(error)}`);
    }
    preparedPrototypes.add(prototype);
  }
  return raw as NativeBrowserBinding;
}

/** Native page transport: debugger, lifetime and activity only. */
export class NativePageTransport implements PageTransport {
  constructor(readonly page: NativePageHandle) {}

  get debugger(): PageDebuggerChannel { return this.page.debugger; }

  isDestroyed(): boolean { return this.page.isDestroyed(); }

  acquireActivity(): PageActivityLease {
    this.page.beginActivity();
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.page.endActivity();
      },
    };
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new BrowserError('cancelled', 'The native download was cancelled.');
}

function validateInit(init: RequestInit): void {
  const supported = new Set(['method', 'body', 'headers', 'redirect', 'credentials', 'signal']);
  for (const key of Object.keys(init)) {
    if (!supported.has(key)) {
      throw new BrowserError('invalid_request', `Native profile downloads do not support ${key}.`);
    }
  }
  if (init.method !== undefined && init.method.toUpperCase() !== 'GET') {
    throw new BrowserError('invalid_request', 'Native profile downloads support GET only.');
  }
  if (init.body !== undefined) {
    throw new BrowserError('invalid_request', 'Native profile downloads do not support a request body.');
  }
  if (init.headers !== undefined) {
    throw new BrowserError('invalid_request', 'Native profile downloads do not support custom request headers.');
  }
  if (init.redirect !== undefined && init.redirect !== 'manual') {
    throw new BrowserError('invalid_request', 'Native profile downloads require redirect: "manual".');
  }
  if (init.credentials !== undefined && init.credentials !== 'include') {
    throw new BrowserError('invalid_request', 'Native profile downloads require credentials: "include".');
  }
}

/**
 * GET stream over the native page's real Profile network. Responses are pulled
 * one native chunk at a time; redirects are returned before they are followed.
 */
export class NativeProfileDownloadNetwork implements BrowserDownloadNetwork {
  private readonly active = new Set<string>();

  constructor(
    private readonly page: NativeProfileRequestHandle,
    private readonly nextId: () => string = randomUUID,
  ) {}

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    validateInit(init);
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new BrowserError('invalid_request', 'The native download URL is invalid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BrowserError('invalid_request', 'Native profile downloads require an HTTP or HTTPS URL.');
    }
    const id = this.nextId();
    if (!id || id.length > 256) throw new BrowserError('download_limit', 'The native request id is invalid.');
    if (this.active.has(id)) throw new BrowserError('download_limit', 'The native request id is already active.');
    this.active.add(id);

    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      this.active.delete(id);
      throw abortReason(signal);
    }

    let finished = false;
    let aborted = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let onAbort: () => void = () => {};
    const finish = (cancel: boolean): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      this.active.delete(id);
      if (cancel) {
        try { this.page.cancelRequest(id); } catch { /* cancelRequest is idempotent */ }
      }
    };
    onAbort = (): void => {
      if (finished) return;
      aborted = true;
      const error = abortReason(signal);
      if (streamController) {
        try { streamController.error(error); } catch { /* the stream may already be settled */ }
      }
      finish(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      throw abortReason(signal);
    }

    let headers: NativeProfileHeaders;
    try {
      headers = await this.page.startRequest(id, url.href);
    } catch (error) {
      const wasAborted = aborted || signal?.aborted;
      finish(true);
      if (wasAborted) throw abortReason(signal);
      throw error instanceof Error ? error : new BrowserError('download_failed', String(error));
    }
    if (aborted || signal?.aborted) {
      finish(true);
      throw abortReason(signal);
    }

    const responseHeaders = new Headers();
    try {
      for (const pair of headers.headers) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
          throw new BrowserError('download_failed', 'The native request returned an invalid header pair.');
        }
        responseHeaders.append(pair[0], pair[1]);
      }
    } catch (error) {
      finish(true);
      throw error instanceof BrowserError ? error : new BrowserError('download_failed', message(error));
    }
    const status = headers.status;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      finish(true);
      throw new BrowserError('download_failed', `The native request returned an invalid HTTP status: ${status}.`);
    }
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308
      || status === 204 || status === 205 || status === 304) {
      finish(true);
      return new Response(null, { status, headers: responseHeaders });
    }

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller): Promise<void> => {
        if (finished) {
          controller.error(abortReason(signal));
          return;
        }
        streamController = controller;
        try {
          const chunk = await this.page.readRequest(id);
          if (finished) return;
          if (typeof chunk.data === 'string' && chunk.data.length > 0) {
            controller.enqueue(Buffer.from(chunk.data, 'base64'));
          }
          if (chunk.done === true) {
            finish(true);
            controller.close();
            return;
          }
          if (typeof chunk.data !== 'string' || chunk.data.length === 0) {
            finish(true);
            controller.error(new BrowserError('download_failed', 'The native request returned no data and no completion.'));
          }
        } catch (error) {
          if (finished) return;
          finish(true);
          controller.error(error instanceof Error ? error : new BrowserError('download_failed', String(error)));
        }
      },
      cancel: (): void => { finish(true); },
    }, { highWaterMark: 0 });
    try {
      return new Response(stream, { status, headers: responseHeaders });
    } catch (error) {
      finish(true);
      throw error instanceof Error ? error : new BrowserError('download_failed', message(error));
    }
  }
}
