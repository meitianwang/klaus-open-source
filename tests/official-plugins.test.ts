import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Json } from '../main/ipc/contract';
import { OfficialPluginsService, OFFICIAL_MARKETPLACE } from '../main/services/extensions/official-plugins';
import { PluginCatalog } from '../main/services/extensions/plugin-catalog';
import { object, type JsonObject } from '../main/services/service-types';
import { sha256 as digest, zip } from './archive-bytes-fixture';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';

const h = new Harness();

interface Values { values: JsonObject; version: string }
function engine(values: Values, calls: Array<{ method: string; params: JsonObject }>) {
  return async (method: string, params: Json): Promise<Json> => {
    calls.push({ method, params: object(params) });
    if (method === 'config/read') return { values: values.values, version: values.version };
    if (method === 'session/installedPlugins') return { installedPlugins: { version: 2, plugins: object(values.values.plugins) } };
    if (method === 'session/migrateBundledDiagram') {
      const builtin = object(object(values.values.plugins)['digram@builtin']);
      if (builtin.source !== 'builtin') return { migrated: false, restartRequired: false };
      const plugins = object(values.values.plugins);
      plugins['digram@klaus-official'] ??= { name: 'digram', source: 'marketplace:klaus-official',
        installPath: '/engine/store/digram', enabled: builtin.enabled !== false };
      delete plugins['digram@builtin'];
      return { migrated: true, restartRequired: true };
    }
    if (method === 'config/batchWrite') {
      const edits = (object(params).edits ?? []) as Array<{ keyPath: string; value?: Json; mergeStrategy: string }>;
      for (const edit of edits) {
        const head = edit.keyPath.split('.')[0]!, key = edit.keyPath.slice(edit.keyPath.indexOf('.') + 1);
        if (head !== 'marketplaces') throw new Error('Host may not write the engine plugin ledger or unknown config keys');
        if (head === 'marketplaces') {
          const name = JSON.parse(key);
          if (edit.mergeStrategy === 'delete') delete object(values.values[head])[name];
          else object(values.values[head])[name] = edit.value as JsonObject;
        }
      }
      values.version = 'v' + (Number(values.version.slice(1)) + 1);
      return { values: values.values, version: values.version };
    }
    throw new Error('Unexpected engine method: ' + method);
  };
}
const archive = () => zip([
  { name: 'marketplaces/klaus-official/.claude-plugin/marketplace.json', bytes: Buffer.from(JSON.stringify({ name: OFFICIAL_MARKETPLACE, plugins: [{ name: 'digram', source: './plugins/digram' }] })) },
  { name: 'marketplaces/klaus-official/plugins/digram/plugin.json', bytes: Buffer.from(JSON.stringify({ name: 'digram', version: '1.0.0' })) },
  { name: 'marketplaces/klaus-official/plugins/digram/icons/index.json', bytes: Buffer.from('{"phosphor:cpu":"M0 0"}') },
]);

void (async () => {
await h.test('the official marketplace mirrors into the profile cache and registers once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const bytes = archive();
  const sha = 'a'.repeat(64);
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(request.url ?? '');
    if (request.url === '/api/market/plugins/latest') { response.writeHead(200); response.end(sha); return; }
    if (request.url === `/api/market/plugins/${sha}.zip`) { response.writeHead(200, { 'content-type': 'application/zip' }); response.end(bytes); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let changed = 0;
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: async () => { changed++; } });
  try {
    const revision = await service.refresh(new AbortController().signal);
    assertEqual(revision, sha, 'revision reported');
    const manifest = JSON.parse(await readFile(join(root, 'plugins/marketplaces/klaus-official/.claude-plugin/marketplace.json'), 'utf8'));
    assertEqual(manifest.name, OFFICIAL_MARKETPLACE, 'mirrored manifest');
    const entry = object(object(values.values.marketplaces)[OFFICIAL_MARKETPLACE]);
    assertEqual(entry.installLocation, join(root, 'plugins/marketplaces/klaus-official'), 'registered location');
    assertEqual(changed, 0, 'mirror alone does not mutate plugin rows');
    // A second refresh with the same revision must not re-download the archive.
    // The catalog is probed on every refresh — that is how a client learns
    // whether the server publishes one — so the request count grows by that probe
    // plus the revision pointer, never by the archive itself.
    const archives = () => requests.filter(url => url.endsWith('.zip')).length;
    const before = archives(), writes = calls.filter(call => call.method === 'config/batchWrite').length;
    assertEqual(await service.refresh(new AbortController().signal), sha, 'second refresh');
    assertEqual(archives(), before, 'the archive is not re-downloaded');
    assertEqual(calls.filter(call => call.method === 'config/batchWrite').length, writes, 'an unchanged revision is not re-registered');
  } finally { await service.close(); server.close(); }
});

