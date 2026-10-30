import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PluginService, type PluginChange } from '../main/services/extensions/plugins';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';

const h = new Harness();
const bundled = resolve(__dirname, '../../resources/plugins-builtin/desktop-pet');
const deferred = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, resolve: done }; };
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function document(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }

async function fixture(initial?: JsonObject) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-pet-workflow-')), source = join(root, 'bundled/desktop-pet');
  await cp(bundled, source, { recursive: true });
  const manifest = object(JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))), version = string(manifest.version);
  const ledger: JsonObject = initial ? { 'desktop-pet@builtin': { name: 'desktop-pet', source: 'builtin', version, ...initial } } : {};
  const sentinel = join(root, 'plugins/installed_plugins.json'); await document(sentinel, { engineOwned: 'Preserve these bytes' }); const original = await readFile(sentinel, 'utf8');
  const calls: Array<{ method: string; params: JsonObject; field?: string }> = [], changes: PluginChange[] = [], staged: string[] = [];
  let terminal = async (method: string, params: JsonObject): Promise<unknown> => {
    if (method === 'session/installPlugin') ledger['desktop-pet@builtin'] = { name: 'desktop-pet', source: 'builtin', version: params.version!, enabled: true };
    else if (method === 'session/setInstalledPluginEnabled') object(ledger['desktop-pet@builtin']).enabled = params.enabled!;
    else throw Error('Unexpected plugin mutation ' + method);
    return { persisted: true, restartRequired: false, activationScope: 'next_turn', appliedToCurrentSession: false };
  };
  const service = new PluginService({ configRoot: root,
    request: async (method, params) => {
      calls.push({ method, params: structuredClone(object(params)) });
      if (method === 'config/read') return { values: { marketplaces: {} } };
      if (method === 'session/installedPlugins') return { installedPlugins: { version: 1, plugins: structuredClone(ledger) } };
      throw Error('The host may only read plugin state through named facades: ' + method);
    },
    requestAcknowledged: async (method, params, field) => {
      calls.push({ method, params: structuredClone(params), field }); equal(field, 'pluginMutation');
      if (method === 'session/installPlugin') {
        equal(params.marketplace, 'builtin'); equal(params.version, version); const path = string(params.sourceDir); staged.push(path);
        ok(await exists(path), 'real staged package exists during the engine request');
        const packageManifest = object(JSON.parse(await readFile(join(path, 'plugin.json'), 'utf8'))); equal(packageManifest.name, 'desktop-pet'); equal(packageManifest.version, version);
        equal(await readFile(join(path, 'skills/create-desktop-pet/SKILL.md'), 'utf8'), await readFile(join(source, 'skills/create-desktop-pet/SKILL.md'), 'utf8'));
      }
      return terminal(method, params);
    },
    binding: () => undefined, resolveSession: async () => { throw Error('Installing a workflow cannot create a conversation'); }, onChanged: change => { changes.push(change); },
  });
  return { root, source, ledger, version, service, calls, changes, staged,
    terminal: (handler: typeof terminal) => { terminal = handler; },
    cleanStages: async () => { deepEqual(await readdir(join(root, 'plugins/staging')).catch(() => []), []); equal(await readFile(sentinel, 'utf8'), original, 'the host never writes the engine-owned ledger'); },
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

h.test('concurrent workflow requests install one real bundled package after terminal persistence', async () => {
  const f = await fixture(), gate = deferred(); let entered = false, finished = 0;
  try {
    f.terminal(async (_method, params) => { entered = true; await gate.promise; f.ledger['desktop-pet@builtin'] = { name: 'desktop-pet', source: 'builtin', version: params.version!, enabled: true }; return { persisted: true, restartRequired: false }; });
    const first = f.service.ensureBundled('desktop-pet', f.source).then(result => { finished++; return result; });
    const second = f.service.ensureBundled('desktop-pet', f.source).then(result => { finished++; return result; });
    await waitFor(() => entered, 5000, 'named workflow installation entered'); equal(finished, 0); equal(f.changes.length, 0);
    gate.resolve(); const results = await Promise.all([first, second]); equal(finished, 2);
    for (const result of results) deepEqual(result, { ok: true, name: 'desktop-pet@builtin', version: f.version });
    equal(f.calls.filter(call => call.method === 'session/installPlugin').length, 1); equal(f.changes.length, 1); await f.cleanStages();
  } finally { gate.resolve(); await f.close(); }
});

h.test('an existing disabled workflow is re-enabled through the named engine mutation without reinstalling', async () => {
  const f = await fixture({ enabled: false });
  try {
    equal(object(await f.service.ensureBundled('desktop-pet', f.source)).ok, true);
    const mutations = f.calls.filter(call => call.field); deepEqual(mutations, [{ method: 'session/setInstalledPluginEnabled', params: { name: 'desktop-pet@builtin', enabled: true }, field: 'pluginMutation' }]);
    equal(object(f.ledger['desktop-pet@builtin']).enabled, true); equal(f.changes.length, 1); await f.cleanStages();
  } finally { await f.close(); }
});

h.test('an already active matching workflow needs no mutation', async () => {
  const f = await fixture({ enabled: true });
  try { equal(object(await f.service.ensureBundled('desktop-pet', f.source)).ok, true); equal(f.calls.filter(call => call.field).length, 0); equal(f.changes.length, 0); await f.cleanStages(); }
  finally { await f.close(); }
});

h.test('failed or unconfirmed workflow installation cannot fabricate an active ledger record', async () => {
  for (const response of [{ persisted: false, error: 'Fixture rejected the workflow' }, { submissionId: 'ack-only' }, { persisted: true }]) {
    const f = await fixture();
    try {
      f.terminal(async () => response); await rejects(f.service.ensureBundled('desktop-pet', f.source)); deepEqual(f.ledger, {}); await f.cleanStages();
      equal(f.changes.length, 'persisted' in response && response.persisted === true ? 1 : 0);
    } finally { await f.close(); }
  }
});

h.test('missing or mismatched bundled packages are refused before any engine mutation', async () => {
  const f = await fixture();
  try {
    await rejects(f.service.ensureBundled('desktop-pet', join(f.root, 'missing')));
    await document(join(f.source, 'plugin.json'), { name: 'another-workflow', version: '1.0.0' });
    await rejects(f.service.ensureBundled('desktop-pet', f.source));
    await document(join(f.source, 'plugin.json'), { name: 'desktop-pet' });
    await rejects(f.service.ensureBundled('desktop-pet', f.source)); equal(f.calls.filter(call => call.field).length, 0); deepEqual(f.ledger, {}); await f.cleanStages();
  } finally { await f.close(); }
});

h.test('the bundled validator accepts a shipped atlas and refuses dimensions, traversal and escaping links', async () => {
  const f = await fixture(), directory = join(f.root, 'pets/fixture'), helper = join(f.source, 'skills/create-desktop-pet/scripts/validate-pet.cjs');
  const image = resolve(__dirname, '../../frontend/public/pets/klaus.webp');
  try {
    await mkdir(directory, { recursive: true }); await cp(image, join(directory, 'sprite.webp'));
    const manifest = { displayName: 'Fixture companion', description: 'A fixture atlas', spriteVersionNumber: 2, spritesheetPath: 'sprite.webp' };
    await document(join(directory, 'pet.json'), manifest);
    const run = () => spawnSync(process.execPath, [helper, directory, '--version', '2'], { encoding: 'utf8' });
    const valid = run(); equal(valid.status, 0, valid.stderr); const result = object(JSON.parse(valid.stdout)); equal(result.valid, true); equal(result.width, 1536); equal(result.height, 2288); equal(result.spriteVersion, 2);
    const small = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(small); small.write('IHDR', 12); small.writeUInt32BE(1, 16); small.writeUInt32BE(1, 20);
    await writeFile(join(directory, 'small.png'), small); await document(join(directory, 'pet.json'), { ...manifest, spritesheetPath: 'small.png' }); const wrong = run(); equal(wrong.status, 1); ok(wrong.stderr.includes('dimensions'));
    const outside = join(f.root, 'pets/outside.webp'); await cp(image, outside); await document(join(directory, 'pet.json'), { ...manifest, spritesheetPath: '../outside.webp' }); const traversed = run(); equal(traversed.status, 1); ok(traversed.stderr.includes('inside the pet directory'));
    await symlink(outside, join(directory, 'escape.webp')); await document(join(directory, 'pet.json'), { ...manifest, spritesheetPath: 'escape.webp' }); const escaped = run(); equal(escaped.status, 1); ok(escaped.stderr.includes('inside the pet directory'));
  } finally { await f.close(); }
});

void h.finish(join(__dirname, 'desktop-pet-workflow-result.json'), 'desktop-pet-workflow').then(code => { process.exitCode = code; });
