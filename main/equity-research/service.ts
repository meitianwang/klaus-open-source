import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeTheme, app, BrowserWindow, dialog, net, session, shell, WebContentsView, type Session } from 'electron';
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
import { canCaptureNativeViewSnapshot, captureNativeViewSnapshot } from '../utils/native-view-snapshot';
import { EquityResearchStore, type EquityResearchProject } from './store';
import { EQUITY_RESEARCH_TOOL_FIELDS, equityResearchTools } from './tools';

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

export interface EquityResearchOptions {
  configRoot: string;
  window: BrowserWindow;
  pluginRoot(): string | undefined;
  windowForOwner?(owner: string): BrowserWindow;
  windowForSender?(senderId: number): BrowserWindow | undefined;
  enabled?(): boolean;
  language?(): string;
  readRoots(owner: string): string[];
  writeRoots?(owner: string): string[];
  registerRenderer(senderId: number, role: 'equity-research'): void;
  unregisterRenderer(senderId: number): void;
  emit(channel: string, payload: Json, windowId?: number): void;
  chooseExportPath?(name: string, format: string): Promise<string | undefined>;
  log?(event: string, data: Data): void;
}

/** Shared live equity-research and visual-effects workspaces driven by the isolated panel view and MCP tools. */
export class EquityResearchService {
  readonly store: EquityResearchStore;
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

