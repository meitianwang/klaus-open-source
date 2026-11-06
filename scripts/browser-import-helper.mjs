#!/usr/bin/env node

/**
 * Prepare and verify the macOS browser-import helper resource.
 *
 * Layout:
 *   resources/browser-import/<platform-arch>/klaus-browser-import-helper
 *   resources/browser-import/<platform-arch>/klaus-browser-import-helper.json
 *
 * This script is intentionally independent of package.mjs. package.mjs stages
 * local unsigned resources; verifyBrowserImportHelper's default mode accepts an
 * unsigned production artifact and reports releaseEligible:false. Final signed
 * delivery must use requireRelease:true. Local staging must not require a
 * Developer ID identity or pretend to be a release.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HELPER_NAME = 'klaus-browser-import-helper';
export const HELPER_MANIFEST = `${HELPER_NAME}.json`;
export const RESOURCE_ROOT = 'resources/browser-import';
export const MANIFEST_SCHEMA_VERSION = 1;
export const MAX_HELPER_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const SOURCE_FILES = [
  'native/browser-import/main.mm',
  'native/browser-import/browser_import_crypto.h',
  'native/browser-import/browser_import_crypto.mm',
  'native/browser-import/build-macos-helper.mjs',
  'scripts/browser-import-helper.mjs',
];
export const WINDOWS_SOURCE_FILES = [
  'native/browser-import/windows/Cargo.toml',
  'native/browser-import/windows/Cargo.lock',
  'native/browser-import/windows/src/main.rs',
  'native/browser-import/build-windows-helper.mjs',
  'scripts/browser-import-helper.mjs',
];

export function helperName(platform) {
  return platform === 'win32' ? `${HELPER_NAME}.exe` : HELPER_NAME;
}

function sourceFiles(platform) {
  return platform === 'win32' ? WINDOWS_SOURCE_FILES : SOURCE_FILES;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepo = resolve(scriptDirectory, '..');
const buildScript = platform => platform === 'win32'
  ? 'native/browser-import/build-windows-helper.mjs'
  : 'native/browser-import/build-macos-helper.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainFile(path) {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink();
}

function targetFrom(options) {
  let platform = options.platform;
  let arch = options.arch;
  if (options.target) {
    const match = /^(darwin|win32)-(arm64|x64)$/u.exec(options.target);
    if (!match) throw new Error('target must be darwin-arm64 or win32-x64');
    platform ??= match[1];
    arch ??= match[2];
  }
  platform ??= process.platform;
  arch ??= process.arch;
  const target = `${platform}-${arch}`;
  if (options.target && options.target !== target) throw new Error('target differs from platform and arch');
  if (!['darwin-arm64', 'win32-x64'].includes(target)) throw new Error(`Unsupported browser-import helper target: ${target}`);
  return { platform, arch, target };
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sourceIdentity(repo, platform) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Could not identify the browser-import helper source commit');
  const dirty = git([
    'status', '--porcelain', '--untracked-files=all', '--',
    ...sourceFiles(platform).map(file => file.split('/')[0]),
  ]).length > 0;
  return { sourceCommit, sourceTreeDirty: dirty };
}

/** Stable fingerprint over every source input that changes the production helper. */
export function sourceFingerprint(repo = defaultRepo, platform = process.platform) {
  const hash = createHash('sha256');
  for (const file of sourceFiles(platform).slice().sort()) {
    hash.update(file).update('\0').update(readFileSync(join(repo, file))).update('\0');
  }
  return hash.digest('hex');
}

function compilerIdentity(platform) {
  const command = platform === 'win32' ? 'rustc' : 'clang++';
  const text = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
  if (!text) throw new Error(`${command} did not report a compiler identity`);
  return text.slice(0, 512);
}