await h.test('a server without official plugins is a quiet no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => { response.writeHead(404); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: async () => {} });
  try {
    assertEqual(await service.refresh(new AbortController().signal), undefined, 'no revision');
    assertEqual(calls.filter(call => call.method === 'config/batchWrite').length, 0, 'nothing written');
  } finally { await service.close(); server.close(); }
});

await h.test('bundled digram records migrate to the official install and keep enablement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const location = join(root, 'plugins/marketplaces/klaus-official');
  await mkdir(join(location, 'plugins/digram'), { recursive: true });
  await writeFile(join(location, 'plugins/digram/plugin.json'), '{}');
  const values: Values = { values: { plugins: { 'digram@builtin': { name: 'digram', source: 'builtin', installPath: '/old/bundled', enabled: false } }, marketplaces: {} }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let changed = 0;
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => undefined, onChanged: async () => { changed++; } });
  try {
    const result = object(await service.migrateBundledRecords(new AbortController().signal));
    assertDeepEqual(result.migrated, ['digram'], 'migrated set');
    const plugins = object(values.values.plugins);
    const official = object(plugins['digram@klaus-official']);
    assertEqual(official.enabled, false, 'user disablement survives');
    assertEqual(official.installPath, '/engine/store/digram', 'engine owns the installed copy');
    assertEqual(plugins['digram@builtin'], undefined, 'bundled record retired');
    assertEqual(changed, 1, 'live reload requested');
    assertDeepEqual(calls.filter(call => call.method === 'session/migrateBundledDiagram').map(call => call.params.sourceDir),
      [join(location, 'plugins/digram')], 'only the named engine migration method writes the ledger');
    const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/plugin-rpc-vectors.json'), 'utf8'));
    assertEqual(calls.find(call => call.method === vector.requests.legacyDiagramMigration.method)?.method,
      vector.requests.legacyDiagramMigration.method, 'migration uses the pinned named facade');
    const again = object(await service.migrateBundledRecords(new AbortController().signal));
    assertDeepEqual(again.migrated, [], 'idempotent');
    assertEqual(changed, 1, 'no duplicate reload');
  } finally { await service.close(); }
});

await h.test('fresh and uninstalled profiles do not silently reinstall Diagram', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const location = join(root, 'plugins/marketplaces/klaus-official');
  await mkdir(join(location, 'plugins/digram'), { recursive: true });
  await writeFile(join(location, 'plugins/digram/plugin.json'), '{}');
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => undefined, onChanged: async () => {} });
  try {
    const result = object(await service.migrateBundledRecords(new AbortController().signal));
    assertDeepEqual(result.migrated, [], 'no legacy record means no automatic installation');
    assertEqual(object(values.values.plugins)['digram@klaus-official'], undefined, 'no record written');
    assertEqual(calls.filter(call => call.method === 'session/migrateBundledDiagram').length, 0, 'engine mutation skipped');
  } finally { await service.close(); }
});

