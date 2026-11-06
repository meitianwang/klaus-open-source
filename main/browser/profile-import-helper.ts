/**
 * Locate and validate the browser-import decryption helper.
 *
 * Development first reuses a prepared production resource and falls back to an
 * optional absolute override. Packaged builds resolve the helper from their
 * immutable resource tree. This module never reads a browser profile or the
 * keychain and never starts the helper; callers invoke it lazily when
 * encryption is actually needed.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  BrowserImportDecryptError,
} from '../../contracts/browser-import';

export const BROWSER_IMPORT_HELPER_ENV = 'KLAUS_BROWSER_IMPORT_HELPER';
export const BROWSER_IMPORT_HELPER_NAME = 'klaus-browser-import-helper';
export const BROWSER_IMPORT_HELPER_MANIFEST = `${BROWSER_IMPORT_HELPER_NAME}.json`;
export const BROWSER_IMPORT_HELPER_DIRECTORY = 'browser-import';
export const helperName = (platform: string): string => platform === 'win32' ? `${BROWSER_IMPORT_HELPER_NAME}.exe` : BROWSER_IMPORT_HELPER_NAME;

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_HELPER_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);

export interface BrowserImportHelperLocatorOptions {
  packaged: boolean;
  resourceDirs: readonly string[];
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  verifySignature?: (path: string) => boolean;
  parentBinary?: string;
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
  sourceSha256: string;
  sourceCommit: string;
  sourceTreeDirty: boolean;
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
  if (manifest.file !== helperName(platform)) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest names the wrong file.');
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_HELPER_BYTES) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest size is invalid.');
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    failure('invalid_helper_manifest', 'The browser-import helper manifest SHA-256 is invalid.');
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.sourceSha256)) {
    failure('invalid_helper_manifest', 'The browser-import helper source SHA-256 is invalid.');
  }
  if (!/^[a-f0-9]{40}$/u.test(manifest.sourceCommit)) {
    failure('invalid_helper_manifest', 'The browser-import helper source commit is invalid.');
  }
  if (typeof manifest.sourceTreeDirty !== 'boolean') {
    failure('invalid_helper_manifest', 'The browser-import helper source state is invalid.');
  }
}

function signerIdentity(path: string, platform: string): string | undefined {
  if (platform === 'darwin') {
    const verify = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', path], { encoding: 'utf8' });
    if (verify.error || verify.status !== 0) return undefined;
    const details = spawnSync('codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' });
    const text = `${details.stdout ?? ''}${details.stderr ?? ''}`;
    return details.status === 0 ? /^TeamIdentifier=(\S+)$/mu.exec(text)?.[1] : undefined;
  }
  if (platform === 'win32') {
    const escaped = path.replaceAll("'", "''");
    const command = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($s.Status -eq 'Valid') { $s.SignerCertificate.Thumbprint }`;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    const thumbprint = result.stdout.trim();
    return !result.error && result.status === 0 && /^[A-Fa-f0-9]{40,64}$/u.test(thumbprint) ? thumbprint.toUpperCase() : undefined;
  }
  return undefined;
}

function sameSigner(helper: string, parent: string, platform: string): boolean {
  const helperSigner = signerIdentity(helper, platform), parentSigner = signerIdentity(parent, platform);
  return !!helperSigner && !!parentSigner && helperSigner === parentSigner;
}

function packageRecord(resourceRoot: string): Record<string, unknown> | undefined {
  const path = join(resourceRoot, 'desktop-resources.json');
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return value.browserImport && typeof value.browserImport === 'object' ? value.browserImport as Record<string, unknown> : undefined;
  } catch {
    return undefined;
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
    platform = process.platform,
    arch = process.arch,
    env = process.env,
  } = options;
  if (!Array.isArray(resourceDirs) || resourceDirs.length === 0 || resourceDirs.some(directory => typeof directory !== 'string' || !isAbsolute(directory))) {
    failure('helper_unavailable', 'The application resource directories must be non-empty absolute paths.');
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    failure('helper_unavailable', `Browser profile import is unavailable on ${platform}.`);
  }
  if (!['darwin-arm64', 'win32-x64'].includes(`${platform}-${arch}`)) {
    failure('helper_unavailable', `Browser profile import is unavailable for ${platform}-${arch}.`);
  }

  let helperPath: string | undefined;
  let manifestPath: string | undefined;
  let expectedRealDirectory: string | undefined;
  let packagedResourceRoot: string | undefined;
  if (packaged) {
    for (const resourceDir of resourceDirs) {
      let resourceRoot: string;
      try {
        resourceRoot = realpathSync(resolve(resourceDir));
      } catch {
        continue;
      }
      const container = join(resourceRoot, BROWSER_IMPORT_HELPER_DIRECTORY);
      const containerInfo = lstatSync(container, { throwIfNoEntry: false });
      if (!containerInfo) continue;
      if (!containerInfo.isDirectory() || containerInfo.isSymbolicLink()) {
        failure('invalid_helper_path', 'The packaged browser-import helper directory is not a regular directory.');
      }
      const expectedDirectory = join(container, `${platform}-${arch}`);
      const directoryInfo = lstatSync(expectedDirectory, { throwIfNoEntry: false });
      if (!directoryInfo) continue;
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        failure('invalid_helper_path', 'The packaged browser-import helper target is not a regular directory.');
      }
      const candidateRealDirectory = realPath(expectedDirectory, 'helper_unavailable', 'The packaged browser-import helper target is missing.');
      if (!isInside(resourceRoot, candidateRealDirectory) || !isInside(container, candidateRealDirectory)) {
        failure('invalid_helper_path', 'The packaged browser-import helper directory escapes the application resources.');
      }
      helperPath = join(expectedDirectory, helperName(platform));
      manifestPath = join(expectedDirectory, BROWSER_IMPORT_HELPER_MANIFEST);
      expectedRealDirectory = candidateRealDirectory;
      packagedResourceRoot = resourceRoot;
      break;
    }
    if (!helperPath || !manifestPath || !expectedRealDirectory) {
      failure('helper_unavailable', 'The packaged browser-import helper was not found in the supplied resource directories.');
    }
  } else {
    for (const resourceDir of resourceDirs) {
      const directory = join(resolve(resourceDir), BROWSER_IMPORT_HELPER_DIRECTORY, `${platform}-${arch}`);
      const candidate = join(directory, helperName(platform));
      if (existsSync(candidate)) { helperPath = candidate; manifestPath = join(directory, BROWSER_IMPORT_HELPER_MANIFEST); break; }
    }
  }
  if (!helperPath && !packaged) {
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
  if (!helperPath || !manifestPath) failure('helper_unavailable', 'The browser-import helper was not found.');

  if (helperPath.split(/[\\/]/u).at(-1) !== helperName(platform)) {
    failure('invalid_helper_path', `The browser-import helper must be named ${helperName(platform)}.`);
  }

  const helperInfo = statFile(helperPath, 'helper_unavailable', 'The browser-import helper is missing.');
  if (helperInfo.size < 1 || helperInfo.size > MAX_HELPER_BYTES) {
    failure('invalid_helper_manifest', 'The browser-import helper size is outside the supported bound.');
  }
  if (platform === 'darwin' && (helperInfo.mode & 0o111) === 0) {
    failure('helper_not_executable', 'The browser-import helper is not executable.');
  }
  const manifestInfo = statFile(manifestPath, 'helper_unavailable', 'The browser-import helper manifest is missing.');
  const realHelper = realPath(helperPath, 'helper_unavailable', 'The browser-import helper is missing.');
  const realManifest = realPath(manifestPath, 'helper_unavailable', 'The browser-import helper manifest is missing.');
  if (packaged && expectedRealDirectory) {
    if (!isInside(expectedRealDirectory, realHelper) || !isInside(expectedRealDirectory, realManifest)) {
      failure('invalid_helper_path', 'The packaged browser-import helper escapes its target directory.');
    }
  }

  const manifest = readManifest(manifestPath);
  validateManifest(manifest, platform, arch);
  const digest = createHash('sha256').update(readFileSync(realHelper)).digest('hex');
  if (digest === manifest.sha256) {
    if (manifest.size !== helperInfo.size) failure('helper_integrity_failed', 'The browser-import helper size differs from its manifest.');
    return realHelper;
  }
  if (!packaged || !packagedResourceRoot) failure('helper_integrity_failed', 'A changed browser-import helper requires a packaged parent bundle.');
  if (manifest.sourceTreeDirty !== false) failure('helper_integrity_failed', 'A signed browser-import helper must come from a clean source tree.');
  const record = packageRecord(packagedResourceRoot);
  if (!record || record.target !== manifest.target || record.sourceSha256 !== manifest.sourceSha256
    || record.sourceCommit !== manifest.sourceCommit || record.file !== manifest.file) {
    failure('helper_integrity_failed', 'The packaged browser-import resource record does not match the signed helper.');
  }
  const verify = options.verifySignature ?? ((path: string) => sameSigner(path, options.parentBinary ?? process.execPath, platform));
  if (!verify(realHelper)) failure('helper_integrity_failed', 'The browser-import helper signature is not from the packaged application signer.');
  return realHelper;
}
