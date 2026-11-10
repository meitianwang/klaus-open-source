import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  dialog,
  ipcMain,
  Menu,
  type BrowserWindow,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import {
  BROWSER_AUTOFILL_CHANNELS,
  BROWSER_CREDENTIAL_LIMITS,
  type BrowserAutofillAck,
  type BrowserAutofillCandidate,
  type BrowserAutofillChoice,
  type BrowserAutofillFieldKind,
  type BrowserAutofillFillMessage,
  type BrowserAutofillFrame,
  type BrowserAutofillSaveCandidate,
  type BrowserAutofillSubmission,
} from '../../contracts/browser-credentials';
import { AUTOFILL_PRELOAD_SOURCE } from './autofill-preload';
import { BrowserAutofillController } from './autofill';
import { frameCdp } from './dom';
import { AUTOFILL_CONTAINER_WORLD, isolatedWorldEvaluate } from './page-evaluate';
import type { BrowserCdp } from './page-operations';
import { object, type BrowserObject } from './types';
import type { BrowserCredentialsStore } from './credentials-store';

export interface BrowserAutofillBridgeLabels {
  chooseCredential: string;
  cancel: string;
  savePasswordTitle: string;
  savePasswordMessage: (origin: string, username: string) => string;
  save: string;
  dontSave: string;
}

export interface BrowserAutofillBridgeOptions {
  session: Session;
  store: BrowserCredentialsStore;
  isManagedContents(contents: WebContents): boolean;
  isPresented(contents: WebContents): boolean;
  windowForContents(contents: WebContents): BrowserWindow | null;
  labels: BrowserAutofillBridgeLabels;
  preloadDirectory?: string;
  ackTimeoutMs?: number;
  enabled?: () => boolean;
  /** Page transport lookup so the container scan can run in an isolated world. */
  cdpForContents?: (contents: WebContents) => BrowserCdp | undefined;
  /** Test seam; production omits this and uses Menu.popup. */
  chooseCredential?: (
    candidates: BrowserAutofillCandidate[],
    context: { frame: BrowserAutofillFrame; kind: BrowserAutofillFieldKind; intentId: string },
  ) => Promise<BrowserAutofillChoice | null>;
  /** Test seam; production omits this and uses dialog.showMessageBox. */
  confirmSave?: (
    candidate: BrowserAutofillSaveCandidate,
    submission: BrowserAutofillSubmission,
  ) => Promise<boolean>;
}

interface FrameRecord {
  frameId: string;
  contents: WebContents;
  frame: WebFrameMain;
  processId: number;
  routingId: number;
  frameToken: string;
  frameTreeNodeId: number;
  origin: string;
  documentId: string;
  isTopFrame: boolean;
}

interface AckWaiter {
  resolve(ack: BrowserAutofillAck): void;
  timer: ReturnType<typeof setTimeout>;
}

const FIELD_KINDS = new Set<BrowserAutofillFieldKind>(['username', 'password', 'email', 'address', 'contact']);

