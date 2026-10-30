import { app, BrowserWindow, dialog, net, session, shell, WebContentsView } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_HOST, APP_SCHEME } from '../app/protocol';
import { preloadFor } from '../app/windows';
import type { HandlerContext } from '../ipc/registry';
import type { Json } from '../ipc/contract';
import { VisualCapabilityServer } from '../visuals/capability-server';
import { inside, message, readBounded, record, text, type Data } from '../visuals/data';
import { VideoEditingStore, type VideoEditingProject } from './store';
import { VideoEditingRuntime } from './runtime';
import { videoEditingTools } from './tools';

interface Editor {
  id: string;
  owner: string;
  view: WebContentsView;
  runtime: VideoEditingRuntime;
  info: Data;
  version: string;
  ready: boolean;
  failure?: string;
  loading: Promise<void>;
  queue: Promise<unknown>;
  lastUsed: number;
  waits: Set<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
}
export interface VideoEditingOptions {
  configRoot: string;
  window: BrowserWindow;
  pluginRoot(): string | undefined;
  enabled?(): boolean;
  registerRenderer(id: number, role: 'video-editing'): void;
  unregisterRenderer(id: number): void;
  emit(channel: string, payload: Json): void;
  log?(event: string, data: Data): void;
}

/** A complete native editor instance is shared by the work panel and agent tools. */
export class VideoEditingService {
  readonly store: VideoEditingStore;
  private readonly mcp: VisualCapabilityServer;
  private readonly editors = new Map<string, Editor>();
  private readonly openRequests = new Map<string, { resolve(value: Data): void; timer: ReturnType<typeof setTimeout> }>();
  private activeId = '';
  private bounds: Data | undefined;
  private presentation = 0;
  private allocation: Promise<unknown> = Promise.resolve();
  private quiescing = false;
  private closed = false;
  private closePreparation: Promise<void> | undefined;
  private restoreAfterClose: (() => void) | undefined;

