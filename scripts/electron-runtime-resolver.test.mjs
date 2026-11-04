import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeRuntimeReceipt,
  describeElectronRuntime,
  resolveElectronRuntime,
  resolveStockRuntime,
  RUNTIME_ENV,
  selectElectronRuntimeMode,
  validateNativeRuntime,
} from './electron-runtime-resolver.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const platform = 'darwin';
const arch = 'arm64';
const macTest = process.platform === 'darwin' ? test : test.skip;

function fixtureDirectory() {
  return mkdtempSync(join(tmpdir(), 'klaus-runtime-resolver-'));
}

function machoBytes(targetArch = arch) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(targetArch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  return bytes;
}

function writePlist(file, values) {
  mkdirSync(dirname(file), { recursive: true });
  const entries = Object.entries(values)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join('\n');
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${entries}\n</dict>\n</plist>\n`,
  );
}

function runtimeManifest() {
  return {
    schema: 2,
    name: 'native-browser-runtime-phase1',
    electron_version: '44.2.0',
    chromium_version: '152.0.7977.76',
    node_version: '24.20.0',
    repositories: { chromium: { root: 'src' }, electron: { root: 'src/electron' } },
    patch_order: [
      { repo: 'chromium', file: 'patches/0000-chromium-fix.patch', sha256: '9ce50d49ec5539a393e9b7e530a4e91af21a0878824f58ec0bce4e9cb2b7c31e', purpose: 'fixture' },
      { repo: 'electron', file: 'patches/0001-electron-fix.patch', sha256: '6bd14f78495f3ca67ccf05e8ed80fd102c960d8cbddcd127ea0d5a132d8866fd', purpose: 'fixture' },
    ],
  };
}

function createArtifact(rootDirectory, version = '44.2.0') {
  const manifestFile = join(rootDirectory, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(runtimeManifest()));
  const appDirectory = join(rootDirectory, 'Electron.app');
  const executable = join(appDirectory, 'Contents/MacOS/Electron');
  mkdirSync(dirname(executable), { recursive: true });
  const bytes = machoBytes();
  writeFileSync(executable, bytes);
  chmodSync(executable, 0o755);
  writePlist(join(appDirectory, 'Contents/Info.plist'), { CFBundleShortVersionString: version, CFBundleVersion: version });
  const framework = join(appDirectory, 'Contents/Frameworks/Electron Framework.framework/Versions/A');
  mkdirSync(join(framework, 'Resources'), { recursive: true });
  writePlist(join(framework, 'Resources/Info.plist'), { CFBundleVersion: version });
  writeFileSync(join(framework, 'Electron Framework'), bytes);
  const resources = join(appDirectory, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, 'default_app.asar'), 'fixture default app');
  symlinkSync('A', join(framework, '..', 'Current'));
  return { appDirectory, manifestFile, executable };
}

function nativeEnv(rootDirectory) {
  return {
    [RUNTIME_ENV.mode]: 'native',
    [RUNTIME_ENV.directory]: rootDirectory,
    [RUNTIME_ENV.receipt]: join(rootDirectory, 'runtime.json'),
    [RUNTIME_ENV.manifest]: join(rootDirectory, 'manifest.json'),
  };
}

test('select mode returns explicit choice', () => {
  assert.equal(selectElectronRuntimeMode({ mode: 'native' }), 'native');
  assert.equal(selectElectronRuntimeMode({ mode: 'stock' }), 'stock');
});

test('select mode rejects invalid explicit choice', () => {
  assert.throws(() => selectElectronRuntimeMode({ mode: 'custom' }), /native or stock/);
});

test('select mode defaults to native when runtime paths are injected', () => {
  const directory = fixtureDirectory();
  const env = { [RUNTIME_ENV.directory]: directory, [RUNTIME_ENV.receipt]: join(directory, 'r.json'), [RUNTIME_ENV.manifest]: join(directory, 'm.json') };
  assert.equal(selectElectronRuntimeMode({ env }), 'native');
  rmSync(directory, { recursive: true, force: true });
});

test('explicit stock mode overrides injected native paths', () => {
  const directory = fixtureDirectory();
  const env = { [RUNTIME_ENV.mode]: 'stock', [RUNTIME_ENV.directory]: directory };
  assert.equal(selectElectronRuntimeMode({ env }), 'stock');
  rmSync(directory, { recursive: true, force: true });
});

test('select mode defaults to stock without injected paths', () => {
  assert.equal(selectElectronRuntimeMode({ env: {} }), 'stock');
});

test('stock runtime resolves the installed Electron executable', async () => {
  const runtime = await resolveStockRuntime({ appDirectory: root });
  assert.equal(runtime.mode, 'stock');
  assert.match(runtime.electronVersion, /^\d+\.\d+\.\d+/);
  assert.ok(existsSync(runtime.executable));
  assert.match(basename(runtime.executable), /^Electron(?:\.exe)?$/);
});

macTest('native runtime receipt is created and validates', async () => {
  const directory = fixtureDirectory();
  try {
    createArtifact(directory);
    const receiptFile = join(directory, 'runtime.json');
    const runtime = await createNativeRuntimeReceipt({
      runtimeDirectory: directory,
      receiptFile,
      manifestFile: join(directory, 'manifest.json'),
      platform,
      arch,
    });
    assert.equal(runtime.mode, 'native');
    assert.equal(runtime.electronVersion, '44.2.0');
    assert.equal(runtime.receipt.kind, 'klaus-electron-runtime');
    assert.equal(runtime.summary.mode, 'native');
    assert.equal(runtime.summary.name, 'native-browser-runtime-phase1');
    assert.ok(runtime.packagerZip?.sha256);
    assert.equal(basename(runtime.packagerZip.file), 'electron-v44.2.0-darwin-arm64.zip');
    const archive = spawnSync('/usr/bin/unzip', ['-Z', '-l', runtime.packagerZip.file], { encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    assert.match(archive.stdout, /Electron\.app\//);
    assert.match(archive.stdout, /lrwxr-xr-x .*Electron\.app\/Contents\/Frameworks\/Electron Framework\.framework\/Versions\/Current/);
    assert.ok(readFileSync(receiptFile, 'utf8').includes('treeSha256'));
    const revalidated = await validateNativeRuntime({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch, requirePackagerZip: true });
    assert.equal(revalidated.mode, 'native');
    const cli = spawnSync(process.execPath, [
      join(root, 'scripts/electron-runtime-resolver.mjs'), 'verify',
      '--runtime-dir', directory,
      '--receipt', receiptFile,
      '--manifest', join(directory, 'manifest.json'),
      '--platform', platform,
      '--arch', arch,
      '--require-packager-zip',
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /"mode": "native"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

macTest('native runtime rejects a mismatched target', async () => {
  const directory = fixtureDirectory();
  try {
    createArtifact(directory);
    const receiptFile = join(directory, 'runtime.json');
    await createNativeRuntimeReceipt({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch });
    await assert.rejects(
      validateNativeRuntime({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform: 'win32', arch: 'x64', requirePackagerZip: true }),
      /platform/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

macTest('native runtime rejects a changed manifest', async () => {
  const directory = fixtureDirectory();
  try {
    createArtifact(directory);
    const receiptFile = join(directory, 'runtime.json');
    await createNativeRuntimeReceipt({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch });
    const manifestFile = join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.patch_order[0].purpose = 'tampered';
    writeFileSync(manifestFile, JSON.stringify(manifest));
    await assert.rejects(
      validateNativeRuntime({ runtimeDirectory: directory, receiptFile, manifestFile, platform, arch, requirePackagerZip: true }),
      /Patch manifest SHA-256/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

macTest('native runtime rejects a changed patch order digest', async () => {
  const directory = fixtureDirectory();
  try {
    createArtifact(directory);
    const receiptFile = join(directory, 'runtime.json');
    await createNativeRuntimeReceipt({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch });
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    receipt.source.patchOrderSha256 = '0'.repeat(64);
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
    await assert.rejects(
      validateNativeRuntime({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch, requirePackagerZip: true }),
      /Patch order SHA-256/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

macTest('native runtime rejects a modified executable', async () => {
  const directory = fixtureDirectory();
  try {
    createArtifact(directory);
    const receiptFile = join(directory, 'runtime.json');
    await createNativeRuntimeReceipt({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch });
    const executable = join(directory, 'Electron.app/Contents/MacOS/Electron');
    const bytes = readFileSync(executable);
    bytes[0] = 0x00;
    writeFileSync(executable, bytes);
    await assert.rejects(
      validateNativeRuntime({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch, requirePackagerZip: true }),
      /tree SHA-256/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

macTest('native runtime rejects a modified resource', async () => {
  const directory = fixtureDirectory();
  try {
    createArtifact(directory);
    const receiptFile = join(directory, 'runtime.json');
    await createNativeRuntimeReceipt({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch });
    writeFileSync(join(directory, 'Electron.app/Contents/Resources/default_app.asar'), 'tampered resource');
    await assert.rejects(
      validateNativeRuntime({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch, requirePackagerZip: true }),
      /tree SHA-256/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

macTest('native runtime rejects a missing packager zip when required', async () => {
  const directory = fixtureDirectory();
  try {
    createArtifact(directory);
    const receiptFile = join(directory, 'runtime.json');
    await createNativeRuntimeReceipt({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch });
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    rmSync(join(directory, receipt.packager.zipFile), { force: true });
    await assert.rejects(
      validateNativeRuntime({ runtimeDirectory: directory, receiptFile, manifestFile: join(directory, 'manifest.json'), platform, arch, requirePackagerZip: true }),
      /ZIP/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resolveElectronRuntime fails in native mode without injected paths', async () => {
  await assert.rejects(
    resolveElectronRuntime({ appDirectory: root, mode: 'native', env: {}, platform, arch }),
    /Native Electron runtime selection requires/,
  );
});

test('resolveElectronRuntime uses stock explicitly for Node-only tests', async () => {
  const runtime = await resolveElectronRuntime({ appDirectory: root, mode: 'stock', env: {}, platform, arch });
  assert.equal(runtime.mode, 'stock');
  assert.equal(runtime.electronVersion, '44.2.0');
});

test('describeElectronRuntime formats both modes', () => {
  const stock = { mode: 'stock', electronVersion: '44.2.0', target: { platform, arch }, receipt: null, receiptSha256: null };
  assert.ok(describeElectronRuntime(stock).includes('stock'));
  const native = {
    mode: 'native',
    electronVersion: '44.2.0',
    target: { platform, arch },
    receipt: { name: 'native-browser-runtime-phase1' },
    receiptSha256: 'a'.repeat(64),
  };
  assert.ok(describeElectronRuntime(native).includes('native'));
});
