/**
 * Locate and validate the macOS browser-import decryption helper.
 *
 * Development accepts only an explicitly injected absolute executable path.
 * Packaged builds resolve the helper from their immutable resource tree. This
 * module never reads a browser profile or the keychain and never starts the
 * helper; callers should invoke it lazily when encryption is actually needed.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  BrowserImportDecryptError,
  type BrowserImportPlatform,
} from '../../contracts/browser-import';

export const BROWSER_IMPORT_HELPER_ENV = 'KLAUS_BROWSER_IMPORT_HELPER';
export const BROWSER_IMPORT_HELPER_NAME = 'klaus-browser-import-helper';
export const BROWSER_IMPORT_HELPER_MANIFEST = `${BROWSER_IMPORT_HELPER_NAME}.json`;
export const BROWSER_IMPORT_HELPER_DIRECTORY = 'browser-import';

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_HELPER_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);

export interface BrowserImportHelperLocatorOptions {
  packaged: boolean;
  resourceDirs: string;
  platform?: BrowserImportPlatform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BrowserImportHelperManifest {
  schemaVersion: number;
  mode: 'production';
  platform: string;
  arch: string;
  target: string;
  file: string;
  size: number;
  sha256: string;
  [key: string]: unknown;
}

function failure(code: string, message: string): never {
  throw new BrowserImportDecryptError(code, message);
}

function statFile(path: string, code: string, message: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) failure(code, message);
  if (!info.isFile() || info.isSymbolicLink()) failure('invalid_helper_path', message);
  return info;
}

function realPath(path: string, code: string, message: string): string {
  try {
    return realpathSync(path);
  } catch {
    failure(code, message);
  }
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function readManifest(path: string): BrowserImportHelperManifest {
  const info = statFile(path, 'helper_unavailable', 'The browser-import helper manifest is missing.');
  if (info.size < 1 || info.size > MAX_MANIFEST_BYTES) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest size is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    failure('invalid_helper_manifest', 'The browser-import helper manifest is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest is invalid.');
  }
  return value as BrowserImportHelperManifest;
}

function validateManifest(manifest: BrowserImportHelperManifest, platform: string, arch: string): void {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest schema is unsupported.');
  }
  if (manifest.mode !== 'production') {
    failure('invalid_helper_manifest', 'Test browser-import helper artifacts cannot be used by the app.');
  }
  if (manifest.platform !== platform || manifest.arch !== arch || manifest.target !== `${platform}-${arch}`) {
    failure('invalid_helper_manifest', 'The browser-import helper target differs from this application.');
  }
  if (manifest.file !== BROWSER_IMPORT_HELPER_NAME) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest names the wrong file.');
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_HELPER_BYTES) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest size is invalid.');
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest SHA-256 is invalid.');
  }
}

/**
 * Return the absolute helper path or a structured BrowserImportDecryptError.
 *
 * `packaged: true` ignores the development environment and requires the helper
 * inside `resourceDirs/browser-import/<platform>-<arch>`. `packaged: false`
 * requires `KLAUS_BROWSER_IMPORT_HELPER` to be an absolute path.
 */
export function resolveBrowserImportHelper(options: BrowserImportHelperLocatorOptions): string {
  const {
    packaged,
    resourceDirs,
    platform = process.platform as BrowserImportPlatform,
    arch = process.arch,
    env = process.env,
  } = options;
  if (!isAbsolute(resourceDirs)) failure('helper_unavailable', 'The application resource directory must be absolute.');
  if (platform !== 'darwin') {
    failure('helper_unavailable', `Browser profile import is unavailable on ${platform}.`);
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    failure('helper_unavailable', `Browser profile import is unavailable for ${platform}-${arch}.`);
  }

  let helperPath: string;
  let manifestPath: string;
  if (packaged) {
    const resourceRoot = realPath(resolve(resourceDirs), 'helper_unavailable', 'The packaged application resource directory is missing.');
    const container = join(resourceRoot, BROWSER_IMPORT_HELPER_DIRECTORY);
    const containerInfo = lstatSync(container, { throwIfNoEntry: false });
    if (!containerInfo?.isDirectory() || containerInfo.isSymbolicLink()) {
      failure('helper_unavailable', 'The packaged browser-import helper directory is missing.');
    }
    const expectedDirectory = join(container, `${platform}-${arch}`);
    const directoryInfo = lstatSync(expectedDirectory, { throwIfNoEntry: false });
    if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
      failure('helper_unavailable', 'The packaged browser-import helper target is missing.');
    }
    const expectedRealDirectory = realPath(expectedDirectory, 'helper_unavailable', 'The packaged browser-import helper target is missing.');
    if (!isInside(resourceRoot, expectedRealDirectory) || !isInside(container, expectedRealDirectory)) {
      failure('invalid_helper_path', 'The packaged browser-import helper directory escapes the application resources.');
    }
    helperPath = join(expectedDirectory, BROWSER_IMPORT_HELPER_NAME);
    manifestPath = join(expectedDirectory, BROWSER_IMPORT_HELPER_MANIFEST);
  } else {
    const injected = env[BROWSER_IMPORT_HELPER_ENV];
    if (typeof injected !== 'string' || !injected.trim()) {
      failure('helper_unavailable', `${BROWSER_IMPORT_HELPER_ENV} must identify an absolute browser-import helper.`);
    }
    if (!isAbsolute(injected)) {
      failure('invalid_helper_path', `${BROWSER_IMPORT_HELPER_ENV} must be an absolute path.`);
    }
    helperPath = resolve(injected);
    manifestPath = `${helperPath}.json`;
  }

  if (helperPath.split(/[\\/]/u).at(-1) !== BROWSER_IMPORT_HELPER_NAME) {
    failure('invalid_helper_path', `The browser-import helper must be named ${BROWSER_IMPORT_HELPER_NAME}.`);
  }

  const helperInfo = statFile(helperPath, 'helper_unavailable', 'The browser-import helper is missing.');
  if (helperInfo.size < 1 || helperInfo.size > MAX_HELPER_BYTES) {
    failure('invalid_helper_manifest', 'The browser-import helper size is outside the supported bound.');
  }
  if ((helperInfo.mode & 0o111) === 0) {
    failure('helper_not_executable', 'The browser-import helper is not executable.');
  }
  const manifestInfo = statFile(manifestPath, 'helper_unavailable', 'The browser-import helper manifest is missing.');
  const realHelper = realPath(helperPath, 'helper_unavailable', 'The browser-import helper is missing.');
  const realManifest = realPath(manifestPath, 'helper_unavailable', 'The browser-import helper manifest is missing.');
  if (packaged) {
    const expectedRealDirectory = realPath(join(resourceDirs, BROWSER_IMPORT_HELPER_DIRECTORY, `${platform}-${arch}`), 'helper_unavailable', 'The packaged browser-import helper target is missing.');
    if (!isInside(expectedRealDirectory, realHelper) || !isInside(expectedRealDirectory, realManifest)) {
      failure('invalid_helper_path', 'The packaged browser-import helper escapes its target directory.');
    }
  }

  const manifest = readManifest(manifestPath);
  validateManifest(manifest, platform, arch);
  if (manifest.size !== helperInfo.size) {
    failure('helper_integrity_failed', 'The browser-import helper size differs from its manifest.');
  }
  const digest = createHash('sha256').update(readFileSync(realHelper)).digest('hex');
  if (digest !== manifest.sha256) {
    failure('helper_integrity_failed', 'The browser-import helper SHA-256 differs from its manifest.');
  }
  return realHelper;
}