await h.test('a cached official Diagram migrates while the market server is offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const sha = 'c'.repeat(64);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/api/market/plugins/latest') { response.writeHead(200); response.end(sha); return; }
    if (request.url === `/api/market/plugins/${sha}.zip`) { response.writeHead(200); response.end(archive()); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Values = { values: { plugins: { 'digram@builtin': { name: 'digram', source: 'builtin',
    installPath: '/removed/digram', enabled: false } }, marketplaces: {} }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const published = new OfficialPluginsService({ configRoot: root, request: engine(values, calls),
    endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: () => {} });
  try {
    await published.refresh(new AbortController().signal);
    await published.close();
    server.close();
    let changed = 0;
    const offline = new OfficialPluginsService({ configRoot: root, request: engine(values, calls),
      endpoint: () => undefined, onChanged: () => { changed++; } });
    try {
      await offline.initialize();
      assertEqual(object(values.values.plugins)['digram@builtin'], undefined, 'cached migration retires legacy record');
      assertEqual(object(object(values.values.plugins)['digram@klaus-official']).enabled, false, 'cached migration preserves disabled state');
      assertEqual(changed, 1, 'successful migration reloads views');
    } finally { await offline.close(); }
  } finally { if (server.listening) server.close(); }
});

await h.test('a rejected engine migration does not claim success or refresh live views', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const location = join(root, 'plugins/marketplaces/klaus-official/plugins/digram');
  await mkdir(location, { recursive: true });
  await writeFile(join(location, 'plugin.json'), '{"name":"digram"}');
  const values: Values = { values: { plugins: { 'digram@builtin': { name: 'digram', source: 'builtin',
    installPath: '/removed/digram', enabled: true } }, marketplaces: {} }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const original = engine(values, calls);
  let changed = 0;
  const service = new OfficialPluginsService({ configRoot: root,
    request: (method, params) => method === 'session/migrateBundledDiagram'
      ? Promise.resolve({ error: 'migration refused' }) : original(method, params),
    endpoint: () => undefined, onChanged: () => { changed++; } });
  try {
    let error = '';
    try { await service.migrateBundledRecords(new AbortController().signal); }
    catch (reason) { error = String(reason); }
    assert(error.includes('migration refused'), 'engine refusal surfaced');
    assertEqual(changed, 0, 'no reload after engine refusal');
    assert(object(values.values.plugins)['digram@builtin'], 'legacy record remains visible after refusal');
  } finally { await service.close(); }
});

await h.test('a foreign marketplace occupying the official cache path is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const sha = 'b'.repeat(64);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/api/market/plugins/latest') { response.writeHead(200); response.end(sha); return; }
    if (request.url === `/api/market/plugins/${sha}.zip`) { response.writeHead(200); response.end(archive()); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Values = { values: { plugins: {}, marketplaces: { squatter: { installLocation: join(root, 'plugins/marketplaces/klaus-official') } } }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: async () => {} });
  try {
    let error = '';
    try { await service.refresh(new AbortController().signal); } catch (reason) { error = String(reason instanceof Error ? reason.message : reason); }
    assert(error.includes('occupied'), 'refusal names the squatter: ' + error);
    assertEqual(object(object(values.values.marketplaces)[OFFICIAL_MARKETPLACE] ?? {}).installLocation, undefined, 'no lying registration');
  } finally { await service.close(); server.close(); }
});

// --- the per-plugin catalog path -------------------------------------------
//
// A server publishing `plugins/catalog` is served from it and never downloads
// the legacy aggregate. These tests pin that split, because the two paths share
// one cache directory and one engine registration, and a mistake in either makes
// the other's plugins disappear from the UI or fail to install.

const pluginPackage = (name: string, version: string) => zip([
  { name: 'plugin.json', bytes: Buffer.from(JSON.stringify({ name, version })) },
  { name: 'skills/' + name + '/SKILL.md', bytes: Buffer.from('# ' + name + '\n') },
]);

interface CatalogFixture {
  revision: string;
  catalog: string;
  packages: Map<string, Buffer>;
  requests: string[];
  origin: string;
  server: ReturnType<typeof createServer>;
  close: () => Promise<void>;
}

