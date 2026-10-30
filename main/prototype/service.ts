import { app, BrowserWindow, dialog, net, session, shell, WebContentsView, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_HOST, APP_SCHEME } from '../app/protocol';
import { preloadFor } from '../app/windows';
import type { HandlerContext } from '../ipc/registry';
import type { Json } from '../ipc/contract';
import { VisualCapabilityServer } from '../visuals/capability-server';
import { inside, message, readBounded, record, text, type Data } from '../visuals/data';
import { PrototypeStore, type PrototypeProject } from './store';
import { prototypeTools } from './tools';
import { planLegacyPrototypeImport, type LegacyImportPlan } from './legacy';

/**
 * Whether an inspect snapshot already holds drawn content: any page with child
 * nodes. The open-time artifact card uses it to tell "a workspace exists" from
 * "a prototype exists", so an empty design never claims to be finished.
 */
function designHasContent(state: Data): boolean {
  const pages = record(record(state).result).pages;
  return Array.isArray(pages) && pages.some(page => {
    const children = record(page).children;
    return Array.isArray(children) && children.length > 0;
  });
}

/** Whether a batch result created at least one node: result entries carry node ids. */
function batchCreatedNodes(response: Data): boolean {
  const results = record(record(response).result).results;
  return Array.isArray(results) && results.some(entry => typeof record(entry).id === 'number');
}

/**
 * The accepted parameter names per tool, so a misspelled or hallucinated field
 * is refused with the supported list instead of being silently ignored. Silent
 * acceptance let a caller believe a filter was applied when nothing read it.
 */
const PROTOTYPE_TOOL_FIELDS: Record<string, readonly string[]> = {
  prototype_open: ['id', 'title', 'legacy_canvas'],
  prototype_inspect: ['id', 'node_id', 'depth', 'all_pages'],
  prototype_commands: ['id', 'query', 'limit'],
  prototype_execute: ['id', 'expected_revision', 'label', 'commands'],
  prototype_export: ['id', 'format', 'ids', 'scale'],
};

