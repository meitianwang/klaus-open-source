import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { WORKSPACE_DEPENDENCIES_ENABLED_KEY } from '../contracts/workspace-dependency-settings';
import { createWorkspaceDependencySettingsService } from '../main/services/workspace-dependency-settings';
import { WorkspaceDependenciesManager, WorkspaceDependenciesOptions, WorkspaceRuntimeCommand } from '../main/services/workspace-dependencies';

const roots: string[] = [];
const shippedResources = join(__dirname, '../..', 'resources/workspace-runtime');
const archiveBytes = Buffer.from('Pinned runtime archive fixture');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-workspace-settings-')); roots.push(root);
  const resourcesDir = join(root, 'resources'), rootDir = join(root, 'runtime');
  await mkdir(resourcesDir);
  const manifest = JSON.parse(readFileSync(join(shippedResources, 'manifest.json'), 'utf8')) as {
    version: string; pythonVersion: string; packages: Record<string, string>;
    platforms: Record<string, { sha256: string; binary: string }>;
  };
  for (const archive of Object.values(manifest.platforms)) archive.sha256 = createHash('sha256').update(archiveBytes).digest('hex');
  await writeFile(join(resourcesDir, 'manifest.json'), JSON.stringify(manifest));
  await copyFile(join(shippedResources, 'requirements.lock'), join(resourcesDir, 'requirements.lock'));
  let downloads = 0;
  const options: WorkspaceDependenciesOptions = {
    rootDir, resourcesDir, platform: 'darwin', arch: 'arm64',
    hooks: {
      download: async (_url, target) => { downloads++; await writeFile(target, archiveBytes); },
      extract: async (_archive, target) => { await writeFile(target, 'fixture executable'); },
      run: async (file, args, _command: WorkspaceRuntimeCommand) => {
        if (args[0] === 'venv') {
          const binDir = join(args.at(-1)!, 'bin'); await mkdir(binDir, { recursive: true }); await writeFile(join(binDir, 'python'), 'fixture Python');
        }
        if (args[0] === '-I') return { stdout: JSON.stringify({ python: manifest.pythonVersion, packages: manifest.packages }), stderr: '' };
        return { stdout: '', stderr: '' };
      },
    },
  };
  return { root, rootDir, options, downloads: () => downloads };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('the settings gate withdraws the managed runtime without touching the installed bundle', async () => {
  const f = await fixture();
  let enabled = true; const pushes: string[] = [];
  const manager = new WorkspaceDependenciesManager(f.options);
  const service = createWorkspaceDependencySettingsService(manager, {
    configRoot: f.root, enabled: () => enabled, notify: () => pushes.push('changed'),
  });
  assert.equal(service.status().enabled, true); assert.equal(service.status().state, 'missing');
  assert.equal((await service.ensure()).state, 'ready');
  enabled = false;
  const view = service.status();
  assert.equal(view.enabled, false); assert.equal(view.state, 'disabled'); assert.equal(view.error, undefined);
  const gated = await service.ensure();
  assert.equal(gated.state, 'disabled'); assert.match(gated.error!, /disabled in Settings/);
  assert.equal(await service.diagnose().then(result => result.state), 'disabled');
  assert.equal(await service.reinstall().then(result => result.state), 'disabled');
  assert.equal(f.downloads(), 1);
  enabled = true;
  assert.equal(service.status().enabled, true); assert.equal(service.status().state, 'ready');
  assert.ok(pushes.length >= 1);
  await manager.close();
});

test('an absent preference keeps the managed runtime available', async () => {
  const f = await fixture();
  const manager = new WorkspaceDependenciesManager(f.options);
  const service = createWorkspaceDependencySettingsService(manager, { configRoot: join(f.root, 'no-settings-db') });
  assert.equal(service.status().enabled, true);
  assert.equal((await service.ensure()).state, 'ready');
  await manager.close();
});

test('reinstall resets the bundle, reports the installing state and notifies on settle', async () => {
  const f = await fixture();
  let pushes = 0;
  const manager = new WorkspaceDependenciesManager(f.options);
  const service = createWorkspaceDependencySettingsService(manager, {
    configRoot: f.root, enabled: () => true, notify: () => { pushes++; },
  });
  assert.equal((await service.ensure()).state, 'ready');
  const kicked = await service.reinstall();
  assert.ok(['installing', 'ready'].includes(kicked.state));
  assert.equal(kicked.enabled, true);
  const deadline = Date.now() + 10_000;
  while (service.status().state === 'installing' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.status().state, 'ready');
  assert.equal(f.downloads(), 2);
  assert.ok(pushes >= 1);
  await manager.close();
});

test('the preference key matches the contract vector pin', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/workspace-dependencies.json'), 'utf8')) as { enabledKey: string; enabledDefault: string };
  assert.equal(vector.enabledKey, WORKSPACE_DEPENDENCIES_ENABLED_KEY);
  assert.equal(vector.enabledDefault, 'on');
});
