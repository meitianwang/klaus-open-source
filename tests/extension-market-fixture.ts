import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerSkillMarketHandlers } from '../main/ipc/handlers/skills-market';
import { registerPluginMarketplaceHandlers } from '../main/ipc/handlers/plugin-marketplaces';
import { SkillMarketService, type SkillMarketDeps } from '../main/skills-market/service';
import { PluginMarketplaceService, type PluginMarketplaceDeps } from '../main/services/extensions/marketplaces';
import { PluginService } from '../main/services/extensions/plugins';
import { SkillService } from '../main/services/extensions/skills';
import { WorkspaceStore } from '../main/services/workspaces';
import { object, string, type EngineRequest, type JsonObject } from '../main/services/service-types';
export { zip } from './archive-bytes-fixture';

export async function put(path: string, content: string | Buffer): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
export async function present(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
export type Respond = (request: IncomingMessage, response: ServerResponse) => void;
export async function marketFixture(options: { skills?: Partial<SkillMarketDeps>; marketplaces?: Partial<PluginMarketplaceDeps> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-extension-market-')), resources = join(root, 'resources');
  const requests: Array<{ url: string; authorization?: string }> = [];
  let respond: Respond = (_request, response) => { response.writeHead(404); response.end(); };
  const server = createServer((request, response) => { requests.push({ url: request.url ?? '', authorization: request.headers.authorization }); respond(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const calls: Array<{ method: string; params: JsonObject }> = [], values: JsonObject = { plugins: {}, marketplaces: {} };
  let version = 0, beforeWrite: (() => void | Promise<void>) | undefined, afterWrite: (() => unknown) | undefined, readFailure = false;
  const request: EngineRequest = async (method, params) => {
    const data = object(params); calls.push({ method, params: structuredClone(data) });
    if (method === 'config/read') { if (readFailure) throw new Error('fixture engine disconnected'); return { values: structuredClone(values), version: 'v' + version }; }
    if (method === 'session/installedPlugins') return { installedPlugins: { version: 1, plugins: structuredClone(values.plugins) } };
    if (method === 'config/batchWrite') {
      await beforeWrite?.();
      if (data.expectedVersion !== 'v' + version) throw new Error('fixture version conflict');
      for (const value of data.edits as Json[]) {
        const edit = object(value), path = string(edit.keyPath);
        if (!path.startsWith('marketplaces.') || edit.mergeStrategy !== 'replace') throw new Error('Unexpected non-marketplace config edit');
        const name = JSON.parse(path.slice('marketplaces.'.length)) as string;
        Object.defineProperty(object(values.marketplaces), name, { value: structuredClone(edit.value), writable: true, enumerable: true, configurable: true });
      }
      version++;
      if (afterWrite) return afterWrite();
      return { values: structuredClone(values), version: 'v' + version };
    }
    throw new Error('Unexpected engine method: ' + method);
  };
  const changes: string[] = [];
  const skills = new SkillService({ workspaces, request, onChanged: async () => { changes.push('skills'); }, openPreviewWindow: async () => { throw new Error('This fixture has no windows'); },
    environment: async () => ({ PATH: '', FIXTURE_EMPTY: '' }), platform: 'darwin' });
  // The production client ships no bundled free catalog anymore; the fixture
  // keeps the explicit-directory override so local-catalog cases stay covered.
  const market = new SkillMarketService({ skills, marketDirectory: join(resources, 'skills-market'), endpoint: () => undefined, environment: {}, onChanged: () => { changes.push('skills'); }, ...options.skills });
  const plugins = new PluginService({ configRoot: root, seedDir: join(resources, 'plugins-seed'), request,
    requestAcknowledged: async (method, params, field) => {
      calls.push({ method, params: structuredClone(params) });
      if (method !== 'session/pluginCatalog' || field !== 'pluginCatalog') throw new Error('Plugin installs are not part of this marketplace fixture');
      return { entries: [] };
    }, onChanged: () => { throw new Error('No plugin ledger mutation is allowed in this fixture'); }, binding: () => undefined,
    resolveSession: async () => { throw new Error('No session creation is allowed in this fixture'); } });
  const environment = { ...process.env, HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-git-config'),
    KLAUS_PLUGIN_GCS_BASE: origin, KLAUS_PLUGIN_OFFICIAL_GIT_URL: pathToFileURL(join(root, 'missing.git')).href };
  await writeFile(environment.GIT_CONFIG_GLOBAL, '');
  const marketplaces = new PluginMarketplaceService({ workspaces, plugins, request, seedDir: join(resources, 'plugins-seed'), environment,
    gitOptions: { env: environment, timeoutMs: 5000 }, onChanged: () => { changes.push('marketplaces'); }, ...options.marketplaces });
  const registry = new ChannelRegistry(); registerSkillMarketHandlers(registry, market); registerPluginMarketplaceHandlers(registry, marketplaces);
  let closed = false;
  return { root, resources, origin, requests, calls, values, request, workspaces, skills, market, plugins, marketplaces, registry, changes, environment,
    route: (handler: Respond) => { respond = handler; },
    beforeWrite: (handler?: () => void | Promise<void>) => { beforeWrite = handler; },
    afterWrite: (handler?: () => unknown) => { afterWrite = handler; },
    failReads: (value: boolean) => { readFailure = value; },
    advanceVersion: () => { version++; },
    invoke: (channel: string, payload?: Json) => {
      const handler = registry.lookup(channel); if (!handler) throw new Error('Missing fixture handler: ' + channel);
      return handler({ role: 'main', senderId: 1, channel, args: payload === undefined ? [] : [payload] });
    },
    close: async () => {
      if (closed) return; closed = true;
      await market.close(); await marketplaces.close(); await skills.close(); await plugins.close();
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type MarketFixture = Awaited<ReturnType<typeof marketFixture>>;
export async function localRepository(root: string, name: string, marketName: string): Promise<{ path: string; url: string; commit(): Promise<string> }> {
  const directory = join(root, 'repositories', name), template = join(root, 'empty-template');
  await mkdir(directory, { recursive: true }); await mkdir(template, { recursive: true });
  const env = { ...process.env, HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-git-config') };
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Fixture git command failed'); return result.stdout.trim();
  };
  git(['init', '--initial-branch=main', '--template=' + template]);
  await put(join(directory, '.claude-plugin/marketplace.json'), JSON.stringify({ name: marketName, plugins: [{ name: 'fixture', source: './plugins/fixture' }] }));
  await put(join(directory, 'plugins/fixture/.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  const commit = async () => { git(['add', '.']); git(['commit', '-m', 'fixture content']); return git(['rev-parse', 'HEAD']); };
  await commit();
  return { path: directory, url: pathToFileURL(directory).href, commit };
}
export async function records(root: string): Promise<JsonObject[]> { return object(JSON.parse(await readFile(join(root, 'skills/.install-records.json'), 'utf8'))).records as JsonObject[]; }