function exactOrigin(frameUrl: string): string | null {
  try {
    const url = new URL(frameUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function frameOrigin(frame: WebFrameMain): string | null {
  return exactOrigin(frame.origin || frame.url);
}

function frameIdentity(contents: WebContents, frame: WebFrameMain): string {
  return `${contents.id}:${frame.processId}:${frame.routingId}:${frame.frameToken}`;
}

function ackKey(frameId: string, documentId: string, intentId: string): string {
  return `${frameId}\u0000${documentId}\u0000${intentId}`;
}

/**
 * Container scan for one credential frame. Reports 'nested_document' when the
 * document embeds another navigable document (iframe, frame, object or embed
 * in any shadow root or nested document), 'service_workers' when a worker
 * controls or is registered for the frame, and null when the frame is fully
 * self-contained.
 */
const CONTAINER_SCAN_SCRIPT = `(async()=>{const embedded=new Set(['IFRAME','FRAME','OBJECT','EMBED']);const walkChildren=parent=>{for(const child of parent.children??[])if(walkNode(child))return true;return false;};const walkNode=node=>{if(!node||node.nodeType!==1)return false;if(embedded.has(node.tagName))return true;if(node.shadowRoot&&walkChildren(node.shadowRoot))return true;const content='contentDocument'in node?node.contentDocument:null;if(content&&walkChildren(content))return true;return false;};if(walkChildren(document))return 'nested_document';try{const serviceWorker=navigator.serviceWorker;if(serviceWorker){if(serviceWorker.controller)return 'service_workers';if((await serviceWorker.getRegistrations()).length)return 'service_workers';}}catch{}return null;})()`;

/**
 * Host glue for the autofill controller.
 *
 * Every authorization decision is made from the IPC sender's WebContents and
 * event.senderFrame. Page-provided frameId, origin and trusted fields are
 * ignored. Fill messages are sent to one WebFrameMain, never broadcast.
 */
export class BrowserAutofillBridge {
  private readonly controller: BrowserAutofillController;
  private readonly frames = new Map<string, FrameRecord>();
  private readonly contentsById = new Map<number, WebContents>();
  private readonly contentCleanup = new Map<number, () => void>();
  private readonly ackWaiters = new Map<string, AckWaiter>();
  private readonly submissionsByContents = new Map<number, Set<string>>();
  private preloadScriptId: string | null = null;
  private preloadPath: string | null = null;
  private disposed = false;
  private started = false;
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly options: BrowserAutofillBridgeOptions) {
    this.controller = new BrowserAutofillController({
      store: options.store,
      resolveFrame: async frameId => this.resolveFrame(frameId),
      chooseCredential: options.chooseCredential
        ? (candidates, context) => options.chooseCredential!(candidates, context)
        : (candidates, context) => this.chooseWithMenu(candidates, context),
      confirmSave: options.confirmSave
        ? (candidate, context) => options.confirmSave!(candidate, context.submission)
        : (candidate, context) => this.confirmWithDialog(candidate, context.submission),
      sendToFrame: (frameId, message) => this.sendToFrame(frameId, message),
      ackTimeoutMs: options.ackTimeoutMs,
      enabled: () => !this.disposed && (options.enabled ? options.enabled() : true),
      isSubmissionAlive: submission => this.isSubmissionAlive(submission),
      verifyContainer: frame => this.verifyContainer(frame),
    });
  }

  /** True while any frame has an in-flight credential submission. */
  hasInFlight(): boolean {
    return this.controller.hasInFlight();
  }

  /**
   * Container integrity check for one credential frame. Host-side facts come
   * first (live identity, exact origin, child frames); the document scan and
   * the service-worker probe then run in an isolated world through the page's
   * CDP transport when it can address this frame uniquely, so page scripts
   * cannot forge the verdict. Otherwise the scan falls back to evaluating on
   * the frame handle itself. Returns null when the frame fully contains its
   * document, otherwise a refusal reason code.
   */
  private async verifyContainer(frame: BrowserAutofillFrame): Promise<string | null> {
    const record = this.frames.get(frame.frameId);
    if (!record || record.contents.isDestroyed() || record.frame.isDestroyed()) return 'unknown_frame';
    if (record.documentId !== frame.documentId) return 'unknown_frame';
    if (record.origin !== frame.origin || frameOrigin(record.frame) !== frame.origin) return 'frame_origin';
    let children: number;
    try {
      children = record.frame.frames.length;
    } catch {
      return 'verification_failed';
    }
    if (children > 0) return 'child_frames';
    try {
      const cdp = this.options.cdpForContents?.(record.contents);
      const scoped = cdp ? await this.containerFrameTransport(cdp, record, frame) : undefined;
      const verdict = scoped
        ? await isolatedWorldEvaluate(scoped, AUTOFILL_CONTAINER_WORLD, CONTAINER_SCAN_SCRIPT)
        : await record.frame.executeJavaScript(CONTAINER_SCAN_SCRIPT);
      return typeof verdict === 'string' && verdict ? verdict : null;
    } catch {
      return 'verification_failed';
    }
  }

  /**
   * Address the page transport at this exact frame: the root page for the main
   * frame, otherwise the frame tree entry whose URL and origin match this
   * frame uniquely. An ambiguous or failed match returns undefined so the
   * caller falls back to the frame handle.
   */
  private async containerFrameTransport(cdp: BrowserCdp, record: FrameRecord, frame: BrowserAutofillFrame): Promise<BrowserCdp | undefined> {
    try {
      if (record.frame === record.contents.mainFrame) return cdp;
      const url = record.frame.url;
      const tree = object(await cdp.command('Page.getFrameTree'));
      const matches: string[] = [];
      const walk = (node: BrowserObject): void => {
        const info = object(node.frame);
        const id = typeof info.id === 'string' ? info.id : '';
        const securityOrigin = typeof info.securityOrigin === 'string' ? info.securityOrigin : '';
        if (id && info.url === url && (!securityOrigin || securityOrigin === frame.origin)) matches.push(id);
        for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) walk(object(child));
      };
      walk(object(tree.frameTree));
      if (matches.length !== 1) return undefined;
      return frameCdp(cdp, matches[0]);
    } catch {
      return undefined;
    }
  }

  async start(): Promise<{ preloadPath: string; preloadScriptId: string }> {
    if (this.disposed) throw new Error('Autofill bridge is disposed.');
    if (this.started) {
      return { preloadPath: this.preloadPath!, preloadScriptId: this.preloadScriptId! };
    }
    await app.whenReady();
    this.preloadPath = this.writePreload();
    this.preloadScriptId = this.options.session.registerPreloadScript({
      type: 'frame',
      filePath: this.preloadPath,
      id: `klaus-browser-autofill-${randomUUID()}`,
    });
    this.listen(BROWSER_AUTOFILL_CHANNELS.documentRequest, this.onDocumentRequest);
    this.listen(BROWSER_AUTOFILL_CHANNELS.input, this.onInput);
    this.listen(BROWSER_AUTOFILL_CHANNELS.submit, this.onSubmit);
    this.listen(BROWSER_AUTOFILL_CHANNELS.ack, this.onAck);
    this.started = true;
    return { preloadPath: this.preloadPath, preloadScriptId: this.preloadScriptId };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.listeners.splice(0)) remove();
    if (this.preloadScriptId) {
      try { this.options.session.unregisterPreloadScript(this.preloadScriptId); } catch { /* session may be shutting down */ }
      this.preloadScriptId = null;
    }
    for (const contents of [...this.contentsById.values()]) this.dropContents(contents);
    for (const waiter of this.ackWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ documentId: '', intentId: '', filled: false, reason: 'cancelled' });
    }
    this.ackWaiters.clear();
    this.controller.dispose();
  }

  private writePreload(): string {
    const directory = this.options.preloadDirectory ?? join(app.getPath('userData'), 'browser-autofill');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, 'autofill-preload.cjs');
    writeFileSync(file, AUTOFILL_PRELOAD_SOURCE, { encoding: 'utf8', mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  }

  private listen(channel: string, handler: (event: IpcMainEvent, payload: unknown) => void): void {
    const listener = (event: IpcMainEvent, payload: unknown) => handler(event, payload);
    ipcMain.on(channel, listener);
    this.listeners.push(() => ipcMain.removeListener(channel, listener));
  }

  private eventFrame(event: IpcMainEvent): { contents: WebContents; frame: WebFrameMain; key: string; origin: string } | null {
    if (this.disposed) return null;
    try {
      if (event.sender.session !== this.options.session) return null;
      if (!this.options.isManagedContents(event.sender) || !this.options.isPresented(event.sender)) return null;
      const frame = event.senderFrame;
      if (!frame || frame.isDestroyed()) return null;
      const origin = frameOrigin(frame);
      if (!origin) return null;
      return { contents: event.sender, frame, key: frameIdentity(event.sender, frame), origin };
    } catch {
      return null;
    }
  }

  private onDocumentRequest = (event: IpcMainEvent): void => {
    const identity = this.eventFrame(event);
    if (!identity) return;
    const previous = this.frames.get(identity.key);
    if (previous) this.revokeFrame(previous);
    const documentId = randomUUID();
    const record: FrameRecord = {
      frameId: identity.key,
      contents: identity.contents,
      frame: identity.frame,
      processId: identity.frame.processId,
      routingId: identity.frame.routingId,
      frameToken: identity.frame.frameToken,
      frameTreeNodeId: identity.frame.frameTreeNodeId,
      origin: identity.origin,
      documentId,
      isTopFrame: identity.frame.parent === null,
    };
    this.frames.set(record.frameId, record);
    this.watchContents(record.contents);
    this.controller.noteFrame({
      frameId: record.frameId,
      origin: record.origin,
      documentId: record.documentId,
      isTopFrame: record.isTopFrame,
    });
    try {
      identity.frame.send(BROWSER_AUTOFILL_CHANNELS.document, {
        type: BROWSER_AUTOFILL_CHANNELS.document,
        documentId,
      });
    } catch {
      this.revokeFrame(record);
    }
  };

  private onInput = (event: IpcMainEvent, payload: unknown): void => {
    const identity = this.eventFrame(event);
    if (!identity || !payload || typeof payload !== 'object') return;
    const value = payload as { documentId?: unknown; intentId?: unknown; kind?: unknown };
    const record = this.frames.get(identity.key);
    if (!record || value.documentId !== record.documentId || typeof value.intentId !== 'string' || !value.intentId) return;
    if (typeof value.kind !== 'string' || !FIELD_KINDS.has(value.kind as BrowserAutofillFieldKind)) return;
    void this.controller.trustedInput({
      frameId: record.frameId,
      kind: value.kind as BrowserAutofillFieldKind,
      intentId: value.intentId,
      trusted: true,
    }).catch(() => undefined);
  };

  private onSubmit = (event: IpcMainEvent, payload: unknown): void => {
    const identity = this.eventFrame(event);
    if (!identity || !payload || typeof payload !== 'object') return;
    const value = payload as { documentId?: unknown; username?: unknown; password?: unknown };
    const record = this.frames.get(identity.key);
    if (!record || value.documentId !== record.documentId) return;
    if (typeof value.username !== 'string' || typeof value.password !== 'string') return;
    const username = value.username.trim();
    if (!username || username.length > BROWSER_CREDENTIAL_LIMITS.maxUsernameLength
      || !value.password || value.password.length > BROWSER_CREDENTIAL_LIMITS.maxPasswordLength) return;
    const submission: BrowserAutofillSubmission = {
      submissionId: randomUUID(),
      frameId: record.frameId,
      documentId: record.documentId,
      contentsId: record.contents.id,
      processId: record.processId,
      routingId: record.routingId,
      frameToken: record.frameToken,
      frameTreeNodeId: record.frameTreeNodeId,
      originUrl: record.origin,
      username,
      password: value.password,
      capturedAt: Date.now(),
    };
    const ids = this.submissionsByContents.get(record.contents.id) ?? new Set<string>();
    ids.add(submission.submissionId);
    this.submissionsByContents.set(record.contents.id, ids);
    void this.controller.captureSave(submission).finally(() => {
      ids.delete(submission.submissionId);
      if (!ids.size) this.submissionsByContents.delete(record.contents.id);
    }).catch(() => undefined);
  };

  private onAck = (event: IpcMainEvent, payload: unknown): void => {
    const identity = this.eventFrame(event);
    if (!identity || !payload || typeof payload !== 'object') return;
    const value = payload as { documentId?: unknown; intentId?: unknown; filled?: unknown; reason?: unknown };
    if (typeof value.documentId !== 'string' || typeof value.intentId !== 'string') return;
    const waiter = this.ackWaiters.get(ackKey(identity.key, value.documentId, value.intentId));
    if (!waiter) return;
    this.ackWaiters.delete(ackKey(identity.key, value.documentId, value.intentId));
    clearTimeout(waiter.timer);
    waiter.resolve({
      documentId: value.documentId,
      intentId: value.intentId,
      filled: value.filled === true,
      ...(value.reason === 'no_target' || value.reason === 'navigation' || value.reason === 'cancelled'
        ? { reason: value.reason }
        : {}),
    });
  };

  private resolveFrame(frameId: string): BrowserAutofillFrame | null {
    const record = this.frames.get(frameId);
    if (!record || record.frame.isDestroyed()) {
      if (record) this.revokeFrame(record);
      return null;
    }
    return {
      frameId: record.frameId,
      origin: record.origin,
      documentId: record.documentId,
      isTopFrame: record.isTopFrame,
    };
  }

  private sendToFrame(frameId: string, message: BrowserAutofillFillMessage): Promise<BrowserAutofillAck> {
    const record = this.frames.get(frameId);
    if (!record || record.documentId !== message.documentId || record.frame.isDestroyed()) {
      return Promise.resolve({ documentId: message.documentId, intentId: message.intentId, filled: false, reason: 'no_target' });
    }
    const key = ackKey(frameId, message.documentId, message.intentId);
    return new Promise<BrowserAutofillAck>(resolve => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(key);
        resolve({ documentId: message.documentId, intentId: message.intentId, filled: false, reason: 'no_target' });
      }, Math.max(1, Math.min(this.options.ackTimeoutMs ?? 1_500, 10_000)) + 100);
      this.ackWaiters.set(key, { resolve, timer });
      try {
        record.frame.send(BROWSER_AUTOFILL_CHANNELS.fill, message);
      } catch {
        clearTimeout(timer);
        this.ackWaiters.delete(key);
        resolve({ documentId: message.documentId, intentId: message.intentId, filled: false, reason: 'no_target' });
      }
    });
  }

  private async chooseWithMenu(
    candidates: BrowserAutofillCandidate[],
    context: { frame: BrowserAutofillFrame; kind: BrowserAutofillFieldKind },
  ): Promise<BrowserAutofillChoice | null> {
    const record = this.frames.get(context.frame.frameId);
    const window = record ? this.options.windowForContents(record.contents) : null;
    if (!window || window.isDestroyed()) return null;
    return new Promise(resolve => {
      let settled = false;
      const finish = (choice: BrowserAutofillChoice | null) => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      const template: MenuItemConstructorOptions[] = [
        { label: this.options.labels.chooseCredential, enabled: false },
        { type: 'separator' },
        ...candidates.map(candidate => ({
          label: candidate.preview ?? candidate.username ?? candidate.label ?? candidate.id,
          click: () => finish({ candidateId: candidate.id }),
        })),
        { type: 'separator' },
        { label: this.options.labels.cancel, click: () => finish(null) },
      ];
      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window, callback: () => finish(null) });
    });
  }

  private async confirmWithDialog(
    candidate: BrowserAutofillSaveCandidate,
    submission: BrowserAutofillSubmission,
  ): Promise<boolean> {
    const contents = this.contentsById.get(submission.contentsId);
    const window = contents ? this.options.windowForContents(contents) : null;
    if (!window || window.isDestroyed()) return false;
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      buttons: [this.options.labels.save, this.options.labels.dontSave],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: this.options.labels.savePasswordTitle,
      message: this.options.labels.savePasswordMessage(candidate.originUrl, candidate.username),
    });
    return result.response === 0;
  }

  private isSubmissionAlive(submission: BrowserAutofillSubmission): boolean {
    if (this.disposed) return false;
    const contents = this.contentsById.get(submission.contentsId);
    if (!contents || contents.isDestroyed()) return false;
    const window = this.options.windowForContents(contents);
    return !!window && !window.isDestroyed();
  }

  private watchContents(contents: WebContents): void {
    if (this.contentCleanup.has(contents.id)) return;
    this.contentsById.set(contents.id, contents);
    const onDestroyed = () => this.dropContents(contents);
    const onNavigation = (
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
      processId: number,
      routingId: number,
    ) => {
      if (isInPlace) return;
      const records = [...this.frames.values()].filter(record => record.contents.id === contents.id);
      if (isMainFrame) {
        for (const record of records) this.revokeFrame(record);
        return;
      }
      const record = records.find(item => item.processId === processId && item.routingId === routingId);
      if (record) this.revokeFrame(record);
    };
    contents.once('destroyed', onDestroyed);
    contents.on('did-start-navigation', onNavigation);
    this.contentCleanup.set(contents.id, () => {
      contents.removeListener('destroyed', onDestroyed);
      contents.removeListener('did-start-navigation', onNavigation);
    });
  }

  private revokeFrame(record: FrameRecord): void {
    this.frames.delete(record.frameId);
    this.controller.noteNavigation(record.frameId, null);
    for (const [key, waiter] of this.ackWaiters) {
      if (!key.startsWith(`${record.frameId}\u0000`)) continue;
      this.ackWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve({
        documentId: record.documentId,
        intentId: key.split('\u0000')[2] ?? '',
        filled: false,
        reason: 'navigation',
      });
    }
  }

  private dropContents(contents: WebContents): void {
    for (const record of [...this.frames.values()]) {
      if (record.contents.id === contents.id) this.revokeFrame(record);
    }
    const submissions = this.submissionsByContents.get(contents.id);
    if (submissions) {
      for (const id of submissions) this.controller.cancelSubmission(id);
      this.submissionsByContents.delete(contents.id);
    }
    const cleanup = this.contentCleanup.get(contents.id);
    if (cleanup) cleanup();
    this.contentCleanup.delete(contents.id);
    this.contentsById.delete(contents.id);
  }
}