interface ReadyWait { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface EditorView {
  id: string;
  owner: string;
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
export interface PrototypeOptions {
  configRoot: string;
  window: BrowserWindow;
  pluginRoot(): string | undefined;
  enabled?(): boolean;
  /** The application's language choice; the isolated editor UI follows it. */
  language?(): string;
  registerRenderer(senderId: number, role: 'prototype'): void;
  unregisterRenderer(senderId: number): void;
  emit(channel: string, payload: Json): void;
  chooseExportPath?(name: string, format: string): Promise<string | undefined>;
  log?(event: string, data: Data): void;
  readLegacy?(path: string): unknown;
}

/** The work panel and MCP tools address the same isolated editor instance. */
export class PrototypeService {
  readonly store: PrototypeStore;
  private readonly mcp: VisualCapabilityServer;
  private readonly editors = new Map<string, EditorView>();
  private readonly openRequests = new Map<string, { resolve(result: Data): void; timer: ReturnType<typeof setTimeout> }>();
  private activeId = '';
  private bounds: Data | undefined;
  private presentationRevision = 0;
  private closed = false;
  private quiescing = false;
  private closePreparation: Promise<void> | undefined;
  private restoreAfterClose: (() => void) | undefined;
  private allocation: Promise<unknown> = Promise.resolve();
  private readonly importing = new Set<string>();
  constructor(readonly options: PrototypeOptions) {
    this.store = new PrototypeStore(options.configRoot, error => this.log('prototype-retention-warning', { error }));
    this.mcp = new VisualCapabilityServer('klaus-prototype', prototypeTools, (owner, name, args) => this.call(owner, name, args), () => this.enabled());
    options.window.on('resize', this.resize);
    options.window.webContents.on('zoom-changed', this.resize);
  }
  private enabled(): boolean { return !this.closed && !this.quiescing && (this.options.enabled?.() ?? true); }
  /** The client ships two locales; anything else falls back to English like the rest of the UI. */
  private appLanguage(): string {
    const saved = this.options.language?.() ?? '';
    // The editor catalog codes the Chinese locale zh-Hans.
    return /^zh(?:[-_]|$)/i.test(saved) ? 'zh-Hans' : 'en';
  }
  /** Push the current application language into every live editor so an open panel follows a settings change. */
  refreshLanguage(): void {
    const code = this.appLanguage();
    for (const editor of this.editors.values()) {
      if (editor.view.webContents.isDestroyed()) continue;
      void editor.view.webContents.executeJavaScript(`window.klausPrototype && window.klausPrototype.setLanguage(${JSON.stringify(code)})`, true).catch(() => {});
    }
  }
  toolSpecs(): Data[] { return prototypeTools(); }
  hostCapabilities(owner: string): Promise<Data> { return this.mcp.hostCapabilities(owner); }
  private assertEnabled(): void { if (!this.enabled()) throw new Error('Interface design is disabled or has shut down.'); }
  private log(event: string, data: Data): void { this.options.log?.(event, data); }
  private rectangle(input: unknown): Electron.Rectangle {
    const fields = record(input);
    if (['x', 'y', 'width', 'height'].some(key => typeof fields[key] !== 'number' || !Number.isFinite(fields[key])) || Number(fields.width) <= 0 || Number(fields.height) <= 0) throw new Error('Invalid interface design panel bounds.');
    const zoom = this.options.window.webContents.getZoomFactor();
    const [width, height] = this.options.window.getContentSize();
    const x = Math.max(0, Math.min(width! - 1, Math.round(Number(fields.x) * zoom)));
    const y = Math.max(0, Math.min(height! - 1, Math.round(Number(fields.y) * zoom)));
    return { x, y, width: Math.max(1, Math.min(width! - x, Math.round(Number(fields.width) * zoom))), height: Math.max(1, Math.min(height! - y, Math.round(Number(fields.height) * zoom))) };
  }
  private readonly resize = (): void => {
    if (this.closed || !this.activeId || !this.bounds || this.options.window.isDestroyed()) return;
    this.editors.get(this.activeId)?.view.setBounds(this.rectangle(this.bounds));
  };
  private waitUntilReady(editor: EditorView): Promise<void> {
    if (editor.failure) return Promise.reject(new Error(editor.failure));
    if (editor.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wait: ReadyWait = { resolve, reject, timer: setTimeout(() => {
        editor.waits.delete(wait);
        reject(new Error('The interface editor is still initializing. Its existing instance was kept; retry this operation when it is ready.'));
      }, 45_000) };
      editor.waits.add(wait);
    });
  }
  private fail(editor: EditorView, error: string): void {
    editor.failure = error;
    for (const wait of editor.waits) { clearTimeout(wait.timer); wait.reject(new Error(error)); }
    editor.waits.clear();
    this.log('prototype-runtime-error', { id: editor.id, error });
  }
  private async editor(project: PrototypeProject, bounds?: Electron.Rectangle): Promise<EditorView> {
    const current = this.editors.get(project.id);
    if (current) {
      this.assertEnabled();
      if (current.owner !== project.sessionId) throw new Error('The editor belongs to another chat.');
      current.lastUsed = Date.now();
      await current.loading;
      await this.waitUntilReady(current);
      return current;
    }
    const next = this.allocation.then(() => this.createEditor(project, bounds));
    this.allocation = next.then(() => undefined, () => undefined);
    return next;
  }
  private async removeEditor(editor: EditorView): Promise<void> {
    if (!this.options.window.isDestroyed()) this.options.window.contentView.removeChildView(editor.view);
    if (!editor.view.webContents.isDestroyed()) editor.view.webContents.close({ waitForBeforeUnload: false });
    this.editors.delete(editor.id);
    if (this.activeId === editor.id) this.activeId = '';
    editor.partition.protocol.unhandle(APP_SCHEME);
    await editor.partition.closeAllConnections();
    await editor.partition.clearStorageData();
  }
  private async createEditor(project: PrototypeProject, bounds?: Electron.Rectangle): Promise<EditorView> {
    this.assertEnabled();
    let editor = this.editors.get(project.id);
    if (editor) {
      if (editor.owner !== project.sessionId) throw new Error('The editor belongs to another chat.');
      await editor.loading;
      await this.waitUntilReady(editor);
      return editor;
    }
    if (this.editors.size >= 3) {
      const oldest = [...this.editors.values()].filter(entry => !entry.view.getVisible() && entry.ready && !entry.failure)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!oldest) throw new Error('The design editor cache is busy. Finish opening the current design and retry.');
      await oldest.queue;
      await oldest.view.webContents.executeJavaScript('window.klausPrototype.flush()', true);
      if (oldest.view.getVisible()) throw new Error('The design became active while saving. Retry opening the other design.');
      await this.removeEditor(oldest);
    }
    const pluginRoot = this.options.pluginRoot();
    if (!pluginRoot) throw new Error('The interface design plugin is not installed.');
    const root = realpathSync(join(pluginRoot, 'runtime', 'dist'));
    const manifest = record(JSON.parse(readBounded(join(root, 'runtime-manifest.json'))));
    if (manifest.bridgeVersion !== 1 || typeof manifest.version !== 'string' || !Array.isArray(manifest.assets) || !manifest.assets.includes('index.html')) throw new Error('The interface design runtime package is incomplete.');
    const assets = new Set(manifest.assets.filter((asset): asset is string => typeof asset === 'string'));
    const partition = session.fromPartition(`prototype-${randomUUID()}`, { cache: false });
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.protocol.handle(APP_SCHEME, async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== APP_HOST || url.username || url.password || url.port || !url.pathname.startsWith('/prototype/')) return new Response('Forbidden', { status: 403 });
        const asset = decodeURIComponent(url.pathname.slice('/prototype/'.length));
        if (!assets.has(asset)) return new Response('Not found', { status: 404 });
        const path = realpathSync(join(root, asset));
        if (!inside(root, path) || !lstatSync(path).isFile()) return new Response('Forbidden', { status: 403 });
        const response = await net.fetch(pathToFileURL(path).toString());
        const headers = new Headers(response.headers);
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' }[extname(path)];
        if (mime) headers.set('Content-Type', mime);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Cache-Control', 'no-store');
        headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        return new Response(response.body, { status: response.status, headers });
      } catch { return new Response('Runtime asset not found', { status: 404 }); }
    });
    const view = new WebContentsView({ webPreferences: {
      session: partition, preload: preloadFor('prototype')!, additionalArguments: ['--klaus-role=prototype'],
      devTools: !app.isPackaged, contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webviewTag: false, backgroundThrottling: false,
    } });
    const entry: EditorView = { id: project.id, owner: project.sessionId, view, partition, ready: false, runtimeVersion: String(manifest.version), waits: new Set(), loading: Promise.resolve(), queue: Promise.resolve(), lastUsed: Date.now() };
    editor = entry;
    this.editors.set(project.id, entry);
    const contents = view.webContents;
    this.options.registerRenderer(contents.id, 'prototype');
    const url = `${APP_SCHEME}://${APP_HOST}/prototype/index.html?${new URLSearchParams({ id: project.id })}`;
    contents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('render-process-gone', (_event, details) => this.fail(entry, `The interface editor stopped: ${details.reason}.`));
    contents.once('destroyed', () => {
      this.options.unregisterRenderer(contents.id);
      this.fail(entry, 'The interface editor has closed.');
      if (this.editors.get(project.id) === entry) this.editors.delete(project.id);
    });
    view.setBounds(bounds ?? { x: 0, y: 0, width: 1440, height: 1000 });
    view.setVisible(false);
    this.options.window.contentView.addChildView(view);
    entry.loading = contents.loadURL(url).catch(error => { this.fail(entry, message(error)); throw error; });
    await entry.loading;
    await this.waitUntilReady(entry);
    return entry;
  }
  private async request(project: PrototypeProject, method: string, params: Data = {}): Promise<Data> {
    const editor = await this.editor(project);
    const next = editor.queue.then(async () => {
      this.assertEnabled();
      if (editor.view.webContents.isDestroyed()) throw new Error('The interface editor closed before the request.');
      const args = JSON.stringify({ method, params });
      const value: unknown = await editor.view.webContents.executeJavaScript(`window.klausPrototype.request(${args})`, true);
      const reply = record(value);
      if (reply.ok === false) throw new Error(String(reply.error ?? 'The design operation failed.'));
      return reply;
    });
    editor.queue = next.then(() => undefined, () => undefined);
    return next;
  }
  private success(value: Data, artifact?: Data): Data {
    return { content: [{ type: 'text', text: JSON.stringify(artifact ? { ...value, artifact } : value) }], structuredContent: artifact ? { ...value, artifact } : value };
  }
  private async importLegacy(project: PrototypeProject, plan: LegacyImportPlan): Promise<string> {
    const catalog = await this.request(project, 'engine.commands');
    const available = new Set((Array.isArray(catalog.result) ? catalog.result : []).map(command => record(command).id));
    for (const command of plan.requiredCommands) if (!available.has(command)) throw new Error(`This editor cannot import the legacy command ${command}. The original project was preserved.`);
    const backup = join(this.store.root, project.id, 'legacy-source.json');
    writeFileSync(backup, JSON.stringify(plan.backup, null, 2), { mode: 0o600, flag: 'wx' });
    const bindings = new Map<string, number>();
    for (let offset = 0; offset < plan.steps.length; offset += 128) {
      const group = plan.steps.slice(offset, offset + 128), local = new Map<string, number>();
      const commands = group.map((step, index) => {
        const params = JSON.parse(JSON.stringify(step.params), (_key, value: unknown) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const reference = value as Record<string, unknown>;
            if (Object.keys(reference).length === 1 && typeof reference.legacyResult === 'string') {
              const saved = bindings.get(reference.legacyResult);
              if (saved !== undefined) return saved;
              const prior = local.get(reference.legacyResult);
              if (prior === undefined) throw new Error('The legacy import contains an unresolved layer.');
              return { $step: prior };
            }
          }
          return value;
        }) as Data;
        if (step.bind) local.set(step.bind, index);
        return { command: step.command, params };
      });
      const response = await this.request(project, 'engine.batch', { commands, label: 'Import saved interface design' });
      const results = record(response.result).results;
      for (const [key, index] of local) {
        const id = record(Array.isArray(results) ? results[index] : null).id;
        if (!Number.isSafeInteger(id)) throw new Error('The legacy import did not return its layer identity.');
        bindings.set(key, Number(id));
      }
    }
    return backup;
  }
  async call(owner: string, name: string, fields: Data): Promise<Data> {
    try {
      this.assertEnabled();
      text(owner, 'interface design session');
      const allowedFields = PROTOTYPE_TOOL_FIELDS[name];
      if (allowedFields) {
        const unknown = Object.keys(fields).filter(key => !allowedFields.includes(key));
        if (unknown.length) throw new Error(`Unknown ${name} parameter: ${unknown.join(', ')}. Supported parameters: ${allowedFields.join(', ')}.`);
      }
      if (name === 'prototype_open') {
        if (typeof fields.id === 'string' && this.importing.has(fields.id)) throw new Error('This design is still being imported.');
        let plan: LegacyImportPlan | undefined;
        if (fields.legacy_canvas !== undefined) {
          if (fields.id !== undefined) throw new Error('Import a legacy project into a new design; omit id to preserve the existing design.');
          if (!this.options.readLegacy) throw new Error('Legacy document access is unavailable in this host.');
          plan = planLegacyPrototypeImport(this.options.readLegacy(text(fields.legacy_canvas, 'legacy Canvas path')));
        }
        let previousId: string | undefined;
        try { previousId = this.store.resolveId(owner); } catch { /* This chat has no previous design. */ }
        const project = this.store.open(owner, plan ? { title: fields.title ?? plan.title } : fields);
        if (plan) this.importing.add(project.id);
        try {
          await this.editor(project);
          const backup = plan ? await this.importLegacy(project, plan) : undefined;
          const state = await this.request(project, 'document.inspect', { depth: 2 });
          // Open the work panel automatically; the artifact card below also gives the user a
          // way back in once the turn is folded or reloaded.
          void this.openPanel({ id: project.id, sessionId: owner }).catch(() => {});
          return this.success({ id: project.id, title: project.title, ...state, ...(plan ? { warnings: plan.warnings, legacyBackup: backup! } : {}) }, { kind: 'prototype', id: project.id, title: project.title, ready: designHasContent(state) });
        } catch (error) {
          if (plan) {
            const editor = this.editors.get(project.id);
            if (editor) await this.removeEditor(editor);
            this.store.discard(project.id, owner, previousId);
          }
          throw error;
        } finally { this.importing.delete(project.id); }
      }
      const id = this.store.resolveId(owner, fields.id);
      if (this.importing.has(id)) throw new Error('This design is still being imported.');
      const project = this.store.load(id, owner);
      if (name === 'prototype_inspect') {
        const depth = typeof fields.depth === 'number' ? Math.max(0, Math.min(12, fields.depth)) : 2;
        return this.success({ id, ...await this.request(project, fields.node_id ? 'node.get' : 'document.inspect', { ...(fields.node_id ? { id: fields.node_id } : { allPages: fields.all_pages === true }), depth }) });
      }
      if (name === 'prototype_commands') {
        const response = await this.request(project, 'engine.commands');
        // A multi-word query is a keyword search: every whitespace-separated token
        // must appear somewhere in the command spec, in any order. Matching the
        // whole phrase as one substring almost never hits a spec, so keyword
        // queries read as "no such command" and callers gave up on search.
        const tokens = String(fields.query ?? '').toLowerCase().split(/\s+/).filter(token => token.length > 0);
        const commands = Array.isArray(response.result) ? response.result.filter(input => {
          const haystack = JSON.stringify(input).toLowerCase();
          return tokens.every(token => haystack.includes(token));
        }) : [];
        const limit = Math.max(1, Math.min(100, Number(fields.limit) || 25));
        return this.success({ id, commands: commands.slice(0, limit), total: commands.length, truncated: commands.length > limit });
      }
      if (name === 'prototype_execute') {
        if (!Number.isSafeInteger(fields.expected_revision) || Number(fields.expected_revision) < 0) throw new Error('Read the design revision before editing.');
        if (!Array.isArray(fields.commands) || fields.commands.length < 1 || fields.commands.length > 128) throw new Error('Expected between 1 and 128 design commands.');
        const response = await this.request(project, 'engine.batch', { commands: fields.commands, label: fields.label ?? 'Edit interface design', expectedRevision: Number(fields.expected_revision) });
        // A batch that created nodes upgrades the open-time "design created" card
        // to the ready copy: the card follows what the document holds, not the
        // moment the workspace came into existence.
        return this.success({ id, ...response }, batchCreatedNodes(response) ? { kind: 'prototype', id, title: project.title, ready: true } : undefined);
      }
      if (name === 'prototype_export') {
        const format = text(fields.format, 'export format');
        if (!['figcraft', 'png', 'jpg', 'webp', 'svg', 'pdf', 'fig'].includes(format)) throw new Error('Unsupported design export format.');
        const response = await this.request(project, format === 'figcraft' ? 'document.serialize' : 'engine.execute', format === 'figcraft' ? {} : { command: 'file.export', params: { format, scale: fields.scale ?? 1, ...(fields.ids ? { ids: fields.ids } : {}) } });
        const result = record(response.result);
        const bytes = this.decode(result.data);
        const directory = join(this.store.root, id);
        const path = join(directory, `export-${randomUUID()}.${format}`);
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
        return this.success({ id, format, path, ...(result.warnings ? { warnings: result.warnings } : {}) });
      }
      throw new Error(`Unknown interface design tool: ${name}`);
    } catch (error) { return { isError: true, content: [{ type: 'text', text: message(error) }] }; }
  }
  private decode(input: unknown): Buffer {
    if (typeof input !== 'string' || input.length > 96 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) throw new Error('Invalid design export bytes.');
    const bytes = Buffer.from(input, 'base64');
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('Empty or oversized design export.');
    return bytes;
  }
  private async present(fields: Data): Promise<Data> {
    const owner = text(fields.sessionId, 'interface design session');
    const project = this.store.load(fields.id, owner);
    if (this.importing.has(project.id)) throw new Error('This design is still being imported.');
    const bounds = this.rectangle(fields.bounds);
    const revision = ++this.presentationRevision;
    // The panel's rectangle is known before the page loads: laying the view out at its real size lets the
    // editor measure its canvas on mount instead of starting from a placeholder that never re-measures.
    const editor = await this.editor(project, bounds);
    if (revision !== this.presentationRevision || this.closed) return { ok: false, error: 'The design presentation request is stale.' };
    for (const entry of this.editors.values()) entry.view.setVisible(false);
    this.activeId = project.id;
    this.bounds = record(fields.bounds);
    editor.view.setBounds(bounds);
    editor.view.setVisible(true);
    this.nudge(editor);
    this.recover(editor, revision);
    return { ok: true };
  }
  /** One invisible layout pass after a show: a canvas that mounted while hidden measured nothing there. */
  private nudge(editor: EditorView): void {
    if (this.closed || !this.bounds || editor.view.webContents.isDestroyed()) return;
    try {
      const bounds = this.rectangle(this.bounds);
      editor.view.setBounds({ ...bounds, width: Math.max(1, bounds.width - 1) });
      setTimeout(() => {
        if (this.closed || this.activeId !== editor.id || editor.view.webContents.isDestroyed() || !this.bounds) return;
        try { editor.view.setBounds(this.rectangle(this.bounds)); } catch { /* the panel moved meanwhile; the next sync bounds it */ }
      }, 40);
    } catch { /* the panel moved meanwhile; the next sync bounds it */ }
  }
  /**
   * A design editor that ended under the panel (a gone renderer, a failed load) stays failed on this
   * object forever: bringing it back is one fresh load of the same page, while the saved document stands.
   */
  private recover(editor: EditorView, revision: number): void {
    if (!editor.failure || this.closed || editor.view.webContents.isDestroyed()) return;
    setTimeout(() => {
      const contents = editor.view.webContents;
      if (this.closed || revision !== this.presentationRevision || this.activeId !== editor.id || contents.isDestroyed()) return;
      this.options.log?.('interface-editor-recover', { id: editor.id });
      editor.failure = undefined; editor.ready = false;
      editor.loading = contents.loadURL(contents.getURL()).then(() => this.waitUntilReady(editor))
        .catch(error => { this.fail(editor, message(error)); throw error; });
    }, 0);
  }
  private hide(): Data {
    this.presentationRevision++;
    if (this.activeId) this.editors.get(this.activeId)?.view.setVisible(false);
    return { ok: true };
  }
  private async openPanel(fields: Data): Promise<Data> {
    const owner = text(fields.sessionId, 'interface design session');
    const project = this.store.load(fields.id, owner);
    const requestId = randomUUID();
    const result = new Promise<Data>(resolve => {
      const timer = setTimeout(() => { this.openRequests.delete(requestId); resolve({ ok: false, error: 'The design panel did not acknowledge the open request.' }); }, 60_000);
      this.openRequests.set(requestId, { resolve, timer });
    });
    this.options.emit('prototype:open-panel', { requestId, id: project.id, title: project.title, sessionId: owner });
    return result;
  }
  private async runtimeAction(editor: EditorView, fields: Data): Promise<Data> {
    if (this.closed) throw new Error('The design service has closed.');
    if (fields.type === 'load') return { ...this.store.runtimeLoad(editor.id, editor.owner), language: this.appLanguage() };
    if (fields.type === 'ready') {
      if (fields.bridgeVersion !== 1 || fields.version !== editor.runtimeVersion) throw new Error('The interface editor runtime does not match this host package.');
      editor.ready = true;
      for (const wait of editor.waits) { clearTimeout(wait.timer); wait.resolve(); }
      editor.waits.clear();
      return { ok: true };
    }
    if (fields.type === 'error') { this.fail(editor, String(fields.error ?? 'The interface editor failed to start.')); return { ok: true }; }
    if (fields.type === 'save') {
      const project = this.store.save(editor.id, editor.owner, fields);
      editor.lastUsed = Date.now();
      return { ok: true, version: project.version };
    }
    if (fields.type === 'export') {
      const bytes = this.decode(fields.data);
      const name = basename(String(fields.name ?? 'Design.figcraft')).replace(/[\x00-\x1f:?*"<>|]/g, '_').slice(0, 160);
      const format = extname(name).slice(1).toLowerCase();
      if (!['figcraft', 'fig', 'json', 'svg', 'pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(format)) throw new Error('Unsupported design download.');
      const path = this.options.chooseExportPath ? await this.options.chooseExportPath(name, format) : (await dialog.showSaveDialog(this.options.window, { defaultPath: name })).filePath;
      if (!path) return { canceled: true };
      writeFileSync(path, bytes, { mode: 0o600 });
      return { ok: true, path };
    }
    if (fields.type === 'import') {
      const result = await dialog.showOpenDialog(this.options.window, { properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return { canceled: true };
      if (result.filePaths.length > 32) throw new Error('Import at most 32 design files at once.');
      let size = 0;
      const files = result.filePaths.map(path => {
        const stats = lstatSync(path);
        size += stats.size;
        if (!stats.isFile() || size > 64 * 1024 * 1024) throw new Error('The selected design files exceed the import limit.');
        return { name: basename(path), data: readFileSync(path).toString('base64') };
      });
      return { files };
    }
    if (fields.type === 'open-url') {
      const url = new URL(text(fields.url, 'external URL'));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public web links can be opened.');
      await shell.openExternal(url.href);
      return { ok: true };
    }
    throw new Error('Unknown interface design runtime action.');
  }
  async invoke(context: HandlerContext): Promise<Data> {
    const fields = record(context.args[0]);
    if (context.role === 'prototype' && context.channel === 'prototype:runtime-action') {
      const editor = [...this.editors.values()].find(entry => entry.view.webContents.id === context.senderId && !entry.view.webContents.isDestroyed());
      if (!editor) throw new Error('This design editor is no longer active.');
      return this.runtimeAction(editor, record(fields.action));
    }
    this.assertEnabled();
    if (context.role !== 'main' || context.senderId !== this.options.window.webContents.id) throw new Error('Interface design belongs to another window.');
    switch (context.channel) {
      case 'prototype:list': return { prototypes: this.store.list(text(fields.sessionId, 'interface design session')).filter(project => !this.importing.has(project.id)).map(project => ({ id: project.id, title: project.title })) as unknown as Json };
      case 'prototype:open': return this.openPanel(fields);
      case 'prototype:open-result': {
        const requestId = text(fields.requestId, 'request id');
        const request = this.openRequests.get(requestId);
        if (!request) return { ok: false, error: 'The open request expired.' };
        clearTimeout(request.timer); this.openRequests.delete(requestId);
        request.resolve(fields.ok === true ? { ok: true } : { ok: false, error: fields.error ?? 'The design panel could not open.' });
        return { ok: true };
      }
      case 'prototype:panel-show': return this.present(fields);
      case 'prototype:panel-set-bounds': this.bounds = record(fields.bounds); this.resize(); return { ok: true };
      case 'prototype:panel-hide': return this.hide();
      case 'prototype:panel-close': this.hide(); this.activeId = ''; this.bounds = undefined; return { ok: true };
      default: throw new Error(`Unknown interface design channel: ${context.channel}`);
    }
  }
  releaseSession(owner: string): void { this.mcp.releaseSession(owner); this.store.releaseSession(owner); }
  async flush(): Promise<void> {
    for (const editor of this.editors.values()) {
      if (!editor.view.webContents.isDestroyed() && editor.ready) {
        try { await editor.queue; await editor.view.webContents.executeJavaScript('window.klausPrototype.flush()', true); }
        catch (error) {
          this.log('prototype-final-save-failed', { id: editor.id, error: message(error) });
          throw new Error('The interface design still has unsaved edits. Retry saving before closing its editor.');
        }
      }
    }
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.prepareToClose();
    if (this.closed) return;
    this.closed = true;
    this.options.window.removeListener('resize', this.resize);
    this.options.window.webContents.removeListener('zoom-changed', this.resize);
    for (const request of this.openRequests.values()) { clearTimeout(request.timer); request.resolve({ ok: false, error: 'The design service closed.' }); }
    this.openRequests.clear();
    for (const editor of this.editors.values()) {
      this.fail(editor, 'The design service closed.');
      await this.removeEditor(editor);
    }
    this.editors.clear();
    await this.mcp.shutdown();
  }
  prepareToClose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePreparation) return this.closePreparation;
    const active = this.editors.get(this.activeId);
    const wasVisible = active?.view.getVisible() ?? false;
    this.restoreAfterClose = () => {
      if (wasVisible && active && this.editors.get(this.activeId) === active && !active.view.webContents.isDestroyed()) { active.view.setVisible(true); this.nudge(active); }
    };
    this.quiescing = true;
    this.hide();
    this.closePreparation = (async () => { await this.allocation; await this.flush(); })().catch(error => {
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
}