  constructor(readonly options: EquityResearchOptions) {
    this.store = new EquityResearchStore(options.configRoot);
    this.mcp = new VisualCapabilityServer('klaus-equity', equityResearchTools, (owner, name, args) => this.call(owner, name, args), () => this.enabled());
    this.trackWindow(options.window);
    nativeTheme.on('updated', this.refreshLanguage);
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

  refreshLanguage = (): void => {
    const code = this.appLanguage();
    for (const editor of this.editors.values()) {
      if (!editor.ready || editor.failure || editor.view.webContents.isDestroyed()) continue;
      void editor.view.webContents
        .executeJavaScript(`window.__klausEquityResearchRuntime?.setLanguage?.(${JSON.stringify(code)}); window.__klausEquityResearchRuntime?.setTheme?.(${JSON.stringify(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')})`, true)
        .catch(() => {});
    }
  }

  tools(): Data[] {
    return equityResearchTools();
  }

  hostCapabilities(owner: string): Promise<Data> {
    return this.mcp.hostCapabilities(owner);
  }

  private assertEnabled(): void {
    if (!this.enabled()) throw new Error('Equity Research is disabled or has shut down.');
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
      throw new Error('Invalid equity-research panel bounds.');
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
      const validExts =
        expectedExt === 'lottie'
          ? ['json', 'lottie']
          : expectedExt === 'dotlottie'
            ? ['lottie']
            : expectedExt === 'aep'
              ? ['aep', 'aepx']
              : [expectedExt];
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
          reject(new Error('The equity-research studio is still initializing. Retry this operation once it finishes starting.'));
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
    this.log('equity-research-runtime-error', { id: editor.id, error });
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

  private async editor(project: EquityResearchProject, targetWindow?: BrowserWindow, bounds?: Electron.Rectangle): Promise<EditorView> {
    const win = targetWindow ?? this.hostWindow(project.sessionId);
    const current = this.editors.get(project.id);
    if (current) {
      this.assertEnabled();
      if (current.owner !== project.sessionId) throw new Error('The equity-research studio belongs to another chat.');
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

  private async createEditor(project: EquityResearchProject, targetWindow: BrowserWindow, bounds?: Electron.Rectangle): Promise<EditorView> {
    this.assertEnabled();
    let editor = this.editors.get(project.id);
    if (editor) {
      if (editor.owner !== project.sessionId) throw new Error('The equity-research studio belongs to another chat.');
      this.attachEditorToWindow(editor, targetWindow);
      await editor.loading;
      await this.waitUntilReady(editor);
      return editor;
    }
    if (this.editors.size >= 6) {
      const oldest = [...this.editors.values()]
        .filter(entry => !entry.view.getVisible() && entry.ready && !entry.failure)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!oldest) throw new Error('The equity-research workspace cache is busy. Finish the current operation and retry.');
      await oldest.queue;
      if (record(await oldest.view.webContents.executeJavaScript("window.__klausEquityResearchRuntime.invoke('workspace.inspect')")).dirty) throw new Error('Save edits before opening another workspace.');
      if (oldest.view.getVisible()) throw new Error('The equity-research studio became active while saving. Retry opening the other workspace.');
      await this.removeEditor(oldest);
    }
    const pluginRoot = this.options.pluginRoot();
    if (!pluginRoot) throw new Error('The equity-research plugin is not installed.');
    const root = realpathSync(join(pluginRoot, 'runtime', 'dist'));
    const manifest = record(JSON.parse(readBounded(join(root, 'runtime-manifest.json'))));
    if (
      manifest.bridgeVersion !== 1
      || typeof manifest.version !== 'string'
      || !Array.isArray(manifest.assets)
      || !manifest.assets.includes('index.html')
    ) {
      throw new Error('The equity-research runtime package is incomplete.');
    }
    const assets = new Set(manifest.assets.filter((asset): asset is string => typeof asset === 'string'));
    const partition = session.fromPartition(`equity-research-${randomUUID()}`, { cache: false });
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.protocol.handle(APP_SCHEME, async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== APP_HOST || url.username || url.password || url.port || !url.pathname.startsWith('/equity-research/')) {
          return new Response('Forbidden', { status: 403 });
        }
        const asset = decodeURIComponent(url.pathname.slice('/equity-research/'.length));
        if (!assets.has(asset)) return new Response('Not found', { status: 404 });
        const path = realpathSync(join(root, asset));
        if (!inside(root, path) || !lstatSync(path).isFile()) return new Response('Forbidden', { status: 403 });
        const response = await net.fetch(pathToFileURL(path).toString());
        const headers = new Headers(response.headers);
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
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
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
        preload: preloadFor('equity-research')!,
        additionalArguments: ['--klaus-role=equity-research'],
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
    this.options.registerRenderer(contents.id, 'equity-research');
    const url = `${APP_SCHEME}://${APP_HOST}/equity-research/index.html?${new URLSearchParams({ id: project.id })}`;
    contents.on('will-navigate', (event, destination) => {
      if (destination !== url) event.preventDefault();
    });
    contents.on('will-redirect', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('render-process-gone', (_event, details) => this.fail(entry, `The equity-research studio stopped: ${details.reason}.`));
    contents.once('destroyed', () => {
      this.options.unregisterRenderer(contents.id);
      this.fail(entry, 'The equity-research studio has closed.');
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

  private async request(project: EquityResearchProject, method: string, params: Data = {}): Promise<Data> {
    const editor = await this.editor(project);
    const next = editor.queue.then(async () => {
      this.assertEnabled();
      if (editor.view.webContents.isDestroyed()) throw new Error('The equity-research studio closed before the request.');
      const methodJson = JSON.stringify(method);
      const paramsJson = JSON.stringify(params);
      const value: unknown = await editor.view.webContents.executeJavaScript(
        `window.__klausEquityResearchRuntime.invoke(${methodJson}, ${paramsJson})`,
        true,
      );
      return value && typeof value === 'object' && !Array.isArray(value) ? record(value) : { ok: true, result: (value ?? null) as Json };
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
      error: `Version conflict: expected version ${expectedVersion}, but workspace is currently at version ${currentVersion}. Call equity_inspect to read the latest workspace state (including manual panel edits) and retry with expected_version: ${currentVersion}.`,
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }

  private async runEngineCli(command: string, input: Data, outputPath?: string): Promise<string> {
    const root = this.options.pluginRoot();
    if (!root) throw new Error('Equity research is not installed.');
    const path = join(this.store.root, `${randomUUID()}.input.json`);
    try {
      writeFileSync(path, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
      return (await promisify(execFile)(process.execPath, [join(root, 'engine', 'cli.cjs'), command, '--input', path, ...(outputPath ? ['--output', outputPath] : [])], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KLAUS_EQUITY_CACHE_DIR: join(this.store.root, 'cache') }, timeout: 90_000, maxBuffer: 32 * 1024 * 1024,
      })).stdout;
    } finally { rmSync(path, { force: true }); }
  }

  private async engineJson(command: string, input: Data): Promise<Data> {
    return record(JSON.parse(await this.runEngineCli(command, input)));
  }

  private artifactTitle(project: EquityResearchProject, doc: Data | null): string {
    const security = record(doc?.security), quote = record(doc?.quote), base = record(record(record(doc?.valuation).scenarios).base);
    const price = quote.price, target = base.targetPrice;
    if (security.secucode && security.name && typeof price === 'number' && typeof target === 'number' && price > 0) {
      const upside = (target / price - 1) * 100;
      return `${security.secucode} ${security.name} · ${Number(price.toFixed(2))} → ${Number(target.toFixed(2))} (${upside >= 0 ? '+' : ''}${upside.toFixed(1)}%)`;
    }
    return project.title;
  }

  private async exportFile(project: EquityResearchProject, doc: Data | null, format: string, path: string): Promise<Data> {
    if (!doc) throw new Error('The workspace has no document.');
    let bytes: Buffer;
    if (format === 'png') {
      const editor = await this.editor(project);
      await editor.view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      bytes = (await editor.view.webContents.capturePage()).toPNG();
    } else if (format === 'json') bytes = Buffer.from(JSON.stringify(doc, null, 2));
    else if (format === 'xlsx' || format === 'html') {
      const temp = join(this.store.root, `${randomUUID()}.${format}`);
      try { await this.runEngineCli(`export-${format}`, doc, temp); bytes = readFileSync(temp); }
      finally { rmSync(temp, { force: true }); }
    } else throw new Error('Unsupported equity research export format.');
    this.writeBinaryAtomic(path, bytes);
    return { id: project.id, version: project.version, format, path, bytes: bytes.length };
  }

  async call(owner: string, name: string, fields: Data): Promise<Data> {
    try {
      this.assertEnabled();
      const keys = EQUITY_RESEARCH_TOOL_FIELDS[name];
      if (!keys || Object.keys(fields).some(key => !keys.includes(key))) throw new Error('Unknown equity research tool or field.');
      const title = typeof fields.title === 'string' ? fields.title.trim() || undefined : undefined;
      let project = name === 'equity_open' ? this.store.open(owner, { id: fields.id, title }) : this.store.load(this.store.resolveId(owner, fields.id), owner);
      const id = project.id;
      let doc = this.store.readDocument(project);
      if (name === 'equity_inspect') {
        const live = this.editors.get(id)?.ready ? await this.request(project, 'workspace.inspect').catch(() => ({} as Data)) : {} as Data;
        const snapshot = live.document ? record(live.document) : doc;
        const { bars, ...compact } = snapshot ?? {};
        return this.success({ id, title: project.title, version: project.version, tab: live.tab ?? 'overview', dirty: live.dirty ?? false, document: snapshot ? fields.include_bars === true ? snapshot : { ...compact, barCount: Array.isArray(bars) ? bars.length : 0 } : null });
      }
      if (name === 'equity_open' || name === 'equity_publish') {
        const expected = name === 'equity_open' ? project.version : fields.expected_version;
        if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) throw new Error('Expected a non-negative safe expected_version.');
        if (expected !== project.version) return this.conflictFailure(id, expected, project.version);
        const overrides = { ...(fields.thesis === undefined ? {} : { thesis: fields.thesis }), ...(fields.valuation_overrides === undefined ? {} : { valuationOverrides: fields.valuation_overrides }) };
        const query = fields.ticker ?? fields.query;
        if (fields.document !== undefined) doc = record(fields.document);
        if (name === 'equity_open' && fields.document === undefined && query) {
          doc = await this.engineJson('build-workspace', { query: String(query), ...overrides, ...(Array.isArray(fields.peers) ? { peers: fields.peers } : {}) });
        } else if (name === 'equity_publish' || fields.document !== undefined) {
          if (doc?.schema !== 1) throw new Error('Expected a schema v1 workspace document.');
          if (Object.keys(overrides).length) doc = await this.engineJson('recompute-workspace', { document: doc, ...overrides });
        }
        if (doc && (name === 'equity_publish' || fields.document !== undefined || query)) {
          const security = record(doc.security);
          const save = this.store.saveDocument(id, owner, { expectedVersion: expected, document: doc, title: title ?? (name === 'equity_open' && security.secucode ? `${security.secucode} ${security.name ?? ''}`.trim() : undefined), summary: this.artifactTitle(project, doc) });
          if (save.conflict) return this.conflictFailure(id, expected, save.version);
          project = save.project;
        }
        await this.editor(project);
        if (doc) await this.request(project, 'workspace.load', { document: doc, version: project.version, ...(name === 'equity_open' ? { force: true } : {}) });
        if (fields.tab) await this.request(project, 'workspace.setTab', { tab: fields.tab });
        const panel = this.openPanel({ id, sessionId: owner });
        if (name === 'equity_open') await panel;
        else void panel.catch(error => this.log('equity-research-open', { error: message(error) }));
        return this.success({ id, title: project.title, version: project.version, security: doc?.security ?? null, quote: doc?.quote ?? null, valuation: doc?.valuation ?? null, thesis: doc?.thesis ?? null }, { kind: 'equity-research', id, title: this.artifactTitle(project, doc), ready: doc !== null });
      }
      const format = name === 'equity_preview' ? 'png' : String(fields.format);
      if (!['png', 'json', 'xlsx', 'html'].includes(format)) throw new Error('Unsupported equity research export format.');
      if (name === 'equity_preview' && fields.tab) await this.request(project, 'workspace.setTab', { tab: fields.tab });
      const path = this.resolveOutputPath(owner, fields.output_path, join(this.store.root, id, `${name}-${randomUUID()}.${format}`), format);
      return this.success({ ...await this.exportFile(project, doc, format, path), ...(name === 'equity_preview' ? { tab: fields.tab ?? 'overview' } : {}) });
    } catch (error) {
      const payload = { error: message(error) };
      return { isError: true, ...this.success(payload) };
    }
  }

  private async runtimeAction(editor: EditorView, fields: Data): Promise<Data> {
    if (this.closed) throw new Error('The equity research service is closed.');
    const { id, owner } = editor;
    switch (fields.type) {
      case 'ready':
        if (fields.bridgeVersion !== 1 || fields.version !== editor.runtimeVersion) throw new Error('The equity research runtime does not match the host package.');
        editor.ready = true;
        for (const wait of editor.waits) { clearTimeout(wait.timer); wait.resolve(); }
        editor.waits.clear();
        this.refreshLanguage();
        return { ok: true };
      case 'error': this.fail(editor, String(fields.error ?? 'Equity research failed to start.')); return { ok: true };
      case 'load': return this.store.runtimeLoad(id, owner);
      case 'save': {
        const result = this.store.saveDocument(id, owner, { expectedVersion: Number(fields.expectedVersion), document: record(fields.document), summary: typeof fields.summary === 'string' ? fields.summary : undefined });
        return result.conflict
          ? { ok: false, conflict: true, version: result.version, current: result.current }
          : { ok: true, version: result.version };
      }
      case 'refresh': {
        const current = this.store.runtimeLoad(id, owner);
        if (!current.document) throw new Error('The workspace has no document.');
        const document = await this.engineJson('refresh-workspace', current.document);
        const result = this.store.saveDocument(id, owner, { expectedVersion: current.version, document });
        return result.conflict ? result.current : { document, version: result.version };
      }
      case 'export': {
        const format = String(fields.format);
        if (!['png', 'json', 'xlsx', 'html'].includes(format)) throw new Error('Unsupported equity research export format.');
        const project = this.store.load(id, owner);
        const { filePath } = await dialog.showSaveDialog(editor.window, { defaultPath: `equity-research.${format}` });
        return filePath ? { ok: true, ...await this.exportFile(project, this.store.readDocument(project), format, filePath) } : { canceled: true };
      }
      case 'open-url': {
        const url = new URL(text(fields.url, 'external URL'));
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS web links can be opened.');
        await shell.openExternal(url.href);
        return { ok: true };
      }
      default: throw new Error('Unknown equity research runtime action.');
    }
  }

  private async present(win: BrowserWindow, fields: Data): Promise<Data> {
    const owner = text(fields.sessionId, 'equity-research session');
    const project = this.store.load(fields.id, owner);
    const bounds = this.rectangle(win, fields.bounds);
    const winId = win.webContents.id;
    const revision = (this.revisionByWindow.get(winId) ?? 0) + 1;
    this.revisionByWindow.set(winId, revision);
    const editor = await this.editor(project, win, bounds);
    if (this.revisionByWindow.get(winId) !== revision || this.closed || win.isDestroyed()) {
      return { ok: false, error: 'The equity-research presentation request is stale.' };
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
      this.log('equity-research-recover', { id: editor.id });
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
    const active = activeId ? this.editors.get(activeId) : undefined;
    if (active) {
      active.view.setVisible(false);
    }
    return { ok: true };
  }

  private async hideWindowWithSnapshot(winId: number): Promise<Data> {
    const revision = (this.revisionByWindow.get(winId) ?? 0) + 1;
    this.revisionByWindow.set(winId, revision);
    const activeId = this.activeByWindow.get(winId);
    const active = activeId ? this.editors.get(activeId) : undefined;
    if (active && canCaptureNativeViewSnapshot(active.view)) {
      const snapshotDataUrl = await captureNativeViewSnapshot(active.view);
      if (this.revisionByWindow.get(winId) === revision && this.activeByWindow.get(winId) === activeId) {
        active.view.setVisible(false);
      }
      return snapshotDataUrl ? { ok: true, snapshotDataUrl } : { ok: true };
    }
    active?.view.setVisible(false);
    return { ok: true };
  }

  private async openPanel(fields: Data, explicitWindow?: BrowserWindow): Promise<Data> {
    const owner = text(fields.sessionId, 'equity-research session');
    const project = this.store.load(fields.id, owner);
    const targetWindow = explicitWindow ?? this.hostWindow(owner);
    const windowId = targetWindow.webContents.id;
    const requestId = randomUUID();
    const result = new Promise<Data>(resolve => {
      const timer = setTimeout(() => {
        this.openRequests.delete(requestId);
        resolve({ ok: false, error: 'The equity-research panel did not acknowledge the open request.' });
      }, 60_000);
      this.openRequests.set(requestId, { windowId, resolve, timer });
    });
    this.options.emit('equity-research:open-panel', { requestId, id: project.id, title: project.title, sessionId: owner }, windowId);
    return result;
  }

  async invoke(context: HandlerContext): Promise<Data> {
    const fields = record(context.args[0]);
    if (context.role === 'equity-research' && context.channel === 'equity-research:runtime-action') {
      const editor = [...this.editors.values()].find(
        entry => entry.view.webContents.id === context.senderId && !entry.view.webContents.isDestroyed(),
      );
      if (!editor) throw new Error('This equity-research studio is no longer active.');
      return this.runtimeAction(editor, record(fields.action));
    }
    this.assertEnabled();
    const senderWin = context.role === 'main' ? this.senderWindow(context.senderId) : undefined;
    if (!senderWin) throw new Error('Equity Research belongs to another window.');
    const winId = senderWin.webContents.id;
    switch (context.channel) {
      case 'equity-research:list':
        return {
          equityWorkspaces: this.store
            .list(text(fields.sessionId, 'equity-research session'))
            .map(project => ({ id: project.id, title: project.title })) as unknown as Json,
        };
      case 'equity-research:open':
        return this.openPanel(fields, senderWin);
      case 'equity-research:open-result': {
        const requestId = text(fields.requestId, 'request id');
        const request = this.openRequests.get(requestId);
        if (!request || request.windowId !== winId) return { ok: false, error: 'The open request expired.' };
        clearTimeout(request.timer);
        this.openRequests.delete(requestId);
        request.resolve(fields.ok === true ? { ok: true } : { ok: false, error: fields.error ?? 'The equity-research panel could not open.' });
        return { ok: true };
      }
      case 'equity-research:panel-show':
        return this.present(senderWin, fields);
      case 'equity-research:panel-set-bounds':
        this.boundsByWindow.set(winId, record(fields.bounds));
        this.resizeWindow(winId);
        return { ok: true };
      case 'equity-research:panel-hide':
        return this.hideWindowWithSnapshot(winId);
      case 'equity-research:panel-close':
        this.hideWindow(winId);
        this.activeByWindow.delete(winId);
        this.boundsByWindow.delete(winId);
        return { ok: true };
      default:
        throw new Error(`Unknown equity-research channel: ${context.channel}`);
    }
  }

  releaseSession(owner: string): void {
    this.mcp.releaseSession(owner);
    for (const editor of this.editors.values()) if (editor.owner === owner) void this.removeEditor(editor).catch(error => this.log('equity-research-release', { error: message(error) }));
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.prepareToClose();
    if (this.closed) return;
    this.closed = true;
    nativeTheme.removeListener('updated', this.refreshLanguage);
    for (const { window: win, onResize } of this.trackedWindows.values()) {
      if (!win.isDestroyed()) {
        win.removeListener('resize', onResize);
        win.webContents.removeListener('zoom-changed', onResize);
      }
    }
    this.trackedWindows.clear();
    for (const request of this.openRequests.values()) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error: 'The equity-research service closed.' });
    }
    this.openRequests.clear();
    for (const editor of [...this.editors.values()]) {
      this.fail(editor, 'The equity-research service closed.');
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
      for (const editor of this.editors.values()) {
        await editor.queue;
        if (editor.ready && !editor.view.webContents.isDestroyed() && record(await editor.view.webContents.executeJavaScript("window.__klausEquityResearchRuntime.invoke('workspace.inspect')")).dirty) throw new Error('Save equity research edits before closing.');
      }
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
