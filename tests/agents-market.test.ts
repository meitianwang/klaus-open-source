import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMarketService } from '../main/agents-market/service';
import { registerAgentMarketHandlers } from '../main/ipc/handlers/agents-market';
import { ChannelRegistry } from '../main/ipc/registry';
import { FileExtensionService } from '../main/services/extensions/management';
import { WorkspaceStore } from '../main/services/workspaces';
import { object, type JsonObject } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import { present } from './extension-market-fixture';
import { Harness } from './harness';

const h = new Harness();

// The published artifact is a plain agent file: exactly what a hand-authored
// ~/.klaus/agents/<id>.md looks like, with no marketplace metadata in it.
const AGENT_MD = '---\nname: frontend-studio\ndescription: "写前端页面与界面时用这个智能体"\ntools: "*"\nmodel: high\n---\n# 角色\n\n前端实现专家。\n';

interface Fixture {
  root: string;
  marketDir: string;
  origin: string;
  requests: string[];
  changes: string[];
  trashed: string[];
  service: AgentMarketService;
  extensions: FileExtensionService;
  registry: ChannelRegistry;
  invoke: (channel: string, payload?: JsonObject) => Json | Promise<Json>;
  route: (respond: (request: IncomingMessage, response: ServerResponse) => void) => void;
  close: () => Promise<void>;
}

function catalogItem(overrides: JsonObject = {}): JsonObject {
  return {
    slug: 'frontend-studio', nameCn: '前端工作室', displayName: 'Frontend Studio',
    summary: 'builds pages', descriptionCn: '写前端页面', author: 'fixture-author', model: 'high',
    latestVersion: { version: '1.0.0' }, downloadFile: 'frontend-studio.md', ...overrides,
  };
}

/**
 * A fixture market server plus a REAL FileExtensionService. Install is wired to
 * the production `agentsSave`, so these cases exercise the same validation,
 * duplicate-name refusal, atomic write and change notification a user gets —
 * a stub writer here would prove nothing about the seam that matters.
 */
