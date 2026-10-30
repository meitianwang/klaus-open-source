import { open, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Json } from '../../ipc/contract';
import { IpcHandlerError } from '../../ipc/registry';
import { object, string, errorMessage, type EngineRequest, type JsonObject } from '../service-types';
import { withSettingsDb, withSettingsTransaction } from '../settings';
import { pathInside, WorkspaceStore } from '../workspaces';
import { frontmatter, scalar } from './frontmatter';
import { atomicDocument, directoryNames, managedPath, missing, optionalDocument } from './file-store';
import { BUNDLED_COMMANDS } from './builtins';
import { registeredRoots } from './scopes';
import { DirectoryMutations } from './directory-mutations';

export interface SkillDeps {
  workspaces: WorkspaceStore;
  request: EngineRequest;
  onChanged: (projectRoot?: string) => Promise<void>;
  openPreviewWindow: (options: { kind: 'skill'; filePath: string }) => Promise<void>;
  environment?: () => Promise<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  bundledSkills?: () => Promise<JsonObject[]>;
}
interface SkillScope { root: string; base: string; projectRoot?: string }
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
async function readSkillPreview(path: string): Promise<Json> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat(); if (!info.isFile()) throw new Error('not-a-file');
    const limit = 1024 * 1024, buffer = Buffer.alloc(Math.min(limit + 1, info.size + 1)); let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    return { ok: true, content: buffer.subarray(0, Math.min(limit, length)).toString('utf8'), truncated: length > limit || info.size > limit, size: info.size };
  } finally { await handle.close(); }
}
function validName(value: string): boolean { return Boolean(value && value.length <= 128 && value !== '.' && value !== '..' && !/[/\\\0]/.test(value)); }
function builtinRow(name: string, description: string, userInvocable: boolean): JsonObject {
  return { name, description, source: 'builtin', userInvocable, userEnabled: true, installed: true, dirName: name, tags: ['builtin'] };
}
export class SkillService {
  readonly configRoot: string;
  private closed = false;
  private readonly mutations: DirectoryMutations;
  constructor(private readonly deps: SkillDeps) { this.configRoot = deps.workspaces.configRoot; this.mutations = new DirectoryMutations(deps.workspaces); }
  private async scope(projectRoot: unknown, registered = false): Promise<SkillScope> {
    const value = string(projectRoot).trim();
    if (!value) return { root: this.configRoot, base: await managedPath(this.configRoot, 'skills') };
    if (value.includes('\0') || value.startsWith('ssh://')) throw new Error('invalid projectRoot');
    const root = resolve(value);
    if (registered && !registeredRoots(this.deps.workspaces).includes(root)) throw new Error('unknown-project-root');
    return { root, base: await managedPath(root, '.klaus/skills'), projectRoot: root };
  }
  private active(): void { if (this.closed) throw new Error('The skill service is closed'); }
  /** Market installs share the same queue and directory lease as toggle/uninstall. */
  withMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutations.run(async () => { this.active(); return operation(); });
  }
  async missingDependencies(meta: JsonObject): Promise<{ missingBins: string[]; missingEnv: string[]; unsupported: boolean }> {
    const metadata = object(meta.metadata), nested = object(metadata.klaus ?? metadata.openclaw ?? metadata.clawdbot ?? metadata), requires = object(nested.requires);
    const environment = await this.deps.environment?.() ?? process.env, platform = this.deps.platform ?? process.platform;
    const windows = platform === 'win32', paths = string(environment.PATH ?? environment.Path).split(windows ? ';' : ':').filter(Boolean);
    const suffixes = windows ? ['', ...string(environment.PATHEXT, '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(value => value.toLowerCase())] : [''];
    const executable = async (bin: string): Promise<boolean> => {
      const candidates = bin.includes('/') || (windows && bin.includes('\\')) ? [bin] : paths.map(path => join(path, bin));
      for (const candidate of candidates) for (const suffix of suffixes) {
        try { const info = await stat(candidate + suffix); if (info.isFile() && (windows || (info.mode & 0o111) !== 0)) return true; } catch { /* Missing or inaccessible binaries are not runnable. */ }
      }
      return false;
    };
    const missingBins: string[] = [];
    for (const bin of strings(requires.bins)) if (!await executable(bin)) missingBins.push(bin);
    const platforms = strings(nested.os);
    return { missingBins, missingEnv: strings(requires.env).filter(key => environment[key] === undefined), unsupported: Boolean(platforms.length && !platforms.includes(platform)) };
  }
  async list(payload: JsonObject): Promise<Json> {
    this.active();
    const workspace = string(payload.workspaceId).trim();
    if (workspace) {
      // A workspace tab lists every member folder's skills; `root` tells the
      // page which folder owns each row so mutations target the right one.
      const prefs = withSettingsDb(this.configRoot, db => new Map(db.prepare("SELECT key,value FROM settings WHERE key LIKE 'skill:%'").all().map(row => [String(row.key).slice(6), String(row.value)])));
      const out: JsonObject[] = [];
      for (const root of this.deps.workspaces.workspaceRoots(workspace)) {
        for (const row of await this.listScope(await this.scope(root), prefs)) {
          if (!out.some(existing => string(existing.dirName) === string(row.dirName))) out.push({ ...row, root });
        }
      }
      return out;
    }
    const scope = await this.scope(payload.projectRoot, Boolean(string(payload.projectRoot).trim()));
    return this.listScope(scope);
  }
  private async listScope(scope: SkillScope, prefs?: Map<string, string>): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    const preferences = prefs ?? withSettingsDb(this.configRoot, db => new Map(db.prepare("SELECT key,value FROM settings WHERE key LIKE 'skill:%'").all().map(row => [String(row.key).slice(6), String(row.value)])));
    for (const name of await directoryNames(scope.base)) {
      if (name.startsWith('.')) continue;
      const path = await managedPath(scope.base, name);
      let info; try { info = await stat(path); } catch { continue; } if (!info.isDirectory()) continue;
      let raw: string | undefined; try { raw = await optionalDocument(await managedPath(scope.base, join(name, 'SKILL.md'))); } catch { raw = undefined; }
      if (scope.projectRoot && raw === undefined) continue;
      let meta: JsonObject = {}, parseError: string | undefined;
      if (raw !== undefined) { const parsed = frontmatter(raw); meta = parsed.data; parseError = parsed.error; }
      else parseError = 'Installed skill has no readable SKILL.md';
      const metadata = object(meta.metadata), nested = object(metadata.klaus ?? metadata.openclaw ?? metadata.clawdbot ?? metadata);
      const dependencies = parseError ? { missingBins: [], missingEnv: [], unsupported: false } : await this.missingDependencies(meta); let enabled = true;
      const pref = preferences.get(name); if (pref !== undefined) try { enabled = object(JSON.parse(pref)).enabled !== false; } catch { enabled = pref !== 'off'; }
      const row: JsonObject = { name: scalar(meta.name)?.trim() || name, description: scalar(meta.description)?.trim().split(/\s+/).join(' ') || '', source: 'installed', userInvocable: true, userEnabled: enabled, installed: true, dirName: name,
        path: join(path, 'SKILL.md'), definitionPreview: raw !== undefined,
        dependencyStatus: parseError ? 'invalid' : dependencies.unsupported ? 'unsupported' : dependencies.missingBins.length ? 'missing' : dependencies.missingEnv.length ? 'config' : 'ready', missingBins: dependencies.missingBins, missingEnv: dependencies.missingEnv,
        ...(parseError ? { error: parseError } : {}) };
      if (typeof nested.emoji === 'string') row.emoji = nested.emoji;
      if (meta.tags !== null && typeof meta.tags === 'object' && Object.keys(meta.tags).length) row.tags = meta.tags;
      rows.push(row);
    }
    return rows;
  }
  toggle(payload: JsonObject): Promise<Json> {
    return this.mutations.run(async () => {
      this.active(); const name = string(payload.name);
      if (!validName(name)) throw new IpcHandlerError('BAD_REQUEST', 'A valid skill name is required');
      if (typeof payload.enabled !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'enabled must be a boolean');
      withSettingsTransaction(this.configRoot, db => {
        const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('skill:' + name)?.value;
        let value: JsonObject = {}; if (typeof raw === 'string') try { value = object(JSON.parse(raw)); } catch { /* Replace a legacy preference while retaining valid objects. */ }
        db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('skill:' + name, JSON.stringify({ ...value, enabled: payload.enabled === true }));
      });
      try { await this.deps.onChanged(); return null; }
      catch (error) { return { ok: false, saved: true, reloadRequired: true, error: 'Skill preference was saved, but live sessions could not reload: ' + errorMessage(error) }; }
    });
  }
  uninstall(payload: JsonObject): Promise<Json> {
    let scope: SkillScope | undefined;
    return this.mutations.run(async () => {
      this.active(); const name = string(payload.name); if (!validName(name)) return false;
      if (!scope) return false;
      const path = await managedPath(scope.base, name);
      try { await stat(path); } catch (error) { if (missing(error)) return false; throw error; }
      await rm(path, { recursive: true });
      if (!scope.projectRoot) {
        withSettingsTransaction(this.configRoot, db => { db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('skill:' + name, ''); });
        const recordPath = await managedPath(this.configRoot, 'skills/.install-records.json'), raw = await optionalDocument(recordPath);
        if (raw !== undefined) {
          let value: JsonObject | undefined; try { value = object(JSON.parse(raw)); } catch { /* An unreadable record cannot identify an entry to remove. */ }
          if (value && Array.isArray(value.records)) {
            const records = value.records.filter(record => object(record).slug !== name);
            if (records.length !== value.records.length) await atomicDocument(this.configRoot, 'skills/.install-records.json', JSON.stringify({ ...value, records }, null, 2) + '\n');
          }
        }
      }
      try { await this.deps.onChanged(scope.projectRoot); return true; }
      catch (error) { return { ok: false, removed: true, reloadRequired: true, error: 'Skill was removed, but live sessions could not reload: ' + errorMessage(error) }; }
    }, async () => {
      if (!validName(string(payload.name))) return [];
      try { scope = await this.scope(payload.projectRoot, true); return [scope.root]; } catch { return []; }
    });
  }
  async readFile(payload: JsonObject): Promise<Json> {
    try {
      this.active(); const input = string(payload.filePath); if (!input || input.includes('\0')) throw new Error('invalid-path');
      let scope = await this.scope(undefined);
      if (isAbsolute(input)) for (const root of registeredRoots(this.deps.workspaces)) {
        const candidate = await this.scope(root, true);
        if (resolve(input) !== candidate.base && pathInside(resolve(input), candidate.base)) { scope = candidate; break; }
      }
      const absolute = isAbsolute(input) ? resolve(input) : resolve(scope.base, input);
      if (!pathInside(absolute, scope.base)) {
        const bundled = isAbsolute(input) ? await this.deps.bundledSkills?.() ?? [] : [];
        this.active();
        // The host catalog grants one exact definition, never its directory.
        if (!bundled.some(row => typeof row.path === 'string' && row.path === absolute)) throw new Error('path-escape');
        return await readSkillPreview(await managedPath(dirname(absolute), basename(absolute)));
      }
      return await readSkillPreview(await managedPath(scope.base, relative(scope.base, absolute)));
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async openWindow(payload: JsonObject): Promise<Json> {
    try {
      this.active(); const name = string(payload.name);
      if (!name || /[/\\\0]/.test(name) || name === '.' || name === '..') throw new Error('invalid name');
      const scope = await this.scope(payload.projectRoot, true), path = await managedPath(scope.base, join(name, 'SKILL.md'));
      await this.deps.openPreviewWindow({ kind: 'skill', filePath: path }); return { ok: true };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async builtin(): Promise<Json> {
    this.active(); const rows: JsonObject[] = []; let error: Json = null;
    try {
      const reply = object(await this.deps.request('engine/builtinSkills', {}));
      if (reply.error !== undefined) throw reply.error;
      if (!Array.isArray(reply.builtinSkills)) throw new Error('Invalid engine builtin skills reply');
      for (const value of reply.builtinSkills) {
        const row = object(value); if (typeof row.name === 'string') rows.push(builtinRow(row.name, string(row.description), row.userInvocable !== false));
      }
    } catch (reason) { error = { message: errorMessage(reason) }; }
    for (const command of BUNDLED_COMMANDS) if (command.loadedFrom === 'builtin-skill' && !rows.some(row => row.dirName === command.name)) rows.push(builtinRow(string(command.name), string(command.description), command.userInvocable !== false));
    for (const skill of await this.deps.bundledSkills?.() ?? []) if (!rows.some(row => row.dirName === skill.name)) rows.push(builtinRow(string(skill.name), string(skill.description), skill.userInvocable !== false));
    rows.sort((a, b) => string(a.name).localeCompare(string(b.name))); return { items: rows, error };
  }
  async close(): Promise<void> { this.closed = true; await this.mutations.close(); }
}