/** A market server publishing the per-plugin catalog, not the aggregate. */
async function catalogServer(plugins: Array<{ name: string; version: string; legacyCompatible?: boolean; iconDataUrl?: string; platformArchive?: Buffer }>): Promise<CatalogFixture> {
  const packages = new Map<string, Buffer>();
  const items = plugins.map(plugin => {
    const bytes = pluginPackage(plugin.name, plugin.version);
    const sha256 = digest(bytes);
    packages.set(`packages/${plugin.name}-${sha256}.zip`, bytes);
    let platformPackages: Record<string, { packageFile: string; sha256: string }> | undefined;
    if (plugin.platformArchive) {
      const platformSha = digest(plugin.platformArchive);
      packages.set(`packages/${plugin.name}-${platformSha}.zip`, plugin.platformArchive);
      platformPackages = { [`${process.platform}-${process.arch}`]: { packageFile: `packages/${plugin.name}-${platformSha}.zip`, sha256: platformSha } };
    }
    return { name: plugin.name, version: plugin.version, sha256, packageFile: `packages/${plugin.name}-${sha256}.zip`, legacyCompatible: plugin.legacyCompatible !== false, bytes: bytes.length, ...(plugin.iconDataUrl ? { iconDataUrl: plugin.iconDataUrl } : {}), ...(platformPackages ? { platformPackages } : {}) };
  });
  const revision = digest(Buffer.from(JSON.stringify(items)));
  const catalog = JSON.stringify({ schemaVersion: 1, marketplace: OFFICIAL_MARKETPLACE, revision, count: items.length, items });
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    requests.push(url);
    if (url === '/api/market/plugins/catalog') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(catalog); return; }
    const bytes = packages.get(url.replace('/api/market/plugins/', ''));
    if (bytes) { response.writeHead(200, { 'content-type': 'application/zip' }); response.end(bytes); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { revision, catalog, packages, requests, origin, server, close: async () => { server.close(); } };
}

await h.test('catalog artwork displays before download and repairs metadata discarded by older clients', async () => {
  const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/plugin-icon-vectors.json'), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-icons-'));
  const fixture = await catalogServer([{ name: 'fixture', version: '1.0.0', iconDataUrl: vector.iconDataUrl }, { name: 'invalid', version: '1.0.0', iconDataUrl: vector.rejectedValues[2] }]);
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const request = engine(values, []);
  const service = new OfficialPluginsService({ configRoot: root, request, endpoint: () => ({ baseUrl: fixture.origin, direct: false }), onChanged: () => {} });
  try {
    await service.refresh(new AbortController().signal);
    const catalog = new PluginCatalog({ request });
    let rows = (await catalog.snapshot()).rows;
    assertEqual(rows.find(row => row.id === 'fixture@klaus-official')?.iconDataUrl, vector.iconDataUrl, 'uninstalled plugin receives artwork without its package');
    assertEqual(rows.find(row => row.id === 'invalid@klaus-official')?.iconDataUrl, undefined, 'unsafe optional artwork is discarded');
    assertEqual(rows.length, 2, 'invalid artwork does not remove a catalog entry');
    const path = join(root, 'plugins/marketplaces/klaus-official/.claude-plugin/marketplace.json');
    const oldManifest = JSON.parse(await readFile(path, 'utf8'));
    delete oldManifest.plugins[0].iconDataUrl;
    await writeFile(path, JSON.stringify(oldManifest, null, 2) + '\n');
    await service.refresh(new AbortController().signal);
    rows = (await catalog.snapshot()).rows;
    assertEqual(rows.find(row => row.id === 'fixture@klaus-official')?.iconDataUrl, vector.iconDataUrl, 'same revision repairs previously dropped artwork');
    assertEqual(fixture.requests.filter(url => url.includes('/packages/')).length, 0, 'artwork never forces a package download');
  } finally { await service.close(); await fixture.close(); }
});

