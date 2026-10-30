import { deepEqual, equal, rejects } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginService, type PluginChange } from '../main/services/extensions/plugins';
import { PluginSources } from '../main/services/extensions/plugin-sources';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness } from './harness';

const h = new Harness(), id = 'prototype-studio@klaus-official';
async function document(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function fixture(version?: string, enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-bundled-official-')), source = join(root, 'source');
  const ledger: JsonObject = version === undefined ? {} : { [id]: { name: 'prototype-studio', version, enabled, dataPath: 'preserved-data', source: 'marketplace:klaus-official' } };
  const manifest = { name: 'prototype-studio', version: '2.0.0', mcpServers: { 'klaus-prototype': { hostManaged: true } } };
  await document(join(source, 'plugin.json'), manifest);
  await mkdir(join(source, 'runtime/dist'), { recursive: true }); await writeFile(join(source, 'runtime/dist/index.html'), 'Offline editor fixture\n');
  await symlink(join(root, 'external-build-cache'), join(source, 'runtime/target'));
  await symlink(join(root, 'external-local-toolchain'), join(source, 'runtime/.tools'));
  const sentinel = join(root, 'plugins/installed_plugins.json'); await document(sentinel, { engineOwned: true });
  const original = await readFile(sentinel, 'utf8');
  const calls: Array<{ method: string; params: JsonObject }> = [], changes: PluginChange[] = [];
  let terminal = async (method: string, params: JsonObject): Promise<unknown> => {
    equal(method, 'session/installPlugin'); equal(params.marketplace, 'klaus-official');
    equal(params.version, '2.0.0');
    equal(await readFile(join(string(params.sourceDir), 'runtime/dist/index.html'), 'utf8'), 'Offline editor fixture\n');
    deepEqual(await readdir(join(string(params.sourceDir), 'runtime')), ['dist'], 'local caches and toolchains are never staged');
    deepEqual(JSON.parse(await readFile(join(string(params.sourceDir), 'plugin.json'), 'utf8')), manifest);
    ledger[id] = { name: 'prototype-studio', enabled: true, ...object(ledger[id]), version: params.version! };
    return { persisted: true, restartRequired: false };
  };
  const service = new PluginService({
    configRoot: root,
    request: async method => {
      if (method === 'config/read') return { values: { marketplaces: {} } };
      if (method === 'session/installedPlugins') return { installedPlugins: { version: 1, plugins: structuredClone(ledger) } };
      throw new Error('Unexpected read facade ' + method);
    },
    requestAcknowledged: async (method, params, field) => { equal(field, 'pluginMutation'); calls.push({ method, params }); return terminal(method, params); },
    ensurePackage: async () => { throw new Error('Offline provisioning cannot download'); },
    binding: () => undefined, resolveSession: async () => { throw new Error('Offline provisioning cannot create a chat'); },
    onChanged: change => { changes.push(change); },
  });
  return { root, source, ledger, calls, changes, service, terminal: (value: typeof terminal) => { terminal = value; },
    clean: async () => {
      equal(await readFile(sentinel, 'utf8'), original, 'the host leaves the engine ledger untouched');
      deepEqual(await readdir(join(root, 'plugins/staging')).catch(() => []), []);
    },
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

h.test('offline provisioning installs one official package for concurrent requests without a downloader', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.service.ensureBundledOfficial('prototype-studio', f.source), f.service.ensureBundledOfficial('prototype-studio', f.source)]);
    for (const result of results) deepEqual(result, { ok: true, name: id, version: '2.0.0', enabled: true });
    equal(f.calls.length, 1); equal(f.calls[0]!.params.expectedInstalledVersion, undefined); equal(f.changes[0]!.id, id);
    equal(f.ledger['prototype-studio@builtin'], undefined); await f.clean();
  } finally { await f.close(); }
});
h.test('offline upgrades preserve user disablement and persistent plugin data through the engine', async () => {
  for (const enabled of [false, true]) {
    const f = await fixture('1.0.0', enabled);
    try {
      deepEqual(await f.service.ensureBundledOfficial('prototype-studio', f.source), { ok: true, name: id, version: '2.0.0', enabled });
      equal(f.calls.length, 1); equal(f.calls[0]!.params.expectedInstalledVersion, '1.0.0');
      equal(object(f.ledger[id]).dataPath, 'preserved-data'); equal(object(f.ledger[id]).enabled, enabled); await f.clean();
    } finally { await f.close(); }
  }
});
h.test('equal, newer and unorderable official versions are retained without toggling or reinstalling', async () => {
  for (const version of ['2.0.0', '2.0.0+market', '2.1.0', '3.0.0-beta.1', 'unknown']) {
    const f = await fixture(version);
    try {
      deepEqual(await f.service.ensureBundledOfficial('prototype-studio', f.source), { ok: true, name: id, version, enabled: false });
      equal(f.calls.length, 0); equal(f.changes.length, 0); await f.clean();
    } finally { await f.close(); }
  }
});
h.test('offline provisioning rejects unconfirmed mutations and cleans its staging directory', async () => {
  for (const result of [{ submissionId: 'ack-only' }, { persisted: false, error: 'Fixture refused' }, { persisted: true }]) {
    const f = await fixture();
    try {
      f.terminal(async () => result);
      await rejects(f.service.ensureBundledOfficial('prototype-studio', f.source));
      deepEqual(f.ledger, {}); await f.clean();
    } finally { await f.close(); }
  }
});
h.test('offline provisioning rejects invalid shipped identities and versions before mutation', async () => {
  for (const manifest of [{ name: 'another-plugin', version: '2.0.0' }, { name: 'prototype-studio', version: 'unknown' }]) {
    const f = await fixture();
    try {
      await document(join(f.source, 'plugin.json'), manifest);
      await rejects(f.service.ensureBundledOfficial('prototype-studio', f.source)); equal(f.calls.length, 0); await f.clean();
    } finally { await f.close(); }
  }
});
h.test('offline provisioning refuses a concurrent installed-state change during staging', async () => {
  for (const field of ['version', 'enabled', 'removed']) {
    const f = await fixture('1.0.0'), original = PluginSources.prototype.stage;
    try {
      PluginSources.prototype.stage = async function(entry, location, options) {
        const staged = await original.call(this, entry, location, options);
        if (field === 'removed') delete f.ledger[id];
        else object(f.ledger[id])[field] = field === 'version' ? '3.0.0' : true;
        return staged;
      };
      await rejects(f.service.ensureBundledOfficial('prototype-studio', f.source), /changed during offline/);
      equal(f.calls.length, 0); equal(f.changes.length, 0); await f.clean();
    } finally { PluginSources.prototype.stage = original; await f.close(); }
  }
});
h.test('offline provisioning reports an engine that fails to preserve disablement without re-enabling', async () => {
  const f = await fixture('1.0.0');
  try {
    f.terminal(async () => { f.ledger[id] = { version: '2.0.0', enabled: true }; return { persisted: true }; });
    await rejects(f.service.ensureBundledOfficial('prototype-studio', f.source), /did not confirm/);
    equal(f.calls.length, 1); equal(f.calls[0]!.method, 'session/installPlugin'); await f.clean();
  } finally { await f.close(); }
});

void h.finish(join(__dirname, 'bundled-official-plugin-result.json'), 'bundled-official-plugin').then(code => { process.exitCode = code; });
