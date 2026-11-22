import { app, BrowserWindow, dialog, nativeImage, net, session, shell, WebContentsView, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_HOST, APP_SCHEME } from '../app/protocol';
import { preloadFor } from '../app/windows';
import type { Json } from '../ipc/contract';
import type { HandlerContext } from '../ipc/registry';
import { VisualCapabilityServer } from '../visuals/capability-server';
import { inside, message, readBounded, record, text, type Data } from '../visuals/data';
import { PhotoEditingStore, type PhotoEditingProject } from './store';
import { PHOTO_EDITING_TOOL_FIELDS, photoEditingTools } from './tools';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const ALLOWED_DOWNLOAD_FORMATS = new Set([
  'pcraft', 'psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'tiff', 'tif', 'pdf', 'svg', 'bmp', 'gif', 'tga', 'ico', 'avif',
]);

function workspaceHasDocument(state: Data): boolean {
  const result = record(state.result);
  return result.empty !== true && result.document !== null && typeof result.document === 'object';
}

interface ReadyWait {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface EditorView {
  id: string;
  owner: string;
  window: BrowserWindow;
  view: WebContentsView;
  partition: Session;
  ready: boolean;
  runtimeVersion: string;
  failure?: string;
  waits: Set<ReadyWait>;
  loading: Promise<void>;
  queue: Promise<unknown>;
  lastUsed: number;
}

export interface PhotoEditingOptions {
  configRoot: string;
  window: BrowserWindow;
  pluginRoot(): string | undefined;
  windowForOwner?(owner: string): BrowserWindow;
  windowForSender?(senderId: number): BrowserWindow | undefined;
  enabled?(): boolean;
  language?(): string;
  readRoots(owner: string): string[];
  writeRoots?(owner: string): string[];
  registerRenderer(senderId: number, role: 'photo-editing'): void;
  unregisterRenderer(senderId: number): void;
  emit(channel: string, payload: Json, windowId?: number): void;
  chooseExportPath?(name: string, format: string): Promise<string | undefined>;
  log?(event: string, data: Data): void;
}

/** Shared live photo-editing workspaces driven by both the isolated panel view and MCP tools. */
export class PhotoEditingService {
  readonly store: PhotoEditingStore;
  private readonly mcp: VisualCapabilityServer;
  private readonly editors = new Map<string, EditorView>();
  private readonly openRequests = new Map<string, { windowId: number; resolve(result: Data): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly trackedWindows = new Map<number, { window: BrowserWindow; onResize: () => void }>();
  private readonly activeByWindow = new Map<number, string>();
  private readonly boundsByWindow = new Map<number, Data>();
  private readonly revisionByWindow = new Map<number, number>();
  private closed = false;
  private quiescing = false;
  private closePreparation: Promise<void> | undefined;
  private restoreAfterClose: (() => void) | undefined;
  private allocation: Promise<unknown> = Promise.resolve();

  constructor(readonly options: PhotoEditingOptions) {
    this.store = new PhotoEditingStore(options.configRoot, error => this.log('photo-editing-retention-warning', { error }));
    this.mcp = new VisualCapabilityServer('klaus-photo-editing', photoEditingTools, (owner, name, args) => this.call(owner, name, args), () => this.enabled());
    this.trackWindow(options.window);
  }

  private enabled(): boolean {
    return !this.closed && !this.quiescing && (this.options.enabled?.() ?? true);
  }

  private appLanguage(): string {
    const saved = (this.options.language?.() ?? '').trim().toLowerCase();
    if (/^zh[-_](?:tw|hk|mo|hant)/.test(saved)) return 'zh-hant';
    if (/^zh(?:[-_]|$)/.test(saved)) return 'zh-hans';
    return 'en';
  }

  refreshLanguage(): void {
    const code = this.appLanguage();
    for (const editor of this.editors.values()) {
      if (editor.view.webContents.isDestroyed()) continue;
      void editor.view.webContents
        .executeJavaScript(`window.klausPhotoEditing && window.klausPhotoEditing.setLanguage(${JSON.stringify(code)})`, true)
        .catch(() => {});
    }
  }

  toolSpecs(): Data[] {
    return photoEditingTools();
  }

  hostCapabilities(owner: string): Promise<Data> {
    return this.mcp.hostCapabilities(owner);
  }

  private assertEnabled(): void {
    if (!this.enabled()) throw new Error('Photo Editing is disabled or has shut down.');
  }

  private log(event: string, data: Data): void {
    this.options.log?.(event, data);
  }

  private hostWindow(owner: string): BrowserWindow {
    const target = this.options.windowForOwner?.(owner) ?? this.options.window;
    this.trackWindow(target);
    return target;
  }

  private senderWindow(senderId: number): BrowserWindow | undefined {
    const target = this.options.windowForSender?.(senderId)
      ?? (senderId === this.options.window.webContents.id ? this.options.window : undefined);
    if (target) this.trackWindow(target);
    return target;
  }

  private trackWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const id = win.webContents.id;
    if (this.trackedWindows.has(id)) return;
    const onResize = () => this.resizeWindow(id);
    win.on('resize', onResize);
    win.webContents.on('zoom-changed', onResize);
    win.once('closed', () => {
      this.trackedWindows.delete(id);
      this.activeByWindow.delete(id);
      this.boundsByWindow.delete(id);
      this.revisionByWindow.delete(id);
    });
    this.trackedWindows.set(id, { window: win, onResize });
  }