await h.test('artwork catalogs larger than one MiB survive cache writes and subsequent refreshes', async () => {
  const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/plugin-icon-vectors.json'), 'utf8'));
  const image = Buffer.alloc(vector.maxBytes); Buffer.from(vector.iconDataUrl.split(',')[1], 'base64').copy(image);
  const iconDataUrl = 'data:image/png;base64,' + image.toString('base64');
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-icon-limit-'));
  const fixture = await catalogServer(Array.from({ length: 13 }, (_, index) => ({ name: 'plugin' + index, version: '1.0.0', iconDataUrl })));
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const request = engine(values, []);
  const service = new OfficialPluginsService({ configRoot: root, request, endpoint: () => ({ baseUrl: fixture.origin, direct: false }), onChanged: () => {} });
  try {
    assert(Buffer.byteLength(fixture.catalog) > 1024 * 1024, 'fixture exceeds the ordinary document limit');
    assertEqual(await service.refresh(new AbortController().signal), fixture.revision, 'large artwork cache is written');
    assertEqual(await service.refresh(new AbortController().signal), fixture.revision, 'large artwork cache is reread');
    const rows = (await new PluginCatalog({ request }).snapshot()).rows;
    assertEqual(rows.length, 13, 'every plugin remains listed');
    assert(rows.every(row => row.iconDataUrl === iconDataUrl), 'every catalog icon survives');
  } finally { await service.close(); await fixture.close(); }
});

await h.test('a catalog server is mirrored without downloading any plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const fixture = await catalogServer([{ name: 'digram', version: '1.0.0' }, { name: 'reverse-engineering', version: '1.0.0', legacyCompatible: false }]);
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => ({ baseUrl: fixture.origin, direct: false }), onChanged: async () => {} });
  try {
    assertEqual(await service.refresh(new AbortController().signal), fixture.revision, 'the catalog revision is reported');
    // The aggregate pointer is never fetched, so a server publishing only a
    // catalog still works and nothing large is transferred.
    assert(fixture.requests.every(url => !url.includes('/latest')), 'the legacy pointer is not requested: ' + fixture.requests.join(','));
    assertEqual(fixture.requests.filter(url => url.endsWith('/catalog')).length, 1, 'the catalog is fetched once');
    assertEqual(fixture.requests.filter(url => url.includes('/packages/')).length, 0, 'no plugin package is downloaded during refresh');

    const manifest = JSON.parse(await readFile(join(root, 'plugins/marketplaces/klaus-official/.claude-plugin/marketplace.json'), 'utf8'));
    assertEqual(manifest.name, OFFICIAL_MARKETPLACE, 'the mirrored manifest names the marketplace');
    // Both plugins are listed, including the one an older engine could not run:
    // a client reading the catalog is by construction new enough to run it.
    assertDeepEqual(manifest.plugins.map((item: JsonObject) => item.name).sort(), ['digram', 'reverse-engineering'], 'the manifest lists every cataloged plugin');
    const entry = object(object(values.values.marketplaces)[OFFICIAL_MARKETPLACE]);
    assertEqual(entry.installLocation, join(root, 'plugins/marketplaces/klaus-official'), 'registered location');
    assertEqual(entry.officialRevision, fixture.revision, 'the catalog revision is recorded');
    assertEqual(object(entry).officialSha, undefined, 'no aggregate revision is claimed');
    // Nothing is on disk yet, so the plugin directories must not exist.
    const missing = await readFile(join(root, 'plugins/marketplaces/klaus-official/plugins/digram/plugin.json'), 'utf8').then(() => false, () => true);
    assert(missing, 'an unmirrored plugin has no directory');

    // The catalog is the revision pointer, so it is fetched again on every
    // refresh — that is how a client learns whether anything changed. What must
    // not happen at an unchanged revision is a package download or a re-write of
    // the mirrored manifest.
    const packages = () => fixture.requests.filter(url => url.includes('/packages/')).length;
    const catalogs = () => fixture.requests.filter(url => url.endsWith('/catalog')).length;
    const packagesBefore = packages(), catalogsBefore = catalogs();
    const manifestBytes = await readFile(join(root, 'plugins/marketplaces/klaus-official/.claude-plugin/marketplace.json'), 'utf8');
    assertEqual(await service.refresh(new AbortController().signal), fixture.revision, 'second refresh');
    assertEqual(packages(), packagesBefore, 'no plugin package is downloaded');
    assertEqual(catalogs(), catalogsBefore + 1, 'the catalog pointer is refetched, once');
    assertEqual(await readFile(join(root, 'plugins/marketplaces/klaus-official/.claude-plugin/marketplace.json'), 'utf8'), manifestBytes, 'an unchanged revision does not rewrite the manifest');
  } finally { await service.close(); await fixture.close(); }
});

