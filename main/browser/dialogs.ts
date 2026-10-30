import { app, BrowserWindow, type IpcMainEvent, type WebContents, type WebFrameMain } from 'electron';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BrowserError, object, type BrowserObject } from './types';

interface DialogPage { owner: string; handle: number; view: { webContents: WebContents } }
/**
 * Dialogs are keyed by the page's WebContents id. Once that contents is destroyed
 * Electron's view getter answers undefined, so the key must tolerate a gone page
 * instead of throwing inside a present/finish sweep.
 */
const contentsId = (page: DialogPage): number => page.view.webContents?.id ?? -1;
interface PendingDialog {
  page: DialogPage;
  frame: WebFrameMain;
  frameUrl: string;
  event: IpcMainEvent;
  data: BrowserObject;
  timer: ReturnType<typeof setTimeout>;
  window?: BrowserWindow;
  windowUrl?: string;
  windowReady?: boolean;
}
interface DialogOptions {
  window: BrowserWindow;
  isEnabled: () => boolean;
  isPresented: (page: DialogPage) => boolean;
  navigationAllowed: (url: string) => string;
  timeoutMs?: number;
}

/** Synchronous page semantics, asynchronous host/UI handling, and no host API. */
export class BrowserDialogs {
  private readonly pending = new Map<number, PendingDialog>();
  private readonly bindings = new Map<number, () => void>();
  private disposed = false;

  constructor(private readonly options: DialogOptions) {}

  setWindow(window: BrowserWindow): void {
    this.options.window = window;
    for (const pending of this.pending.values()) if (pending.window && !pending.window.isDestroyed()) pending.window.setParentWindow(window);
    this.present();
  }

  bind(page: DialogPage): void {
    const contents = page.view.webContents;
    const request = (event: IpcMainEvent, input: unknown): void => {
      const data = object(input);
      const frame = event.senderFrame;
      const cancel = (): void => { event.returnValue = { accepted: false, value: '' }; };
      try {
        if (this.disposed || !this.options.isEnabled() || event.sender !== contents || contents.isDestroyed() || !frame || frame.detached) { cancel(); return; }
        // Compare live frame identities; never trust an origin or frame id in input.
        if (!contents.mainFrame.framesInSubtree.some(candidate => candidate.frameTreeNodeId === frame.frameTreeNodeId && candidate.processId === frame.processId && candidate.routingId === frame.routingId)) { cancel(); return; }
        const frameUrl = frame.url;
        this.options.navigationAllowed(frameUrl);
        if (data.sandboxed !== true || data.contextIsolated !== true || !['prompt', 'alert', 'confirm'].includes(String(data.type)) || typeof data.message !== 'string' || typeof data.defaultValue !== 'string' || data.message.length > 16_384 || data.defaultValue.length > 16_384 || this.pending.has(contents.id)) { cancel(); return; }
        const id = randomUUID();
        const pending: PendingDialog = {
          page, frame, frameUrl, event,
          data: { id, type: data.type ?? 'prompt', message: data.message, defaultValue: data.defaultValue, origin: frame.origin, url: frameUrl, tabId: page.handle, sandboxed: true },
          timer: setTimeout(() => this.finish(contents.id, false), this.options.timeoutMs ?? 30_000),
        };
        this.pending.set(contents.id, pending);
        this.present();
      } catch { cancel(); }
    };
    const navigating = (_event: Electron.Event, _url: string, isSameDocument: boolean): void => { if (!isSameDocument) this.finish(contents.id, false); };
    const destroyed = (): void => { this.release(contents.id); };
    contents.ipc.on('klaus:browser:dialog', request);
    contents.on('did-start-navigation', navigating);
    contents.once('destroyed', destroyed);
    this.bindings.set(contents.id, () => {
      try {
        contents.ipc.removeListener('klaus:browser:dialog', request);
        contents.removeListener('did-start-navigation', navigating);
        contents.removeListener('destroyed', destroyed);
      } catch { /* The contents is already gone; there is nothing left to unbind. */ }
    });
  }

  private live(pending: PendingDialog): boolean {
    try {
      const contents = pending.page.view.webContents;
      return !this.disposed && this.options.isEnabled() && !contents.isDestroyed() && !pending.frame.detached && pending.frame.url === pending.frameUrl && pending.event.senderFrame === pending.frame;
    } catch { return false; }
  }

  state(page: DialogPage): BrowserObject | null {
    const pending = this.pending.get(contentsId(page));
    if (!pending) return null;
    if (!this.live(pending)) { this.finish(contentsId(page), false); return null; }
    return { ...pending.data };
  }

  answer(page: DialogPage, accept: boolean, text = '', id?: string): void {
    const pending = this.pending.get(contentsId(page));
    if (!pending || !this.live(pending)) throw new BrowserError('not_found', 'The page has no pending dialog.');
    if (id !== undefined && id !== pending.data.id) throw new BrowserError('stale_dialog', 'This dialog was already replaced or closed.');
    if (text.length > 16_384) throw new BrowserError('invalid_request', 'Dialog input is too long.');
    this.finish(contentsId(page), accept, text);
  }