  private rectangle(win: BrowserWindow, input: unknown): Electron.Rectangle {
    const fields = record(input);
    if (
      ['x', 'y', 'width', 'height'].some(key => typeof fields[key] !== 'number' || !Number.isFinite(fields[key]))
      || Number(fields.width) <= 0
      || Number(fields.height) <= 0
    ) {
      throw new Error('Invalid photo-editing panel bounds.');
    }
    const zoom = win.webContents.getZoomFactor();
    const [width, height] = win.getContentSize();
    const x = Math.max(0, Math.min(width! - 1, Math.round(Number(fields.x) * zoom)));
    const y = Math.max(0, Math.min(height! - 1, Math.round(Number(fields.y) * zoom)));
    return {
      x,
      y,
      width: Math.max(1, Math.min(width! - x, Math.round(Number(fields.width) * zoom))),
      height: Math.max(1, Math.min(height! - y, Math.round(Number(fields.height) * zoom))),
    };
  }

  private resizeWindow(windowId: number): void {
    const tracked = this.trackedWindows.get(windowId);
    const activeId = this.activeByWindow.get(windowId);
    const bounds = this.boundsByWindow.get(windowId);
    if (this.closed || !tracked || tracked.window.isDestroyed() || !activeId || !bounds) return;
    const editor = this.editors.get(activeId);
    if (editor && editor.window === tracked.window && !editor.view.webContents.isDestroyed()) {
      editor.view.setBounds(this.rectangle(tracked.window, bounds));
    }
  }

  private readRoots(owner: string): string[] {
    return this.options.readRoots(owner).flatMap(candidate => {
      try {
        return [realpathSync(candidate)];
      } catch {
        return [];
      }
    });
  }

  private writeRoots(owner: string): string[] {
    const roots = this.options.writeRoots ? this.options.writeRoots(owner) : this.options.readRoots(owner).slice(0, -1);
    const effective = roots.length ? roots : this.options.readRoots(owner).slice(0, 1);
    return effective.flatMap(candidate => {
      try {
        return [realpathSync(candidate)];
      } catch {
        return [];
      }
    });
  }

  private readWorkspaceFile(owner: string, inputPath: string): { path: string; name: string; bytes: Buffer } {
    if (!isAbsolute(inputPath)) throw new Error('Image paths must be absolute paths inside the chat workspace.');
    let resolved: string;
    try {
      resolved = realpathSync(inputPath);
    } catch {
      throw new Error(`Input file does not exist: ${inputPath}`);
    }
    const roots = this.readRoots(owner);
    if (!roots.some(root => inside(root, resolved))) {
      throw new Error('Input files must reside inside the chat workspace.');
    }
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
      throw new Error('Input file must be a non-empty regular file of at most 128 MiB.');
    }
    return { path: resolved, name: basename(resolved), bytes: readFileSync(resolved) };
  }