await h.test('a plugin package is downloaded on demand and verified against its catalog hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const fixture = await catalogServer([{ name: 'digram', version: '1.0.0' }, { name: 'reverse-engineering', version: '2.0.0' }]);
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, []), endpoint: () => ({ baseUrl: fixture.origin, direct: false }), onChanged: async () => {} });
  try {
    await service.refresh(new AbortController().signal);
    assertEqual(await service.ensureDownloaded('digram', new AbortController().signal), true, 'a cataloged plugin downloads');
    const manifest = JSON.parse(await readFile(join(root, 'plugins/marketplaces/klaus-official/plugins/digram/plugin.json'), 'utf8'));
    assertEqual(manifest.name, 'digram', 'the package lands at its own directory');
    assertEqual(manifest.version, '1.0.0', 'the downloaded version is the cataloged one');
    const skill = await readFile(join(root, 'plugins/marketplaces/klaus-official/plugins/digram/skills/digram/SKILL.md'), 'utf8');
    assert(skill.includes('# digram'), 'nested package content is extracted');
    // The manifest written by refresh must survive a download: it lives outside
    // the plugin directory, and losing it would empty the marketplace UI.
    const stillListed = JSON.parse(await readFile(join(root, 'plugins/marketplaces/klaus-official/.claude-plugin/marketplace.json'), 'utf8'));
    assertDeepEqual(stillListed.plugins.map((item: JsonObject) => item.name).sort(), ['digram', 'reverse-engineering'], 'mirroring the manifest survives a download');

    // A second call must not re-download.
    const before = fixture.requests.filter(url => url.includes('/packages/')).length;
    assertEqual(await service.ensureDownloaded('digram', new AbortController().signal), true, 'already present');
    assertEqual(fixture.requests.filter(url => url.includes('/packages/')).length, before, 'a downloaded plugin is not fetched again');

    // An unknown plugin is refused rather than guessed at.
    assertEqual(await service.ensureDownloaded('nope', new AbortController().signal), false, 'an uncataloged plugin is not downloadable');
  } finally { await service.close(); await fixture.close(); }
});

await h.test('a package whose bytes do not match the catalog hash is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const bytes = pluginPackage('digram', '1.0.0');
  const sha = digest(bytes);
  const revision = 'b'.repeat(64);
  const catalog = JSON.stringify({ schemaVersion: 1, marketplace: OFFICIAL_MARKETPLACE, revision, count: 1,
    items: [{ name: 'digram', version: '1.0.0', sha256: sha, packageFile: `packages/digram-${sha}.zip` }] });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/api/market/plugins/catalog') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(catalog); return; }
    // Serve different bytes than the catalog advertised: a truncated or swapped
    // download must never become a plugin the manifest vouches for.
    if (request.url === `/api/market/plugins/packages/digram-${sha}.zip`) {
      response.writeHead(200, { 'content-type': 'application/zip' }); response.end(Buffer.concat([bytes, Buffer.from('extra')])); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, []), endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: async () => {} });
  try {
    assertEqual(await service.refresh(new AbortController().signal), revision, 'the catalog mirrors');
    let error = '';
    try { await service.ensureDownloaded('digram', new AbortController().signal); } catch (reason) { error = String(reason instanceof Error ? reason.message : reason); }
    assert(error.includes('catalog hash'), 'the mismatch is reported: ' + error);
    const absent = await readFile(join(root, 'plugins/marketplaces/klaus-official/plugins/digram/plugin.json'), 'utf8').then(() => false, () => true);
    assert(absent, 'mismatched bytes are not left on disk');
  } finally { await service.close(); server.close(); }
});