  private finish(contentsId: number, accept: boolean, value = ''): void {
    const pending = this.pending.get(contentsId);
    if (!pending) return;
    const accepted = accept && this.live(pending);
    this.pending.delete(contentsId);
    clearTimeout(pending.timer);
    try { pending.event.returnValue = { accepted, value: accepted ? value : '' }; } catch { /* The sender may already be gone. */ }
    if (pending.window && !pending.window.isDestroyed()) pending.window.destroy();
  }

  present(): void {
    for (const pending of this.pending.values()) {
      if (!this.live(pending)) { this.finish(contentsId(pending.page), false); continue; }
      if (!this.options.isPresented(pending.page)) { pending.window?.hide(); continue; }
      if (!pending.window) this.createWindow(pending);
      else if (pending.windowReady && !pending.window.isVisible()) pending.window.show();
    }
  }

  private createWindow(pending: PendingDialog): void {
    const window = new BrowserWindow({
      width: 460, height: pending.data.type === 'prompt' ? 280 : 240, show: false, resizable: false, minimizable: false, maximizable: false,
      parent: this.options.window, modal: true, title: 'Klaus',
      webPreferences: { devTools: !app.isPackaged, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, partition: `browser-dialog-${randomUUID()}`, preload: join(__dirname, 'dialog-window-preload.js') },
    });
    pending.window = window;
    const valid = (event: Electron.IpcMainInvokeEvent): boolean => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === pending.windowUrl && this.pending.get(contentsId(pending.page)) === pending;
    window.webContents.ipc.handle('klaus:browser:dialog:read', event => {
      if (!valid(event)) throw new BrowserError('refused_by_policy', 'This dialog is no longer current.');
      return { ...pending.data, language: app.getLocale().startsWith('zh') ? 'zh' : 'en' };
    });
    window.webContents.ipc.handle('klaus:browser:dialog:answer', (event, input: unknown) => {
      const data = object(input);
      if (!valid(event) || data.id !== pending.data.id || typeof data.accepted !== 'boolean' || typeof data.value !== 'string' || data.value.length > 16_384) throw new BrowserError('refused_by_policy', 'Invalid dialog answer.');
      // Reply first; destroying the prompt page before its invoke resolves would
      // produce an unhandled rejection in an otherwise successful human answer.
      setImmediate(() => {
        if (this.pending.get(contentsId(pending.page)) === pending) this.finish(contentsId(pending.page), data.accepted === true, String(data.value));
      });
      return { ok: true };
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('closed', () => { if (this.pending.get(contentsId(pending.page)) === pending) this.finish(contentsId(pending.page), false); });
    const nonce = randomBytes(16).toString('base64');
    const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'"><meta charset="utf-8"><style>body{font:14px system-ui;margin:22px;color:CanvasText;background:Canvas;color-scheme:light dark}#origin{font-size:12px;opacity:.7;overflow-wrap:anywhere}#message{white-space:pre-wrap;overflow-wrap:anywhere;max-height:90px;overflow:auto}input{box-sizing:border-box;width:100%;font:inherit;padding:7px}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}button{font:inherit;padding:6px 18px}</style><div id="origin"></div><p id="message"></p><form><input id="value" maxlength="16384"><footer><button type="button" id="cancel">Cancel</button><button id="accept" type="submit">OK</button></footer></form><script nonce="${nonce}">window.klausBrowserPrompt.read().then(d=>{const input=document.querySelector('#value');document.querySelector('#origin').textContent=d.origin;document.querySelector('#message').textContent=d.message;input.value=d.defaultValue;input.hidden=d.type!=='prompt';const cancel=document.querySelector('#cancel');cancel.hidden=d.type==='alert';cancel.textContent=d.language==='zh'?'取消':'Cancel';document.querySelector('#accept').textContent=d.language==='zh'?'确定':'OK';const answer=accepted=>window.klausBrowserPrompt.answer({id:d.id,accepted,value:input.value});cancel.onclick=()=>answer(false);document.querySelector('form').onsubmit=e=>{e.preventDefault();answer(true)};document.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();answer(false)}};if(d.type==='prompt'){input.focus();input.select()}else document.querySelector('#accept').focus()})</script>`;
    pending.windowUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    void window.loadURL(pending.windowUrl).then(() => {
      pending.windowReady = true;
      if (this.pending.get(contentsId(pending.page)) === pending && this.options.isPresented(pending.page)) window.show();
    }).catch(() => this.finish(contentsId(pending.page), false));
  }

  release(contentsId: number): void {
    this.finish(contentsId, false);
    this.bindings.get(contentsId)?.();
    this.bindings.delete(contentsId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.bindings.keys()]) this.release(id);
  }
}
