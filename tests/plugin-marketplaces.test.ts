import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';
import { localRepository, marketFixture, present, put, zip, type MarketFixture } from './extension-market-fixture';

const h = new Harness(), official = 'claude-plugins-official', sha = 'a'.repeat(40);
const visibilityVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/official-plugin-market-vectors.json'), 'utf8')) as { visibleIds: string[]; hiddenId: string };
const refreshVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/plugin-marketplace-refresh-vectors.json'), 'utf8')) as { seededInstallLocations: string[]; seededRefresh: JsonObject };
const discoveryVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/plugin-update-discovery-vectors.json'), 'utf8')) as { freshnessMs: number; retryAfterFailureMs: number; backgroundIntervalMs: number; hiddenUninstalledMarketplace: JsonObject };
const catalog = (name: string, plugin = 'fixture') => JSON.stringify({ name, plugins: [{ name: plugin, source: './plugins/' + plugin }] });
function mirrorZip(plugin = 'fixture'): Buffer {
  const prefix = 'marketplaces/' + official + '/';
  return zip([{ name: prefix + '.claude-plugin/marketplace.json', bytes: Buffer.from(catalog(official, plugin)), mode: 0o100644 },
    { name: prefix + 'plugins/' + plugin + '/.claude-plugin/plugin.json', bytes: Buffer.from(JSON.stringify({ name: plugin })) },
    { name: prefix + 'plugins/' + plugin + '/run.sh', bytes: Buffer.from('#!/bin/sh\nexit 0\n') }]);
}
function mirror(f: MarketFixture, bytes = mirrorZip()): void {
  f.route((request, response) => { if (request.url === '/latest') response.end(sha); else { response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes); } });
}
async function cleanStages(f: MarketFixture): Promise<void> {
  if (await present(join(f.root, 'plugins/staging'))) assert.deepEqual(await readdir(join(f.root, 'plugins/staging')), []);
  if (await present(join(f.root, 'plugins/marketplaces'))) assert.deepEqual((await readdir(join(f.root, 'plugins/marketplaces'))).filter(name => name.startsWith('.klaus-backup-')), []);
}