await h.test('a catalog naming a path outside its package layout is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const bytes = pluginPackage('digram', '1.0.0');
  const sha = digest(bytes);
  // The name is used to build a directory and the packageFile a URL, so a
  // catalog that disagrees with its own convention is rejected outright.
  const cases: Array<[string, string, string]> = [
    ['a traversal in the package file', JSON.stringify({ schemaVersion: 1, marketplace: OFFICIAL_MARKETPLACE, revision: 'b'.repeat(64), items: [{ name: 'digram', version: '1.0.0', sha256: sha, packageFile: '../../etc/passwd' }] }), 'does not match its name and hash'],
    ['a traversal in the plugin name', JSON.stringify({ schemaVersion: 1, marketplace: OFFICIAL_MARKETPLACE, revision: 'b'.repeat(64), items: [{ name: '../evil', version: '1.0.0', sha256: sha, packageFile: `packages/evil-${sha}.zip` }] }), 'invalid plugin name'],
    ['a malformed revision', JSON.stringify({ schemaVersion: 1, marketplace: OFFICIAL_MARKETPLACE, revision: 'nope', items: [] }), 'invalid revision'],
    ['no items', JSON.stringify({ schemaVersion: 1, marketplace: OFFICIAL_MARKETPLACE, revision: 'b'.repeat(64), items: [] }), 'published no plugins'],
  ];
  for (const [label, catalog, expected] of cases) {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      if ((request.url ?? '') === '/api/market/plugins/catalog') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(catalog); return; }
      response.writeHead(404); response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
    const calls: Array<{ method: string; params: JsonObject }> = [];
    const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: async () => {} });
    let error = '';
    try { await service.refresh(new AbortController().signal); } catch (reason) { error = String(reason instanceof Error ? reason.message : reason); }
    try {
      assert(error.includes(expected), `${label} is refused: ${error}`);
      assertEqual(calls.filter(call => call.method === 'config/batchWrite').length, 0, `${label} writes nothing`);
    } finally { await service.close(); server.close(); }
  }
});

await h.test('a server publishing no catalog falls back to the aggregate archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-plugins-'));
  const bytes = archive();
  const sha = 'c'.repeat(64);
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(request.url ?? '');
    if (request.url === '/api/market/plugins/catalog') { response.writeHead(404); response.end(); return; }
    if (request.url === '/api/market/plugins/latest') { response.writeHead(200); response.end(sha); return; }
    if (request.url === `/api/market/plugins/${sha}.zip`) { response.writeHead(200, { 'content-type': 'application/zip' }); response.end(bytes); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const service = new OfficialPluginsService({ configRoot: root, request: engine(values, []), endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: async () => {} });
  try {
    assertEqual(await service.refresh(new AbortController().signal), sha, 'the aggregate revision is reported');
    assert(requests.some(url => url.includes('/latest')), 'the legacy pointer is fetched');
    const manifest = JSON.parse(await readFile(join(root, 'plugins/marketplaces/klaus-official/.claude-plugin/marketplace.json'), 'utf8'));
    assertEqual(manifest.name, OFFICIAL_MARKETPLACE, 'the aggregate still mirrors');
    const entry = object(object(values.values.marketplaces)[OFFICIAL_MARKETPLACE]);
    assertEqual(entry.officialSha, sha, 'the aggregate revision is recorded');
  } finally { await service.close(); server.close(); }
});

