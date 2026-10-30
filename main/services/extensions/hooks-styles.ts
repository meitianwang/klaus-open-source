import { homedir } from 'node:os';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Json } from '../../ipc/contract';
import { errorMessage, object, string, type EngineRequest, type JsonObject } from '../service-types';
import { WorkspaceStore } from '../workspaces';
import { hookDeclarationsFromDocument } from './discovery';
import { directoryNames, managedPath, optionalDocument } from './file-store';
import { HooksTrustState, type HookRow } from './hooks-state';
import { description, frontmatter } from './frontmatter';
import { BUILTIN_OUTPUT_STYLES } from './style-builtins';
import { registeredRoots } from './scopes';
import { DirectoryMutations } from './directory-mutations';

export interface HookStyleDeps {
  workspaces: WorkspaceStore;
  request: EngineRequest;
  onChanged: (kind: 'hooks' | 'outputStyle', projectRoot?: string) => Promise<void>;
  userHome?: string;
  diagnostic?: (path: string, error: unknown) => void;
  /** Shared with session injection so the gate and the settings page read one ledger. */
  hookTrust?: HooksTrustState;
}
interface StyleDocument { name: string; body: string; description: string; listDescription: string; keepCodingInstructions: boolean }
function hooksObject(payload: JsonObject, legacy: boolean): JsonObject {
  const raw = payload.hooks;
  const candidate = legacy && raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && Object.hasOwn(raw, 'hooks') ? raw.hooks : raw;
  return object(candidate);
}
function refused(error: unknown, hooks: JsonObject = {}): JsonObject { return { ok: false, error: errorMessage(error), hooks, path: '', events: [] }; }
export class HookStyleService {
  private closed = false;
  private readonly mutations: DirectoryMutations;
  constructor(private readonly deps: HookStyleDeps) {
    this.mutations = new DirectoryMutations(deps.workspaces);
    this.trust = deps.hookTrust ?? new HooksTrustState(deps.workspaces.configRoot);
  }
  private readonly trust: HooksTrustState;
  private active(): void { if (this.closed) throw new Error('The hooks and output styles service is closed'); }
  /** Keep an imported hook read/merge/write in the same order as settings edits. */
  withMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutations.run(async () => { this.active(); return operation(); });
  }
  private async request(method: string, params: Json): Promise<JsonObject> {
    this.active(); const reply = object(await this.deps.request(method, params));
    if (reply.error !== undefined) throw reply.error; return reply;
  }
  private async hookScope(value: unknown, workspaceId?: unknown): Promise<{ filePath?: string; projectRoot?: string; roots: string[] }> {
    if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('invalid projectRoot');
    const raw = string(value).trim(), workspace = string(workspaceId).trim();
    if (value !== undefined && value !== null && !raw && !workspace) throw new Error('invalid projectRoot');
    if (!raw && !workspace) return { roots: [] };
    if (raw.includes('\0') || raw.startsWith('ssh://')) throw new Error('invalid projectRoot');
    // A workspace scope reads every member folder's hooks file and writes the
    // group's primary folder, mirroring the commands editor.
    const resolved = raw || (this.deps.workspaces.workspaceRoots(workspace)[0] ?? '');
    if (!resolved) return { roots: [] };
    const root = resolve(resolved);
    if (!registeredRoots(this.deps.workspaces).includes(root)) throw new Error('unknown projectRoot');
    return { filePath: await managedPath(root, '.klaus/hooks.json'), projectRoot: root, roots: workspace
      ? this.deps.workspaces.workspaceRoots(workspace).filter(item => registeredRoots(this.deps.workspaces).includes(resolve(item)))
      : [root] };
  }
  private hookReply(reply: JsonObject): JsonObject {
    if (reply.hooks === null || typeof reply.hooks !== 'object' || Array.isArray(reply.hooks) || typeof reply.path !== 'string' || !Array.isArray(reply.events) || reply.events.some(event => typeof event !== 'string')) throw new Error('Invalid hooks reply from engine');
    return { ok: true, hooks: reply.hooks, path: reply.path, events: reply.events };
  }
  async hooksGet(payload: JsonObject = {}, legacy = false): Promise<Json> {
    try {
      const scope = legacy ? { roots: [] as string[] } : await this.hookScope(payload.projectRoot, payload.workspaceId);
      const reply = this.hookReply(await this.request('hooks/read', scope.filePath ? { filePath: scope.filePath } : {}));
      const rows = await this.stateRows(scope.roots);
      const files: Array<{ scope: 'global' | 'project'; filePath: string }> = [{ scope: 'global', filePath: join(this.deps.workspaces.configRoot, 'hooks.json') }];
      for (const root of scope.roots) files.push({ scope: 'project', filePath: await managedPath(root, '.klaus/hooks.json') });
      await this.trust.prune(files, new Set(rows.map(row => row.key))).catch(() => undefined);
      return { ...reply, rows };
    } catch (error) { return refused(error); }
  }
  /**
   * Trust the given hook keys in their current declaration form and enable them.
   * Keys are matched against the live row set, so a stale UI can neither trust a
   * declaration that changed under it nor invent one.
   */
  hooksTrustSet(payload: JsonObject): Promise<Json> {
    const keys = Array.isArray(payload.keys) ? payload.keys.filter((key): key is string => typeof key === 'string') : [];
    const projectRoot = typeof payload.projectRoot === 'string' ? payload.projectRoot : undefined;
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
    return this.mutations.run(async (): Promise<Json> => {
      try {
        this.active();
        const roots = (await this.hookScope(projectRoot, workspaceId)).roots;
        const live = await this.liveRows(roots);
        await this.trust.trust(keys, live);
        await this.deps.onChanged('hooks', projectRoot);
        return { ok: true };
      } catch (error) { return refused(error); }
    }, async () => [projectRoot ? resolve(projectRoot) : this.deps.workspaces.configRoot])
      .catch(error => refused(error));
  }
  /** Flip a hook's explicit enable flag without touching its stored trust hash. */
  hooksEnabledSet(payload: JsonObject): Promise<Json> {
    const key = string(payload.key);
    const enabled = payload.enabled === true;
    const projectRoot = typeof payload.projectRoot === 'string' ? payload.projectRoot : undefined;
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
    return this.mutations.run(async (): Promise<Json> => {
      try {
        this.active();
        if (!key) throw new Error('invalid key');
        const roots = (await this.hookScope(projectRoot, workspaceId)).roots;
        const live = await this.liveRows(roots);
        await this.trust.setEnabled(key, enabled, live);
        await this.deps.onChanged('hooks', projectRoot);
        return { ok: true };
      } catch (error) { return refused(error); }
    }, async () => [projectRoot ? resolve(projectRoot) : this.deps.workspaces.configRoot])
      .catch(error => refused(error));
  }
  /** Per-hook trust rows for every folder the scope spans, plus the global file. */
  private async stateRows(projectRoots: string[] = []): Promise<HookRow[]> {
    const rows = await this.fileRows('global', join(this.deps.workspaces.configRoot, 'hooks.json'));
    for (const projectRoot of projectRoots) rows.push(...await this.fileRows('project', await managedPath(projectRoot, '.klaus/hooks.json')));
    return rows;
  }
  private async liveRows(projectRoots: string[] = []): Promise<Map<string, HookRow>> {
    return new Map((await this.stateRows(projectRoots)).map(row => [row.key, row]));
  }
  private async fileRows(scope: 'global' | 'project', filePath: string): Promise<HookRow[]> {
    let raw: string | undefined;
    try { raw = await optionalDocument(filePath); } catch (error) { this.deps.diagnostic?.(filePath, error); return []; }
    if (raw === undefined) return [];
    let declarations;
    try { declarations = hookDeclarationsFromDocument(JSON.parse(raw)); } catch (error) { this.deps.diagnostic?.(filePath, error); return []; }
    return this.trust.rows(scope, filePath, declarations);
  }
  hooksSet(payload: JsonObject, legacy = false): Promise<Json> {
    const hooks = hooksObject(payload, legacy);
    let scope!: { filePath?: string; projectRoot?: string };
    return this.mutations.run(async () => {
      try {
        const reply = this.hookReply(await this.request('hooks/write', { hooks, ...(scope.filePath ? { filePath: scope.filePath } : {}) }));
        await this.deps.onChanged('hooks', scope.projectRoot); return reply;
      } catch (error) { return refused(error, hooks); }
    }, async () => { scope = legacy ? { roots: [] } : await this.hookScope(payload.projectRoot, payload.workspaceId); return [scope.projectRoot ?? this.deps.workspaces.configRoot]; })
      .catch(error => refused(error, hooks));
  }
  private async current(configValues?: JsonObject): Promise<string> {
    const reply = configValues === undefined ? await this.request('config/read', {}) : undefined;
    if (reply && (reply.values === null || typeof reply.values !== 'object' || Array.isArray(reply.values))) throw new Error('Invalid engine config values');
    const values = configValues ?? object(reply?.values);
    return string(values.outputStyle) || 'default';
  }
  private async styles(root: string, relative: string): Promise<StyleDocument[]> {
    const rows: StyleDocument[] = []; let files: string[];
    try { files = await directoryNames(await managedPath(root, relative)); }
    catch (error) { this.deps.diagnostic?.(join(root, relative), error); return []; }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const path = join(root, relative, file);
      try {
        const raw = await optionalDocument(await managedPath(root, join(relative, file))); if (raw === undefined) continue;
        const { data, body } = frontmatter(raw), fallback = file.slice(0, -3), name = string(data.name) || fallback;
        const first = body.split('\n').map(line => line.trim()).find(Boolean)?.replace(/^#+/, '').trim();
        rows.push({ name, body: body.trim(), description: string(data.description).trim() || description(body, 'Custom ' + fallback + ' output style'),
          listDescription: typeof data.description === 'string' ? data.description : first || 'Custom ' + fallback + ' output style', keepCodingInstructions: data['keep-coding-instructions'] !== false && data['keep-coding-instructions'] !== 'false' });
      } catch (error) { this.deps.diagnostic?.(path, error); }
    }
    return rows;
  }
  async outputStylesList(): Promise<Json> {
    try {
      this.active(); const current = await this.current();
      let styles: JsonObject[] = [{ id: 'default', name: 'default', description: '', source: 'built-in', keepCodingInstructions: true, active: current === 'default', isDefault: true },
        ...BUILTIN_OUTPUT_STYLES.map(style => ({ id: style.name!, name: style.name!, description: style.description!, source: 'built-in', keepCodingInstructions: true, active: style.name === current, isDefault: false }))];
      for (const style of await this.styles(this.deps.workspaces.configRoot, 'output-styles')) {
        styles = styles.filter(row => row.id !== style.name);
        styles.push({ id: style.name, name: style.name, description: style.listDescription, source: 'userSettings', keepCodingInstructions: style.keepCodingInstructions, active: style.name === current, isDefault: style.name === 'default' });
      }
      return { current, defaultStyle: 'default', styles };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  outputStylesSet(payload: JsonObject): Promise<Json> {
    return this.mutations.run(async (): Promise<Json> => {
      try {
        this.active(); const style = string(payload.style).trim() || 'default';
        const known = ['default', ...BUILTIN_OUTPUT_STYLES.map(item => string(item.name)), ...(await this.styles(this.deps.workspaces.configRoot, 'output-styles')).map(item => item.name)];
        if (!known.includes(style)) throw new Error('unknown_style');
        await this.request('config/batchWrite', { edits: [{ keyPath: 'outputStyle', value: style === 'default' ? null : style, mergeStrategy: 'replace' }] });
        await this.deps.onChanged('outputStyle'); return { ok: true, current: style };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    }).catch(error => ({ ok: false, error: errorMessage(error) }));
  }
  /** Merge these fields with other host declarations; the default sentinel stays absent. */
  async sessionExtensions(cwd: string, configValues?: JsonObject, extraRoots: string[] = []): Promise<JsonObject> {
    this.active(); const styles = structuredClone(BUILTIN_OUTPUT_STYLES), loaded = await this.styles(this.deps.workspaces.configRoot, 'output-styles');
    for (const start of [...(cwd && !cwd.startsWith('ssh://') ? [cwd] : []), ...extraRoots.filter(root => root && !root.startsWith('ssh://'))]) {
      const home = resolve(this.deps.userHome ?? homedir()); let current = resolve(start);
      for (;;) {
        if (current === home) break;
        loaded.push(...await this.styles(current, '.klaus/output-styles'));
        try { await access(join(current, '.git')); break; } catch { /* Include ancestors until the checkout boundary. */ }
        const parent = dirname(current); if (parent === current) break; current = parent;
      }
    }
    for (const style of loaded) {
      const row: JsonObject = { name: style.name, body: style.body }; if (style.description) row.description = style.description;
      const index = styles.findIndex(item => item.name === style.name); if (index < 0) styles.push(row); else styles[index] = row;
    }
    const selected = await this.current(configValues), fields: JsonObject = { outputStyles: styles };
    if (selected !== 'default') fields.selectedOutputStyle = selected; return fields;
  }
  async close(): Promise<void> { this.closed = true; await this.mutations.close(); }
}
