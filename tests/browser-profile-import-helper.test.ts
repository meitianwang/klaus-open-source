import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserImportDecryptError,
} from '../contracts/browser-import';
import {
  BROWSER_IMPORT_HELPER_ENV,
  BROWSER_IMPORT_HELPER_MANIFEST,
  BROWSER_IMPORT_HELPER_NAME,
  resolveBrowserImportHelper,
} from '../main/browser/profile-import-helper';
import { Harness, assert, assertEqual } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-helper-locator-'));
const resources = join(root, 'resources');
const resultDirectory = join(process.cwd(), 'dist', 'browser-import-helper-logs');
mkdirSync(resultDirectory, { recursive: true });
mkdirSync(resources, { recursive: true });

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifact({ mode = 'production', arch = 'arm64' }: { mode?: 'production' | 'test'; arch?: 'arm64' | 'x64' } = {}) {
  const directory = mkdtempSync(join(root, 'artifact-'));
  const bytes = Buffer.from(`synthetic ${mode} helper`);
  const binary = join(directory, BROWSER_IMPORT_HELPER_NAME);
  writeFileSync(binary, bytes, { mode: 0o755 });
  chmodSync(binary, 0o755);
  const manifest = {
    schemaVersion: 1,
    mode,
    platform: 'darwin',
    arch,
    target: `darwin-${arch}`,
    file: BROWSER_IMPORT_HELPER_NAME,
    size: bytes.length,
    sha256: sha256(bytes),
    sourceSha256: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    sourceTreeDirty: false,
    compiler: 'synthetic compiler',
    signing: 'unsigned',
    signed: false,
    releaseEligible: false,
  };
  writeFileSync(join(directory, BROWSER_IMPORT_HELPER_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, binary, manifest };
}

function packagedArtifact(source = artifact()) {
  const directory = join(resources, 'browser-import', 'darwin-arm64');
  mkdirSync(directory, { recursive: true });
  cpSync(source.directory, directory, { recursive: true });
  chmodSync(join(directory, BROWSER_IMPORT_HELPER_NAME), 0o755);
  return { directory, helper: join(directory, BROWSER_IMPORT_HELPER_NAME), manifest: source.manifest };
}

function expectError(fn: () => string, code: string, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof BrowserImportDecryptError, `${message}: expected BrowserImportDecryptError, got ${String(caught)}`);
  assertEqual((caught as BrowserImportDecryptError).code, code, `${message}: error code`);
}

