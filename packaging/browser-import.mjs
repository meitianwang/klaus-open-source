import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  HELPER_MANIFEST,
  HELPER_NAME,
  prepareBrowserImportHelper,
  RESOURCE_ROOT,
  verifyBrowserImportHelper,
} from '../scripts/browser-import-helper.mjs';

export { HELPER_MANIFEST, HELPER_NAME };

export const BROWSER_IMPORT_RESOURCE_ROOT = 'browser-import';
export const BROWSER_IMPORT_HELPER_ENV = 'KLAUS_BROWSER_IMPORT_HELPER';

const defaultRepo = fileURLToPath(new URL('..', import.meta.url));

export function browserImportUnsupported(platform) {
  return {
    supported: false,
    platform,
    reason: `Browser profile import is unavailable on ${platform}; no browser-import helper is packaged.`,
  };
}

export function browserImportDirectory(repo, platform, arch) {
  return join(resolve(repo), RESOURCE_ROOT, `${platform}-${arch}`);
}

/** Copy only portable identity fields into the package manifest. */
export function browserImportManifestRecord(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, HELPER_MANIFEST), 'utf8'));
  const target = `${manifest.platform}-${manifest.arch}`;
  return {
    supported: true,
    schemaVersion: manifest.schemaVersion,
    mode: manifest.mode,
    platform: manifest.platform,
    arch: manifest.arch,
    target,
    file: HELPER_NAME,
    helperPath: `${BROWSER_IMPORT_RESOURCE_ROOT}/${target}/${HELPER_NAME}`,
    manifestPath: `${BROWSER_IMPORT_RESOURCE_ROOT}/${target}/${HELPER_MANIFEST}`,
    size: manifest.size,
    sha256: manifest.sha256,
    sourceSha256: manifest.sourceSha256,
    sourceCommit: manifest.sourceCommit,
    sourceTreeDirty: manifest.sourceTreeDirty,
    compiler: manifest.compiler,
    signing: manifest.signing,
    signed: manifest.signed,
    releaseEligible: manifest.releaseEligible,
  };
}

/**
 * Development entrypoint helper: reuse a valid production resource, otherwise
 * rebuild it through the same producer used by release preparation.
 */
export function ensureBrowserImportHelper({ repo = defaultRepo, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin') return browserImportUnsupported(platform);
  const directory = browserImportDirectory(repo, platform, arch);
  if (existsSync(directory)) {
    try {
      const verified = verifyBrowserImportHelper({ repo, platform, arch, directory });
      return {
        ...verified,
        supported: true,
        prepared: false,
        helperPath: join(directory, HELPER_NAME),
        record: browserImportManifestRecord(directory),
      };
    } catch {
      // A stale or malformed generated resource is replaced below.
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const prepared = prepareBrowserImportHelper({ repo, platform, arch, mode: 'production' });
  return {
    ...prepared,
    supported: true,
    prepared: true,
    helperPath: join(prepared.directory, HELPER_NAME),
    record: browserImportManifestRecord(prepared.directory),
  };
}

/** Validate an explicitly selected helper directory before copying it into a package. */
export function validateBrowserImportResource(directory, { repo = defaultRepo, platform = process.platform, arch = process.arch, requireRelease = false } = {}) {
  if (platform !== 'darwin') {
    throw new Error(`Browser profile import is unavailable on ${platform}; refusing to package a browser-import helper`);
  }
  const verified = verifyBrowserImportHelper({ repo, platform, arch, directory, requireRelease });
  return { ...verified, record: browserImportManifestRecord(directory) };
}

/** Verify the resource in its final package location and match its manifest identity. */
export function verifyBrowserImportResource(resources, manifest, { repo = defaultRepo } = {}) {
  const platform = manifest.platform;
  const arch = manifest.arch;
  const target = `${platform}-${arch}`;
  const root = join(resources, BROWSER_IMPORT_RESOURCE_ROOT);
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (platform !== 'darwin') {
    if (rootInfo) throw new Error('The macOS browser-import helper leaked into a non-macOS package');
    const expected = browserImportUnsupported(platform);
    if (manifest.browserImport !== undefined && !isDeepStrictEqual(manifest.browserImport, expected)) {
      throw new Error('The non-macOS package has an inconsistent browser-import capability record');
    }
    return expected;
  }
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || readdirSync(root).join(',') !== target) {
    throw new Error('Unexpected browser-import helper target');
  }
  const directory = join(root, target);
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error('The browser-import helper target must be a regular directory');
  }
  const verified = validateBrowserImportResource(directory, { repo, platform, arch });
  const record = browserImportManifestRecord(directory);
  if (!isDeepStrictEqual(record, manifest.browserImport)) {
    throw new Error('Packaged browser-import helper differs from its resource identity');
  }
  if (readdirSync(directory).sort().join(',') !== [HELPER_NAME, HELPER_MANIFEST].sort().join(',')) {
    throw new Error('Unexpected packaged browser-import helper payload');
  }
  return verified.record;
}
