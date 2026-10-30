import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import * as tar from 'tar';
import { WorkspaceDependenciesManager, WorkspaceDependenciesOptions, WorkspaceRuntimeCommand } from '../main/services/workspace-dependencies';

const roots: string[] = [];
const shippedResources = join(__dirname, '../..', 'resources/workspace-runtime');
const archiveBytes = Buffer.from('Pinned runtime archive fixture');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-workspace-runtime-')); roots.push(root);
  const resourcesDir = join(root, 'resources'), rootDir = join(root, 'runtime');
  await mkdir(resourcesDir);
  const manifest = JSON.parse(readFileSync(join(shippedResources, 'manifest.json'), 'utf8')) as {
    version: string; pythonVersion: string; packages: Record<string, string>;
    platforms: Record<string, { sha256: string; binary: string }>;
  };
  for (const archive of Object.values(manifest.platforms)) archive.sha256 = createHash('sha256').update(archiveBytes).digest('hex');
  await writeFile(join(resourcesDir, 'manifest.json'), JSON.stringify(manifest));
  await copyFile(join(shippedResources, 'requirements.lock'), join(resourcesDir, 'requirements.lock'));
  const calls: Array<{ file: string; args: string[]; command: WorkspaceRuntimeCommand }> = [];
  let downloads = 0, failInstall = false, failProbe = false;
  const options: WorkspaceDependenciesOptions = {
    rootDir, resourcesDir, platform: 'darwin', arch: 'arm64',
    hooks: {
      download: async (_url, target) => { downloads++; await writeFile(target, archiveBytes); },
      extract: async (_archive, target) => { await writeFile(target, 'fixture executable'); },
      run: async (file, args, command) => {
        calls.push({ file, args, command });
        if (args[0] === 'pip' && failInstall) throw new Error('Fixture package download failed');
        if (args[0] === 'venv') {
          const binDir = join(args.at(-1)!, 'bin'); await mkdir(binDir, { recursive: true }); await writeFile(join(binDir, 'python'), 'fixture Python');
        }
        if (args[0] === '-I') {
          if (!existsSync(file)) throw new Error('Fixture Python executable is missing');
          return { stdout: JSON.stringify({ python: failProbe ? '3.12.0' : manifest.pythonVersion, packages: manifest.packages }), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    },
  };
  return { root, rootDir, resourcesDir, manifest, options, calls, downloads: () => downloads,
    failInstall: (value: boolean) => { failInstall = value; }, failProbe: (value: boolean) => { failProbe = value; } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('parallel callers share a verified private installation and receive precise package paths', async () => {
  const f = await fixture(), manager = new WorkspaceDependenciesManager(f.options);
  const initial = manager.status(); assert.equal(initial.state, 'missing'); assert.ok(initial.pythonPath?.endsWith('/venv/bin/python'));
  assert.match(manager.contextInstructions(), /Call load_workspace_dependencies/);
  const first = manager.ensure(), second = manager.ensure(); assert.equal(first, second); assert.equal(manager.status().state, 'installing');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.state, 'ready'); assert.deepEqual(a, b); assert.equal(f.downloads(), 1);
  assert.equal(a.pythonVersion, f.manifest.pythonVersion); assert.deepEqual(a.packages, f.manifest.packages);
  assert.match(manager.contextInstructions(), /runtime is ready/); assert.ok(existsSync(a.pythonPath!));
  const sync = f.calls.find(call => call.args[0] === 'pip')!;
  assert.ok(sync.args.includes('--require-hashes')); assert.ok(sync.args.includes('--only-binary'));
  assert.ok(sync.args.includes('https://pypi.org/simple')); assert.ok(sync.args.includes('--no-config'));
  const install = f.calls.find(call => call.args[0] === 'python')!;
  assert.ok(install.args.includes('--no-bin')); assert.ok(install.args.includes('--no-registry'));
  assert.ok(install.command.env.UV_PYTHON_INSTALL_DIR?.startsWith(f.rootDir));
  assert.ok(install.command.env.UV_CACHE_DIR?.startsWith(f.rootDir));
  assert.equal(install.command.env.UV_PYTHON_PREFERENCE, 'only-managed');
  const probes = f.calls.filter(call => call.args[0] === '-I'); assert.equal(probes.length, 1);
  assert.match(probes[0]!.args[2]!, /page\.render/); assert.match(probes[0]!.args[2]!, /PdfReader/);
  assert.match(await readFile(a.logPath, 'utf8'), /Runtime ready/);
  await manager.close();
});

test('a new manager probes an existing runtime without downloading again', async () => {
  const f = await fixture(), first = new WorkspaceDependenciesManager(f.options);
  assert.equal((await first.ensure()).state, 'ready');
  const second = new WorkspaceDependenciesManager(f.options);
  assert.equal((await second.ensure()).state, 'ready'); assert.equal(f.downloads(), 1);
  assert.equal(f.calls.filter(call => call.args[0] === '-I').length, 2);
  await first.close(); await second.close();
});

test('later calls revalidate the environment and rebuild files removed after readiness', async () => {
  const f = await fixture(), manager = new WorkspaceDependenciesManager(f.options);
  const ready = await manager.ensure(); assert.equal(ready.state, 'ready');
  assert.equal((await manager.ensure()).state, 'ready'); assert.equal(f.downloads(), 1);
  assert.equal(f.calls.filter(call => call.args[0] === '-I').length, 2);
  await rm(ready.pythonPath!);
  assert.equal((await manager.ensure()).state, 'ready'); assert.equal(f.downloads(), 2);
  assert.ok(existsSync(ready.pythonPath!)); await manager.close();
});

test('a failed install leaves no ready marker, preserves earlier versions and can be retried', async () => {
  const f = await fixture(), previous = join(f.rootDir, 'versions', 'previous-healthy');
  await mkdir(previous, { recursive: true }); await writeFile(join(previous, 'ready.json'), 'previous runtime');
  f.failInstall(true);
  const manager = new WorkspaceDependenciesManager(f.options), failed = await manager.ensure();
  assert.equal(failed.state, 'failed'); assert.match(failed.error!, /Fixture package download failed/);
  assert.deepEqual(await readdir(join(f.rootDir, 'versions')), ['previous-healthy']);
  assert.equal(await readFile(join(previous, 'ready.json'), 'utf8'), 'previous runtime');
  assert.match(await readFile(failed.logPath, 'utf8'), /Installation failed/);
  f.failInstall(false); assert.equal((await manager.ensure()).state, 'ready'); assert.equal(f.downloads(), 2);
  await manager.close();
});

test('an incomplete directory is rebuilt and a mismatched probe never reports readiness', async () => {
  const f = await fixture(), manager = new WorkspaceDependenciesManager(f.options);
  const versionDir = dirname(dirname(dirname(manager.status().pythonPath!)));
  await mkdir(versionDir, { recursive: true }); await writeFile(join(versionDir, 'partial'), 'interrupted');
  f.failProbe(true); const failed = await manager.ensure();
  assert.equal(failed.state, 'failed'); assert.match(failed.error!, /version probe/); assert.equal(existsSync(versionDir), false);
  f.failProbe(false); assert.equal((await manager.ensure()).state, 'ready'); assert.equal(existsSync(join(versionDir, 'partial')), false);
  await manager.close();
});

test('archive bytes must match their committed SHA-256 before extraction or execution', async () => {
  const f = await fixture();
  f.options.hooks!.download = async (_url, target) => { await writeFile(target, 'tampered archive'); };
  const manager = new WorkspaceDependenciesManager(f.options), status = await manager.ensure();
  assert.equal(status.state, 'failed'); assert.match(status.error!, /SHA-256 mismatch/); assert.equal(f.calls.length, 0);
  await manager.close();
});

test('unsupported platforms and missing manifests give explicit failures without downloads', async () => {
  const f = await fixture(), unsupported = new WorkspaceDependenciesManager({ ...f.options, platform: 'linux', arch: 'arm64' });
  assert.equal((await unsupported.ensure()).state, 'unsupported'); assert.equal(f.downloads(), 0);
  const missing = new WorkspaceDependenciesManager({ ...f.options, resourcesDir: join(f.root, 'missing') });
  assert.equal((await missing.ensure()).state, 'failed'); assert.match(missing.status().error!, /manifest\.json/);
  await unsupported.close(); await missing.close();
});

test('inherited interpreter and package-manager configuration cannot redirect installation', async () => {
  const f = await fixture(), variables = ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'PIP_INDEX_URL', 'UV_INDEX_URL', 'UV_PYTHON_DOWNLOADS_JSON_URL'];
  const original = variables.map(key => process.env[key]);
  try {
    for (const key of variables) process.env[key] = 'untrusted fixture configuration';
    const manager = new WorkspaceDependenciesManager(f.options); assert.equal((await manager.ensure()).state, 'ready');
    for (const call of f.calls) for (const key of variables) assert.equal(call.command.env[key], undefined, key);
    await manager.close();
  } finally { variables.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; }); }
});

