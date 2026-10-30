import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerExternalAgentImportHandlers } from '../main/ipc/handlers/external-agent-import';
import { ExternalAgentImportService, type ExternalAgentImportDeps } from '../main/external-agent-import/service';
import { WorkspaceStore } from '../main/services/workspaces';
import { SkillService } from '../main/services/extensions/skills';
import { HookStyleService } from '../main/services/extensions/hooks-styles';
import { McpConfigurationService } from '../main/services/mcp/configuration';
import { object, string, type EngineRequest, type JsonObject } from '../main/services/service-types';
export { put } from './feedback-fixture';

export async function importFixture(extra: Partial<ExternalAgentImportDeps> = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'klaus-external-fixture-'))), home = join(temp, 'home'), ws = join(temp, 'workspace with space'), root = join(home, '.klaus');
  await mkdir(home); await mkdir(ws);
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, pickDirectory: async () => null, onSessionWorkdirChanged: () => {} });
  const calls: Array<{ method: string; params: JsonObject }> = [], values: JsonObject = {}, persisted = new Map<string, JsonObject>();
  let hooks: JsonObject = {}, version = 0, loseReply = false, beforeWrite: (() => void) | undefined, afterWrite: (() => JsonObject) | undefined;
  const request: EngineRequest = async (method, raw) => {
    const params = object(raw); calls.push({ method, params: structuredClone(params) });
    if (method === 'config/read') return { values: structuredClone(values), version: 'v' + version };
    if (method === 'config/batchWrite') {
      beforeWrite?.(); if (params.expectedVersion !== 'v' + version) throw new Error('fixture config conflict');
      for (const raw of params.edits as Json[]) { const edit = object(raw); Object.defineProperty(values, string(edit.keyPath), { value: structuredClone(edit.value), enumerable: true, configurable: true, writable: true }); }
      version++; return afterWrite?.() ?? { values: structuredClone(values), version: 'v' + version };
    }
    if (method === 'hooks/read') return { hooks: structuredClone(hooks), path: join(root, 'hooks.json'), events: [] };
    if (method === 'hooks/write') { hooks = structuredClone(object(params.hooks)); return { hooks, path: join(root, 'hooks.json'), events: [] }; }
    if (method === 'engine/importExternalSession') {
      const id = string(params.threadId), prior = persisted.get(id); if (prior && JSON.stringify(prior) !== JSON.stringify(params)) throw new Error('fixture import conflict');
      persisted.set(id, structuredClone(params)); if (loseReply) { loseReply = false; throw new Error('fixture lost reply'); }
      return { threadId: id, persisted: true, alreadyImported: Boolean(prior), messageCount: (params.messages as Json[]).length };
    }
    throw new Error('Unexpected named method: ' + method);
  };
  const changes: string[] = [];
  const skills = new SkillService({ workspaces, request, onChanged: async () => { changes.push('skills'); }, openPreviewWindow: async () => { throw new Error('No fixture windows'); } });
  const hookService = new HookStyleService({ workspaces, request, userHome: home, onChanged: async () => { changes.push('hooks'); } });
  const mcp = new McpConfigurationService({ workspaces, request, onChanged: async () => { changes.push('mcp'); } });
  const plugins = { install: async (params: JsonObject): Promise<Json> => { calls.push({ method: 'plugin-owner/install', params }); return { ok: true }; },
    toggle: async (params: JsonObject): Promise<Json> => { calls.push({ method: 'plugin-owner/toggle', params }); return { ok: true }; } };
  const service = new ExternalAgentImportService({ home, workspaces, request, skills, hooks: hookService, mcp, plugins, onChanged: () => { changes.push('import'); }, ...extra });
  const registry = new ChannelRegistry(); registerExternalAgentImportHandlers(registry, service);
  return { temp, home, ws, root, service, registry, workspaces, calls, values, persisted, changes, request,
    hooks: () => hooks, loseNextImportReply: () => { loseReply = true; }, advanceVersion: () => { version++; },
    beforeWrite: (handler?: () => void) => { beforeWrite = handler; }, afterWrite: (handler?: () => JsonObject) => { afterWrite = handler; },
    invoke: (channel: string, payload?: Json) => registry.lookup(channel)!({ role: 'main', channel, senderId: 1, args: payload === undefined ? [] : [payload] }),
    close: async () => { await service.close(); await skills.close(); await hookService.close(); await mcp.close(); await rm(temp, { recursive: true, force: true }); },
  };
}
export type ImportFixture = Awaited<ReturnType<typeof importFixture>>;
export const contractRoot = join(__dirname, '../../contracts/vectors');
export async function materialize(spec: JsonObject, root: string, now: number): Promise<void> {
  const escaped = JSON.stringify(root).slice(1, -1);
  for (const [name, data] of Object.entries(object(spec.files))) {
    const path = join(root, name); await mkdir(dirname(path), { recursive: true });
    let body = String(data).replaceAll('$ROOT', escaped).replaceAll('$RECENT_TS_PLUS_5S', new Date(now - 3_595_000).toISOString()).replaceAll('$RECENT_TS', new Date(now - 3_600_000).toISOString());
    if (process.platform === 'win32' && name.endsWith('workspace.json')) {
      const data = JSON.parse(body); if (typeof data.folder === 'string' && data.folder.startsWith('file://' + root)) data.folder = pathToFileURL(data.folder.slice(7)).href; body = JSON.stringify(data);
    }
    await writeFile(path, body);
  }
  for (const name of spec.emptyDirs as string[]) await mkdir(join(root, name), { recursive: true });
  for (const [name, target] of Object.entries(object(spec.symlinks))) { await mkdir(dirname(join(root, name)), { recursive: true }); await symlink(join(root, String(target)), join(root, name), process.platform === 'win32' ? 'junction' : 'dir'); }
  for (const [name, seconds] of Object.entries(object(spec.mtimeOffsetsSecs))) { const time = new Date(now + Number(seconds) * 1000); await utimes(join(root, name), time, time); }
}
export function scrub(value: unknown, f: Pick<ImportFixture, 'home' | 'ws'>): unknown {
  if (typeof value === 'string') return value.replaceAll(f.home, '<HOME>').replaceAll(f.ws, '<WS>').replaceAll('\\', '/');
  if (Array.isArray(value)) return value.map(item => scrub(item, f));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, f)])); return value;
}
export function substitute(value: unknown, f: Pick<ImportFixture, 'home' | 'ws'>): Json {
  if (typeof value === 'string') return value.replaceAll('<HOME>', f.home).replaceAll('<WS>', f.ws);
  if (Array.isArray(value)) return value.map(item => substitute(item, f));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, f)])); return value as Json;
}
export async function vectors(): Promise<{ spec: JsonObject; reference: JsonObject }> {
  return { spec: JSON.parse(await readFile(join(contractRoot, 'external-agents-fixture.json'), 'utf8')), reference: JSON.parse(await readFile(join(contractRoot, 'external-agents-vectors.json'), 'utf8')) };
}
