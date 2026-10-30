import { app, BrowserWindow, dialog, nativeTheme, net, session, shell, WebContentsView, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appUrl, APP_HOST, APP_SCHEME } from '../app/protocol';
import { preloadFor } from '../app/windows';
import { frontendDist } from '../paths';
import { mimeForExtension } from '../services/media';
import { CanvasStore } from './store';
import { CanvasDocumentStore } from './document-store';
import { inside, message, record, text, type Data } from '../visuals/data';
import type { HandlerContext } from '../ipc/registry';
import type { Json } from '../ipc/contract';

export interface CanvasOptions {
  configRoot: string;
  resourcesRoot: string;
  window: BrowserWindow;
  frontendRoot?: string;
  registerRenderer(senderId: number, role: 'canvas'): void;
  unregisterRenderer(senderId: number): void;
  emit(channel: string, payload: Json): void;
  theme?(): 'light' | 'dark' | 'system';
  locale?(): string;
  /** Additional existing workspace media scope, checked against a real path. */
  assetAllowed?(path: string): boolean;
  chooseExportPath?(name: string, format: string): Promise<string | undefined>;
}

export class CanvasService {
  readonly store: CanvasStore;
  readonly documents: CanvasDocumentStore;
  private readonly options: CanvasOptions;
  private readonly hostContents: WebContents;
  readonly windowId: number;
  private panel: WebContentsView | undefined;
  private panelContents: WebContents | undefined;
  private partition: Session | undefined;
  private filePath = '';
  private revision = 0;
  private closed = false;
  private bounds: Data | undefined;
  private readonly openRequests = new Map<string, { resolve: (result: Data) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(options: CanvasOptions) {
    this.options = options; this.store = new CanvasStore(options.configRoot, options.resourcesRoot);
    this.documents = new CanvasDocumentStore(this.store.root, input => this.store.path(input));
    this.hostContents = options.window.webContents; this.windowId = this.hostContents.id;
    options.window.on('resize', this.resize);
    this.hostContents.on('zoom-changed', this.resize);
  }
  get view(): WebContentsView | undefined { return this.panel; }
  provision(): void { this.store.provision(); }
  toolSpec(): Data { return this.store.toolSpec(); }
  documentToolSpec(): Data { return { type: 'function', name: 'canvas_document', description: 'Read, version, and edit the document associated with a Canvas. Read before applying changes; expected_version prevents overwriting a user edit.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, action: { type: 'string', enum: ['get', 'apply', 'history', 'restore'] }, expected_version: { type: 'integer' }, document: { type: 'object' }, version: { type: 'integer' } }, required: ['file_path', 'action'] } }; }
  private documentAction(filePath: unknown, action: Data): Data {
    switch (action.type) {
      case 'document.get': return this.documents.get(filePath);
      case 'document.apply': return this.documents.apply(filePath, action.expectedVersion, action.document);
      case 'document.history': return this.documents.history(filePath);
      case 'document.restore': return this.documents.restore(filePath, action.expectedVersion, action.version);
      default: throw new Error(`Unknown canvas action: ${String(action.type)}`);
    }
  }
  async executeDocument(fields: Data): Promise<Data> {
    try {
      const action = text(fields.action, 'Canvas document action');
      const result = this.documentAction(fields.file_path, { ...fields, type: `document.${action}`, expectedVersion: fields.expected_version ?? null, version: fields.version ?? null });
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: message(error) }] }; }
  }
  private async exportDocument(filePath: unknown, action: Data): Promise<Data> {
    const format = text(action.format, 'Export format');
    if (!['json', 'html', 'svg', 'png'].includes(format)) throw new Error('Unsupported Canvas export format.');
    const content = text(action.content, 'Export content');
    const bytes = format === 'png' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Canvas export exceeds 8 MiB.');
    const name = basename(typeof action.name === 'string' ? action.name : this.store.name(this.store.path(filePath))).replace(/[\\/\x00-\x1f:?*"<>|]/g, '_').slice(0, 100) || 'Canvas';
    const filename = `${name.replace(new RegExp(`\\.${format}$`, 'i'), '')}.${format}`;
    const target = this.options.chooseExportPath
      ? await this.options.chooseExportPath(filename, format)
      : (await dialog.showSaveDialog(this.options.window, { defaultPath: filename, filters: [{ name: format.toUpperCase(), extensions: [format] }] })).filePath;
    if (!target) return { canceled: true };
    if (!this.panelContents || this.panelContents.isDestroyed() || this.filePath !== this.store.path(filePath)) throw new Error('The Canvas page changed before export.');
    await writeFile(target, bytes, { mode: 0o600 });
    return { canceled: false, filePath: target };
  }

  private getSession(): Session {
    if (this.partition) return this.partition;
    const partition = session.fromPartition(`canvas-${randomUUID()}`, { cache: false });
    const root = realpathSync(this.options.frontendRoot ?? frontendDist());
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.protocol.handle(APP_SCHEME, async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== APP_HOST || url.username || url.password || url.port) return new Response('Forbidden', { status: 403 });
        let file: string;
        if (url.pathname === '/canvas-asset') {
          const asked = text(url.searchParams.get('path'), 'asset path');
          file = realpathSync(asked);
          const mime = mimeForExtension(extname(file).slice(1));
          const permitted = [this.store.root, join(this.options.configRoot, 'media')].filter(existsSync).some(path => inside(realpathSync(path), file)) || this.options.assetAllowed?.(file);
          if (!this.panel || !this.filePath || !permitted || !mime || !(mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/'))) return new Response('Forbidden media', { status: 403 });
        } else {
          const path = decodeURIComponent(url.pathname);
          if (path !== '/canvas.html' && !path.startsWith('/assets/')) return new Response('Forbidden document', { status: 403 });
          file = realpathSync(join(root, path));
          if (!inside(root, file)) return new Response('Forbidden asset', { status: 403 });
        }
        if (!lstatSync(file).isFile()) return new Response('Not a file', { status: 404 });
        const headers: Record<string,string> = {};
        const range = request.headers.get('range'); if (range) headers.Range = range;
        return await net.fetch(pathToFileURL(file).toString(), { headers });
      } catch { return new Response('Artifact not found', { status: 404 }); }
    });
    this.partition = partition; return partition;
  }

  private assertSender(context: HandlerContext, file?: unknown): void {
    if (this.closed) throw new Error('Canvas service has shut down.');
    if (context.role === 'canvas') {
      if (!['canvas:load','canvas:list','canvas:open','canvas:action','canvas:state-write','canvas:send-to-chat'].includes(context.channel)) throw new Error('This channel is not available to Canvas pages.');
      if (!this.panelContents || this.panelContents.isDestroyed() || context.senderId !== this.panelContents.id) throw new Error('This Canvas page is no longer active.');
      if (file !== undefined && this.store.path(file) !== this.filePath) throw new Error('This Canvas page may only access its own file.');
    } else if (context.role !== 'main' || context.senderId !== this.windowId) throw new Error('Canvas belongs to another window.');
  }

  private rectangle(input: unknown): Electron.Rectangle {
    if (this.options.window.isDestroyed() || this.hostContents.isDestroyed()) throw new Error('The Canvas window has closed.');
    const fields = record(input); const zoom = this.hostContents.getZoomFactor();
    if (['x','y','width','height'].some(key => typeof fields[key] !== 'number' || !Number.isFinite(fields[key])) || Number(fields.width) <= 0 || Number(fields.height) <= 0) throw new Error('Invalid Canvas panel bounds.');
    const [width, height] = this.options.window.getContentSize();
    const x = Math.max(0, Math.min(width! - 1, Math.round(Number(fields.x) * zoom)));
    const y = Math.max(0, Math.min(height! - 1, Math.round(Number(fields.y) * zoom)));
    return { x, y, width: Math.max(1, Math.min(width! - x, Math.round(Number(fields.width) * zoom))), height: Math.max(1, Math.min(height! - y, Math.round(Number(fields.height) * zoom))) };
  }
  private readonly resize = (): void => { if (!this.closed && !this.options.window.isDestroyed() && this.bounds && this.panel) this.panel.setBounds(this.rectangle(this.bounds)); };
  setBounds(input: unknown): Data {
    const bounds = this.rectangle(input); this.bounds = record(input);
    this.panel?.setBounds(bounds); return { ok: true };
  }
  async show(fields: Data): Promise<Data> {
    if (this.closed) throw new Error('Canvas service has shut down.');
    const filePath = this.store.path(fields.filePath); const bounds = this.rectangle(fields.bounds);
    const revision = ++this.revision;
    const same = this.panel && this.filePath === filePath && this.panelContents && !this.panelContents.isDestroyed();
    if (!same) {
      this.closePanel(false);
      const view = new WebContentsView({ webPreferences: { session: this.getSession(), preload: preloadFor('canvas')!, additionalArguments: ['--klaus-role=canvas'], devTools: !app.isPackaged, contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } });
      this.panel = view; this.filePath = filePath;
      const contents = view.webContents;
      const senderId = contents.id; this.panelContents = contents;
      this.options.registerRenderer(senderId, 'canvas');
      contents.once('destroyed', () => {
        this.options.unregisterRenderer(senderId);
        if (this.panel === view) { this.panel = undefined; this.panelContents = undefined; this.filePath = ''; this.bounds = undefined; this.revision += 1; }
      });
      const url = appUrl(`canvas.html?${new URLSearchParams({ filePath, displayName: typeof fields.displayName === 'string' ? fields.displayName : this.store.name(filePath) })}`);
      contents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
      contents.on('will-redirect', event => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.setBounds(bounds); view.setVisible(false); this.options.window.contentView.addChildView(view);
      try { await contents.loadURL(url); }
      catch (error) { if (this.panel === view) this.closePanel(false); throw error; }
    } else if (fields.reload === true) await this.panel!.webContents.loadURL(this.panel!.webContents.getURL());
    if (this.closed || revision !== this.revision || !this.panel || this.filePath !== filePath) return { ok: false, error: 'The Canvas presentation request is stale.' };
    this.bounds = record(fields.bounds);
    this.panel.setBounds(bounds); this.panel.setVisible(true);
    return { ok: true };
  }
  hide(): Data { this.revision += 1; this.panel?.setVisible(false); return { ok: true }; }
  private closePanel(invalidate = true): Data {
    if (invalidate) this.revision += 1;
    const view = this.panel; const contents = this.panelContents;
    this.panel = undefined; this.panelContents = undefined; this.filePath = ''; this.bounds = undefined;
    if (view && !this.options.window.isDestroyed()) this.options.window.contentView.removeChildView(view);
    if (contents && !contents.isDestroyed()) { this.options.unregisterRenderer(contents.id); contents.close({ waitForBeforeUnload: false }); }
    return { ok: true };
  }
  async open(fields: Data): Promise<Data> {
    const filePath = this.store.path(fields.filePath);
    const requestId = randomUUID();
    const result = new Promise<Data>(resolveOpen => {
      const timer = setTimeout(() => {
        this.openRequests.delete(requestId);
        resolveOpen({ ok: false, error: 'The Canvas panel did not acknowledge the open request.' });
      }, 10_000);
      this.openRequests.set(requestId, { resolve: resolveOpen, timer });
    });
    this.options.emit('canvas:open-panel', { requestId, filePath, displayName: fields.displayName ?? this.store.name(filePath), sessionId: fields.sessionId ?? '' });
    return result;
  }
  private completeOpen(fields: Data): Data {
    const requestId = text(fields.requestId, 'Canvas open request id');
    const pending = this.openRequests.get(requestId);
    if (!pending) return { ok: false, error: 'The Canvas open request is stale.' };
    this.openRequests.delete(requestId); clearTimeout(pending.timer);
    const result: Data = fields.ok === true ? { ok: true } : { ok: false, error: typeof fields.error === 'string' && fields.error ? fields.error : 'The Canvas panel could not open.' };
    pending.resolve(result); return { ok: true };
  }
  async executeCheck(sessionId: string, fields: Data): Promise<Data> {
    try {
      const result = this.store.check(fields.file_path);
      const diagnostics = (result.diagnostics as Data[]).map(record);
      let output = diagnostics.length ? `Canvas check: ${diagnostics.length} issue(s) in ${String(result.filePath)}:\n${diagnostics.map(item => `  [${item.line ? `L${String(item.line)}` : 'file'}] ${String(item.message)}`).join('\n')}` : 'Canvas check: no problems found.';
      if (result.clean) {
        try {
          const opened = await this.open({ filePath: result.filePath!, sessionId });
          output += opened.ok === true ? '\nOpened the Canvas in the right work panel.' : `\nThe canvas is valid, but the panel could not open: ${String(opened.error ?? 'unknown error')}`;
        }
        catch (error) { output += `\nThe canvas is valid, but the panel could not open: ${message(error)}`; }
      }
      return { success: true, contentItems: [{ type: 'inputText', text: output }] };
    } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: message(error) }] }; }
  }
  async invoke(context: HandlerContext): Promise<Data> {
    const fields = record(context.args[0]);
    this.assertSender(context, ['canvas:load','canvas:state-write','canvas:action'].includes(context.channel) ? fields.filePath : undefined);
    switch (context.channel) {
      case 'canvas:list': return this.store.list();
      case 'canvas:open': return this.open(fields);
      case 'canvas:open-result': return this.completeOpen(fields);
      case 'canvas:load': return { ...this.store.load(fields.filePath), themeKind: this.options.theme?.() === 'light' ? 'light' : this.options.theme?.() === 'dark' ? 'dark' : nativeTheme.shouldUseDarkColors ? 'dark' : 'light', locale: this.options.locale?.() ?? 'en' };
      case 'canvas:state-write': return this.store.writeState(fields.filePath, fields.entries);
      case 'canvas:action': {
        const action = record(fields.action);
        if (action.type === 'reveal') { shell.showItemInFolder(this.store.path(fields.filePath)); return { ok: true }; }
        if (action.type === 'export') return this.exportDocument(fields.filePath, action);
        return this.documentAction(fields.filePath, action);
      }
      case 'canvas:send-to-chat': this.options.emit('canvas:send-to-chat', { text: text(fields.text, 'text'), submit: fields.submit === true, newChat: fields.newChat === true }); return { ok: true };
      case 'canvas:panel-show': return this.show(fields);
      case 'canvas:panel-set-bounds': return this.setBounds(fields.bounds);
      case 'canvas:panel-hide': return this.hide();
      case 'canvas:panel-close': return this.closePanel();
      default: throw new Error(`Unknown Canvas channel: ${context.channel}`);
    }
  }
  async dispose(): Promise<void> {
    if (this.closed) return; this.closed = true; this.closePanel();
    for (const request of this.openRequests.values()) { clearTimeout(request.timer); request.resolve({ ok: false, error: 'Canvas service has shut down.' }); }
    this.openRequests.clear();
    this.options.window.removeListener('resize', this.resize);
    this.hostContents.removeListener('zoom-changed', this.resize);
    if (this.partition) { this.partition.protocol.unhandle(APP_SCHEME); await this.partition.closeAllConnections(); await this.partition.clearStorageData(); }
  }
}