await h.test('catalog checks honor caller cancellation and shutdown without publishing a partial response', async () => {
  for (const cancellation of ['caller', 'service']) {
    const root = await mkdtemp(join(tmpdir(), 'klaus-official-cancellation-'));
    let entered = false, settled = false, failure = '';
    const server = createServer((_request, response) => { entered = true; response.writeHead(200); response.write('{'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
    const calls: Array<{ method: string; params: JsonObject }> = [];
    const service = new OfficialPluginsService({ configRoot: root, request: engine(values, calls), endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: () => {} });
    const controller = new AbortController();
    try {
      const pending = service.refresh(controller.signal).catch(error => { failure = String(error); }).finally(() => { settled = true; });
      await waitFor(() => entered, 1000, 'partial catalog response started');
      if (cancellation === 'caller') controller.abort(); else await service.close();
      await waitFor(() => settled, 1000, 'catalog request cancelled without waiting for the network deadline');
      await pending;
      assert(/abort|cancel/i.test(failure), 'The read reports cancellation');
      assertEqual(calls.some(call => call.method === 'config/batchWrite'), false, 'No incomplete catalog is saved');
    } finally {
      await service.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});

await h.test('a platform package replaces the neutral download on its own machine', async () => {
  const platformArchive = zip([
    { name: 'plugin.json', bytes: Buffer.from(JSON.stringify({ name: 'fixture', version: '1.0.0' })) },
    { name: 'runtime/browsers-bundle/README', bytes: Buffer.from('bundled rendering browser placeholder\n') },
  ]);
  const platformSha = digest(platformArchive);
  const neutralSha = digest(pluginPackage('fixture', '1.0.0'));
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-platform-'));
  const fixture = await catalogServer([{ name: 'fixture', version: '1.0.0', platformArchive }]);
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const request = engine(values, []);
  const service = new OfficialPluginsService({ configRoot: root, request, endpoint: () => ({ baseUrl: fixture.origin, direct: false }), onChanged: () => {} });
  try {
    await service.refresh(new AbortController().signal);
    assertEqual(await service.ensureDownloaded('fixture', new AbortController().signal), true, 'the platform package downloads');
    assert(fixture.requests.includes(`/api/market/plugins/packages/fixture-${platformSha}.zip`), 'the platform package file is requested');
    assertEqual(fixture.requests.some(url => url === `/api/market/plugins/packages/fixture-${neutralSha}.zip`), false, 'the neutral package is not requested');
    const installed = JSON.parse(await readFile(join(root, 'plugins/marketplaces/klaus-official/plugins/fixture/plugin.json'), 'utf8'));
    assertEqual(installed.name, 'fixture', 'the platform package installs in place');
  } finally { await service.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

await h.test('a platform package whose file name escapes the pinned shape is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-official-platform-bad-'));
  const bytes = pluginPackage('fixture', '1.0.0');
  const sha256 = digest(bytes);
  const platformSha = digest(Buffer.from('unrelated bytes'));
  const items = [{
    name: 'fixture', version: '1.0.0', sha256, packageFile: `packages/fixture-${sha256}.zip`,
    platformPackages: { [`${process.platform}-${process.arch}`]: { packageFile: `packages/other-${platformSha}.zip`, sha256: platformSha } },
  }];
  const catalog = JSON.stringify({ schemaVersion: 1, marketplace: OFFICIAL_MARKETPLACE, revision: digest(Buffer.from(JSON.stringify(items))), count: 1, items });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/api/market/plugins/catalog') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(catalog); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Values = { values: { plugins: {}, marketplaces: {} }, version: 'v1' };
  const request = engine(values, []);
  const service = new OfficialPluginsService({ configRoot: root, request, endpoint: () => ({ baseUrl: origin, direct: false }), onChanged: () => {} });
  try {
    let error = '';
    try { await service.refresh(new AbortController().signal); } catch (reason) { error = String(reason instanceof Error ? reason.message : reason); }
    assert(error.includes('platform package file does not match'), 'the malformed platform entry is rejected: ' + error);
  } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

process.exitCode = await h.finish(join(__dirname, 'official-plugins.result.json'), 'official-plugins');
})();
