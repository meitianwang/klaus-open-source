import type { WebContents } from 'electron';
import { BrowserError, message, type BrowserObject } from './types';

export type PageDebuggerMessageListener = (event: unknown, method: string, params: unknown, sessionId?: string) => void;
export type PageDebuggerDetachListener = () => void;

/**
 * The CDP debugger surface that PageDebugger needs. It is intentionally
 * narrower than Electron's full Debugger type so native pages can supply a
 * channel without pretending to be WebContents.
 */
export interface PageDebuggerChannel {
  on(event: 'message', listener: PageDebuggerMessageListener): unknown;
  on(event: 'detach', listener: PageDebuggerDetachListener): unknown;
  removeListener(event: 'message', listener: PageDebuggerMessageListener): unknown;
  removeListener(event: 'detach', listener: PageDebuggerDetachListener): unknown;
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  sendCommand(method: string, params?: BrowserObject, sessionId?: string): Promise<unknown>;
  detach(): void;
}

/** A lease keeps the page renderable while an agent operation is running. */
export interface PageActivityLease {
  release(): void | Promise<void>;
}

/**
 * Page surface abstraction. Native pages implement this directly with their
 * own debugger channel and activity API; Electron pages use
 * {@link ElectronPageTransport} below.
 */
export interface PageTransport {
  readonly debugger: PageDebuggerChannel;
  isDestroyed(): boolean;
  acquireActivity(): PageActivityLease | Promise<PageActivityLease>;
  /** Optional viewport capture. When absent PageDebugger falls back to CDP. */
  captureViewport?(format: string, quality: number): Promise<string>;
  /** Optional native PDF renderer. When absent PageDebugger falls back to CDP. */
  printToPDF?(): Promise<Uint8Array>;
}

export function isPageTransport(value: WebContents | PageTransport): value is PageTransport {
  return (
    value !== null &&
    typeof value === 'object' &&
    'acquireActivity' in value &&
    typeof (value as PageTransport).acquireActivity === 'function' &&
    'debugger' in value &&
    typeof (value as PageTransport).isDestroyed === 'function'
  );
}

/**
 * Electron WebContents adapter that preserves the existing background
 * throttling and viewport capture behavior while exposing only the page
 * surface PageDebugger needs.
 */
export class ElectronPageTransport implements PageTransport {
  private activityUsers = 0;
  private activityReady: Promise<void> | undefined;
  private previousThrottling = true;

  readonly debugger: PageDebuggerChannel;

  constructor(readonly contents: WebContents) {
    this.debugger = contents.debugger as unknown as PageDebuggerChannel;
  }

  isDestroyed(): boolean {
    return this.contents.isDestroyed();
  }

  /**
   * Keep the WebContents compositing while an agent operation runs. The first
   * lease disables background throttling; the last lease restores the previous
   * value. Leases are idempotent and safe to release more than once.
   */
  acquireActivity(): PageActivityLease {
    this.activityUsers += 1;
    if (this.activityUsers === 1) {
      this.activityReady = (async () => {
        if (!this.contents.isDestroyed()) {
          this.previousThrottling = this.contents.getBackgroundThrottling();
          this.contents.setBackgroundThrottling(false);
        }
      })();
    }
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        try { await this.activityReady; } catch { /* setup failures still need accounting */ }
        this.activityUsers = Math.max(0, this.activityUsers - 1);
        if (this.activityUsers === 0 && !this.contents.isDestroyed()) {
          this.contents.setBackgroundThrottling(this.previousThrottling);
        }
        if (this.activityUsers === 0) this.activityReady = undefined;
      },
    };
  }

  async captureViewport(format: string, quality: number): Promise<string> {
    if (this.contents.isDestroyed()) throw new BrowserError('stale_tab', 'The browser page is closed.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const image = await Promise.race([
        this.contents.capturePage(undefined, { stayHidden: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BrowserError('timeout', 'Browser capture timed out.')), 15_000);
        }),
      ]);
      if (image.isEmpty()) throw new BrowserError('host_error', 'The browser returned an empty screenshot.');
      return (format === 'jpeg' ? image.toJPEG(quality) : image.toPNG()).toString('base64');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async printToPDF(): Promise<Uint8Array> {
    if (this.contents.isDestroyed()) throw new BrowserError('stale_tab', 'The browser page is closed.');
    const pdf = await this.contents.printToPDF({ printBackground: true });
    if (!pdf.length) throw new BrowserError('host_error', 'The browser returned an empty PDF.');
    return pdf;
  }
}
