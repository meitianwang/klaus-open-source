import { app, dialog, MessageChannelMain, session, shell, WebContentsView, type BrowserWindow, type Session, type DownloadItem } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import type { Json } from '../ipc/contract';
import type { HandlerContext } from '../ipc/registry';
import { APP_SCHEME, APP_HOST } from '../app/protocol';
import { preloadFor } from '../app/windows';
import { HOST_CHANNELS } from '../ipc/host-channels';
import { decodeBinary } from '../ipc/binary';
import { VisualCapabilityServer } from '../visuals/capability-server';
import { inside, message, record, text, type Data } from '../visuals/data';
import { canCaptureNativeViewSnapshot, captureNativeViewSnapshot } from '../utils/native-view-snapshot';
import { DesignStore, designContentType, type DesignDocument, type DesignFile, type DesignValidationRecord } from './store';
import { DesignRuntime } from './runtime';
import { designTools } from './tools';
import { designAuthoringActivityScript } from './authoring-activity';
import { designAuthoringResult, designAuthoringValidator, type DesignAuthoringCandidate, type DesignAuthoringResult } from './authoring';

const SHELL_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const CONTENT_SUFFIX = '.design-content';
const ASSET_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav',
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf',
  'text/css', 'text/javascript', 'application/json',
]);
const ALLOWED_SAVE_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.html', '.zip']);

type IssueLike = { message: string; path?: string; line?: number; col?: number; severity?: string };
const issueList = (issues: IssueLike[]): Data[] => issues.map(issue => ({
  message: issue.message,
  ...(issue.path ? { path: issue.path } : {}),
  ...(issue.line ? { line: issue.line } : {}),
  ...(issue.col ? { col: issue.col } : {}),
  ...(issue.severity ? { severity: issue.severity } : {}),
}));