function validateBinary(bytes, platform, arch) {
  if (platform === 'darwin') {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error('The browser-import helper is not a thin 64-bit Mach-O executable');
    const expected = arch === 'arm64' ? 0x0100000c : 0x01000007;
    if (bytes.readUInt32LE(4) !== expected) throw new Error('The browser-import helper architecture differs from the selected target');
    return;
  }
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('The browser-import helper is not a PE executable');
  const offset = bytes.readUInt32LE(60);
  if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('The browser-import helper is not an x64 PE executable');
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('The browser-import helper manifest is invalid');
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new Error('Unknown browser-import helper manifest schema');
  if (manifest.mode !== 'production') throw new Error('Test browser-import helper artifacts cannot be packaged');
  if (manifest.file !== helperName(manifest.platform)) throw new Error('The browser-import helper manifest names the wrong file');
  if (typeof manifest.platform !== 'string' || typeof manifest.arch !== 'string' || typeof manifest.target !== 'string') throw new Error('The browser-import helper target is missing');
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_HELPER_BYTES) throw new Error('The browser-import helper size is outside the supported bound');
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256 ?? '')) throw new Error('The browser-import helper SHA-256 is invalid');
  if (!/^[a-f0-9]{64}$/u.test(manifest.sourceSha256 ?? '')) throw new Error('The browser-import helper source fingerprint is invalid');
  if (!/^[a-f0-9]{40}$/u.test(manifest.sourceCommit ?? '')) throw new Error('The browser-import helper source commit is invalid');
  if (typeof manifest.sourceTreeDirty !== 'boolean') throw new Error('The browser-import helper source state is invalid');
  if (typeof manifest.compiler !== 'string' || !manifest.compiler.trim() || manifest.compiler.length > 512) throw new Error('The browser-import helper compiler identity is invalid');
  if (!['codesign', 'unsigned'].includes(manifest.signing)) throw new Error('The browser-import helper signing mode is invalid');
  if (typeof manifest.signed !== 'boolean') throw new Error('The browser-import helper signed flag is invalid');
  if (typeof manifest.releaseEligible !== 'boolean') throw new Error('The browser-import helper release flag is invalid');
  if ((manifest.signing === 'codesign') !== manifest.signed) throw new Error('The browser-import helper signing fields disagree');
  const releaseEligible = !manifest.sourceTreeDirty && manifest.signed;
  if (manifest.releaseEligible !== releaseEligible) throw new Error('The browser-import helper release flag is inconsistent');
}