test('manager shutdown aborts a shared installer and settles all waiting callers', async () => {
  const f = await fixture(); let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.options.hooks!.download = async (_url, _target, signal) => {
    started(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Fixture download cancelled')), { once: true }));
  };
  const manager = new WorkspaceDependenciesManager(f.options), first = manager.ensure(), second = manager.ensure();
  await entered; await manager.close();
  assert.equal((await first).state, 'failed'); assert.deepEqual(await first, await second);
  assert.match((await manager.ensure()).error!, /closed/); assert.equal(existsSync(join(f.rootDir, 'install.lock')), false);
});

test('independent managers serialize installation and the second reuses the verified result', async () => {
  const f = await fixture(), first = new WorkspaceDependenciesManager(f.options), second = new WorkspaceDependenciesManager(f.options);
  const [a, b] = await Promise.all([first.ensure(), second.ensure()]);
  assert.equal(a.state, 'ready'); assert.equal(b.state, 'ready'); assert.equal(f.downloads(), 1);
  assert.equal(existsSync(join(f.rootDir, 'install.lock')), false);
  await first.close(); await second.close();
});

test('dead installer locks can be reclaimed', async () => {
  const f = await fixture(); await mkdir(f.rootDir); await writeFile(join(f.rootDir, 'install.lock'), JSON.stringify({ pid: 2147483647, owner: 'dead' }));
  const manager = new WorkspaceDependenciesManager(f.options); assert.equal((await manager.ensure()).state, 'ready');
  assert.equal(existsSync(join(f.rootDir, 'install.lock')), false); await manager.close();
});

test('tar archives containing links are rejected even when their outer hash is pinned', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(), archiveRoot = join(f.root, 'archive'), directory = join(archiveRoot, 'uv-aarch64-apple-darwin');
  await mkdir(directory, { recursive: true }); await symlink('/tmp/unsafe-runtime-executable', join(directory, 'uv'));
  const archive = join(f.root, 'unsafe.tar.gz'); await tar.c({ file: archive, cwd: archiveRoot, gzip: true }, ['uv-aarch64-apple-darwin']);
  f.manifest.platforms['darwin-arm64']!.sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(f.resourcesDir, 'manifest.json'), JSON.stringify(f.manifest));
  delete f.options.hooks!.extract;
  f.options.hooks!.download = async (_url, target) => copyFile(archive, target);
  const manager = new WorkspaceDependenciesManager(f.options), status = await manager.ensure();
  assert.equal(status.state, 'failed'); assert.match(status.error!, /link or special file/); assert.equal(f.calls.length, 0);
  await manager.close();
});