  private resolveOutputPath(owner: string, requestedPath: unknown, defaultPath: string, expectedExt?: string): string {
    if (requestedPath === undefined || requestedPath === null || requestedPath === '') return defaultPath;
    const target = text(requestedPath, 'output_path');
    if (!isAbsolute(target) || /[\u0000-\u001f]/.test(target)) {
      throw new Error('output_path must be an absolute path inside the chat workspace.');
    }
    const parentInput = dirname(target);
    if (!existsSync(parentInput)) {
      throw new Error(`Output directory does not exist: ${parentInput}`);
    }
    const parentReal = realpathSync(parentInput);
    const storeRootReal = existsSync(this.store.root) ? realpathSync(this.store.root) : this.store.root;
    const allowedRoots = [...this.writeRoots(owner), storeRootReal];
    const leaf = basename(target);
    if (!leaf || leaf === '.' || leaf === '..') throw new Error('Invalid output filename.');
    const finalPath = join(parentReal, leaf);
    if (!allowedRoots.some(root => inside(root, finalPath))) {
      throw new Error('output_path must stay inside the chat workspace.');
    }
    if (expectedExt) {
      const actualExt = extname(leaf).slice(1).toLowerCase();
      const validExts = expectedExt === 'jpg' ? ['jpg', 'jpeg'] : expectedExt === 'tiff' ? ['tiff', 'tif'] : [expectedExt];
      if (!validExts.includes(actualExt)) {
        throw new Error(`output_path extension (.${actualExt || 'none'}) must match format "${expectedExt}".`);
      }
    }
    let existing: ReturnType<typeof lstatSync> | undefined;
    try { existing = lstatSync(finalPath); } catch { /* Target does not exist yet. */ }
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error('Refusing to overwrite a directory or symbolic link.');
    }
    return finalPath;
  }

  private writeBinaryAtomic(destination: string, bytes: Buffer): void {
    const temp = join(dirname(destination), `.tmp-${process.pid}-${randomUUID()}`);
    try {
      writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(temp, destination);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  private waitUntilReady(editor: EditorView): Promise<void> {
    if (editor.failure) return Promise.reject(new Error(editor.failure));
    if (editor.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wait: ReadyWait = {
        resolve,
        reject,
        timer: setTimeout(() => {
          editor.waits.delete(wait);
          reject(new Error('The photo editor is still initializing. Retry this operation once it finishes starting.'));
        }, 60_000),
      };
      editor.waits.add(wait);
    });
  }

  private fail(editor: EditorView, error: string): void {
    editor.failure = error;
    for (const wait of editor.waits) {
      clearTimeout(wait.timer);
      wait.reject(new Error(error));
    }
    editor.waits.clear();
    this.log('photo-editing-runtime-error', { id: editor.id, error });
  }

  private attachEditorToWindow(editor: EditorView, targetWindow: BrowserWindow): void {
    this.trackWindow(targetWindow);
    if (editor.window === targetWindow) return;
    if (!editor.window.isDestroyed()) {
      try {
        editor.window.contentView.removeChildView(editor.view);
      } catch { /* already detached */ }
    }
    editor.window = targetWindow;
    if (!targetWindow.isDestroyed()) {
      targetWindow.contentView.addChildView(editor.view);
    }
  }

  private async editor(project: PhotoEditingProject, targetWindow?: BrowserWindow, bounds?: Electron.Rectangle): Promise<EditorView> {
    const win = targetWindow ?? this.hostWindow(project.sessionId);
    const current = this.editors.get(project.id);
    if (current) {
      this.assertEnabled();
      if (current.owner !== project.sessionId) throw new Error('The photo editor belongs to another chat.');
      this.attachEditorToWindow(current, win);
      current.lastUsed = Date.now();
      await current.loading;
      await this.waitUntilReady(current);
      return current;
    }
    const next = this.allocation.then(() => this.createEditor(project, win, bounds));
    this.allocation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async removeEditor(editor: EditorView): Promise<void> {
    if (!editor.window.isDestroyed()) {
      try {
        editor.window.contentView.removeChildView(editor.view);
      } catch { /* already detached */ }
    }
    if (!editor.view.webContents.isDestroyed()) {
      editor.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.editors.delete(editor.id);
    for (const [winId, activeId] of this.activeByWindow) {
      if (activeId === editor.id) this.activeByWindow.delete(winId);
    }
    editor.partition.protocol.unhandle(APP_SCHEME);
    await editor.partition.closeAllConnections();
    await editor.partition.clearStorageData();
  }

  private async createEditor(project: PhotoEditingProject, targetWindow: BrowserWindow, bounds?: Electron.Rectangle): Promise<EditorView> {
    this.assertEnabled();
    let editor = this.editors.get(project.id);
    if (editor) {
      if (editor.owner !== project.sessionId) throw new Error('The photo editor belongs to another chat.');
      this.attachEditorToWindow(editor, targetWindow);
      await editor.loading;
      await this.waitUntilReady(editor);
      return editor;
    }
    if (this.editors.size >= 3) {
      const oldest = [...this.editors.values()]
        .filter(entry => !entry.view.getVisible() && entry.ready && !entry.failure)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!oldest) throw new Error('The photo-editing workspace cache is busy. Finish the current operation and retry.');
      await oldest.queue;
      await oldest.view.webContents.executeJavaScript('window.klausPhotoEditing.flush()', true);
      if (oldest.view.getVisible()) throw new Error('The photo editor became active while saving. Retry opening the other workspace.');
      await this.removeEditor(oldest);
    }
    const pluginRoot = this.options.pluginRoot();
    if (!pluginRoot) throw new Error('The photo-editing plugin is not installed.');
    const root = realpathSync(join(pluginRoot, 'runtime', 'dist'));
    const manifest = record(JSON.parse(readBounded(join(root, 'runtime-manifest.json'))));
    if (
      manifest.bridgeVersion !== 1
      || typeof manifest.version !== 'string'
      || !Array.isArray(manifest.assets)
      || !manifest.assets.includes('index.html')
    ) {
      throw new Error('The photo-editing runtime package is incomplete.');
    }
    const assets = new Set(manifest.assets.filter((asset): asset is string => typeof asset === 'string'));
    const partition = session.fromPartition(`photo-editing-${randomUUID()}`, { cache: false });
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.protocol.handle(APP_SCHEME, async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== APP_HOST || url.username || url.password || url.port || !url.pathname.startsWith('/photo-editing/')) {
          return new Response('Forbidden', { status: 403 });
        }
        const asset = decodeURIComponent(url.pathname.slice('/photo-editing/'.length));
        if (!assets.has(asset)) return new Response('Not found', { status: 404 });
        const path = realpathSync(join(root, asset));
        if (!inside(root, path) || !lstatSync(path).isFile()) return new Response('Forbidden', { status: 403 });
        const response = await net.fetch(pathToFileURL(path).toString());
        const headers = new Headers(response.headers);
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.wasm': 'application/wasm',
          '.json': 'application/json',
          '.txt': 'text/plain; charset=utf-8',
          '.ttf': 'font/ttf',
          '.otf': 'font/otf',
          '.woff2': 'font/woff2',
        }[extname(path).toLowerCase()];
        if (mime) headers.set('Content-Type', mime);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Cache-Control', 'no-store');
        headers.set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return new Response('Runtime asset not found', { status: 404 });
      }
    });

    this.trackWindow(targetWindow);
    const view = new WebContentsView({
      webPreferences: {
        session: partition,
        preload: preloadFor('photo-editing')!,
        additionalArguments: ['--klaus-role=photo-editing'],
        devTools: !app.isPackaged,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    });
    const entry: EditorView = {
      id: project.id,
      owner: project.sessionId,
      window: targetWindow,
      view,
      partition,
      ready: false,
      runtimeVersion: String(manifest.version),
      waits: new Set(),
      loading: Promise.resolve(),
      queue: Promise.resolve(),
      lastUsed: Date.now(),
    };
    editor = entry;
    this.editors.set(project.id, entry);
    const contents = view.webContents;
    this.options.registerRenderer(contents.id, 'photo-editing');
    const url = `${APP_SCHEME}://${APP_HOST}/photo-editing/index.html?${new URLSearchParams({ id: project.id })}`;
    contents.on('will-navigate', (event, destination) => {
      if (destination !== url) event.preventDefault();
    });
    contents.on('will-redirect', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('render-process-gone', (_event, details) => this.fail(entry, `The photo editor stopped: ${details.reason}.`));
    contents.once('destroyed', () => {
      this.options.unregisterRenderer(contents.id);
      this.fail(entry, 'The photo editor has closed.');
      if (this.editors.get(project.id) === entry) this.editors.delete(project.id);
    });
    view.setBounds(bounds ?? { x: 0, y: 0, width: 1280, height: 860 });
    view.setVisible(false);
    targetWindow.contentView.addChildView(view);
    entry.loading = contents.loadURL(url).catch(error => {
      this.fail(entry, message(error));
      throw error;
    });
    await entry.loading;
    await this.waitUntilReady(entry);
    return entry;
  }

  private async flushEditor(project: PhotoEditingProject): Promise<number> {
    const editor = await this.editor(project);
    const next = editor.queue.then(async () => {
      this.assertEnabled();
      if (editor.view.webContents.isDestroyed()) throw new Error('The photo editor closed before flushing.');
      const reply = record(await editor.view.webContents.executeJavaScript('window.klausPhotoEditing.flush()', true));
      return Number.isSafeInteger(reply.version) ? Number(reply.version) : this.store.load(project.id, project.sessionId).version;
    });
    editor.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async request(project: PhotoEditingProject, method: string, params: Data = {}): Promise<Data> {
    const editor = await this.editor(project);
    const next = editor.queue.then(async () => {
      this.assertEnabled();
      if (editor.view.webContents.isDestroyed()) throw new Error('The photo editor closed before the request.');
      const args = JSON.stringify({ method, params });
      const value: unknown = await editor.view.webContents.executeJavaScript(`window.klausPhotoEditing.request(${args})`, true);
      const reply = record(value);
      if (reply.ok === false) throw new Error(String(reply.error ?? 'The photo-editing operation failed.'));
      return reply;
    });
    editor.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private success(value: Data, artifact?: Data): Data {
    const payload = artifact ? { ...value, artifact } : value;
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }

  private conflictFailure(id: string, expectedVersion: number, currentVersion: number): Data {
    const payload = {
      conflict: true,
      id,
      expectedVersion,
      version: currentVersion,
      error: `Version conflict: expected version ${expectedVersion}, but workspace is currently at version ${currentVersion}. Call photo_inspect to read the latest layer state (including manual panel edits) and retry with expected_version: ${currentVersion}.`,
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }

  private decode(input: unknown): Buffer {
    if (typeof input !== 'string' || input.length > MAX_FILE_BYTES * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
      throw new Error('Invalid photo-editing export encoding.');
    }
    const bytes = Buffer.from(input, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) {
      throw new Error('Empty or oversized photo-editing export.');
    }
    return bytes;
  }

  async call(owner: string, name: string, fields: Data): Promise<Data> {
    try {
      this.assertEnabled();
      text(owner, 'photo-editing session');
      const allowedFields = PHOTO_EDITING_TOOL_FIELDS[name];
      if (allowedFields) {
        const unknown = Object.keys(fields).filter(key => !allowedFields.includes(key));
        if (unknown.length) {
          throw new Error(`Unknown ${name} parameter: ${unknown.join(', ')}. Supported parameters: ${allowedFields.join(', ')}.`);
        }
      }

      if (name === 'photo_open') {
        const isFresh = fields.id === undefined;
        let sourceFile: { path: string; name: string; bytes: Buffer } | undefined;
        if (fields.source_path !== undefined) {
          sourceFile = this.readWorkspaceFile(owner, text(fields.source_path, 'source_path'));
        }
        let previousId: string | undefined;
        try {
          previousId = this.store.resolveId(owner);
        } catch { /* No existing workspace in this chat. */ }
        const requestedTitle = typeof fields.title === 'string' && fields.title.trim()
          ? fields.title.trim()
          : sourceFile
            ? sourceFile.name.replace(/\.[^.]+$/, '') || sourceFile.name
            : 'Untitled';
        const project = this.store.open(owner, isFresh ? { title: requestedTitle } : fields);
        try {
          await this.editor(project);
          let warnings: unknown;
          const shouldCreateOrImport = isFresh || sourceFile !== undefined || fields.width !== undefined || fields.height !== undefined;
          if (shouldCreateOrImport && (project.version === 0 || sourceFile !== undefined)) {
            const openReply = await this.request(
              project,
              'document.open',
              sourceFile
                ? {
                    name: sourceFile.name,
                    title: requestedTitle,
                    data: sourceFile.bytes.toString('base64'),
                  }
                : {
                    title: requestedTitle,
                    width: fields.width ?? 1920,
                    height: fields.height ?? 1080,
                    resolution: fields.resolution ?? 72,
                    background: fields.background ?? 'white',
                    mode: fields.mode ?? 'rgb',
                    depth: fields.depth ?? 8,
                  },
            );
            warnings = record(openReply.result).warnings;
          }
          const state = await this.request(project, 'document.inspect', {});
          const refreshed = this.store.load(project.id, owner);
          void this.openPanel({ id: refreshed.id, sessionId: owner }).catch(() => {});
          const inspectResult = record(state.result);
          return this.success(
            {
              id: refreshed.id,
              title: refreshed.title,
              version: refreshed.version,
              revision: state.revision ?? null,
              workspace: state.workspace ?? null,
              document: inspectResult.document ?? null,
              ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {}),
            },
            {
              kind: 'photo-editing',
              id: refreshed.id,
              title: refreshed.title,
              ready: workspaceHasDocument(state),
            },
          );
        } catch (error) {
          if (isFresh) {
            const editor = this.editors.get(project.id);
            if (editor) await this.removeEditor(editor);
            this.store.discard(project.id, owner, previousId);
          }
          throw error;
        }
      }

      if (name === 'photo_inspect') {
        const id = this.store.resolveId(owner, fields.id);
        const project = this.store.load(id, owner);
        const state = await this.request(project, 'document.inspect', {
          ...(fields.tab_index !== undefined ? { tabIndex: fields.tab_index } : {}),
          ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
        });
        const refreshed = this.store.load(id, owner);
        const result = record(state.result);
        return this.success({
          id,
          title: refreshed.title,
          version: refreshed.version,
          revision: state.revision ?? null,
          workspace: state.workspace ?? null,
          session: result.session ?? null,
          document: result.document ?? null,
        });
      }

      if (name === 'photo_commands') {
        const id = this.store.resolveId(owner, fields.id);
        const project = this.store.load(id, owner);
        const response = await this.request(project, 'engine.commands', {
          ...(fields.query !== undefined ? { query: fields.query } : {}),
          ...(fields.enabled_only !== undefined ? { enabledOnly: fields.enabled_only } : {}),
          limit: fields.limit ?? 60,
        });
        const refreshed = this.store.load(id, owner);
        return this.success({
          id,
          version: refreshed.version,
          commands: response.result ?? [],
        });
      }

      if (name === 'photo_execute') {
        if (!Number.isSafeInteger(fields.expected_version) || Number(fields.expected_version) < 0) {
          throw new Error('expected_version must be a non-negative integer.');
        }
        if (!Array.isArray(fields.commands) || fields.commands.length === 0 || fields.commands.length > 128) {
          throw new Error('commands must be a non-empty array of at most 128 steps.');
        }
        const expectedVersion = Number(fields.expected_version);
        const id = this.store.resolveId(owner, fields.id);
        const project = this.store.load(id, owner);
        const liveVersion = await this.flushEditor(project);
        if (expectedVersion !== liveVersion) {
          return this.conflictFailure(id, expectedVersion, liveVersion);
        }
        const commands = fields.commands.map(entry => {
          const item = record(entry);
          return {
            command: text(item.command, 'command'),
            params: item.params === undefined ? {} : record(item.params),
          };
        });
        const response = commands.length === 1
          ? await this.request(project, 'engine.execute', commands[0]!)
          : await this.request(project, 'engine.batch', { commands });
        const refreshed = this.store.load(id, owner);
        return this.success(
          {
            id,
            version: refreshed.version,
            revision: response.revision ?? null,
            workspace: response.workspace ?? null,
            result: response.result ?? null,
          },
          refreshed.files.length > 0
            ? { kind: 'photo-editing', id, title: refreshed.title, ready: true }
            : undefined,
        );
      }

      if (name === 'photo_place') {
        if (!Number.isSafeInteger(fields.expected_version) || Number(fields.expected_version) < 0) {
          throw new Error('expected_version must be a non-negative integer.');
        }
        const expectedVersion = Number(fields.expected_version);
        const source = this.readWorkspaceFile(owner, text(fields.path, 'path'));
        const id = this.store.resolveId(owner, fields.id);
        const project = this.store.load(id, owner);
        const liveVersion = await this.flushEditor(project);
        if (expectedVersion !== liveVersion) {
          return this.conflictFailure(id, expectedVersion, liveVersion);
        }
        const response = await this.request(project, 'document.place', {
          name: source.name,
          data: source.bytes.toString('base64'),
          ...(typeof fields.layer_name === 'string' && fields.layer_name.trim() ? { layerName: fields.layer_name.trim() } : {}),
          smartObject: fields.smart_object !== false,
          fit: fields.fit !== false,
          ...(fields.scale !== undefined ? { scale: fields.scale } : {}),
          ...(fields.x !== undefined ? { x: fields.x } : {}),
          ...(fields.y !== undefined ? { y: fields.y } : {}),
          ...(fields.angle !== undefined ? { angle: fields.angle } : {}),
        });
        const refreshed = this.store.load(id, owner);
        return this.success(
          {
            id,
            version: refreshed.version,
            revision: response.revision ?? null,
            workspace: response.workspace ?? null,
            placed: response.result ?? null,
          },
          { kind: 'photo-editing', id, title: refreshed.title, ready: true },
        );
      }

      if (name === 'photo_preview') {
        const id = this.store.resolveId(owner, fields.id);
        const project = this.store.load(id, owner);
        const maxSide = Number.isFinite(Number(fields.max_side))
          ? Math.max(64, Math.min(4096, Math.round(Number(fields.max_side))))
          : 1024;
        const response = await this.request(project, 'document.preview', { maxSide });
        const result = record(response.result);
        let bytes = this.decode(result.data);
        const docWidth = Number(result.width) || 0;
        const docHeight = Number(result.height) || 0;
        let outWidth = docWidth;
        let outHeight = docHeight;
        if (docWidth > 0 && docHeight > 0 && Math.max(docWidth, docHeight) > maxSide) {
          const scale = maxSide / Math.max(docWidth, docHeight);
          outWidth = Math.max(1, Math.round(docWidth * scale));
          outHeight = Math.max(1, Math.round(docHeight * scale));
          const decoded = nativeImage.createFromBuffer(bytes);
          if (!decoded.isEmpty()) {
            bytes = decoded.resize({ width: outWidth, height: outHeight, quality: 'better' }).toPNG();
          }
        }
        const previewDir = join(this.store.root, id, 'previews');
        mkdirSync(previewDir, { recursive: true, mode: 0o700 });
        const defaultPath = join(previewDir, `preview-${randomUUID()}.png`);
        const path = this.resolveOutputPath(owner, fields.output_path, defaultPath, 'png');
        this.writeBinaryAtomic(path, bytes);
        const refreshed = this.store.load(id, owner);
        return this.success({
          id,
          version: refreshed.version,
          path,
          format: 'png',
          width: outWidth || null,
          height: outHeight || null,
          documentWidth: docWidth || null,
          documentHeight: docHeight || null,
          bytes: bytes.length,
        });
      }

      if (name === 'photo_export') {
        const format = text(fields.format, 'format').toLowerCase();
        if (!['psd', 'psb', 'pcraft', 'png', 'jpg', 'webp', 'tiff', 'pdf'].includes(format)) {
          throw new Error(`Unsupported photo_export format: ${format}`);
        }
        const id = this.store.resolveId(owner, fields.id);
        const project = this.store.load(id, owner);
        const response = await this.request(project, 'document.export', {
          format,
          ...(fields.quality !== undefined ? { quality: fields.quality } : {}),
        });
        const result = record(response.result);
        const bytes = this.decode(result.data);
        const defaultPath = join(this.store.root, id, `export-${randomUUID()}.${format}`);
        const path = this.resolveOutputPath(owner, fields.output_path, defaultPath, format);
        this.writeBinaryAtomic(path, bytes);
        const refreshed = this.store.load(id, owner);
        return this.success({
          id,
          version: refreshed.version,
          format,
          path,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: bytes.length,
          ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        });
      }

      throw new Error(`Unknown photo-editing tool: ${name}`);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: message(error) }] };
    }
  }

  private async present(win: BrowserWindow, fields: Data): Promise<Data> {
    const owner = text(fields.sessionId, 'photo-editing session');
    const project = this.store.load(fields.id, owner);
    const bounds = this.rectangle(win, fields.bounds);
    const winId = win.webContents.id;
    const revision = (this.revisionByWindow.get(winId) ?? 0) + 1;
    this.revisionByWindow.set(winId, revision);
    const editor = await this.editor(project, win, bounds);
    if (this.revisionByWindow.get(winId) !== revision || this.closed || win.isDestroyed()) {
      return { ok: false, error: 'The photo-editing presentation request is stale.' };
    }
    for (const entry of this.editors.values()) {
      if (entry.window === win) entry.view.setVisible(false);
    }
    this.activeByWindow.set(winId, project.id);
    this.boundsByWindow.set(winId, record(fields.bounds));
    editor.view.setBounds(bounds);
    editor.view.setVisible(true);
    this.nudge(win, editor);
    this.recover(win, editor, revision);
    return { ok: true };
  }

  private nudge(win: BrowserWindow, editor: EditorView): void {
    const winId = win.webContents.id;
    const savedBounds = this.boundsByWindow.get(winId);
    if (this.closed || !savedBounds || win.isDestroyed() || editor.view.webContents.isDestroyed()) return;
    try {
      const bounds = this.rectangle(win, savedBounds);
      editor.view.setBounds({ ...bounds, width: Math.max(1, bounds.width - 1) });
      setTimeout(() => {
        const currentBounds = this.boundsByWindow.get(winId);
        if (
          this.closed
          || this.activeByWindow.get(winId) !== editor.id
          || win.isDestroyed()
          || editor.view.webContents.isDestroyed()
          || !currentBounds
        ) {
          return;
        }
        try {
          editor.view.setBounds(this.rectangle(win, currentBounds));
        } catch { /* next resize sync bounds it */ }
      }, 40);
    } catch { /* next resize sync bounds it */ }
  }

  private recover(win: BrowserWindow, editor: EditorView, revision: number): void {
    const winId = win.webContents.id;
    if (!editor.failure || this.closed || editor.view.webContents.isDestroyed()) return;
    setTimeout(() => {
      const contents = editor.view.webContents;
      if (
        this.closed
        || this.revisionByWindow.get(winId) !== revision
        || this.activeByWindow.get(winId) !== editor.id
        || contents.isDestroyed()
      ) {
        return;
      }
      this.log('photo-editor-recover', { id: editor.id });
      editor.failure = undefined;
      editor.ready = false;
      editor.loading = contents
        .loadURL(contents.getURL())
        .then(() => this.waitUntilReady(editor))
        .catch(error => {
          this.fail(editor, message(error));
          throw error;
        });
    }, 0);
  }

  private hideWindow(winId: number): Data {
    this.revisionByWindow.set(winId, (this.revisionByWindow.get(winId) ?? 0) + 1);
    const activeId = this.activeByWindow.get(winId);
    if (activeId) this.editors.get(activeId)?.view.setVisible(false);
    return { ok: true };
  }

  private async openPanel(fields: Data, explicitWindow?: BrowserWindow): Promise<Data> {
    const owner = text(fields.sessionId, 'photo-editing session');
    const project = this.store.load(fields.id, owner);
    const targetWindow = explicitWindow ?? this.hostWindow(owner);
    const windowId = targetWindow.webContents.id;
    const requestId = randomUUID();
    const result = new Promise<Data>(resolve => {
      const timer = setTimeout(() => {
        this.openRequests.delete(requestId);
        resolve({ ok: false, error: 'The photo-editing panel did not acknowledge the open request.' });
      }, 60_000);
      this.openRequests.set(requestId, { windowId, resolve, timer });
    });
    this.options.emit('photo-editing:open-panel', { requestId, id: project.id, title: project.title, sessionId: owner }, windowId);
    return result;
  }

  private async runtimeAction(editor: EditorView, fields: Data): Promise<Data> {
    if (this.closed) throw new Error('The photo-editing service has closed.');
    if (fields.type === 'load') {
      return { ...this.store.runtimeLoad(editor.id, editor.owner), language: this.appLanguage() };
    }
    if (fields.type === 'ready') {
      if (fields.bridgeVersion !== 1 || fields.version !== editor.runtimeVersion) {
        throw new Error('The photo-editing runtime does not match this host package.');
      }
      editor.ready = true;
      for (const wait of editor.waits) {
        clearTimeout(wait.timer);
        wait.resolve();
      }
      editor.waits.clear();
      return { ok: true };
    }
    if (fields.type === 'error') {
      this.fail(editor, String(fields.error ?? 'The photo editor failed to start.'));
      return { ok: true };
    }
    if (fields.type === 'save') {
      const project = this.store.save(editor.id, editor.owner, fields);
      editor.lastUsed = Date.now();
      return { ok: true, version: project.version };
    }
    if (fields.type === 'export') {
      const bytes = this.decode(fields.data);
      const name = basename(String(fields.name ?? 'Untitled.psd')).replace(/[\x00-\x1f:?*"<>|]/g, '_').slice(0, 160);
      const format = extname(name).slice(1).toLowerCase();
      if (!ALLOWED_DOWNLOAD_FORMATS.has(format)) throw new Error('Unsupported photo-editing download format.');
      const path = this.options.chooseExportPath
        ? await this.options.chooseExportPath(name, format)
        : (await dialog.showSaveDialog(editor.window, { defaultPath: name })).filePath;
      if (!path) return { canceled: true };
      this.writeBinaryAtomic(path, bytes);
      return { ok: true, path };
    }
    if (fields.type === 'import') {
      const result = await dialog.showOpenDialog(editor.window, { properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return { canceled: true };
      if (result.filePaths.length > 24) throw new Error('Import at most 24 image files at once.');
      let size = 0;
      const files = result.filePaths.map(path => {
        const stats = lstatSync(path);
        size += stats.size;
        if (!stats.isFile() || size > MAX_FILE_BYTES) {
          throw new Error('The selected image files exceed the 128 MiB import limit.');
        }
        return { name: basename(path), data: readFileSync(path).toString('base64') };
      });
      return { files };
    }
    if (fields.type === 'open-url') {
      const url = new URL(text(fields.url, 'external URL'));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Only public web links can be opened.');
      }
      await shell.openExternal(url.href);
      return { ok: true };
    }
    throw new Error('Unknown photo-editing runtime action.');
  }

  async invoke(context: HandlerContext): Promise<Data> {
    const fields = record(context.args[0]);
    if (context.role === 'photo-editing' && context.channel === 'photo-editing:runtime-action') {
      const editor = [...this.editors.values()].find(
        entry => entry.view.webContents.id === context.senderId && !entry.view.webContents.isDestroyed(),
      );
      if (!editor) throw new Error('This photo editor is no longer active.');
      return this.runtimeAction(editor, record(fields.action));
    }
    this.assertEnabled();
    const senderWin = context.role === 'main' ? this.senderWindow(context.senderId) : undefined;
    if (!senderWin) throw new Error('Photo Editing belongs to another window.');
    const winId = senderWin.webContents.id;
    switch (context.channel) {
      case 'photo-editing:list':
        return {
          photoWorkspaces: this.store
            .list(text(fields.sessionId, 'photo-editing session'))
            .map(project => ({ id: project.id, title: project.title })) as unknown as Json,
        };
      case 'photo-editing:open':
        return this.openPanel(fields, senderWin);
      case 'photo-editing:open-result': {
        const requestId = text(fields.requestId, 'request id');
        const request = this.openRequests.get(requestId);
        if (!request || request.windowId !== winId) return { ok: false, error: 'The open request expired.' };
        clearTimeout(request.timer);
        this.openRequests.delete(requestId);
        request.resolve(fields.ok === true ? { ok: true } : { ok: false, error: fields.error ?? 'The photo-editing panel could not open.' });
        return { ok: true };
      }
      case 'photo-editing:panel-show':
        return this.present(senderWin, fields);
      case 'photo-editing:panel-set-bounds':
        this.boundsByWindow.set(winId, record(fields.bounds));
        this.resizeWindow(winId);
        return { ok: true };
      case 'photo-editing:panel-hide':
        return this.hideWindow(winId);
      case 'photo-editing:panel-close':
        this.hideWindow(winId);
        this.activeByWindow.delete(winId);
        this.boundsByWindow.delete(winId);
        return { ok: true };
      default:
        throw new Error(`Unknown photo-editing channel: ${context.channel}`);
    }
  }

  releaseSession(owner: string): void {
    this.mcp.releaseSession(owner);
    this.store.releaseSession(owner);
  }

  async flush(): Promise<void> {
    for (const editor of this.editors.values()) {
      if (!editor.view.webContents.isDestroyed() && editor.ready) {
        try {
          await editor.queue;
          await editor.view.webContents.executeJavaScript('window.klausPhotoEditing.flush()', true);
        } catch (error) {
          this.log('photo-editing-final-save-failed', { id: editor.id, error: message(error) });
          throw new Error('Photo Editing still has unsaved edits. Retry saving before closing its editor.');
        }
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.prepareToClose();
    if (this.closed) return;
    this.closed = true;
    for (const { window: win, onResize } of this.trackedWindows.values()) {
      if (!win.isDestroyed()) {
        win.removeListener('resize', onResize);
        win.webContents.removeListener('zoom-changed', onResize);
      }
    }
    this.trackedWindows.clear();
    for (const request of this.openRequests.values()) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error: 'The photo-editing service closed.' });
    }
    this.openRequests.clear();
    for (const editor of [...this.editors.values()]) {
      this.fail(editor, 'The photo-editing service closed.');
      await this.removeEditor(editor);
    }
    this.editors.clear();
    await this.mcp.shutdown();
  }

  prepareToClose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePreparation) return this.closePreparation;
    const visibleSnapshots: Array<{ win: BrowserWindow; editor: EditorView }> = [];
    for (const [winId, activeId] of this.activeByWindow) {
      const tracked = this.trackedWindows.get(winId);
      const editor = this.editors.get(activeId);
      if (tracked && !tracked.window.isDestroyed() && editor && editor.view.getVisible()) {
        visibleSnapshots.push({ win: tracked.window, editor });
      }
    }
    this.restoreAfterClose = () => {
      for (const { win, editor } of visibleSnapshots) {
        if (
          !win.isDestroyed()
          && this.activeByWindow.get(win.webContents.id) === editor.id
          && this.editors.get(editor.id) === editor
          && !editor.view.webContents.isDestroyed()
        ) {
          editor.view.setVisible(true);
          this.nudge(win, editor);
        }
      }
    };
    this.quiescing = true;
    for (const winId of this.trackedWindows.keys()) this.hideWindow(winId);
    this.closePreparation = (async () => {
      await this.allocation;
      await this.flush();
    })().catch(error => {
      this.abortClosePreparation();
      throw error;
    });
    return this.closePreparation;
  }

  abortClosePreparation(): void {
    if (this.closed) return;
    this.quiescing = false;
    this.closePreparation = undefined;
    const restore = this.restoreAfterClose;
    this.restoreAfterClose = undefined;
    restore?.();
  }
}