export function platformSignatureValid(binary, platform = process.platform) {
  if (platform === 'darwin') {
    const result = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', binary], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  }
  if (platform === 'win32') {
    const escaped = binary.replaceAll("'", "''");
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`], { encoding: 'utf8' });
    return !result.error && result.status === 0 && result.stdout.trim() === 'Valid';
  }
  return false;
}

function verifySignature(binary, manifest, requireRelease) {
  if (!manifest.signed) {
    if (requireRelease) throw new Error('An unsigned browser-import helper cannot be packaged for release');
    return;
  }
  const verify = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', binary], { encoding: 'utf8' });
  if (verify.error) throw verify.error;
  if (verify.status !== 0) throw new Error(`The browser-import helper signature is invalid: ${(verify.stderr || verify.stdout || '').trim()}`);
  if (requireRelease) {
    const details = spawnSync('codesign', ['-dv', '--verbose=4', binary], { encoding: 'utf8' });
    const text = `${details.stdout ?? ''}${details.stderr ?? ''}`;
    if (details.status !== 0 || !/Authority=Developer ID Application/u.test(text)) {
      throw new Error('A release browser-import helper requires a Developer ID Application signature');
    }
  }
}

/**
 * Verify a prepared resource directory.
 *
 * Test manifests are always rejected. Unsigned production builds verify but
 * report releaseEligible:false; requireRelease makes unsigned/dirty artifacts
 * fail explicitly.
 */
export function verifyBrowserImportHelper(options = {}) {
  const repo = resolve(options.repo ?? defaultRepo);
  const { platform, arch, target } = targetFrom(options);
  const directory = resolve(options.directory ?? join(repo, RESOURCE_ROOT, target));
  const requireRelease = options.requireRelease === true;
  if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('The browser-import helper directory is invalid');
  const file = helperName(platform), names = readdirSync(directory).sort();
  if (names.length !== 2 || !names.includes(file) || !names.includes(HELPER_MANIFEST)) {
    throw new Error('The browser-import helper directory must contain only the helper and its manifest');
  }
  const binary = join(directory, file);
  const manifestPath = join(directory, HELPER_MANIFEST);
  if (!isPlainFile(manifestPath)) throw new Error('The browser-import helper manifest must be a regular file');
  const binaryInfo = lstatSync(binary);
  if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) throw new Error('The browser-import helper must be a regular file');
  if (binaryInfo.size < 1 || binaryInfo.size > MAX_HELPER_BYTES) throw new Error('The browser-import helper size is outside the supported bound');
  if (lstatSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error('The browser-import helper manifest exceeds the supported size');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  if (manifest.platform !== platform || manifest.arch !== arch || manifest.target !== target) throw new Error('The browser-import helper target mismatch');
  if (manifest.sourceSha256 !== sourceFingerprint(repo, platform)) throw new Error('The browser-import helper source fingerprint differs from this checkout');
  if (binaryInfo.size !== manifest.size) throw new Error('The browser-import helper size differs from its manifest');
  const bytes = readFileSync(binary);
  if (bytes.length !== manifest.size) throw new Error('The browser-import helper size differs from its manifest');
  const rawMatches = sha256(bytes) === manifest.sha256;
  const signed = rawMatches ? manifest.signed : (options.verifySignature
    ? options.verifySignature(binary)
    : platformSignatureValid(binary, platform));
  if (!rawMatches && !signed) throw new Error('The browser-import helper SHA-256 differs from its manifest and no platform signature verifies');
  validateBinary(bytes, platform, arch);
  if (platform === 'darwin' && (binaryInfo.mode & 0o111) === 0) throw new Error('The browser-import helper is not executable');
  if (requireRelease && !signed) throw new Error('An unsigned browser-import helper cannot be released');
  if (requireRelease && (!manifest.releaseEligible || manifest.sourceTreeDirty)) {
    throw new Error('The browser-import helper is not release eligible');
  }
  return {
    verified: true,
    directory,
    target,
    mode: manifest.mode,
    signed,
    signing: manifest.signing,
    releaseEligible: manifest.releaseEligible,
    sha256: manifest.sha256,
    sourceSha256: manifest.sourceSha256,
    size: manifest.size,
  };
}

/**
 * Build and atomically publish a production helper resource.
 *
 * A test-mode build must name an explicit output outside the packaged resource
 * tree; its manifest remains mode:test and verify rejects it for packaging.
 */
export function prepareBrowserImportHelper(options = {}) {
  const repo = resolve(options.repo ?? defaultRepo);
  const { platform, arch, target } = targetFrom(options);
  const mode = options.mode ?? 'production';
  if (!['production', 'test'].includes(mode)) throw new Error('mode must be production or test');
  const requestedOutput = options.output ?? (mode === 'production'
    ? join(repo, RESOURCE_ROOT, target)
    : undefined);
  if (!requestedOutput) throw new Error('A test-mode helper requires an explicit output directory');
  const output = resolve(requestedOutput);
  if (mode === 'test' && isInside(join(repo, RESOURCE_ROOT), output)) {
    throw new Error('Test browser-import helper artifacts cannot be written into the packaged resource tree');
  }
  if (options.identity !== undefined && !String(options.identity).trim()) {
    throw new Error('A signing identity must not be empty');
  }
  if (mode === 'production' && options.identity !== undefined && String(options.identity).trim() === '-') {
    throw new Error('Ad-hoc signing is not a release identity');
  }
  if (options.entitlements && !options.identity) {
    throw new Error('Signing entitlements require a signing identity');
  }
  if (mode === 'test' && (options.identity || options.entitlements)) {
    throw new Error('Test-mode helper artifacts are unsigned and take no signing inputs');
  }
  const sourceBefore = sourceFingerprint(repo, platform);
  const identity = sourceIdentity(repo, platform);
  if (mode === 'production' && identity.sourceTreeDirty && options.identity) {
    throw new Error('A signed browser-import helper cannot be built from a dirty source tree');
  }
  const compiler = compilerIdentity(platform);
  mkdirSync(output, { recursive: true });
  if (lstatSync(output).isSymbolicLink()) throw new Error('The browser-import helper output directory is a symbolic link');
  const temporary = join(output, `${helperName(platform)}.tmp-${process.pid}`);
  rmSync(temporary, { force: true });
  const args = platform === 'win32'
    ? [join(repo, buildScript(platform)), '--output', temporary]
    : [join(repo, buildScript(platform)), '--mode', mode, '--arch', arch, '--output', temporary];
  if (options.identity) args.push('--identity', String(options.identity));
  if (options.entitlements) args.push('--entitlements', resolve(String(options.entitlements)));
  const build = spawnSync(process.execPath, args, { cwd: repo, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error('The browser-import helper build failed');
  }
  try {
    if (sourceFingerprint(repo, platform) !== sourceBefore) throw new Error('Browser-import helper sources changed during compilation');
    if (!isPlainFile(temporary)) throw new Error('The browser-import helper build did not produce a regular file');
    const bytes = readFileSync(temporary);
    if (bytes.length > MAX_HELPER_BYTES) throw new Error('The browser-import helper exceeds the supported size');
    validateBinary(bytes, platform, arch);
    if (options.identity) {
      const check = spawnSync('codesign', ['--verify', '--strict', temporary], { encoding: 'utf8' });
      if (check.error) throw check.error;
      if (check.status !== 0) throw new Error('The browser-import helper signature does not verify');
    }
    chmodSync(temporary, 0o755);
    renameSync(temporary, join(output, helperName(platform)));
    const final = join(output, helperName(platform));
    const sourceAfter = sourceIdentity(repo, platform);
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      mode,
      platform,
      arch,
      target,
      file: helperName(platform),
      size: lstatSync(final).size,
      sha256: sha256(readFileSync(final)),
      sourceSha256: sourceBefore,
      sourceCommit: sourceAfter.sourceCommit,
      sourceTreeDirty: sourceAfter.sourceTreeDirty,
      compiler,
      signing: options.identity ? 'codesign' : 'unsigned',
      signed: Boolean(options.identity),
      releaseEligible: mode === 'production' && !sourceAfter.sourceTreeDirty && Boolean(options.identity),
    };
    const manifestTemporary = join(output, `${HELPER_MANIFEST}.tmp-${process.pid}`);
    writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    renameSync(manifestTemporary, join(output, HELPER_MANIFEST));
    return { ...manifest, directory: output };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function parseArgv(argv) {
  const command = argv[0];
  if (!['prepare', 'verify'].includes(command)) throw new Error('Expected prepare or verify');
  const result = { command };
  const valueOptions = new Set([
    'platform', 'arch', 'target', 'mode', 'output', 'directory', 'identity', 'entitlements',
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--require-release') { result.requireRelease = true; continue; }
    if (name === '--allow-dirty') { result.allowDirty = true; continue; }
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const key = name.slice(2);
    if (!valueOptions.has(key)) throw new Error(`Unknown option: ${name}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    result[key] = value;
  }
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(
      'usage: browser-import-helper.mjs prepare --platform darwin --arch arm64|x64 '
      + '[--mode production|test] [--output <dir>] [--identity <codesign identity>] '
      + '[--entitlements <path>] [--allow-dirty]\n'
      + '       browser-import-helper.mjs verify --platform darwin --arch arm64|x64 '
      + '[--directory <dir>] [--require-release]\n',
    );
    return;
  }
  const options = parseArgv(argv);
  if (options.command === 'prepare') {
    process.stdout.write(`${JSON.stringify(prepareBrowserImportHelper(options), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(verifyBrowserImportHelper(options), null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
