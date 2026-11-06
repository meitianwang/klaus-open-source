import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HELPER_MANIFEST,
  HELPER_NAME,
  MAX_HELPER_BYTES,
  prepareBrowserImportHelper,
  sourceFingerprint,
  verifyBrowserImportHelper,
} from './browser-import-helper.mjs';

const repo = new URL('..', import.meta.url).pathname;

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function artifact({ arch = 'arm64', mode = 'production', sourceSha256 = sourceFingerprint(repo) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-browser-import-resource-'));
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
    sha256: sha(binary),
    sourceSha256,
    sourceCommit: 'a'.repeat(40),
    sourceTreeDirty: false,
    compiler: 'synthetic clang',
    signing: 'unsigned',
    signed: false,
    releaseEligible: false,
  };
  writeFileSync(join(directory, HELPER_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, binary, manifest };
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

test('unsigned production helper verifies but is not release eligible', () => {
  const { directory } = artifact();
  try {
    const verified = verifyBrowserImportHelper({ repo, platform: 'darwin', arch: 'arm64', directory });
    assert.equal(verified.verified, true);
    assert.equal(verified.signed, false);
    assert.equal(verified.releaseEligible, false);
    assert.throws(
      () => verifyBrowserImportHelper({ repo, platform: 'darwin', arch: 'arm64', directory, requireRelease: true }),
      /unsigned|release eligible/i,
    );
  } finally {
    cleanup(directory);
  }
});

test('oversized sparse helper is rejected before reading its bytes', () => {
  const { directory } = artifact();
  try {
    truncateSync(join(directory, HELPER_NAME), MAX_HELPER_BYTES + 1);
    assert.throws(
      () => verifyBrowserImportHelper({ repo, platform: 'darwin', arch: 'arm64', directory }),
      /size is outside the supported bound/i,
    );
  } finally {
    cleanup(directory);
  }
});

test('test-mode manifest is always rejected for packaging', () => {
  const { directory } = artifact({ mode: 'test' });
  try {
    assert.throws(
      () => verifyBrowserImportHelper({ repo, platform: 'darwin', arch: 'arm64', directory }),
      /test browser-import helper/i,
    );
  } finally {
    cleanup(directory);
  }
});

test('hash, source fingerprint and extra payload payload changes are rejected', () => {
  const first = artifact();
  try {
    const manifestPath = join(first.directory, HELPER_MANIFEST);
    const manifest = { ...first.manifest, sha256: '0'.repeat(64) };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => verifyBrowserImportHelper({ repo, platform: 'darwin', arch: 'arm64', directory: first.directory }),
      /SHA-256/i,
    );
  } finally {
    cleanup(first.directory);
  }

  const second = artifact({ sourceSha256: '0'.repeat(64) });
  try {
    assert.throws(
      () => verifyBrowserImportHelper({ repo, platform: 'darwin', arch: 'arm64', directory: second.directory }),
      /source fingerprint/i,
    );
  } finally {
    cleanup(second.directory);
  }

  const third = artifact();
  try {
    writeFileSync(join(third.directory, 'unexpected.txt'), 'extra');
    assert.throws(
      () => verifyBrowserImportHelper({ repo, platform: 'darwin', arch: 'arm64', directory: third.directory }),
      /only the helper/i,
    );
  } finally {
    cleanup(third.directory);
  }
});

test('test-mode prepare refuses the packaged resource tree before compiling', () => {
  const f = mkdtempSync(join(tmpdir(), 'klaus-browser-import-prepare-'));
  try {
    assert.throws(
      () => prepareBrowserImportHelper({
        repo,
        platform: 'darwin',
        arch: 'arm64',
        mode: 'test',
        output: join(repo, 'resources/browser-import/darwin-arm64'),
      }),
      /test browser-import helper artifacts cannot be written/i,
    );
  } finally {
    rmSync(f, { recursive: true, force: true });
  }
});