void (async () => {
  await h.test('development accepts only an explicit absolute helper path', () => {
    const source = artifact();
    try {
      const resolved = resolveBrowserImportHelper({
        packaged: false,
        resourceDirs: [resources],
        platform: 'darwin',
        arch: 'arm64',
        env: { [BROWSER_IMPORT_HELPER_ENV]: source.binary },
      });
      assertEqual(resolved, realpathSync(source.binary), 'development helper path');
      expectError(
        () => resolveBrowserImportHelper({ packaged: false, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'helper_unavailable',
        'missing development helper',
      );
      expectError(
        () => resolveBrowserImportHelper({ packaged: false, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: { [BROWSER_IMPORT_HELPER_ENV]: 'relative/helper' } }),
        'invalid_helper_path',
        'relative development helper',
      );
      expectError(
        () => resolveBrowserImportHelper({ packaged: false, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: { [BROWSER_IMPORT_HELPER_ENV]: join(root, 'missing', BROWSER_IMPORT_HELPER_NAME) } }),
        'helper_unavailable',
        'missing development helper file',
      );
    } finally {
      rmSync(source.directory, { recursive: true, force: true });
    }
  });

  await h.test('packaged mode resolves the target resource and ignores injected development paths', () => {
    try {
      const packaged = packagedArtifact();
      writeFileSync(join(resources, 'desktop-resources.json'), `${JSON.stringify({
        browserImport: {
          target: packaged.manifest.target,
          sourceSha256: packaged.manifest.sourceSha256,
          sourceCommit: packaged.manifest.sourceCommit,
          file: packaged.manifest.file,
        },
      })}\n`);
      const resolved = resolveBrowserImportHelper({
        packaged: true,
        resourceDirs: [resources],
        platform: 'darwin',
        arch: 'arm64',
        env: { [BROWSER_IMPORT_HELPER_ENV]: '/untrusted/dev-helper' },
      });
      assertEqual(resolved, realpathSync(packaged.helper), 'packaged helper path');
    } finally {
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
    }
  });

  await h.test('test-mode and corrupt helper artifacts are rejected', () => {
    try {
      const testMode = packagedArtifact(artifact({ mode: 'test' }));
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'invalid_helper_manifest',
        'test-mode artifact',
      );
      assertEqual(testMode.manifest.mode, 'test', 'fixture is test mode');
      writeFileSync(join(testMode.directory, BROWSER_IMPORT_HELPER_MANIFEST), `${JSON.stringify({ ...testMode.manifest, mode: 'production' })}\n`);
      const bytes = Buffer.from('corrupt helper');
      writeFileSync(testMode.helper, bytes);
      chmodSync(testMode.helper, 0o755);
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'helper_integrity_failed',
        'corrupt helper',
      );
    } finally {
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
    }
  });

  await h.test('wrong target, non-executable files and missing manifests are rejected', () => {
    try {
      const packaged = packagedArtifact();
      writeFileSync(join(packaged.directory, BROWSER_IMPORT_HELPER_MANIFEST), `${JSON.stringify({ ...packaged.manifest, arch: 'x64', target: 'darwin-x64' })}\n`);
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'invalid_helper_manifest',
        'wrong target',
      );
      writeFileSync(join(packaged.directory, BROWSER_IMPORT_HELPER_MANIFEST), `${JSON.stringify(packaged.manifest)}\n`);
      chmodSync(packaged.helper, 0o644);
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'helper_not_executable',
        'non-executable helper',
      );
      chmodSync(packaged.helper, 0o755);
      rmSync(join(packaged.directory, BROWSER_IMPORT_HELPER_MANIFEST));
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'helper_unavailable',
        'missing manifest',
      );
    } finally {
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
    }
  });

  await h.test('malformed source identity is rejected before helper use', () => {
    try {
      const packaged = packagedArtifact();
      for (const manifest of [
        { ...packaged.manifest, sourceSha256: 'not-a-sha' },
        { ...packaged.manifest, sourceCommit: 'not-a-commit' },
        { ...packaged.manifest, sourceTreeDirty: 'no' },
      ]) {
        writeFileSync(join(packaged.directory, BROWSER_IMPORT_HELPER_MANIFEST), `${JSON.stringify(manifest)}\n`);
        expectError(
          () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
          'invalid_helper_manifest',
          'malformed source identity',
        );
      }
    } finally {
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
    }
  });

  await h.test('packaged symlink escapes are rejected before reading helper contents', () => {
    try {
      const outside = mkdtempSync(join(root, 'outside-'));
      symlinkSync(outside, join(resources, 'browser-import'));
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'invalid_helper_path',
        'symlinked resource directory',
      );
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
      const packaged = packagedArtifact();
      const externalHelper = join(outside, BROWSER_IMPORT_HELPER_NAME);
      writeFileSync(externalHelper, 'outside helper', { mode: 0o755 });
      rmSync(packaged.helper);
      symlinkSync(externalHelper, packaged.helper);
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {} }),
        'invalid_helper_path',
        'symlinked helper',
      );
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
    }
  });

  await h.test('unsupported platforms and relative resource roots fail structurally', () => {
    expectError(
      () => resolveBrowserImportHelper({ packaged: false, resourceDirs: [resources], platform: 'linux', arch: 'x64', env: {} }),
      'helper_unavailable',
      'unsupported platform',
    );
    expectError(
      () => resolveBrowserImportHelper({ packaged: false, resourceDirs: [resources], platform: 'win32', arch: 'arm64', env: {} }),
      'helper_unavailable',
      'unsupported Windows architecture',
    );
    expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: ['relative/resources'], platform: 'darwin', arch: 'arm64', env: {} }),
        'helper_unavailable',
        'relative resource root',
      );
    });

  await h.test('signed helper bytes are accepted only after a trusted signature check', () => {
    try {
      const packaged = packagedArtifact();
      const original = Buffer.from('synthetic production helper');
      const changed = Buffer.from('Synthetic production helper');
      assertEqual(changed.length, original.length, 'fixture keeps the manifest size');
      writeFileSync(packaged.helper, changed, { mode: 0o755 });
      chmodSync(packaged.helper, 0o755);
      expectError(
        () => resolveBrowserImportHelper({ packaged: true, resourceDirs: [resources], platform: 'darwin', arch: 'arm64', env: {}, verifySignature: () => false }),
        'helper_integrity_failed',
        'changed bytes without a signature',
      );
      const resolved = resolveBrowserImportHelper({
        packaged: true,
        resourceDirs: [resources],
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        verifySignature: () => true,
      });
      assertEqual(resolved, realpathSync(packaged.helper), 'signed helper with a changed hash');
    } finally {
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
      rmSync(join(resources, 'desktop-resources.json'), { force: true });
    }
  });

  await h.test('packaged lookup accepts multiple resource roots in order', () => {
    try {
      const packaged = packagedArtifact();
      const resolved = resolveBrowserImportHelper({
        packaged: true,
        resourceDirs: [join(root, 'empty-root'), resources],
        platform: 'darwin',
        arch: 'arm64',
        env: {},
      });
      assertEqual(resolved, realpathSync(packaged.helper), 'helper from the second resource root');
    } finally {
      rmSync(join(resources, 'browser-import'), { recursive: true, force: true });
    }
  });

  process.exitCode = await h.finish(join(resultDirectory, 'browser-profile-import-helper.result.json'), 'browser-profile-import-helper');
})();
