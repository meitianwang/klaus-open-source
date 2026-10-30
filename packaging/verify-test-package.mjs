import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import semver from 'semver';
import { verifyPackage } from './verify.mjs';
import { verifySignedRelease } from './release.mjs';
import { receiptHasNoAuthenticode, verifyReceiptIntegrity } from './release-receipt.mjs';
import { requireTarget } from './resources.mjs';
import { DEFAULT_DESKTOP_EDITION, candidateEdition, desktopEdition } from './desktop-edition.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Project verified identity without treating a receipt's historical filesystem paths as executable inputs. */
export function signedTestMetadata(bundle, receipt, verified, receiptProof) {
  const edition = desktopEdition(verified?.edition ?? DEFAULT_DESKTOP_EDITION);
  if ((verified?.application ?? edition.application) !== edition.application) throw new Error('Verified package edition mismatch');
  if (!object(receipt) || receipt.schemaVersion !== 1 || receipt.kind !== 'signed-package-receipt' || receipt.application !== edition.application
    || receipt.framework !== 'electron' || receipt.buildKind !== 'signed-release' || semver.valid(receipt.version) !== receipt.version
    || !['stable', 'preview'].includes(receipt.channel) || !Array.isArray(receipt.files)) throw new Error('Unsupported signed package identity');
  const noAuthenticode = receiptHasNoAuthenticode(receipt);
  const target = requireTarget(receipt.platform, receipt.arch), source = receipt.unsigned?.source;
  candidateEdition(source ?? {}, edition.id);
  if (!object(source) || source.buildKind !== 'local-unsigned' || source.verified !== true || source.clientTreeDirty !== false
    || source.target !== target || source.version !== receipt.version || !/^[a-f0-9]{40}$/.test(source.clientCommit ?? '')
    || !/^[a-f0-9]{40}$/.test(source.engineCommit ?? '') || source.recordedEngineCommit !== source.engineCommit) throw new Error('Signed receipt has inconsistent original candidate provenance');
  if (verified?.signatureVerified !== !noAuthenticode || verified.receiptVerified !== true || verified.target !== target || verified.version !== receipt.version
    || (noAuthenticode && (verified.authenticode !== 'not-configured' || verified.integrityVerified !== true))) throw new Error('Live platform verification differs from the signed receipt');
  if (receipt.platform === 'darwin' && (receipt.notarization?.status !== 'Accepted' || receipt.notarization.stapled !== true)) throw new Error('Signed macOS receipt has no accepted and stapled notarization');
  const mac = receipt.platform === 'darwin', actual = resolve(bundle);
  for (const path of [mac ? `Contents/MacOS/${edition.executableName}` : `${edition.executableName}.exe`, mac ? 'Contents/Resources/app.asar' : 'resources/app.asar']) {
    if (!receipt.files.some(file => file.path === path && file.type === 'file')) throw new Error('Signed inventory lacks the actual application entry or ASAR');
  }
  return { bundle: actual, edition: edition.id, application: edition.application, resources: join(actual, mac ? 'Contents/Resources' : 'resources'), executable: join(actual, mac ? `Contents/MacOS/${edition.executableName}` : `${edition.executableName}.exe`),
    version: receipt.version, target, electronVersion: source.electronVersion, buildKind: 'signed-release',
    clientCommit: source.clientCommit, clientTreeDirty: source.clientTreeDirty, recordedEngineCommit: source.recordedEngineCommit, engineCommit: source.engineCommit,
    verified: true, verification: { mode: 'signed', receipt: receiptProof, platform: structuredClone(verified), channel: receipt.channel,
      application: receipt.application, framework: receipt.framework, actualBundle: actual, signedFileCount: receipt.files.length,
      // Raw manifests and all original byte hashes remain bound to the immutable signed receipt.
      originalUnsignedSource: structuredClone(source) } };
}

/** Test-only dependency composition; CLI callers use the fixed shipping validators below, with no key or bypass option. */
export function packageTestVerifier({ unsigned = verifyPackage, signed = verifySignedRelease, integrity = verifyReceiptIntegrity } = {}) {
  return async function verify(bundle, { receipt: receiptFile } = {}) {
    const requestedBundle = resolve(bundle), actualBundle = await realpath(requestedBundle);
    if (!(await lstat(actualBundle)).isDirectory()) throw new Error('A package test requires an actual application directory');
    if (receiptFile === undefined) {
      const result = await unsigned(actualBundle);
      return { ...result, verification: { mode: 'unsigned', requestedBundle, actualBundle,
        description: 'Strict original candidate hashes; no signed release or installed-update claim.' } };
    }
    if (typeof receiptFile !== 'string' || !receiptFile.trim()) throw new Error('An explicit receipt path is required; unsigned fallback is forbidden');
    const receiptPath = await realpath(resolve(receiptFile)), signaturePath = `${receiptPath}.sig`;
    for (const path of [receiptPath, signaturePath]) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > (path === receiptPath ? 32 * 1024 * 1024 : 16 * 1024)) throw new Error('Receipt and detached signature must be bounded regular files');
    }
    const before = await readFile(receiptPath), signature = await readFile(signaturePath);
    const platform = await signed({ bundle: actualBundle, receiptFile: receiptPath });
    // Recheck shipping Ed25519 + the complete file inventory after the live OS signature checks.
    const receipt = await integrity(actualBundle, receiptPath, { application: platform.application ?? desktopEdition().application });
    assert.deepEqual(JSON.parse(before), receipt, 'Receipt changed during package verification');
    if (!(await readFile(receiptPath)).equals(before) || !(await readFile(signaturePath)).equals(signature)) throw new Error('Receipt or detached signature changed during package verification');
    if (await realpath(requestedBundle) !== actualBundle) throw new Error('The requested package path changed during verification');
    const result = signedTestMetadata(actualBundle, receipt, platform, { path: receiptPath, size: before.length, sha256: hash(before),
      signaturePath, signatureSize: signature.length, signatureSha256: hash(signature) });
    result.verification.requestedBundle = requestedBundle;
    return result;
  };
}

export const verifyTestPackage = packageTestVerifier();