interface ExportWait { request: string; path: string; format: string; resolve(value: Data): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Editor { id: string; owner: string; window: BrowserWindow; view: WebContentsView; partition: Session; locale: string; loading: Promise<void>; failure?: string; exporting?: boolean; exportWait?: ExportWait; download?: (event: Electron.Event, item: DownloadItem) => void }

export interface DesignOptions {
  configRoot: string;
  window: BrowserWindow;
  pluginRoot(): string | undefined;
  windowForOwner?(owner: string): BrowserWindow;
  windowForSender?(senderId: number): BrowserWindow | undefined;
  enabled?(): boolean;
  language?(): string;
  readRoots(owner: string): string[];
  registerRenderer(id: number, role: 'design'): void;
  unregisterRenderer(id: number): void;
  emit(channel: string, payload: Json, windowId?: number): void;
  log?(event: string, data: Data): void;
  chooseExportPath?(name: string): Promise<string | undefined>;
}

/** One revision service per chat, with isolated native views for its Design Canvases. */
export class DesignService {
  readonly store: DesignStore;
  private readonly runtime: DesignRuntime;
  private readonly editors = new Map<string, Editor>();
  private readonly recent = new Map<string, string>();
  private readonly operations = new Map<string, Set<Promise<unknown>>>();
  private readonly retiring = new Set<string>();
  private readonly openRequests = new Map<string, { windowId: number; resolve(value: Data): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly mcp: VisualCapabilityServer;
  private readonly windows = new Map<number, BrowserWindow>();
  private readonly windowIds = new WeakMap<BrowserWindow, number>();
  private readonly active = new Map<number, Editor>();
  private readonly bounds = new Map<number, Data>();
  private readonly revisions = new Map<number, number>();
  private authoringOwners = new Set<string>();
  private closed = false;
  private closing = false;

  constructor(readonly options: DesignOptions) {
    this.store = new DesignStore(options.configRoot);
    this.runtime = new DesignRuntime(this.store, options.pluginRoot, (event, data) => this.log(event, data), () => this.appLanguage());
    this.mcp = new VisualCapabilityServer('klaus-design', designTools, (owner, name, args) => this.call(owner, name, args), () => this.enabled());
    this.trackWindow(options.window);
  }
  private trackWindow(window: BrowserWindow): BrowserWindow {
    if (window.isDestroyed()) throw new Error('The design canvas window has closed.');
    const id = window.webContents.id;
    this.windowIds.set(window, id);
    if (!this.windows.has(id)) {
      window.setMaxListeners(Math.max(window.getMaxListeners(), 24));
      this.windows.set(id, window);
      window.on('resize', this.resize);
      window.webContents.on('zoom-changed', this.resize);
      window.once('closed', () => { void this.closeWindow(id).catch(error => this.log('design-window-close-error', { error: message(error) })); });
    }
    return window;
  }
  private windowId(window: BrowserWindow): number { return this.windowIds.get(window) ?? window.webContents.id; }
  private appLanguage(): string {
    const saved = this.options.language?.() ?? '';
    return /^zh(?:[-_]|$)/i.test(saved) ? 'zh-Hans' : 'en-US';
  }
  private shellUrl(id: string): string { return `${SHELL_ORIGIN}/code/artifact/${id}`; }
  refreshLanguage(): void {
    const locale = this.appLanguage();
    for (const editor of [...this.editors.values()]) {
      if (editor.view.webContents.isDestroyed() || editor.locale === locale) continue;
      editor.locale = locale;
      void (async () => {
        try { await this.flush(editor); }
        catch (error) { this.log('design-language-flush-skipped', { id: editor.id, error: message(error) }); }
        if (editor.view.webContents.isDestroyed()) return;
        const url = this.shellUrl(editor.id);
        editor.loading = editor.view.webContents.loadURL(url).catch(error => { editor.failure = message(error); throw error; });
        void editor.loading.then(() => { void this.postAuthoringActivity(editor, this.authoringOwners.has(editor.owner)); }, () => {});
        editor.loading.catch(() => {});
      })();
    }
  }
  private async closeWindow(id: number): Promise<void> {
    if (this.closed) return;
    const window = this.windows.get(id); this.windows.delete(id); this.active.delete(id); this.bounds.delete(id); this.revisions.delete(id);
    const owners = new Set<string>();
    for (const editor of [...this.editors.values()].filter(editor => editor.window === window)) {
      try {
        await Promise.allSettled([...(this.operations.get(editor.owner) ?? [])]);
        if (editor.window !== window) continue;
        await this.flush(editor); await this.removeEditor(editor); owners.add(editor.owner);
      } catch (error) { this.log('design-recovery-kept', { id: editor.id, error: message(error) }); }
    }
    for (const owner of owners) if (![...this.editors.values()].some(editor => editor.owner === owner) && !this.operations.has(owner)) {
      this.runtime.release(owner);
    }
  }
  private hostWindow(owner: string): BrowserWindow { return this.trackWindow(this.options.windowForOwner?.(owner) ?? this.options.window); }
  private callerWindow(senderId: number): BrowserWindow {
    const window = this.options.windowForSender?.(senderId) ?? (!this.options.window.isDestroyed() && this.options.window.webContents.id === senderId ? this.options.window : undefined);
    if (!window) throw new Error('This main window does not own a Design Canvas surface.');
    return this.trackWindow(window);
  }
  private enabled(): boolean { return !this.closed && !this.closing && (this.options.enabled?.() ?? true); }
  private assertEnabled(): void { if (!this.enabled()) throw new Error('The Design Canvas plugin is disabled or has closed.'); }
  private log(event: string, data: Data): void { this.options.log?.(event, data); }
  hostCapabilities(owner: string): Promise<Data> { return this.mcp.hostCapabilities(owner); }
  toolSpecs(): Data[] { return designTools(); }
  private directory(owner: string): string { return join(this.options.configRoot, 'design', createHash('sha256').update(owner).digest('hex')); }
  private async resolve(owner: string, id: unknown): Promise<{ row: DesignDocument; id: string }> {
    this.assertEnabled(); text(owner, 'design chat');
    if (this.retiring.has(owner)) throw new Error('The design chat is closing.');
    const wanted = typeof id === 'string' && id ? id : this.recent.get(owner);
    if (!wanted) throw new Error('Open a design canvas in this chat first.');
    const row = this.store.get(owner, wanted);
    return { row, id: row.id };
  }
  private readRoots(owner: string): string[] {
    return this.options.readRoots(owner).flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } });
  }
  private workspaceFile(owner: string, value: string): { path: string; bytes: Uint8Array; size: number } {
    if (!isAbsolute(value) || value.includes('\0') || Buffer.byteLength(value) > 4096) throw new Error('Local design file paths must be absolute.');
    const path = realpathSync(value);
    if (!this.readRoots(owner).some(root => inside(root, path))) throw new Error('Design files must stay inside the chat workspace.');
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Design files must be regular files of at most 20 MB.');
    return { path, bytes: new Uint8Array(readFileSync(path)), size: stat.size };
  }
  private textContentType(type: string): boolean {
    return /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/i.test(type);
  }
  private candidateSnapshot(owner: string, id: string, writes: { path: string; bytes: Uint8Array }[] = [], remove: string[] = []): DesignAuthoringCandidate {
    const files = new Map<string, DesignAuthoringCandidate['files'][number]>();
    for (const file of this.store.files(owner, id)) {
      const content = this.textContentType(file.contentType) ? new TextDecoder().decode(this.store.read(owner, id, file.path)) : undefined;
      files.set(file.path, { path: file.path, contentType: file.contentType, size: file.size, sha256: file.sha256, ...(content !== undefined ? { content } : {}) });
    }
    for (const name of remove) files.delete(name);
    for (const write of writes) {
      const contentType = designContentType(write.path);
      const sha256 = createHash('sha256').update(write.bytes).digest('hex');
      const content = this.textContentType(contentType) ? new TextDecoder().decode(write.bytes) : undefined;
      files.set(write.path, { path: write.path, contentType, size: write.bytes.byteLength, sha256, ...(content !== undefined ? { content } : {}) });
    }
    return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }
  private validateCandidate(candidate: DesignAuthoringCandidate): DesignAuthoringResult | undefined {
    const validate = designAuthoringValidator(this.options.pluginRoot());
    return validate ? designAuthoringResult(validate(candidate)) : undefined;
  }
  private validatePublish(owner: string, id: string, writes: { path: string; bytes: Uint8Array }[], remove: string[]): { candidate: DesignAuthoringCandidate; result?: DesignAuthoringResult } {
    const candidate = this.candidateSnapshot(owner, id, writes, remove);
    return { candidate, result: this.validateCandidate(candidate) };
  }
  private validationRecord(version: string, candidate: DesignAuthoringCandidate, result: DesignAuthoringResult): DesignValidationRecord {
    const shas = Object.fromEntries(candidate.files.map(file => [file.path, file.sha256]));
    return {
      version,
      shas,
      errors: result.errors,
      warnings: result.warnings,
      at: new Date().toISOString(),
      ...(result.contentHash ? { contentHash: result.contentHash } : {}),
      ...(result.artboards !== undefined ? { artboards: result.artboards } : {}),
    };
  }
  private diagnosticsContext(owner: string, id: string): { files: DesignFile[]; result?: DesignAuthoringResult; record?: DesignValidationRecord; valid: boolean; source: 'snapshot' | 'cached' | 'none' } {
    const document = this.store.get(owner, id), files = this.store.files(owner, id), record = this.store.validation(owner, id);
    let fresh: { candidate: DesignAuthoringCandidate; result?: DesignAuthoringResult } = { candidate: { files: [] } };
    try { fresh = this.validatePublish(owner, id, [], []); }
    catch (error) { this.log('design-validator-error', { id, error: message(error) }); }
    if (fresh.result) {
      try { this.store.recordValidation(owner, id, this.validationRecord(document.version, fresh.candidate, fresh.result)); }
      catch (error) { this.log('design-validation-record-error', { id, error: message(error) }); }
    }
    const matches = record !== undefined && record.version === document.version
      && files.length === Object.keys(record.shas).length
      && files.every(file => record!.shas[file.path] === file.sha256);
    const valid = fresh.result ? fresh.result.valid && fresh.result.errors.length === 0 : matches && record!.errors.length === 0;
    return { files, result: fresh.result, record: matches ? record : undefined, valid, source: fresh.result ? 'snapshot' : matches ? 'cached' : 'none' };
  }
  private async readLiveViewContext(owner: string, id: string): Promise<Data | undefined> {
    const editor = this.editors.get(this.key(owner, id));
    if (!editor || editor.view.webContents.isDestroyed()) return undefined;
    try {
      const value = await editor.view.webContents.executeJavaScript('window.__klausDesignPresence ?? null');
      const obj = record(value);
      return Object.keys(obj).length ? obj : undefined;
    } catch { return undefined; }
  }
  private async diagnostics(owner: string, id: string): Promise<Data> {
    const context = this.diagnosticsContext(owner, id), document = this.store.get(owner, id);
    const rec = context.record, result = context.result;
    const errors = result ? result.errors : (rec?.errors ?? []);
    const warnings = result ? result.warnings : (rec?.warnings ?? []);
    const artboards = result?.artboards ?? rec?.artboards;
    const contentHash = result?.contentHash ?? rec?.contentHash;
    const viewContext = await this.readLiveViewContext(owner, id);
    const assetRows = this.store.assets(owner, id).map(asset => ({
      id: asset.id, url: asset.url, contentType: asset.type, name: asset.name, sizeBytes: asset.sizeBytes,
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
      ...(asset.createdAt !== undefined ? { createdAt: new Date(asset.createdAt).toISOString() } : {}),
    }));
    return {
      version: document.version,
      saved: true,
      validated: context.valid,
      source: context.source,
      ...(rec ? { validationVersion: rec.version, validatedAt: rec.at } : {}),
      ...(contentHash ? { contentHash } : {}),
      errors: issueList(errors),
      warnings: issueList(warnings),
      ...(artboards !== undefined ? { artboards: artboards as Json } : {}),
      ...(viewContext ? { view_context: viewContext } : {}),
      files: context.files.map(file => ({
        path: file.path, saved: true,
        validated: context.source !== 'none' && !errors.some(issue => issue.path === undefined || issue.path === file.path),
        sha256: file.sha256, size: file.size, contentType: file.contentType,
      })),
      assets: assetRows,
    };
  }
  private fileDiagnostics(owner: string, id: string, file: DesignFile): Data {
    const context = this.diagnosticsContext(owner, id), rec = context.record, result = context.result;
    const errors = (result ? result.errors : (rec?.errors ?? [])).filter(issue => issue.path === undefined || issue.path === file.path);
    const warnings = (result ? result.warnings : (rec?.warnings ?? [])).filter(issue => issue.path === undefined || issue.path === file.path);
    const contentHash = result?.contentHash ?? rec?.contentHash;
    return {
      path: file.path,
      saved: true,
      validated: context.source !== 'none' && errors.length === 0,
      source: context.source,
      ...(rec ? { validationVersion: rec.version, validatedAt: rec.at } : {}),
      ...(contentHash ? { contentHash } : {}),
      errors: issueList(errors),
      warnings: issueList(warnings),
    };
  }
  private async inspect(owner: string, id: string, args: Data = {}): Promise<Data> {
    const document = this.store.get(owner, id), files = this.store.files(owner, id);
    const includeDiagnostics = args.diagnostics === true;
    if (args.path === undefined) {
      return {
        slug: id, version: document.version,
        files: files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size, content_type: file.contentType })),
        ...(includeDiagnostics ? { diagnostics: await this.diagnostics(owner, id) } : {}),
      };
    }
    const path = text(args.path, 'design canvas file path'), entry = files.find(file => file.path === path);
    if (!entry) throw new Error('The design canvas file does not exist.');
    if (!this.textContentType(entry.contentType)) throw new Error('Only design canvas text files can be inspected.');
    const offset = args.offset ?? 1, limit = args.limit ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 1 || !Number.isSafeInteger(limit) || Number(limit) < 0) throw new Error('Invalid design canvas file range.');
    const content = new TextDecoder().decode(this.store.read(owner, id, path)), lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (Number(offset) > Math.max(1, lines.length)) throw new Error('The design canvas file range is outside the file.');
    const selected: string[] = []; let size = 0;
    for (const line of lines.slice(Number(offset) - 1)) {
      if (Number(limit) > 0 && selected.length >= Number(limit) || size + Buffer.byteLength(line) > 1024 * 1024) break;
      selected.push(line); size += Buffer.byteLength(line);
    }
    if (!selected.length && lines.length && Number(offset) <= lines.length) throw new Error('This design canvas line is too large to inspect.');
    const next = Number(offset) - 1 + selected.length < lines.length ? Number(offset) + selected.length : undefined;
    return {
      slug: id, version: document.version, path, content_type: entry.contentType, size: entry.size, total_lines: lines.length,
      content: selected.join(''),
      ...(args.offset !== undefined ? { offset: Number(offset) } : {}),
      ...(next !== undefined ? { next_offset: next } : {}),
      ...(includeDiagnostics ? { diagnostics: this.fileDiagnostics(owner, id, entry) } : {}),
    };
  }
  private rectangle(value: unknown, window: BrowserWindow): Electron.Rectangle {
    const fields = record(value);
    if (['x', 'y', 'width', 'height'].some(key => typeof fields[key] !== 'number' || !Number.isFinite(fields[key])) || Number(fields.width) <= 0 || Number(fields.height) <= 0) {
      throw new Error('Invalid Design Canvas panel bounds.');
    }
    const zoom = window.webContents.getZoomFactor(), [width, height] = window.getContentSize();
    const x = Math.max(0, Math.min(width! - 1, Math.round(Number(fields.x) * zoom))), y = Math.max(0, Math.min(height! - 1, Math.round(Number(fields.y) * zoom)));
    return { x, y, width: Math.max(1, Math.min(width! - x, Math.round(Number(fields.width) * zoom))), height: Math.max(1, Math.min(height! - y, Math.round(Number(fields.height) * zoom))) };
  }
  private readonly resize = (): void => {
    for (const [id, editor] of this.active) {
      const bounds = this.bounds.get(id);
      if (bounds && !editor.window.isDestroyed()) editor.view.setBounds(this.rectangle(bounds, editor.window));
    }
  };
  private key(owner: string, id: string): string { return `${owner}:${id}`; }
  private async editor(owner: string, id: string): Promise<Editor> {
    const key = this.key(owner, id), current = this.editors.get(key);
    if (current) { await current.loading; if (current.failure) throw new Error(current.failure); return current; }
    await this.resolve(owner, id);
    this.assertEnabled();
    const raced = this.editors.get(key); if (raced) { await raced.loading; return raced; }
    const partition = session.fromPartition(`persist:design-${createHash('sha256').update(`${this.options.configRoot}:${owner}:${id}`).digest('hex')}`, { cache: false });
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.protocol.handle(APP_SCHEME, async request => {
      try {
        const url = new URL(request.url);
        if (url.username || url.password || url.port || ![APP_HOST, `${id}${CONTENT_SUFFIX}`].includes(url.hostname)) return new Response('Forbidden', { status: 403 });
        const response = await this.runtime.page(owner, id, request);
        this.log('design-page', { url: `${url.protocol}//${url.host}${url.pathname}`, status: response.status });
        return response;
      } catch (error) {
        this.log('design-page-error', { error: message(error), url: request.url });
        return new Response('Design Canvas page unavailable.', { status: 500 });
      }
    });
    const view = new WebContentsView({
      webPreferences: {
        session: partition, preload: preloadFor('design')!, additionalArguments: ['--klaus-role=design'],
        devTools: !app.isPackaged, contextIsolation: true, sandbox: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, webviewTag: false, backgroundThrottling: false,
      },
    });
    const url = this.shellUrl(id);
    const editor: Editor = { owner, id, window: this.hostWindow(owner), view, partition, locale: this.appLanguage(), loading: Promise.resolve() };
    this.editors.set(key, editor);
    this.options.registerRenderer(view.webContents.id, 'design');
    view.webContents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
    view.webContents.on('will-redirect', event => { if (event.isMainFrame) event.preventDefault(); });
    view.webContents.setWindowOpenHandler(({ url: extUrl }) => { if (/^https?:\/\//.test(extUrl)) void shell.openExternal(extUrl); return { action: 'deny' }; });
    view.webContents.on('console-message', event => { if (event.level === 'warning' || event.level === 'error') this.log('design-console', { id, level: event.level, message: event.message }); });
    view.webContents.on('render-process-gone', (_event, details) => { editor.failure = `The Design Canvas editor stopped: ${details.reason}.`; this.rejectExport(editor, new Error(editor.failure)); });
    const senderId = view.webContents.id;
    view.webContents.once('destroyed', () => {
      this.options.unregisterRenderer(senderId);
      if (editor.download) { partition.removeListener('will-download', editor.download); editor.download = undefined; }
      if (this.editors.get(key) === editor) this.editors.delete(key);
      for (const [winId, active] of this.active) if (active === editor) { this.active.delete(winId); this.bounds.delete(winId); }
      this.rejectExport(editor, new Error('The Design Canvas editor closed.'));
    });
    editor.download = (_event, item) => { void this.download(editor, item); };
    partition.on('will-download', editor.download);
    view.setBounds({ x: 0, y: 0, width: 1440, height: 1000 }); view.setVisible(false);
    editor.window.contentView.addChildView(view);
    editor.loading = view.webContents.loadURL(url).catch(error => { editor.failure = message(error); throw error; });
    await editor.loading;
    void this.postAuthoringActivity(editor, this.authoringOwners.has(owner));
    return editor;
  }
  setAuthoringActivity(runningOwners: readonly string[]): void {
    this.authoringOwners = new Set(runningOwners);
    for (const editor of this.editors.values()) void this.postAuthoringActivity(editor, this.authoringOwners.has(editor.owner));
  }
  private async postAuthoringActivity(editor: Editor, working: boolean): Promise<void> {
    if (this.closed || editor.view.webContents.isDestroyed()) return;
    try {
      await editor.loading;
      if (this.closed || editor.view.webContents.isDestroyed() || this.authoringOwners.has(editor.owner) !== working) return;
      await editor.view.webContents.executeJavaScript(designAuthoringActivityScript(working), true);
    } catch (error) { this.log('design-authoring-activity-skipped', { id: editor.id, error: message(error) }); }
  }
  private async download(editor: Editor, item: DownloadItem): Promise<void> {
    item.pause();
    try {
      const name = basename(item.getFilename()).replace(/[\x00-\x1f:?*"<>|]/g, '_').slice(0, 180) || 'Design';
      const path = this.options.chooseExportPath ? await this.options.chooseExportPath(name) : (await dialog.showSaveDialog(editor.window, { defaultPath: name })).filePath;
      if (!path) { item.cancel(); return; }
      item.setSavePath(path);
      item.once('done', (_event, state) => { if (state !== 'completed') this.log('design-download-error', { id: editor.id, state }); });
      item.resume();
    } catch (error) { item.cancel(); this.log('design-download-error', { id: editor.id, error: message(error) }); }
  }
  private async saveFile(senderId: number, args: Data): Promise<Data> {
    const editor = [...this.editors.values()].find(item => item.view.webContents.id === senderId);
    if (!editor || editor.view.webContents.isDestroyed()) throw new Error('Unknown design save request.');
    const request = args.request;
    if (request !== undefined && (typeof request !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(request))) throw new Error('Invalid design export request.');
    const name = basename(text(args.filename, 'export filename')).replace(/[\x00-\x1f:?*"<>|]/g, '_').slice(0, 180);
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_SAVE_EXTS.has(ext)) throw new Error('Unsupported design export file type.');
    const bytes = decodeBinary(args.bytes, 200 * 1024 * 1024);
    if (!bytes?.length) throw new Error('Empty or invalid design export bytes.');
    const pending = editor.exportWait;
    if (args.tool !== undefined && (typeof request !== 'string' || !pending || args.tool !== pending.request)) throw new Error('This design export is no longer active.');
    if (pending && args.tool === pending.request && extname(pending.path) !== ext && !(pending.format === 'png' && ext === '.zip')) {
      throw new Error('The design export format did not match the request.');
    }
    const finalToolPath = pending && args.tool === pending.request
      ? (ext !== extname(pending.path) ? pending.path.slice(0, -extname(pending.path).length) + ext : pending.path)
      : undefined;
    const path = finalToolPath
      ?? (this.options.chooseExportPath ? await this.options.chooseExportPath(name) : (await dialog.showSaveDialog(editor.window, { defaultPath: name })).filePath);
    if (!path) return { ok: false, cancelled: true, error: 'The design export was cancelled.' };
    if (args.tool !== undefined && editor.exportWait !== pending) throw new Error('This design export expired before saving.');
    writeFileSync(path, bytes, { mode: 0o600, ...(args.tool !== undefined ? { flag: 'wx' } : {}) });
    if (pending && args.tool === pending.request && editor.exportWait === pending) {
      clearTimeout(pending.timer); editor.exportWait = undefined;
      pending.resolve({ id: editor.id, format: pending.format, path, bytes: bytes.length });
    }
    return { ok: true, path, bytes: bytes.length };
  }
  private transport(senderId: number): Data {
    const editor = [...this.editors.values()].find(item => item.view.webContents.id === senderId);
    if (!editor || editor.view.webContents.isDestroyed()) throw new Error('Unknown design transport.');
    const { port1, port2 } = new MessageChannelMain();
    try { this.runtime.connect(editor.owner, editor.id, port1); editor.view.webContents.postMessage(HOST_CHANNELS.designTransportPort, null, [port2]); }
    catch (error) { port1.close(); port2.close(); throw error; }
    return { ok: true };
  }
  private async export(owner: string, id: string, format: string): Promise<Data> {
    if (!['pdf', 'png', 'html'].includes(format)) throw new Error('Export format must be pdf, png or html.');
    const editor = await this.editor(owner, id);
    if (editor.exporting || editor.exportWait) throw new Error('Another design export is already running.');
    editor.exporting = true;
    try {
      const report = await this.waitForReport(editor);
      const exports = Array.isArray(report.exports) ? report.exports.map(record) : [];
      const entry = exports.find(value => value.format === format);
      if (!entry || entry.disabled === true) throw new Error('This export is not currently available in the Design Canvas editor (ensure at least one artboard exists).');
      const outDir = join(this.directory(owner), 'exports'); mkdirSync(outDir, { recursive: true, mode: 0o700 });
      const path = join(outDir, `${randomUUID()}.${format}`), request = randomUUID().replaceAll('-', '');
      const result = new Promise<Data>((resolve, reject) => {
        editor.exportWait = {
          request, path, format, resolve, reject,
          timer: setTimeout(() => { this.rejectExport(editor, new Error('The Design Canvas editor did not finish exporting in time.')); }, 120_000),
        };
      });
      this.log('design-export-state', record(await editor.view.webContents.executeJavaScript('({controller:window.__klausPresentationController?.hostState(),downloads:window.__klausPresentationDownloadState?.(),dialogs:[...document.querySelectorAll("[role=dialog]")].map(node=>node.textContent?.slice(0,240))})')));
      const queue = record(await editor.view.webContents.executeJavaScript('window.__klausPresentationController?.hostState() ?? null'));
      if (typeof queue.lastAt === 'number' && typeof queue.now === 'number' && queue.now - queue.lastAt < 250) {
        await new Promise(resolve => setTimeout(resolve, Math.ceil(260 - (Number(queue.now) - Number(queue.lastAt)))));
      }
      const outcome = record(await editor.view.webContents.executeJavaScript(`(async () => {
        const controller = window.__klausPresentationController;
        if (!controller) return { ok: false, reason: 'missing_controller' };
        window.__klausPresentationToolExport = ${JSON.stringify(request)};
        try { return await controller.download(${JSON.stringify(format)}, false, undefined, false, 'claude'); }
        finally { if (window.__klausPresentationToolExport === ${JSON.stringify(request)}) delete window.__klausPresentationToolExport; }
      })()`, true));
      if (outcome.ok !== true) this.rejectExport(editor, new Error(`Design export failed: ${String(outcome.reason ?? 'not saved')}.`));
      return await result;
    } catch (error) {
      this.rejectExport(editor, error);
      throw error;
    } finally { editor.exporting = false; }
  }
  private async waitForReport(editor: Editor): Promise<Data> {
    const deadline = Date.now() + 45_000;
    while (!this.closed && !editor.view.webContents.isDestroyed() && Date.now() < deadline) {
      if (editor.failure) throw new Error(editor.failure);
      const report = record(await editor.view.webContents.executeJavaScript('window.__klausPresentationReport ?? null'));
      if (Array.isArray(report.exports) && report.exports.length > 0) return report;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The Design Canvas editor did not finish initializing.');
  }
  private rejectExport(editor: Editor, error: unknown): void {
    const pending = editor.exportWait;
    if (pending) { clearTimeout(pending.timer); editor.exportWait = undefined; pending.reject(error instanceof Error ? error : new Error(message(error))); }
  }
  private success(data: Data, artifact?: Data): Data {
    const result = artifact ? { ...data, artifact } : data;
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
  private failure(data: Data): Data { return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }

  async call(owner: string, name: string, args: Data): Promise<Data> {
    if (this.retiring.has(owner)) return { isError: true, content: [{ type: 'text', text: 'The design chat is closing.' }] };
    const operation = this.performCall(owner, name, args);
    let active = this.operations.get(owner);
    if (!active) this.operations.set(owner, active = new Set());
    active.add(operation);
    try { return await operation; } finally { active.delete(operation); if (!active.size) this.operations.delete(owner); }
  }
  private async performCall(owner: string, name: string, args: Data): Promise<Data> {
    try {
      this.assertEnabled();
      const spec = designTools().find(tool => tool.name === name), properties = record(record(spec?.inputSchema).properties);
      if (!spec || Object.keys(args).some(key => !(key in properties))) throw new Error('Unknown design operation or parameter.');
      if (name === 'design_open') {
        let id = args.id;
        if (!id) id = this.store.open(owner, typeof args.title === 'string' && args.title.trim() ? args.title : 'Design Canvas').id;
        const found = await this.resolve(owner, id); this.recent.set(owner, found.id);
        const files = await this.inspect(owner, found.id);
        this.options.emit('design:open-panel', { id: found.id, title: found.row.title ?? 'Design Canvas', sessionId: owner }, this.hostWindow(owner).webContents.id);
        return this.success({ id: found.id, ...files }, { kind: 'design', id: found.id, title: found.row.title ?? 'Design Canvas', ...(args.id ? {} : { ready: false }) });
      }
      const found = await this.resolve(owner, args.id); this.recent.set(owner, found.id);
      if (name === 'design_inspect') {
        if (args.path === undefined && (args.offset !== undefined || args.limit !== undefined)) throw new Error('A file path is required for a partial read.');
        if (args.diagnostics !== undefined && typeof args.diagnostics !== 'boolean') throw new Error('Design diagnostics must be a boolean.');
        return this.success({ id: found.id, ...(await this.inspect(owner, found.id, args)) });
      }
      if (name === 'design_publish') {
        if (!Array.isArray(args.files) || args.files.length + (Array.isArray(args.remove) ? args.remove.length : 0) > 512) throw new Error('Publish at most 512 files at once.');
        let total = 0;
        const files = args.files.map(value => {
          const file = record(value), input = text(file.path, 'local file path'), as = text(file.as, 'design canvas path');
          const source = this.workspaceFile(owner, input);
          total += source.size; if (total > 256 * 1024 * 1024) throw new Error('Design canvas files exceed 256 MB.');
          return { path: as, bytes: source.bytes };
        });
        const remove = args.remove !== undefined ? args.remove as string[] : [];
        const validation = this.validatePublish(owner, found.id, files, remove);
        if (validation.result) {
          const valid = validation.result.valid && validation.result.errors.length === 0;
          if (!valid) {
            return this.failure({
              id: found.id, version: found.row.version, saved: false, validated: false,
              errors: issueList(validation.result.errors), warnings: issueList(validation.result.warnings),
              ...(validation.result.artboards !== undefined ? { artboards: validation.result.artboards as Json } : {}),
              ...(validation.result.contentHash !== undefined ? { contentHash: validation.result.contentHash } : {}),
            });
          }
        }
        const result = this.store.publish(owner, found.id, { baseVersion: text(args.base_version, 'design canvas version'), writes: files, ...(args.remove !== undefined ? { remove: args.remove as string[] } : {}) });
        if (validation.result) {
          try { this.store.recordValidation(owner, found.id, this.validationRecord(result.version, validation.candidate, validation.result)); }
          catch (error) { this.log('design-validation-record-error', { id: found.id, error: message(error) }); }
        }
        this.runtime.changed(owner, found.id);
        return this.success(
          {
            id: found.id, slug: found.id, saved: true, validated: validation.result !== undefined,
            ...(validation.result ? {
              contentHash: validation.result.contentHash,
              warnings: issueList(validation.result.warnings),
              ...(validation.result.artboards !== undefined ? { artboards: validation.result.artboards as Json } : {}),
            } : {}),
            ...result,
          },
          { kind: 'design', id: found.id, title: found.row.title ?? 'Design Canvas' },
        );
      }
      if (name === 'design_import_asset') {
        const source = this.workspaceFile(owner, text(args.path, 'asset path'));
        const contentType = designContentType(source.path);
        if (!ASSET_TYPES.has(contentType)) throw new Error(`Unsupported design canvas asset type: ${contentType}.`);
        const name = basename(source.path).slice(0, 180) || 'Asset';
        const asset = this.store.putAsset(owner, found.id, source.bytes, contentType, name);
        return this.success(
          { id: found.id, saved: true, assetId: asset.id, url: asset.url, sizeBytes: asset.sizeBytes, contentType, name, sha256: createHash('sha256').update(source.bytes).digest('hex') },
          { kind: 'design', id: found.id, title: found.row.title ?? 'Design Canvas' },
        );
      }
      if (name === 'design_export') return this.success(await this.export(owner, found.id, text(args.format, 'export format')));
      throw new Error('Unknown design operation.');
    } catch (error) { return { isError: true, content: [{ type: 'text', text: message(error) }] }; }
  }
  private async chatRequest(senderId: number, args: Data): Promise<Data> {
    this.assertEnabled();
    const editor = [...this.editors.values()].find(item => item.view.webContents.id === senderId);
    if (!editor || this.active.get(this.windowId(editor.window)) !== editor || !editor.view.getVisible() || args.uuid !== editor.id) {
      throw new Error('This design canvas is not active in its owning chat.');
    }
    const data = record(args.data), serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > 4096 || !['send', 'stage'].includes(String(args.deliver))) throw new Error('Invalid design chat request.');
    if (args.deliver === 'send' && args.senderActivated !== true) throw new Error('Sending a design request requires a viewer action.');
    const request = typeof data.request === 'string' ? data.request : serialized;
    const selected = typeof data.selectedText === 'string' ? `\n\nSelected content:\n${data.selectedText}` : '';
    const presence = args.presence && typeof args.presence === 'object' && !Array.isArray(args.presence)
      ? `\n\n<artifact-view-context artifact="${editor.id}">\n${JSON.stringify(args.presence)}\n</artifact-view-context>`
      : '';
    const requestId = randomUUID();
    const result = new Promise<Data>(resolve => {
      this.openRequests.set(requestId, {
        windowId: this.windowId(editor.window), resolve,
        timer: setTimeout(() => { this.openRequests.delete(requestId); resolve({ ok: false, error: 'The chat did not acknowledge the design request.' }); }, 60_000),
      });
    });
    this.options.emit('design:chat-request', {
      requestId, sessionId: editor.owner, id: editor.id,
      text: `Design Canvas ${editor.id}${presence}\n\n${request}${selected}`,
      submit: args.deliver === 'send',
    }, this.windowId(editor.window));
    return result;
  }
  async invoke(context: HandlerContext): Promise<Json> {
    if (!['design:list', 'design:open', 'design:panel-show'].includes(context.channel)) return this.performInvoke(context);
    this.assertEnabled();
    const owner = text(record(context.args[0]).sessionId, 'chat');
    if (this.retiring.has(owner)) throw new Error('The design chat is closing.');
    const operation = this.performInvoke(context);
    let active = this.operations.get(owner);
    if (!active) this.operations.set(owner, active = new Set());
    active.add(operation);
    try { return await operation; } finally { active.delete(operation); if (!active.size) this.operations.delete(owner); }
  }
  private async performInvoke(context: HandlerContext): Promise<Json> {
    if (context.channel === 'design:save-file') { if (context.role !== 'design') throw new Error('Only the design shell can save an export.'); return this.saveFile(context.senderId, record(context.args[0])); }
    if (context.channel === 'design:chat-request') { if (context.role !== 'design') throw new Error('Only the design shell can request chat input.'); return this.chatRequest(context.senderId, record(context.args[0])); }
    if (context.channel === 'design:transport-ready') { if (context.role !== 'design') throw new Error('Only the design shell can connect.'); return this.transport(context.senderId); }
    if (context.role !== 'main') throw new Error('Only the main window can present design canvases.');
    const window = this.callerWindow(context.senderId), windowId = window.webContents.id;
    const args = record(context.args[0]);
    if (context.channel === 'design:list') return { designs: this.store.list(text(args.sessionId, 'chat')).map(row => ({ id: row.id, title: row.title })) };
    if (context.channel === 'design:open') {
      const found = await this.resolve(text(args.sessionId, 'chat'), args.id), requestId = randomUUID();
      const result = new Promise<Data>(resolve => {
        this.openRequests.set(requestId, {
          windowId, resolve,
          timer: setTimeout(() => { this.openRequests.delete(requestId); resolve({ ok: false, error: 'The Design Canvas panel did not acknowledge opening.' }); }, 60_000),
        });
      });
      this.options.emit('design:open-panel', { id: found.id, title: found.row.title ?? 'Design Canvas', sessionId: String(args.sessionId), requestId }, windowId);
      return result;
    }
    if (context.channel === 'design:open-result' || context.channel === 'design:chat-result') {
      const pending = this.openRequests.get(String(args.requestId));
      if (pending) {
        if (pending.windowId !== windowId) throw new Error('This window does not own the design request.');
        this.openRequests.delete(String(args.requestId)); clearTimeout(pending.timer);
        pending.resolve({ ok: args.ok === true, ...(typeof args.error === 'string' ? { error: args.error } : {}) });
      }
      return { ok: true };
    }
    if (context.channel === 'design:panel-show') {
      const revision = (this.revisions.get(windowId) ?? 0) + 1; this.revisions.set(windowId, revision);
      const bounds = this.rectangle(args.bounds, window), editor = await this.editor(text(args.sessionId, 'chat'), text(args.id, 'design canvas id'));
      if (revision !== this.revisions.get(windowId) || this.closed) return { ok: false, error: 'The design request is stale.' };
      if (editor.window !== window) {
        const previous = this.windowId(editor.window);
        if (!editor.window.isDestroyed()) editor.window.contentView.removeChildView(editor.view);
        if (this.active.get(previous) === editor) this.active.delete(previous);
        editor.window = window; window.contentView.addChildView(editor.view);
      }
      this.active.get(windowId)?.view.setVisible(false);
      this.active.set(windowId, editor); this.bounds.set(windowId, record(args.bounds));
      editor.view.setBounds(bounds); editor.view.setVisible(true);
      return { ok: true };
    }
    if (context.channel === 'design:panel-set-bounds') {
      const editor = this.active.get(windowId);
      if (editor) { this.bounds.set(windowId, record(args.bounds)); editor.view.setBounds(this.rectangle(args.bounds, window)); }
      return { ok: true };
    }
    if (context.channel === 'design:panel-hide' || context.channel === 'design:panel-close') {
      const revision = (this.revisions.get(windowId) ?? 0) + 1;
      this.revisions.set(windowId, revision);
      const active = this.active.get(windowId);
      if (context.channel === 'design:panel-hide' && active && canCaptureNativeViewSnapshot(active.view)) {
        const snapshotDataUrl = await captureNativeViewSnapshot(active.view);
        if (this.revisions.get(windowId) === revision && this.active.get(windowId) === active) active.view.setVisible(false);
        return snapshotDataUrl ? { ok: true, snapshotDataUrl } : { ok: true };
      }
      active?.view.setVisible(false);
      if (context.channel === 'design:panel-close') this.active.delete(windowId);
      return { ok: true };
    }
    throw new Error('Unknown design channel.');
  }
  async releaseSession(owner: string): Promise<void> {
    this.mcp.releaseSession(owner);
    this.retiring.add(owner);
    try {
      await Promise.allSettled([...(this.operations.get(owner) ?? [])]);
      for (const editor of [...this.editors.values()].filter(item => item.owner === owner)) {
        await this.flush(editor);
        await this.removeEditor(editor);
      }
      this.runtime.release(owner);
    } finally { this.retiring.delete(owner); }
  }
  private async removeEditor(editor: Editor): Promise<void> {
    if (!editor.window.isDestroyed()) editor.window.contentView.removeChildView(editor.view);
    for (const [id, active] of this.active) if (active === editor) { this.active.delete(id); this.bounds.delete(id); }
    this.editors.delete(this.key(editor.owner, editor.id));
    this.runtime.release(editor.owner, editor.id);
    if (editor.download) { editor.partition.removeListener('will-download', editor.download); editor.download = undefined; }
    if (!editor.view.webContents.isDestroyed()) editor.view.webContents.close({ waitForBeforeUnload: false });
    editor.partition.protocol.unhandle(APP_SCHEME);
    await editor.partition.closeAllConnections();
  }
  private async flush(editor: Editor): Promise<void> {
    await editor.loading;
    if (editor.failure) throw new Error(editor.failure);
    await this.waitForReport(editor);
    await editor.view.webContents.executeJavaScript("window.__klausPresentationController?.command('save_now')", true);
    const deadline = Date.now() + 15_000;
    let saved = 0;
    while (Date.now() < deadline && !editor.view.webContents.isDestroyed()) {
      const report = record(await editor.view.webContents.executeJavaScript('window.__klausPresentationReport ?? null'));
      saved = report.saved === 'saved' ? saved + 1 : 0;
      if (saved >= 3) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The design canvas has not finished saving. Its editor and recovery data were kept.');
  }
  async prepareToClose(): Promise<void> {
    this.closing = true;
    try {
      await Promise.allSettled([...this.operations.values()].flatMap(active => [...active]));
      for (const editor of this.editors.values()) await this.flush(editor);
    } catch (error) { this.closing = false; throw error; }
  }
  async dispose(force = false): Promise<void> {
    if (this.closed) return;
    if (!this.closing && !force) await this.prepareToClose();
    this.closed = true;
    for (const window of this.windows.values()) {
      window.removeListener('resize', this.resize);
      if (!window.webContents.isDestroyed()) window.webContents.removeListener('zoom-changed', this.resize);
    }
    this.windows.clear(); this.active.clear(); this.bounds.clear(); this.revisions.clear();
    for (const pending of this.openRequests.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error: 'The Design Canvas service closed.' }); }
    this.openRequests.clear();
    for (const editor of [...this.editors.values()]) {
      if (editor.exportWait) { clearTimeout(editor.exportWait.timer); editor.exportWait.reject(new Error('The Design Canvas service closed.')); }
      await this.removeEditor(editor);
    }
    this.editors.clear();
    this.runtime.release();
    await this.mcp.shutdown();
  }
}