test('download size limits apply before reading an oversized response', async () => {
  const f = await fixture(); delete f.options.hooks!.download;
  f.options.fetch = async () => new Response('fixture', { headers: { 'content-length': String(65 * 1024 ** 2) } });
  const manager = new WorkspaceDependenciesManager(f.options), status = await manager.ensure();
  assert.equal(status.state, 'failed'); assert.match(status.error!, /download limit/); assert.equal(f.calls.length, 0);
  await manager.close();
});

test('diagnose checks the installed bundle in place and records every check in the log', async () => {
  const f = await fixture(), manager = new WorkspaceDependenciesManager(f.options);
  const missing = await manager.diagnose();
  assert.equal(missing.state, 'missing');
  assert.match(await readFile(missing.logPath, 'utf8'), /Diagnostics: the bundle is not installed/);
  assert.equal((await manager.ensure()).state, 'ready');
  const ready = await manager.diagnose();
  assert.equal(ready.state, 'ready');
  const log = await readFile(ready.logPath, 'utf8');
  assert.match(log, /Diagnostics: the ready marker matches the locked manifest/);
  assert.match(log, /Diagnostics: the PDF extraction and rendering probe passed/);
  f.failProbe(true);
  const failed = await manager.diagnose();
  assert.equal(failed.state, 'failed'); assert.match(failed.error!, /version probe/);
  assert.match(await readFile(failed.logPath, 'utf8'), /Diagnostics: the probe failed/);
  await manager.close();
});

test('reset removes the installed bundle and cache so the next ensure installs from scratch', async () => {
  const f = await fixture(), manager = new WorkspaceDependenciesManager(f.options);
  const ready = await manager.ensure(); assert.equal(ready.state, 'ready');
  const cacheProbe = join(f.rootDir, 'cache', 'probe');
  await mkdir(dirname(cacheProbe), { recursive: true }); await writeFile(cacheProbe, 'cache');
  await manager.reset();
  assert.equal(manager.status().state, 'missing');
  assert.equal(existsSync(dirname(ready.pythonPath!)), false);
  assert.equal(existsSync(join(f.rootDir, 'cache')), false);
  const reinstalled = await manager.ensure();
  assert.equal(reinstalled.state, 'ready'); assert.equal(f.downloads(), 2);
  assert.match(await readFile(reinstalled.logPath, 'utf8'), /Reset requested/);
  await manager.close();
});
