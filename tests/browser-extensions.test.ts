import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserExtensionManager } from '../main/browser/extension-manager';
import { Harness } from './harness';

const h = new Harness();
const root = awaitRoot();
function awaitRoot(): Promise<string> { return mkdtemp(join(tmpdir(), 'klaus-browser-extensions-')); }

class Loader {
  loaded = new Map<string, { id: string; path: string; name: string; version: string; manifest: Record<string, unknown> }>();
  nextId = 'a'.repeat(32);
  failure = false;
  beforeLoad?: () => Promise<void>;
  calls = 0;
  async loadExtension(path: string, options: { allowFileAccess: boolean }) {
    this.calls++;
    assert.equal(options.allowFileAccess, false);
    await this.beforeLoad?.();
    if (this.failure) throw new Error('Synthetic load failure');
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    const extension = { id: this.nextId, path, name: String(manifest.name), version: String(manifest.version), manifest };
    this.loaded.set(extension.id, extension);
    return extension;
  }
  removeExtension(id: string): void { this.loaded.delete(id); }
}

async function fixture(name: string) {
  const directory = join(await root, name), source = join(directory, 'source'), config = join(directory, 'config');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic extension', version: '1.0', permissions: ['storage'] }));
  const loader = new Loader();
  const manager = new BrowserExtensionManager({ directory: config, extensions: loader });
  return { manager, loader, source, config };
}

h.test('installation is acknowledged only after a real loader result and persists enabled state', async () => {
  const { manager, loader, source, config } = await fixture('install');
  const installed = await manager.install({ path: source });
  assert.equal(installed.enabled, true); assert.equal(installed.loaded, true);
  assert.deepEqual(installed.permissions, ['storage']);
  assert.equal(loader.loaded.size, 1);
  manager.dispose();
  assert.equal(loader.loaded.size, 0);
  const reopenedLoader = new Loader(), reopened = new BrowserExtensionManager({ directory: config, extensions: reopenedLoader });
  await reopened.initialize();
  assert.equal((await reopened.list())[0]?.loaded, true);
  await reopened.setEnabled(installed.id, false);
  assert.equal(reopenedLoader.loaded.size, 0);
  reopened.dispose();
  const disabledLoader = new Loader(), disabled = new BrowserExtensionManager({ directory: config, extensions: disabledLoader });
  assert.equal((await disabled.list())[0]?.enabled, false);
  assert.equal(disabledLoader.calls, 0);
  await disabled.setEnabled(installed.id, true);
  assert.equal(disabledLoader.loaded.size, 1);
  await disabled.remove(installed.id);
  assert.deepEqual(await disabled.list(), []);
  assert.equal(disabledLoader.loaded.size, 0);
  assert.equal(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')).name, 'Synthetic extension');
  disabled.dispose();
});

h.test('a load failure never adds an installed record', async () => {
  const { manager, loader, source } = await fixture('failure');
  loader.failure = true;
  await assert.rejects(manager.install({ path: source }), /Synthetic load failure/);
  assert.deepEqual(await manager.list(), []);
  manager.dispose();
});

h.test('closing while a load is pending unloads the late result without publishing it', async () => {
  const { manager, loader, source } = await fixture('late');
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  loader.beforeLoad = async () => { entered(); await pending; };
  const installation = manager.install({ path: source });
  await started;
  manager.dispose(); finish();
  await assert.rejects(installation, /cancelled/);
  assert.equal(loader.loaded.size, 0);
});

h.test('a manifest symlink is rejected before invoking the runtime', async () => {
  const { manager, loader, source } = await fixture('symlink');
  const manifest = join(source, 'manifest.json'), outside = join(await root, 'outside-manifest.json');
  await writeFile(outside, JSON.stringify({ manifest_version: 3, name: 'Outside', version: '1.0' }));
  await rm(manifest); await symlink(outside, manifest);
  await assert.rejects(manager.install({ path: source }), /manifest/);
  assert.equal(loader.calls, 0);
  manager.dispose();
});

h.test('a corrupt registry is surfaced and is never overwritten by a mutation', async () => {
  const directory = join(await root, 'corrupt');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'extensions.json'), original = '{invalid';
  await writeFile(path, original);
  const manager = new BrowserExtensionManager({ directory, extensions: new Loader() });
  await assert.rejects(manager.list());
  await assert.rejects(manager.install({ path: directory }));
  assert.equal(await readFile(path, 'utf8'), original);
  manager.dispose();
});

h.test('an identity change during startup is reported and the changed extension is unloaded', async () => {
  const { manager, source, config } = await fixture('identity');
  await manager.install({ path: source }); manager.dispose();
  const loader = new Loader(); loader.nextId = 'b'.repeat(32);
  const reopened = new BrowserExtensionManager({ directory: config, extensions: loader });
  const rows = await reopened.list();
  assert.equal(rows[0]?.loaded, false);
  assert.match(rows[0]?.error ?? '', /identity changed/);
  assert.equal(loader.loaded.size, 0);
  reopened.dispose();
});

h.test('an identity conflict rolls back the previous registration and leaves the original extension loaded', async () => {
  const { manager, loader, source, config } = await fixture('conflict-original');
  const first = await manager.install({ path: source });
  const secondSource = join(await root, 'conflict-second');
  await mkdir(secondSource, { recursive: true });
  await writeFile(join(secondSource, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Conflicting extension', version: '2.0', permissions: ['activeTab'] }));
  loader.nextId = first.id;
  await assert.rejects(manager.install({ path: secondSource }), /extension identity is already installed/);
  const rows = await manager.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, first.id);
  assert.equal(rows[0]?.loaded, true);
  assert.equal(loader.loaded.has(first.id), true);
  assert.equal(loader.loaded.has(secondSource), false);
  const registry = JSON.parse(await readFile(join(config, 'extensions.json'), 'utf8'));
  assert.equal(registry.items.length, 1);
  assert.equal(registry.items[0].id, first.id);
  manager.dispose();
});

h.test('a registration save failure rolls back to the previous persisted state and unloads the candidate', async () => {
  const { manager, loader, source, config } = await fixture('save-failure');
  const first = await manager.install({ path: source });
  const secondSource = join(await root, 'save-failure-second');
  await mkdir(secondSource, { recursive: true });
  await writeFile(join(secondSource, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Second extension', version: '2.0' }));
  loader.nextId = 'b'.repeat(32);
  await chmod(config, 0o500);
  try {
    await assert.rejects(manager.install({ path: secondSource }), /EACCES|permission denied/);
  } finally {
    await chmod(config, 0o700);
  }
  const rows = await manager.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, first.id);
  assert.equal(rows[0]?.loaded, true);
  assert.equal(loader.loaded.has(first.id), true);
  assert.equal(loader.loaded.has(secondSource), false);
  const registry = JSON.parse(await readFile(join(config, 'extensions.json'), 'utf8'));
  assert.equal(registry.items.length, 1);
  assert.equal(registry.items[0].id, first.id);
  manager.dispose();
});

void h.finish(join(__dirname, 'browser-extensions-result.json'), 'browser-extensions').then(async code => {
  await rm(await root, { recursive: true, force: true }); process.exitCode = code;
});