void (async () => {
  await h.test('local marketplace registration writes only its engine config entry and preserves plugin ownership', async () => {
    const f = await marketFixture();
    try {
      const source = join(f.root, 'source'); await put(join(source, '.codex-plugin/marketplace.json'), catalog('local'));
      object(f.values.plugins)['existing@builtin'] = { enabled: true, source: 'builtin', name: 'existing' };
      const before = structuredClone(f.values.plugins);
      const result = object(await f.invoke('plugins:marketplace:add', { source }));
      assert.equal(result.ok, true); assert.equal(result.name, 'local'); assert.equal(result.installLocation, source); assert.equal(result.alreadyAdded, false);
      const entry = object(object(f.values.marketplaces).local); assert.deepEqual(entry.source, { source: 'file', path: source }); assert.equal(entry.autoUpdate, false);
      assert.deepEqual(f.values.plugins, before); assert.equal(await present(join(f.root, 'plugins/installed_plugins.json')), false);
      const write = f.calls.find(call => call.method === 'config/batchWrite')!;
      assert.equal(write.params.expectedVersion, 'v0'); assert.equal(object((write.params.edits as JsonObject[])[0]).keyPath, 'marketplaces."local"');
      assert.equal(f.calls.some(call => call.method === 'session/installPlugin'), false); assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  await h.test('unpublished third-party rows stay hidden while official, installed and built-in rows remain', async () => {
    const f = await marketFixture();
    try {
      const source = join(f.root, 'source');
      await put(join(source, '.claude-plugin/marketplace.json'), catalog('local'));
      f.values.marketplaces = { local: { installLocation: source } };
      assert.deepEqual(object(await f.plugins.market()).plugins, []);
      object(f.values.plugins)['fixture@local'] = { name: 'fixture', enabled: true, source: 'marketplace' };
      object(f.values.plugins)['browser@builtin'] = { name: 'browser', enabled: true, source: 'builtin' };
      const rows = object(await f.plugins.market()).plugins as JsonObject[];
      assert.deepEqual(rows.map(row => row.id).sort(), ['browser@builtin', 'fixture@local']);
      const firstParty = join(f.root, 'first-party');
      await put(join(firstParty, '.claude-plugin/marketplace.json'), catalog('klaus-official', 'prototype-studio'));
      await put(join(firstParty, 'plugins/prototype-studio/plugin.json'), JSON.stringify({ name: 'prototype-studio', version: '1.0.0' }));
      object(f.values.marketplaces)['klaus-official'] = { installLocation: firstParty };
      const published = object(await f.plugins.market()).plugins as JsonObject[];
      assert.deepEqual(published.map(row => row.id).sort(), visibilityVector.visibleIds);
      assert.equal(published.some(row => row.id === visibilityVector.hiddenId), false);
      assert.equal((await f.plugins.list({}) as JsonObject[]).length, 2);
    } finally { await f.close(); }
  });
  await h.test('re-adding a source reports alreadyAdded while a conflicting name preserves both directories', async () => {
    const f = await marketFixture();
    try {
      const source = join(f.root, 'one'), other = join(f.root, 'two');
      await put(join(source, '.claude-plugin/marketplace.json'), catalog('same')); await put(join(other, '.claude-plugin/marketplace.json'), catalog('same'));
      assert.equal(object(await f.marketplaces.add({ source })).ok, true);
      assert.equal(object(await f.marketplaces.add({ source })).alreadyAdded, true);
      const saved = structuredClone(f.values.marketplaces);
      assert.match(String(object(await f.marketplaces.add({ source: other })).error), /another source/);
      assert.deepEqual(f.values.marketplaces, saved); assert.equal(await present(source), true); assert.equal(await present(other), true);
    } finally { await f.close(); }
  });
  await h.test('a real local Git repository is cloned and a later commit updates the registered cache', async () => {
    const f = await marketFixture();
    try {
      const repo = await localRepository(f.root, 'git-market', 'remote');
      const first = object(await f.marketplaces.add({ source: repo.url })); assert.equal(first.ok, true);
      const target = join(f.root, 'plugins/marketplaces/git-market'); assert.equal(first.installLocation, target);
      await put(join(repo.path, 'new.txt'), 'new commit'); await repo.commit();
      const again = object(await f.marketplaces.add({ source: repo.url })); assert.equal(again.ok, true); assert.equal(again.alreadyAdded, true);
      assert.equal(await readFile(join(target, 'new.txt'), 'utf8'), 'new commit');
      assert.deepEqual(object(object(f.values.marketplaces).remote).source, { source: 'git', url: repo.url }); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('different repositories with the same cache basename cannot destroy a registered marketplace', async () => {
    const f = await marketFixture();
    try {
      const first = await localRepository(f.root, 'owner-a/same', 'first'), second = await localRepository(f.root, 'owner-b/same', 'second');
      assert.equal(object(await f.marketplaces.add({ source: first.url })).ok, true);
      const target = join(f.root, 'plugins/marketplaces/same'), before = await readFile(join(target, '.claude-plugin/marketplace.json'), 'utf8');
      assert.match(String(object(await f.marketplaces.add({ source: second.url })).error), /occupied/);
      assert.equal(await readFile(join(target, '.claude-plugin/marketplace.json'), 'utf8'), before); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('official mirror refresh extracts the declared prefix and a matching sentinel avoids another archive download', async () => {
    const f = await marketFixture();
    try {
      mirror(f);
      const result = object(await f.invoke('plugins:refresh'));
      assert.equal(result.ok, true); assert.equal(result.plugins, 0); assert.deepEqual(result.official, { ok: true, sha });
      const target = join(f.root, 'plugins/marketplaces', official), entry = object(object(f.values.marketplaces)[official]);
      assert.equal(await readFile(join(target, '.gcs-sha'), 'utf8'), sha); assert.equal(entry.gcsSha, sha);
      assert.deepEqual(entry.source, { source: 'github', repo: 'anthropics/claude-plugins-official' });
      assert.equal(object(await f.marketplaces.refresh()).ok, true);
      assert.deepEqual(f.requests.map(request => request.url), ['/latest', '/' + sha + '.zip', '/latest']);
      assert.equal(f.requests.every(request => request.authorization === undefined), true); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('the UI refresh also pulls the first-party official mirror before reading the catalog', async () => {
    const klausOfficialSha = 'c'.repeat(64);
    // Counters instead of a call trace: what matters is that the catalog read
    // has not happened yet when our mirror is pulled. Otherwise a freshly
    // published official plugin stays invisible until the app restarts.
    let klausRefreshed = false, catalogReadsAtMirrorTime = -1, migratedBeforeCatalog = false;
    const f = await marketFixture({ marketplaces: { klausOfficial: { refresh: async () => {
      klausRefreshed = true; catalogReadsAtMirrorTime = f.calls.filter(call => call.method === 'session/pluginCatalog').length;
      return klausOfficialSha;
    }, migrateBundledRecords: async () => {
      migratedBeforeCatalog = f.calls.every(call => call.method !== 'session/pluginCatalog');
      return { ok: true, migrated: [] };
    } } } });
    try {
      mirror(f);
      const result = object(await f.invoke('plugins:refresh'));
      assert.equal(result.ok, true);
      assert.deepEqual(result.klausOfficial, { ok: true, sha: klausOfficialSha, migration: { ok: true, migrated: [] } });
      assert.deepEqual(result.official, { ok: true, sha });
      assert.equal(klausRefreshed, true);
      assert.equal(catalogReadsAtMirrorTime, 0);
      assert.equal(migratedBeforeCatalog, true);
      assert.equal(f.calls.some(call => call.method === 'session/pluginCatalog'), true);
      await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('a missing first-party publication reports a null sha and a failure never sinks the whole refresh', async () => {
    let mode: 'empty' | 'boom' = 'empty';
    const f = await marketFixture({ marketplaces: { klausOfficial: { refresh: async () => {
      if (mode === 'boom') throw new Error('official endpoint unreachable');
      return undefined;
    }, migrateBundledRecords: async () => ({ ok: true, migrated: [] }) } } });
    try {
      mirror(f);
      const empty = object(await f.invoke('plugins:refresh'));
      assert.equal(empty.ok, true); assert.deepEqual(empty.klausOfficial, { ok: true, sha: null, migration: { ok: true, migrated: [] } });
      mode = 'boom';
      const failedResult = object(await f.invoke('plugins:refresh'));
      // The third-party mirror and the catalog still succeed; only our mirror
      // reports its failure, and the UI surfaces it as a toast.
      assert.equal(failedResult.ok, true); assert.equal(failedResult.plugins, 0);
      assert.equal(object(failedResult.klausOfficial).ok, false);
      assert.match(String(object(failedResult.klausOfficial).error), /official endpoint unreachable/);
      assert.deepEqual(failedResult.official, { ok: true, sha });
      await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('a mirror outage falls back to real Git and reports the checked-out commit', async () => {
    const f = await marketFixture();
    try {
      const repo = await localRepository(f.root, 'official', official); f.environment.KLAUS_PLUGIN_OFFICIAL_GIT_URL = repo.url;
      await put(join(repo.path, 'from-git.txt'), 'git fallback'); const commit = await repo.commit();
      f.route((_request, response) => { response.writeHead(503); response.end(); });
      const result = object(await f.marketplaces.refresh()); assert.deepEqual(result.official, { ok: true, sha: commit });
      assert.equal(await readFile(join(f.root, 'plugins/marketplaces', official, 'from-git.txt'), 'utf8'), 'git fallback');
      assert.equal(object(object(f.values.marketplaces)[official]).gcsSha, undefined); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('failed mirror and Git refreshes retain the last catalog and surface the official error', async () => {
    const f = await marketFixture();
    try {
      mirror(f); assert.equal(object(object(await f.marketplaces.refresh()).official).ok, true);
      const path = join(f.root, 'plugins/marketplaces', official, '.claude-plugin/marketplace.json'), before = await readFile(path, 'utf8');
      f.route((_request, response) => { response.writeHead(503); response.end(); });
      const result = object(await f.marketplaces.refresh()); assert.equal(result.ok, true); assert.equal(result.plugins, 0); assert.equal(object(result.official).ok, false);
      assert.equal(await readFile(path, 'utf8'), before); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('current and historical seed locations skip refresh while the first-party catalog still refreshes', async () => {
    let refreshed = 0;
    const f = await marketFixture({ marketplaces: { klausOfficial: {
      refresh: async () => { refreshed++; return undefined; },
      migrateBundledRecords: async () => ({ ok: true, migrated: [] }),
    } } });
    try {
      const seed = join(f.resources, 'plugins-seed');
      const manifest = join(seed, 'marketplaces', official, '.claude-plugin/marketplace.json');
      await put(manifest, catalog(official));
      for (const raw of refreshVector.seededInstallLocations) {
        const location = raw.replace('$SEED', seed);
        object(f.values.marketplaces)[official] = { installLocation: location };
        const before = structuredClone(f.values);
        const result = object(await f.invoke('plugins:refresh'));
        assert.equal(result.ok, true);
        assert.deepEqual(result.official, refreshVector.seededRefresh, location);
        assert.equal(object(result.klausOfficial).ok, true);
        assert.deepEqual(f.values, before);
      }
      assert.equal(refreshed, refreshVector.seededInstallLocations.length);
      assert.equal(f.requests.length, 0);
      assert.equal(f.calls.some(call => call.method === 'config/batchWrite'), false);
      assert.deepEqual(f.changes, []);
      assert.equal(await readFile(manifest, 'utf8'), catalog(official));
      await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('corrupted external install locations are never refreshed over the network or removed', async () => {
    const f = await marketFixture();
    try {
      const external = join(f.root, 'project'); await put(join(external, 'keep.txt'), 'keep'); object(f.values.marketplaces)[official] = { installLocation: external };
      assert.match(String(object(object(await f.marketplaces.refresh()).official).error), /outside.*cache/);
      assert.equal(f.requests.length, 0); assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'keep');
    } finally { await f.close(); }
  });
  await h.test('unsafe or nameless marketplace sources cannot create a registry entry', async () => {
    const f = await marketFixture();
    try {
      const source = join(f.root, 'source'); await put(join(source, '.claude-plugin/marketplace.json'), catalog('../escape'));
      for (const input of ['', '--upload-pack=unsafe', './relative', 'https://user:secret@fixture.invalid/repo', source]) assert.equal(object(await f.marketplaces.add({ source: input })).ok, false);
      assert.deepEqual(f.values.marketplaces, {}); assert.equal(f.calls.some(call => call.method === 'config/batchWrite'), false); assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  await h.test('official refresh cannot overwrite a cache already registered to another marketplace name', async () => {
    const f = await marketFixture();
    try {
      const target = join(f.root, 'plugins/marketplaces', official); await put(join(target, '.claude-plugin/marketplace.json'), catalog('other'));
      object(f.values.marketplaces).other = { installLocation: target };
      const result = object(await f.marketplaces.refresh()); assert.match(String(object(result.official).error), /occupied by other/);
      assert.equal(f.requests.length, 0); assert.equal(await readFile(join(target, '.claude-plugin/marketplace.json'), 'utf8'), catalog('other'));
    } finally { await f.close(); }
  });
  await h.test('a rejected config write restores the previous cloned content and registry', async () => {
    const f = await marketFixture();
    try {
      const repo = await localRepository(f.root, 'rollback', 'rollback'); assert.equal(object(await f.marketplaces.add({ source: repo.url })).ok, true);
      const before = structuredClone(f.values.marketplaces); await put(join(repo.path, 'new.txt'), 'new'); await repo.commit();
      f.beforeWrite(() => { throw new Error('fixture write refused'); });
      assert.equal(object(await f.marketplaces.add({ source: repo.url })).ok, false);
      assert.deepEqual(f.values.marketplaces, before); assert.equal(await present(join(f.root, 'plugins/marketplaces/rollback/new.txt')), false); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('a lost write reply is successful only after a fresh engine snapshot proves the exact entry', async () => {
    const f = await marketFixture();
    try {
      const source = join(f.root, 'source'); await put(join(source, '.claude-plugin/marketplace.json'), catalog('confirmed'));
      f.afterWrite(() => ({}));
      assert.equal(object(await f.marketplaces.add({ source })).ok, true);
      assert.equal(f.calls.filter(call => call.method === 'config/read').length, 2);
    } finally { await f.close(); }
  });
  await h.test('an unconfirmed config write preserves the candidate and recovery backup without claiming success', async () => {
    const f = await marketFixture();
    try {
      const repo = await localRepository(f.root, 'uncertain', 'uncertain'); assert.equal(object(await f.marketplaces.add({ source: repo.url })).ok, true);
      await put(join(repo.path, 'new.txt'), 'new'); await repo.commit();
      f.afterWrite(() => { f.failReads(true); throw new Error('fixture connection lost after commit'); });
      const result = object(await f.marketplaces.add({ source: repo.url })); assert.equal(result.ok, false); assert.equal(result.commitUnknown, true);
      const base = join(f.root, 'plugins/marketplaces'), backup = (await readdir(base)).find(name => name.startsWith('.klaus-backup-'));
      assert(backup); assert.equal(await present(join(base, 'uncertain/new.txt')), true); assert.equal(await present(join(base, backup, 'new.txt')), false);
      f.failReads(false);
    } finally { await f.close(); }
  });
  await h.test('malformed official archives and a stale sentinel cannot produce an empty successful refresh', async () => {
    const f = await marketFixture();
    try {
      mirror(f, zip([{ name: 'outside/marketplace.json', bytes: Buffer.from(catalog(official)) }]));
      assert.equal(object(object(await f.marketplaces.refresh()).official).ok, false);
      mirror(f); assert.equal(object(object(await f.marketplaces.refresh()).official).ok, true);
      await rm(join(f.root, 'plugins/marketplaces', official, '.claude-plugin/marketplace.json'));
      assert.equal(object(object(await f.marketplaces.refresh()).official).ok, false);
      await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('marketplace replacement shares the existing plugin mutation queue', async () => {
    const f = await marketFixture(); let release!: () => void;
    try {
      const source = join(f.root, 'source'); await put(join(source, '.claude-plugin/marketplace.json'), catalog('queued'));
      let entered = false; const hold = new Promise<void>(resolve => { release = resolve; });
      const installing = f.plugins.withMutation(async () => { entered = true; await hold; });
      await waitFor(() => entered, 1000, 'plugin install ownership admitted');
      const adding = f.marketplaces.add({ source }); await Promise.resolve(); await Promise.resolve();
      assert.equal(f.calls.some(call => call.method === 'config/batchWrite'), false); release(); await installing;
      assert.equal(object(await adding).ok, true);
    } finally { release?.(); await f.close(); }
  });
  await h.test('shutdown aborts partial marketplace acquisition and leaves no staging trees', async () => {
    const f = await marketFixture(); let held: ServerResponse | undefined;
    try {
      f.route((request, response) => { if (request.url === '/latest') response.end(sha); else { held = response; response.writeHead(200); response.write('partial'); } });
      const pending = f.marketplaces.refresh(); void pending.catch(() => undefined);
      await waitFor(() => held !== undefined, 2000, 'partial marketplace ZIP started'); await f.marketplaces.close();
      await assert.rejects(pending, /cancel/); await cleanStages(f); assert.deepEqual(f.values.marketplaces, {});
    } finally { await f.close(); }
  });
  await h.test('a linked cache destination cannot overwrite another directory in the profile', async () => {
    const f = await marketFixture();
    try {
      const repo = await localRepository(f.root, 'link', 'linked'), outside = join(f.root, 'project'); await put(join(outside, 'keep.txt'), 'keep');
      await mkdir(join(f.root, 'plugins/marketplaces'), { recursive: true }); await symlink(outside, join(f.root, 'plugins/marketplaces/link'), 'junction');
      assert.equal(object(await f.marketplaces.add({ source: repo.url })).ok, false); assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep'); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('page and focus checks share in-flight work and reuse a fresh result while manual refresh stays explicit', async () => {
    let now = 1000, reads = 0, release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const checks: JsonObject[] = [];
    const f = await marketFixture({ marketplaces: { now: () => now, shouldRefreshOfficial: async () => false,
      onCheckChanged: () => { checks.push(f.marketplaces.updateCheck()); },
      klausOfficial: { refresh: async () => { reads++; if (reads === 1) await hold; return 'd'.repeat(64); }, migrateBundledRecords: async () => ({ ok: true, migrated: [] }) },
    } });
    try {
      const first = f.marketplaces.refresh({ ifStale: true }), second = f.marketplaces.refresh();
      assert.equal(first, second, 'A manual click joins the already-running metadata check');
      assert.equal(f.marketplaces.updateCheck().checking, true);
      release();
      assert.equal(object(await first).ok, true);
      assert.equal(reads, 1);
      assert.deepEqual(f.marketplaces.updateCheck(), { checking: false, checkedAt: now });
      assert.deepEqual(object(object(await f.invoke('plugins:refresh', { ifStale: true })).official), discoveryVector.hiddenUninstalledMarketplace);
      assert.equal(reads, 1, 'Repeated page entry stays within the metadata cache age');
      await f.marketplaces.refresh(); assert.equal(reads, 2, 'Manual refresh does not reuse the cache');
      now += discoveryVector.freshnessMs - 1;
      assert.equal(object(await f.marketplaces.refresh({ ifStale: true })).cached, true);
      assert.equal(reads, 2);
      now += 2; await f.marketplaces.refresh({ ifStale: true }); assert.equal(reads, 3, 'An expired catalog is checked again');
      assert.equal(f.requests.length, 0, 'A hidden marketplace with no installed plugins is not contacted');
      assert.deepEqual(checks.map(check => check.checking), [true, false, true, false, true, false], 'Checking and completion are observable without repeated cached broadcasts');
      assert.equal(f.calls.some(call => call.method === 'session/installPlugin'), false, 'Discovery never installs a release');
    } finally { release(); await f.close(); }
  });
  await h.test('failed background checks keep catalog data and use a short retry age without discarding the last successful time', async () => {
    let now = 1000, reads = 0, offline = false;
    const f = await marketFixture({ marketplaces: { now: () => now, shouldRefreshOfficial: async () => false,
      klausOfficial: { refresh: async () => { reads++; if (offline) throw new Error('fixture network offline'); return 'e'.repeat(64); }, migrateBundledRecords: async () => ({ ok: true, migrated: [] }) },
    } });
    try {
      const directory = join(f.root, 'catalog'); await put(join(directory, '.claude-plugin/marketplace.json'), catalog('klaus-official'));
      f.values.marketplaces = { 'klaus-official': { installLocation: directory } };
      await f.marketplaces.refresh({ ifStale: true });
      const before = object(await f.plugins.market()).plugins;
      now += discoveryVector.freshnessMs; offline = true;
      const failed = object(await f.marketplaces.refresh({ ifStale: true }));
      assert.equal(object(failed.klausOfficial).ok, false);
      assert.match(String(f.marketplaces.updateCheck().error), /Klaus: fixture network offline/);
      assert.equal(f.marketplaces.updateCheck().checkedAt, 1000);
      assert.deepEqual(object(await f.plugins.market()).plugins, before, 'Offline discovery preserves the visible cached catalog');
      now += discoveryVector.retryAfterFailureMs - 1;
      assert.equal(object(await f.marketplaces.refresh({ ifStale: true })).cached, true); assert.equal(reads, 2);
      now += 2; offline = false; await f.marketplaces.refresh({ ifStale: true });
      assert.equal(reads, 3); assert.equal(f.marketplaces.updateCheck().error, undefined);
      assert.equal(f.marketplaces.updateCheck().checkedAt, now);
    } finally { await f.close(); }
  });
  await h.test('cached legacy migration is still attempted when the latest catalog is offline', async () => {
    let migrations = 0;
    const f = await marketFixture({ marketplaces: { shouldRefreshOfficial: async () => false,
      klausOfficial: { refresh: async () => { throw new Error('fixture network offline'); }, migrateBundledRecords: async () => { migrations++; return { ok: true, migrated: ['digram'] }; } },
    } });
    try {
      const result = object(await f.marketplaces.refresh({ ifStale: true }));
      assert.equal(migrations, 1, 'The last known package can complete an existing migration');
      assert.equal(object(result.klausOfficial).ok, false, 'Catalog discovery still reports its own outage');
      assert.deepEqual(object(result.klausOfficial).migration, { ok: true, migrated: ['digram'] });
      assert.equal(f.calls.some(call => call.method === 'session/installPlugin'), false, 'Discovery itself does not install a new release');
    } finally { await f.close(); }
  });
  await h.test('background update checks stop when the marketplace service closes', async () => {
    let reads = 0;
    const f = await marketFixture({ marketplaces: { refreshIntervalMs: 10, refreshMaxAgeMs: 0, shouldRefreshOfficial: async () => false,
      klausOfficial: { refresh: async () => { reads++; return 'f'.repeat(64); }, migrateBundledRecords: async () => ({ ok: true, migrated: [] }) },
    } });
    try {
      f.marketplaces.startUpdateChecks(); f.marketplaces.startUpdateChecks();
      await waitFor(() => reads >= 2, 1000, 'background checks repeated');
      await f.marketplaces.close(); const stopped = reads;
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(reads, stopped, 'Shutdown clears its timer');
      await assert.rejects(f.marketplaces.refresh({ ifStale: true }), /closed/);
    } finally { await f.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'plugin-marketplaces.result.json'), 'plugin-marketplaces');
})();