  constructor(readonly options: VideoEditingOptions) {
    this.store = new VideoEditingStore(options.configRoot);
    this.mcp = new VisualCapabilityServer('klaus-video-editing', videoEditingTools,
      (owner, name, args) => this.call(owner, name, args), () => this.enabled());
    options.window.on('resize', this.resize);
    options.window.webContents.on('zoom-changed', this.resize);
  }
  private enabled(): boolean { return !this.closed && !this.quiescing && (this.options.enabled?.() ?? true); }
  private assertEnabled(): void { if (!this.enabled()) throw new Error('Video editing is disabled or has shut down.'); }
  hostCapabilities(owner: string): Promise<Data> { return this.mcp.hostCapabilities(owner); }
  private rectangle(value: unknown): Electron.Rectangle {
    const b = record(value);
    if (['x', 'y', 'width', 'height'].some(key => typeof b[key] !== 'number' || !Number.isFinite(b[key])) || Number(b.width) <= 0 || Number(b.height) <= 0) throw new Error('Invalid video editor panel bounds.');
    const zoom = this.options.window.webContents.getZoomFactor();
    const [width, height] = this.options.window.getContentSize();
    const x = Math.max(0, Math.min(width! - 1, Math.round(Number(b.x) * zoom)));
    const y = Math.max(0, Math.min(height! - 1, Math.round(Number(b.y) * zoom)));
    return { x, y, width: Math.max(1, Math.min(width! - x, Math.round(Number(b.width) * zoom))), height: Math.max(1, Math.min(height! - y, Math.round(Number(b.height) * zoom))) };
  }
  private readonly resize = (): void => {
    if (this.closed || !this.activeId || !this.bounds || this.options.window.isDestroyed()) return;
    this.editors.get(this.activeId)?.view.setBounds(this.rectangle(this.bounds));
  };
  private fail(editor: Editor, error: string): void {
    editor.failure = error;
    for (const wait of editor.waits) { clearTimeout(wait.timer); wait.reject(new Error(error)); }
    editor.waits.clear();
    this.options.log?.('video-editor-error', { id: editor.id, error });
  }
  private ready(editor: Editor): Promise<void> {
    if (editor.failure) return Promise.reject(new Error(editor.failure));
    if (editor.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wait = { resolve, reject, timer: setTimeout(() => {
        editor.waits.delete(wait);
        reject(new Error('The video editor is still initializing. Its existing instance was kept.'));
      }, 60_000) };
      editor.waits.add(wait);
    });
  }
  private async remove(editor: Editor): Promise<void> {
    await editor.runtime.close();
    const partition = editor.view.webContents.session;
    if (!this.options.window.isDestroyed()) this.options.window.contentView.removeChildView(editor.view);
    if (!editor.view.webContents.isDestroyed()) editor.view.webContents.close({ waitForBeforeUnload: false });
    partition.protocol.unhandle(APP_SCHEME);
    await partition.closeAllConnections();
    this.editors.delete(editor.id);
    if (this.activeId === editor.id) this.activeId = '';
  }
  private async editor(project: VideoEditingProject, bounds?: Electron.Rectangle): Promise<Editor> {
    const existing = this.editors.get(project.id);
    if (existing) {
      if (existing.owner !== project.sessionId) throw new Error('The video editor belongs to another chat.');
      existing.lastUsed = Date.now();
      await existing.loading;
      await this.ready(existing);
      return existing;
    }
    const next = this.allocation.then(() => this.createEditor(project, bounds));
    this.allocation = next.then(() => undefined, () => undefined);
    return next;
  }
  private async createEditor(project: VideoEditingProject, bounds?: Electron.Rectangle): Promise<Editor> {
    this.assertEnabled();
    const current = this.editors.get(project.id);
    if (current) { await current.loading; await this.ready(current); return current; }
    if (this.editors.size >= 3) {
      const oldest = [...this.editors.values()].filter(e => !e.view.getVisible() && e.ready && !e.failure).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) throw new Error('The video editor cache is busy. Finish opening the current workspace and retry.');
      await this.flushEditor(oldest);
      if (oldest.view.getVisible()) throw new Error('The video workspace became visible while saving.');
      await this.remove(oldest);
    }
    const plugin = this.options.pluginRoot();
    if (!plugin) throw new Error('The video editing plugin is not installed.');
    const root = realpathSync(join(plugin, 'runtime', 'dist'));
    const manifest = record(JSON.parse(readBounded(join(root, 'runtime-manifest.json'))));
    const files = record(manifest.files);
    if (manifest.bridgeVersion !== 1 || typeof manifest.version !== 'string' || typeof files['index.html'] !== 'string' || typeof files['wrapper.js'] !== 'string') throw new Error('The native video editor runtime package is incomplete.');
    const assets = new Set(Object.keys(files));
    const runtime = new VideoEditingRuntime(plugin, join(this.store.directory(project.id), 'runtime'));
    let info: Data;
    try { info = await runtime.request('start', { path: project.path, title: project.title }); }
    catch (error) { await runtime.close().catch(() => {}); throw error; }
    const origin = new URL(text(info.origin, 'video runtime origin'));
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') { await runtime.close(); throw new Error('The video runtime must listen on this computer.'); }
    const partition = session.fromPartition(`video-editing-${randomUUID()}`, { cache: false });
    partition.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'fullscreen' && requestingOrigin === origin.origin);
    partition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
    partition.protocol.handle(APP_SCHEME, async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== APP_HOST || url.username || url.password || url.port || !url.pathname.startsWith('/video-editing/')) return new Response('Forbidden', { status: 403 });
        const asset = decodeURIComponent(url.pathname.slice('/video-editing/'.length));
        if (!assets.has(asset)) return new Response('Not found', { status: 404 });
        const path = realpathSync(join(root, asset));
        if (!inside(root, path) || !lstatSync(path).isFile()) return new Response('Forbidden', { status: 403 });
        if (createHash('sha256').update(readFileSync(path)).digest('hex') !== files[asset]) return new Response('Video runtime integrity check failed', { status: 409 });
        const response = await net.fetch(pathToFileURL(path).toString());
        const headers = new Headers(response.headers);
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(path)];
        if (mime) headers.set('Content-Type', mime);
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Content-Security-Policy', `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src ${origin.origin}; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`);
        return new Response(response.body, { status: response.status, headers });
      } catch { return new Response('Video editor asset not found', { status: 404 }); }
    });
    const view = new WebContentsView({ webPreferences: {
      session: partition, preload: preloadFor('video-editing')!, additionalArguments: ['--klaus-role=video-editing'],
      devTools: !app.isPackaged, contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webviewTag: false, backgroundThrottling: false,
    } });
    const editor: Editor = { id: project.id, owner: project.sessionId, view, runtime, info, version: String(manifest.version),
      ready: false, loading: Promise.resolve(), queue: Promise.resolve(), lastUsed: Date.now(), waits: new Set() };
    this.editors.set(project.id, editor);
    const contents = view.webContents;
    this.options.registerRenderer(contents.id, 'video-editing');
    const url = `${APP_SCHEME}://${APP_HOST}/video-editing/index.html?${new URLSearchParams({ id: project.id })}`;
    contents.on('will-navigate', (event, to) => { if (to !== url) event.preventDefault(); });
    contents.on('will-redirect', event => {
      // The original Studio exchanges its launch capability for a cookie and redirects its iframe.
      if (event.isMainFrame) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('render-process-gone', (_event, details) => this.fail(editor, `The video editor stopped: ${details.reason}. Its project was preserved.`));
    contents.once('destroyed', () => {
      this.options.unregisterRenderer(contents.id);
      this.fail(editor, 'The video editor has closed.');
    });
    view.setBounds(bounds ?? { x: 0, y: 0, width: 1440, height: 1000 });
    view.setVisible(false);
    this.options.window.contentView.addChildView(view);
    editor.loading = contents.loadURL(url).catch(error => { this.fail(editor, message(error)); throw error; });
    try {
      await editor.loading;
      await this.ready(editor);
      return editor;
    } catch (error) {
      // The view stays hidden until readiness; a failed first load has no manual edits.
      if (!editor.ready) {
        try { await this.remove(editor); }
        catch (cleanup) { this.options.log?.('video-editor-cleanup-error', { id: editor.id, error: message(cleanup) }); }
      }
      throw error;
    }
  }
  private async request(project: VideoEditingProject, method: string, params: Data = {}): Promise<Data> {
    const editor = await this.editor(project);
    const next = editor.queue.then(async () => {
      this.assertEnabled();
      if (editor.view.webContents.isDestroyed()) throw new Error('The video editor closed before the operation.');
      const value: unknown = await editor.view.webContents.executeJavaScript(`window.klausVideo.request(${JSON.stringify({ method, params })})`, true);
      const reply = record(value);
      if (reply.ok === false) throw new Error(String(reply.error ?? 'The video editor operation failed.'));
      return reply;
    });
    editor.queue = next.then(() => undefined, () => undefined);
    return next;
  }
  private success(value: Data, artifact?: Data): Data {
    const payload = artifact ? { ...value, artifact } : value;
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
  async call(owner: string, name: string, fields: Data): Promise<Data> {
    try {
      this.assertEnabled(); text(owner, 'video editing session');
      if (name === 'video_editing_docs') return this.success(this.docs(fields));
      if (name === 'video_editing_open') {
        const project = this.store.open(owner, fields);
        const failed = this.editors.get(project.id);
        if (fields.recover === true && failed?.failure && failed.ready) {
          await failed.runtime.request('prepare');
          failed.ready = false; failed.failure = undefined;
          failed.loading = failed.view.webContents.loadURL(failed.view.webContents.getURL());
          await failed.loading;
          await this.ready(failed);
        }
        const state = await this.request(project, 'workspace.inspect');
        void this.openPanel({ id: project.id, sessionId: owner }).catch(() => {});
        return this.success({ id: project.id, title: project.title, ...state }, { kind: 'video-editing', id: project.id, title: project.title });
      }
      const id = this.store.resolveId(owner, fields.id), project = this.store.load(id, owner);
      if (name === 'video_editing_inspect') return this.success({ id, ...await this.request(project, 'workspace.inspect') });
      if (name === 'video_editing_execute') {
        if (typeof fields.expected_revision !== 'string' || !Array.isArray(fields.ops) || !fields.ops.length) throw new Error('Read the current video revision and provide original timeline operations.');
        return this.success({ id, ...await this.request(project, 'timeline.execute', { expected_revision: fields.expected_revision, ops: fields.ops, label: fields.label ?? 'Edit video' }) });
      }
      if (name === 'video_editing_editor') {
        if (fields.target !== 'player' && fields.target !== 'stage') throw new Error('Choose player or stage.');
        return this.success({ id, ...await this.request(project, `${fields.target}.command`, record(fields.command)) });
      }
      const input = { ...fields }; delete input.id; delete input.expected_revision;
      if (name === 'video_editing_request') return this.success({ id, ...await this.request(project, 'workspace.request', { input, ...(fields.expected_revision !== undefined ? { expected_revision: fields.expected_revision } : {}) }) });
      if (name === 'video_editing_project_file') {
        if (fields.action === 'write' && typeof fields.expected_revision !== 'string') throw new Error('Read the live video revision before writing source files.');
        return this.success({ id, ...await this.request(project, 'workspace.file', { input, ...(fields.expected_revision !== undefined ? { expected_revision: fields.expected_revision } : {}) }) });
      }
      if (name === 'video_editing_command') return this.success({ id, ...await this.request(project, 'workspace.command', { input }) });
      const editor = this.editors.get(project.id) ?? await this.editor(project);
      if (editor.owner !== owner) throw new Error('The video runtime belongs to another chat.');
      if (name === 'video_editing_job') {
        const job: Data = { ...input, ...(input.job !== undefined ? { id: input.job } : {}) }; delete job.job;
        return this.success({ id, ...await editor.runtime.request('job', job) });
      }
      if (name === 'video_editing_status') return this.success({ id, ...await editor.runtime.request('status') });
      if (name === 'video_editing_setup') return this.success({ id, ...await editor.runtime.request('setup') });
      throw new Error(`Unknown video editing tool: ${name}`);
    } catch (error) { return { isError: true, content: [{ type: 'text', text: message(error) }] }; }
  }
  private docs(fields: Data): Data {
    const plugin = this.options.pluginRoot();
    if (!plugin) throw new Error('The video editing plugin is not installed.');
    const topic = String(fields.topic ?? 'manual');
    const root = realpathSync(topic === 'api' ? join(plugin, 'skills', 'video-editing', 'references') : join(plugin, 'runtime', 'node_modules', 'openfilm'));
    const file = topic === 'manual' ? 'MANUAL.md' : topic === 'spec' ? 'SPEC.md' : topic === 'api' ? 'api.md' : text(fields.file, 'source file');
    if (isAbsolute(file)) throw new Error('Use a package-relative source path.');
    const path = realpathSync(join(root, file));
    if (!inside(root, path)) throw new Error('Source is outside the video runtime.');
    const value = readFileSync(path, 'utf8'), offset = Number(fields.offset ?? 0), limit = Number(fields.limit ?? 24000);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 65536) throw new Error('Invalid source read offset or limit.');
    return { source: file, text: value.slice(offset, offset + limit), nextOffset: Math.min(value.length, offset + limit), truncated: offset + limit < value.length };
  }
  private hide(): Data {
    this.presentation++;
    this.editors.get(this.activeId)?.view.setVisible(false);
    return { ok: true };
  }
  private async present(fields: Data): Promise<Data> {
    const project = this.store.load(fields.id, text(fields.sessionId, 'video editing session'));
    const bounds = this.rectangle(fields.bounds), revision = ++this.presentation;
    // The panel's rectangle is known before the page loads: laying the view out at its real size lets the
    // embedded studio measure its stage on mount instead of starting from a placeholder that never re-measures.
    const editor = await this.editor(project, bounds);
    if (this.closed || revision !== this.presentation) return { ok: false, error: 'The video presentation request is stale.' };
    for (const other of this.editors.values()) other.view.setVisible(false);
    this.activeId = project.id; this.bounds = record(fields.bounds);
    this.options.window.contentView.removeChildView(editor.view);
    this.options.window.contentView.addChildView(editor.view);
    editor.view.setBounds(bounds); editor.view.setVisible(true);
    this.nudge(editor);
    this.verify(editor, revision);
    return { ok: true };
  }
  /**
   * The embedded studio keeps its own connection to its local server. A page that was hidden while the
   * window sat behind another app can come back with that connection ended for good, and nothing above it
   * notices: this asks the page for one round trip after every show and reloads it once when it cannot answer.
   */
  private verify(editor: Editor, revision: number): void {
    setTimeout(() => {
      const contents = editor.view.webContents;
      if (this.closed || revision !== this.presentation || this.activeId !== editor.id || contents.isDestroyed()) return;
      const probe = `Promise.race([
        window.klausVideo.request({ method: 'workspace.inspect' }).then(() => true, () => false),
        new Promise((done) => setTimeout(() => done(false), 4000))
      ])`;
      void contents.executeJavaScript(probe, true).then(async alive => {
        if (alive === true) return;
        if (this.closed || revision !== this.presentation || this.activeId !== editor.id || contents.isDestroyed()) return;
        this.options.log?.('video-editor-recover', { id: editor.id });
        try { await contents.executeJavaScript('window.klausVideo.flush()', true); } catch { /* the page is gone; the saved copy stands */ }
        try { await this.restartWorkspace(editor); } catch (error) { this.fail(editor, message(error)); return; }
        if (this.closed || contents.isDestroyed()) return;
        editor.ready = false; editor.failure = undefined;
        editor.loading = contents.loadURL(contents.getURL()).catch(error => { this.fail(editor, message(error)); throw error; });
        try { await editor.loading; await this.ready(editor); } catch { /* surfaced through editor.failure and the next operation */ }
      }).catch(() => {});
    }, 700);
  }
  /**
   * The workspace process belongs to this desktop and can go away under it. Starting it again is
   * idempotent: an editor that is still up answers with the address it already has, and one whose
   * process died comes back on a new address, which the reloaded view then loads.
   */
  private async restartWorkspace(editor: Editor): Promise<void> {
    const project = this.store.load(editor.id, editor.owner);
    const info = await editor.runtime.request('start', { path: project.path, title: project.title }, 60_000);
    const origin = String(info.origin ?? '');
    if (!origin || origin === editor.info.origin) return;
    editor.info = { ...editor.info, ...info };
    this.options.log?.('video-runtime-restart', { id: editor.id, origin });
  }
  /** One invisible layout pass after a show: the embedded studio measures its stage as the page mounts, and a view that loaded while hidden measured nothing there. */
  private nudge(editor: Editor): void {
    if (this.closed || !this.bounds || editor.view.webContents.isDestroyed()) return;
    const bounds = this.rectangle(this.bounds);
    try {
      editor.view.setBounds({ ...bounds, width: Math.max(1, bounds.width - 1) });
      setTimeout(() => {
        if (this.closed || this.activeId !== editor.id || editor.view.webContents.isDestroyed() || !this.bounds) return;
        try { editor.view.setBounds(this.rectangle(this.bounds)); } catch { /* the panel moved meanwhile; the next sync bounds it */ }
      }, 40);
    } catch { /* the panel moved meanwhile; the next sync bounds it */ }
  }
  private async openPanel(fields: Data): Promise<Data> {
    const project = this.store.load(fields.id, text(fields.sessionId, 'video editing session'));
    const requestId = randomUUID();
    const promise = new Promise<Data>(resolve => {
      const timer = setTimeout(() => { this.openRequests.delete(requestId); resolve({ ok: false, error: 'The video panel did not acknowledge the open request.' }); }, 60_000);
      this.openRequests.set(requestId, { resolve, timer });
    });
    this.options.emit('video-editing:open-panel', { requestId, id: project.id, title: project.title, sessionId: project.sessionId });
    return promise;
  }
  private async action(editor: Editor, action: Data): Promise<Data> {
    if (this.closed) throw new Error('The video service has closed.');
    if (action.type === 'load') return { ...editor.info, version: editor.version, bridgeVersion: 1 };
    if (action.type === 'ready') {
      if (action.bridgeVersion !== 1 || action.version !== editor.version) throw new Error('The video editor runtime does not match this host.');
      editor.ready = true;
      for (const wait of editor.waits) { clearTimeout(wait.timer); wait.resolve(); }
      editor.waits.clear(); return { ok: true };
    }
    if (action.type === 'error') { this.fail(editor, String(action.error ?? 'The video editor could not initialize.')); return { ok: true }; }
    if (action.type === 'changed') {
      const project = this.store.changed(editor.id, editor.owner, record(action.project));
      editor.info.project = record(action.project);
      return { ok: true, title: project.title };
    }
    if (action.type === 'runtime') {
      const method = text(action.method, 'video runtime operation');
      if (!['api', 'file', 'command', 'job', 'status', 'setup'].includes(method)) throw new Error('This editor runtime operation is not allowed.');
      return editor.runtime.request(method, record(action.params), 600_000);
    }
    if (action.type === 'pick-folder') {
      const result = await dialog.showOpenDialog(this.options.window, { title: typeof action.title === 'string' ? action.title : undefined, properties: ['openDirectory', 'createDirectory'] });
      return { path: result.canceled ? null : result.filePaths[0] ?? null };
    }
    if (action.type === 'open-url') {
      const url = new URL(text(action.url, 'external URL'));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public web links can be opened.');
      await shell.openExternal(url.href); return { ok: true };
    }
    throw new Error('Unknown video editor runtime action.');
  }
  async invoke(context: HandlerContext): Promise<Data> {
    const fields = record(context.args[0]);
    if (context.role === 'video-editing' && context.channel === 'video-editing:runtime-action') {
      const editor = [...this.editors.values()].find(e => e.view.webContents.id === context.senderId && !e.view.webContents.isDestroyed());
      if (!editor) throw new Error('This video editor is no longer active.');
      return this.action(editor, record(fields.action));
    }
    this.assertEnabled();
    if (context.role !== 'main' || context.senderId !== this.options.window.webContents.id) throw new Error('Video editing belongs to another window.');
    switch (context.channel) {
      case 'video-editing:list': return { videos: this.store.list(text(fields.sessionId, 'video editing session')).map(p => ({ id: p.id, title: p.title })) };
      case 'video-editing:open': return this.openPanel(fields);
      case 'video-editing:open-result': {
        const request = this.openRequests.get(text(fields.requestId, 'request id'));
        if (!request) return { ok: false, error: 'The video open request expired.' };
        clearTimeout(request.timer); this.openRequests.delete(String(fields.requestId));
        request.resolve(fields.ok === true ? { ok: true } : { ok: false, error: fields.error ?? 'The video panel could not open.' });
        return { ok: true };
      }
      case 'video-editing:panel-show': return this.present(fields);
      case 'video-editing:panel-set-bounds': this.bounds = record(fields.bounds); this.resize(); return { ok: true };
      case 'video-editing:panel-hide': return this.hide();
      case 'video-editing:panel-close': {
        const editor = this.editors.get(this.activeId);
        if (editor) await this.flushEditor(editor);
        this.hide(); this.activeId = ''; this.bounds = undefined;
        return { ok: true };
      }
      default: throw new Error(`Unknown video editing channel: ${context.channel}`);
    }
  }
  releaseSession(owner: string): void { this.mcp.releaseSession(owner); this.store.releaseSession(owner); }
  private async flushEditor(editor: Editor): Promise<void> {
    if (editor.view.webContents.isDestroyed() || !editor.ready) {
      if (editor.failure) throw new Error(editor.failure);
      return;
    }
    await editor.queue;
    const value: unknown = await editor.view.webContents.executeJavaScript('window.klausVideo.flush()', true);
    const reply = record(value);
    if (reply.ok === false) throw new Error(String(reply.error ?? 'The video still has unsaved edits.'));
    await editor.runtime.request('prepare');
  }
  prepareToClose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePreparation) return this.closePreparation;
    const active = this.editors.get(this.activeId), visible = active?.view.getVisible() ?? false;
    this.restoreAfterClose = () => {
      if (visible && active && !active.view.webContents.isDestroyed()) { active.view.setVisible(true); this.nudge(active); }
    };
    this.quiescing = true; this.hide();
    this.closePreparation = (async () => {
      await this.allocation;
      for (const editor of this.editors.values()) await this.flushEditor(editor);
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
    this.restoreAfterClose?.();
    this.restoreAfterClose = undefined;
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.prepareToClose();
    this.closed = true;
    this.options.window.removeListener('resize', this.resize);
    this.options.window.webContents.removeListener('zoom-changed', this.resize);
    for (const request of this.openRequests.values()) { clearTimeout(request.timer); request.resolve({ ok: false, error: 'The video service closed.' }); }
    this.openRequests.clear();
    for (const editor of this.editors.values()) await this.remove(editor);
    await this.mcp.shutdown();
  }
}
