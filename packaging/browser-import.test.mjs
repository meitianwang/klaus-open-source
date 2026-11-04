import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  browserImportManifestRecord,
  browserImportUnsupported,
  ensureBrowserImportHelper,
  HELPER_MANIFEST,
  HELPER_NAME,
  validateBrowserImportResource,
  verifyBrowserImportResource,
} from './browser-import.mjs';
import { sourceFingerprint } from '../scripts/browser-import-helper.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

function artifact({ mode = 'production', arch = 'arm64', sourceSha256 = sourceFingerprint(repo) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-browser-import-packaging-'));
  const binary = Buffer.alloc(64);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  const binaryPath = join(directory, HELPER_NAME);
  writeFileSync(binaryPath, binary);
  chmodSync(binaryPath, 0o755);
  const manifest = {
    schemaVersion: 1,
    mode,
    platform: 'darwin',
    arch,
    target: `darwin-${arch}`,
    file: HELPER_NAME,
    size: binary.length,
    sha256: createHash('sha256').update(binary).digest('hex'),
    sourceSha256,
    sourceCommit: 'a'.repeat(40),
    sourceTreeDirty: false,
    compiler: 'synthetic clang',
    signing: 'unsigned',
    signed: false,
    releaseEligible: false,
  };
  writeFileSync(join(directory, HELPER_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, binaryPath, manifest };
}

function packageResources(root, source, target = 'darwin-arm64') {
  const destination = join(root, 'resources', 'browser-import', target);
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
  chmodSync(join(destination, HELPER_NAME), 0o755);
  return { resources: join(root, 'resources'), directory: destination };
}

test('non-macOS development is explicitly unsupported without creating a helper', () => {
  assert.deepEqual(ensureBrowserImportHelper({ repo, platform: 'win32', arch: 'x64' }), browserImportUnsupported('win32'));
  assert.throws(
    () => validateBrowserImportResource(join(repo, 'resources/browser-import/darwin-arm64'), { repo, platform: 'win32', arch: 'x64' }),
    /unavailable on win32/,
  );
});

test('production helper identity is copied into package metadata and verified in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-package-'));
  const source = artifact();
  try {
    const { resources } = packageResources(root, source.directory);
    const record = browserImportManifestRecord(source.directory);
    assert.equal(record.supported, true);
    assert.equal(record.helperPath, `browser-import/darwin-arm64/${HELPER_NAME}`);
    assert.equal(record.manifestPath, `browser-import/darwin-arm64/${HELPER_MANIFEST}`);
    assert.deepEqual(
      verifyBrowserImportResource(resources, { platform: 'darwin', arch: 'arm64', browserImport: record }, { repo }),
      record,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test-mode helper artifacts cannot enter package resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-test-mode-'));
  const source = artifact({ mode: 'test' });
  try {
    const { resources } = packageResources(root, source.directory);
    assert.throws(
      () => verifyBrowserImportResource(resources, {
        platform: 'darwin',
        arch: 'arm64',
        browserImport: browserImportManifestRecord(source.directory),
      }, { repo }),
      /test browser-import helper/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows packages reject a leaked macOS browser-import resource', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-windows-'));
  const source = artifact();
  try {
    const { resources } = packageResources(root, source.directory);
    assert.throws(
      () => verifyBrowserImportResource(resources, { platform: 'win32', arch: 'x64', browserImport: browserImportUnsupported('win32') }, { repo }),
      /leaked into a non-macOS package/,
    );
    rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
    assert.deepEqual(
      verifyBrowserImportResource(resources, { platform: 'win32', arch: 'x64', browserImport: browserImportUnsupported('win32') }, { repo }),
      browserImportUnsupported('win32'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hash, source fingerprint and target changes are rejected before copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-invalid-'));
  const source = artifact();
  try {
    const manifestPath = join(source.directory, HELPER_MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify({ ...source.manifest, sha256: '0'.repeat(64) }, null, 2)}\n`);
    assert.throws(
      () => validateBrowserImportResource(source.directory, { repo, platform: 'darwin', arch: 'arm64' }),
      /SHA-256/,
    );
    writeFileSync(manifestPath, `${JSON.stringify({ ...source.manifest, sourceSha256: '0'.repeat(64) }, null, 2)}\n`);
    assert.throws(
      () => validateBrowserImportResource(source.directory, { repo, platform: 'darwin', arch: 'arm64' }),
      /source fingerprint/,
    );
    writeFileSync(manifestPath, `${JSON.stringify({ ...source.manifest, arch: 'x64', target: 'darwin-x64' }, null, 2)}\n`);
    assert.throws(
      () => validateBrowserImportResource(source.directory, { repo, platform: 'darwin', arch: 'arm64' }),
      /target mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