async function fixture(options: { catalog?: JsonObject; artifacts?: Record<string, string>; local?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'klaus-agents-market-'));
  const marketDir = join(root, 'market-catalog'), configRoot = join(root, 'config');
  await mkdir(join(marketDir, 'agents'), { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(marketDir, 'agents-catalog.json'), JSON.stringify(options.catalog ?? { items: [catalogItem()] }));
  for (const [name, body] of Object.entries({ 'frontend-studio.md': AGENT_MD, ...options.artifacts })) {
    await mkdir(join(marketDir, 'agents', name.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    await writeFile(join(marketDir, 'agents', name), body);
  }

  const requests: string[] = [];
  let respond: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => { response.writeHead(404); response.end(); };
  const server = createServer((request, response) => { requests.push(request.url ?? ''); respond(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The default route serves the fixture catalog the way the web service does.
  respond = (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    if (url.pathname === '/api/market/agents') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const items = (JSON.parse(JSON.stringify(options.catalog ?? { items: [catalogItem()] })).items as JsonObject[])
        .filter(item => !query || JSON.stringify(item).toLowerCase().includes(query));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ items, nextCursor: null, total: items.length, query }));
      return;
    }
    if (url.pathname === '/api/market/agents/download') {
      const slug = url.searchParams.get('slug') ?? '';
      const item = (JSON.parse(JSON.stringify(options.catalog ?? { items: [catalogItem()] })).items as JsonObject[])
        .find(entry => entry.slug === slug);
      const file = item?.downloadFile;
      if (typeof file !== 'string') { response.writeHead(404); response.end(); return; }
      const version = url.searchParams.get('version') ?? '';
      const latest = object(item?.latestVersion).version;
      if (version && version !== 'latest' && version !== latest) {
        response.writeHead(409, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'version_unavailable' }));
        return;
      }
      void readFile(join(marketDir, 'agents', file)).then(bytes => {
        response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': bytes.length });
        response.end(bytes);
      }, () => { response.writeHead(404); response.end(); });
      return;
    }
    response.writeHead(404);
    response.end();
  };

  const changes: string[] = [], trashed: string[] = [];
  const workspaces = new WorkspaceStore({ configRoot, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const extensions = new FileExtensionService({
    workspaces, configRoot, trashPath: async path => { trashed.push(path); },
    onChanged: async kind => { changes.push(kind); },
  });
  const service = new AgentMarketService({
    configRoot,
    saveAgent: payload => extensions.agentsSave(payload),
    endpoint: () => ({ baseUrl: origin }),
    ...(options.local ? { marketDirectory: marketDir } : {}),
  });
  const registry = new ChannelRegistry();
  registerAgentMarketHandlers(registry, service);

  return {
    root, marketDir, origin, requests, changes, trashed, service, extensions, registry,
    invoke: (channel: string, payload?: JsonObject) => {
      const handler = registry.lookup(channel);
      if (!handler) throw new Error('Missing fixture handler: ' + channel);
      return handler({ role: 'main', senderId: 1, channel, args: payload === undefined ? [] : [payload] });
    },
    route: next => { respond = next; },
    close: async () => {
      await service.close();
      await extensions.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

void (async () => {
  await h.test('the plaza registers exactly two channels and leaves removal to the existing agent file path', async () => {
    const f = await fixture();
    try { assert.deepEqual(f.registry.channels(), ['agents:install', 'agents:market']); }
    finally { await f.close(); }
  });

  await h.test('the market lists a published agent with its display metadata and an uninstalled state', async () => {
    const f = await fixture();
    try {
      const page = object(await f.service.market({}));
      assert.equal(page.isRemote, true);
      const items = page.items as JsonObject[];
      assert.equal(items.length, 1);
      assert.deepEqual(items[0], {
        slug: 'frontend-studio', name: '前端工作室', description: '写前端页面', installed: false, hasUpdate: false,
        latestVersion: '1.0.0', author: 'fixture-author', model: 'high',
      });
      assert.deepEqual(f.requests, ['/api/market/agents']);
    } finally { await f.close(); }
  });

  await h.test('install writes the real agent file, records its version and invalidates live sessions', async () => {
    const f = await fixture();
    try {
      const result = object(await f.service.install({ slug: 'frontend-studio', version: '1.0.0' }));
      assert.equal(result.ok, true);
      assert.equal(result.id, 'frontend-studio');
      const path = join(f.root, 'config/agents/frontend-studio.md');
      assert.equal(await present(path), true);
      assert.equal(await readFile(path, 'utf8'), AGENT_MD.trimEnd() + '\n');
      const records = JSON.parse(await readFile(join(f.root, 'config/agents/.install-records.json'), 'utf8'));
      assert.deepEqual(records.records, [{ slug: 'frontend-studio', version: '1.0.0', source: 'market', installedAt: records.records[0].installedAt }]);
      // The install must reach the same change notification a hand-authored
      // agent save does, or open sessions keep a roster without the new agent.
      assert.deepEqual(f.changes, ['agents']);
      // The installed agent is a normal user definition: it shows up in the
      // roster the Agents page reads, and the plaza card flips to installed.
      const list = object(await f.extensions.agentsList());
      const rows = list.agents as JsonObject[];
      assert.equal(rows.some(row => row.agentType === 'frontend-studio' && row.source === 'userSettings'), true);
      const page = object(await f.service.market({}));
      assert.equal(object((page.items as JsonObject[])[0]).installed, true);
    } finally { await f.close(); }
  });

  await h.test('a newer published version marks the installed agent as updatable', async () => {
    const f = await fixture();
    try {
      assert.equal(object(await f.service.install({ slug: 'frontend-studio', version: '1.0.0' })).ok, true);
      f.route((request, response) => {
        const url = new URL(request.url ?? '/', f.origin);
        if (url.pathname === '/api/market/agents') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ items: [catalogItem({ latestVersion: { version: '1.1.0' } })], nextCursor: null, total: 1 }));
          return;
        }
        response.writeHead(404); response.end();
      });
      const row = object((object(await f.service.market({})).items as JsonObject[])[0]);
      assert.equal(row.installed, true);
      assert.equal(row.hasUpdate, true);
      assert.equal(row.version, '1.0.0');
      assert.equal(row.latestVersion, '1.1.0');
    } finally { await f.close(); }
  });

  await h.test('a downloaded file with no name, no description or no prompt is refused before anything is written', async () => {
    for (const [label, body] of [
      ['no frontmatter', '# Role\n\nNo frontmatter at all.\n'],
      ['no name', '---\ndescription: builds pages\n---\n# Role\n'],
      ['no description', '---\nname: frontend-studio\n---\n# Role\n'],
      ['no prompt body', '---\nname: frontend-studio\ndescription: builds pages\n---\n'],
      ['broken fence', '---\nname: frontend-studio\ndescription: builds pages\n# Role\n'],
    ] as const) {
      const f = await fixture({ artifacts: { 'frontend-studio.md': body } });
      try {
        const result = object(await f.service.install({ slug: 'frontend-studio' }));
        assert.equal(result.ok, false, label);
        assert.equal(typeof result.error === 'string' && result.error.length > 0, true, label);
        assert.equal(await present(join(f.root, 'config/agents/frontend-studio.md')), false, label);
        assert.equal(await present(join(f.root, 'config/agents/.install-records.json')), false, label);
        assert.deepEqual(f.changes, [], label);
      } finally { await f.close(); }
    }
  });

  await h.test('a slug may not be a path, and an unknown or invalid slug is refused', async () => {
    const f = await fixture();
    try {
      for (const slug of ['../escape', 'a/b', '', '.', 'trailing.']) {
        const result = object(await f.service.install({ slug }));
        assert.equal(result.ok, false, slug);
        assert.equal(result.error, 'Invalid agent name', slug);
      }
      const unknown = object(await f.service.install({ slug: 'absent' }));
      assert.equal(unknown.ok, false);
      assert.equal(String(unknown.error).includes('HTTP 404'), true);
      assert.equal(await present(join(f.root, 'config/agents/absent.md')), false);
      // 路径形的 slug 在发出请求之前就被拒了，所以只有 absent 这一次下载尝试。
      assert.deepEqual(f.requests.filter(url => url.startsWith('/api/market/agents/download')),
        ['/api/market/agents/download?slug=absent']);
    } finally { await f.close(); }
  });

  await h.test('an install whose name is already taken by another agent file is refused instead of shadowing it', async () => {
    const f = await fixture();
    try {
      // A hand-authored file with the SAME agent name but a different file id.
      await mkdir(join(f.root, 'config/agents'), { recursive: true });
      await writeFile(join(f.root, 'config/agents/mine.md'), AGENT_MD);
      const result = object(await f.service.install({ slug: 'frontend-studio' }));
      assert.equal(result.ok, false);
      assert.match(String(result.error), /already defines the name/);
      assert.equal(await present(join(f.root, 'config/agents/frontend-studio.md')), false);
      assert.equal(await readFile(join(f.root, 'config/agents/mine.md'), 'utf8'), AGENT_MD);
    } finally { await f.close(); }
  });

  await h.test('a server error surfaces as an error row set, never as a crashed tab', async () => {
    const f = await fixture();
    try {
      f.route((_request, response) => { response.writeHead(503); response.end('nope'); });
      const page = object(await f.service.market({}));
      assert.deepEqual(page.items, []);
      assert.equal(page.isRemote, false);
      assert.equal(typeof page.error === 'string' && page.error.length > 0, true);
    } finally { await f.close(); }
  });

  await h.test('a catalog row without a usable slug is dropped rather than rendered as a dead card', async () => {
    const f = await fixture({ catalog: { items: [catalogItem(), { displayName: 'slugless' }, { slug: '../escape' }, null] } });
    try {
      const items = object(await f.service.market({})).items as JsonObject[];
      assert.deepEqual(items.map(item => item.slug), ['frontend-studio']);
    } finally { await f.close(); }
  });

  await h.test('the local mirror needs no HTTP and refuses an artifact outside its agents directory', async () => {
    const f = await fixture({ local: true, catalog: { items: [
      catalogItem(),
      catalogItem({ slug: 'escape', downloadFile: '../secret.md' }),
      catalogItem({ slug: 'zipped', downloadFile: 'frontend-studio.zip' }),
    ] } });
    try {
      await writeFile(join(f.marketDir, 'secret.md'), AGENT_MD);
      const page = object(await f.service.market({}));
      assert.equal(page.isRemote, false);
      assert.deepEqual((page.items as JsonObject[]).map(item => item.slug), ['frontend-studio', 'escape', 'zipped']);
      assert.deepEqual(f.requests, []);
      assert.equal(object(await f.service.install({ slug: 'frontend-studio' })).ok, true);
      assert.equal(await readFile(join(f.root, 'config/agents/frontend-studio.md'), 'utf8'), AGENT_MD.trimEnd() + '\n');
      for (const slug of ['escape', 'zipped']) {
        const result = object(await f.service.install({ slug }));
        assert.equal(result.ok, false, slug);
      }
      assert.equal(await present(join(f.root, 'config/agents/escape.md')), false);
      assert.equal(await present(join(f.root, 'config/agents/zipped.md')), false);
    } finally { await f.close(); }
  });

  await h.test('the local mirror is only honoured for an absolute directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-agents-relative-'));
    try {
      const service = new AgentMarketService({
        configRoot: join(root, 'config'), saveAgent: async () => ({ ok: true }),
        endpoint: () => undefined, environment: { KLAUS_AGENTS_MARKET_DIR: 'relative/market' },
      });
      const page = object(await service.market({}));
      assert.deepEqual(page.items, []);
      assert.match(String(page.error), /absolute/);
      await service.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  await h.test('a missing endpoint is an empty plaza, not a thrown error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-agents-noendpoint-'));
    try {
      const service = new AgentMarketService({ configRoot: root, saveAgent: async () => ({ ok: true }), endpoint: () => undefined });
      const page = object(await service.market({}));
      assert.deepEqual(page, { items: [], nextCursor: null, isRemote: false });
      const install = object(await service.install({ slug: 'frontend-studio' }));
      assert.equal(install.ok, false);
      await service.close();
      const closed = object(await service.market({}).then(value => value, error => ({ ok: false, error: String(error) })));
      assert.equal(closed.ok === false || Array.isArray(closed.items), true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  process.exitCode = await h.finish(join(__dirname, 'agents-market.result.json'), 'agents-market');
})();
