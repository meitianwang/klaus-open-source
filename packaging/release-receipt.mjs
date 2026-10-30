import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { binaryKind, bundleInventory } from './release-io.mjs';
import { updaterContract } from './release-signatures.mjs';
import { candidateEdition, desktopEdition } from './desktop-edition.mjs';

export async function captureUnsignedBundle(bundle, source) {
  const files = await bundleInventory(bundle), binaries = [];
  for (const entry of files) if (entry.type === 'file' && await binaryKind(join(bundle, entry.path))) binaries.push(entry.path);
  return { source, files, binaries };
}

/** Platform metadata may change after signing/stapling; app code and raw manifests may not. */
export function validateSigningChanges(unsigned, signed, platform, notarization) {
  const originals = new Map(unsigned.files.map(entry => [entry.path, entry])), actual = new Map(signed.map(entry => [entry.path, entry]));
  const ticketPath = platform === 'darwin' ? 'Contents/CodeResources' : undefined;
  const ticket = actual.get(ticketPath);
  if (ticket) {
    if (notarization?.status !== 'Accepted' || notarization.stapled !== true) throw new Error('A macOS ticket requires accepted, stapled notarization');
    if (ticket.type !== 'file' || !Number.isSafeInteger(ticket.size) || ticket.size <= 0 || ticket.size > 1024 * 1024) throw new Error('The macOS ticket must be a bounded regular file');
  }
  for (const [path, entry] of originals) {
    const current = actual.get(path);
    if (!current || current.type !== entry.type) throw new Error(`Signing removed or changed a bundle entry: ${path}`);
    const seal = platform === 'darwin' && /(?:^|\/)_CodeSignature(?:\/|$)/.test(path);
    if (!seal && path !== ticketPath && !unsigned.binaries.includes(path) && !isDeepStrictEqual(entry, current)) throw new Error(`Signing changed immutable application content: ${path}`);
  }
  const policy = platform === 'darwin' ? 'Contents/Resources/electron-update.json' : 'resources/electron-update.json';
  for (const [path, entry] of actual) if (!originals.has(path)) {
    const seal = platform === 'darwin' && /(?:^|\/)_CodeSignature(?:\/|$)/.test(path);
    if (path !== policy && path !== ticketPath && !seal) throw new Error(`Signing added unexpected application content: ${path}`);
    if (path === policy && entry.type !== 'file') throw new Error('Installed policy must be a regular file');
  }
  if (!actual.has(policy)) throw new Error('Signed bundle has no installed update policy');
}

/** Old receipts without a mode continue to require an OS signature. */
export function receiptHasNoAuthenticode(receipt) {
  const proof = receipt.platformProof;
  if (proof?.authenticode === undefined) {
    if (proof?.verified !== true || proof.platform !== receipt.platform) throw new Error('Missing signed platform release receipt');
    return false;
  }
  if (receipt.platform !== 'win32' || proof.platform !== 'win32' || proof.authenticode !== 'not-configured' || proof.verified !== false
    || Object.keys(proof).sort().join(',') !== 'authenticode,platform,verified') throw new Error('Invalid receipt Authenticode mode');
  return true;
}

/** Bind the no-OS receipt to the exact, independently signed installed policy. */
export function validateReceiptPlatformProof(receipt, key, application = desktopEdition().application) {
  if (receipt.application !== application) throw new Error('Signed package receipt application mismatch');
  const noAuthenticode = receiptHasNoAuthenticode(receipt);
  if (!noAuthenticode && receipt.installedPolicy === undefined) return;
  const contract = updaterContract();
  const config = contract.parseInstalledUpdateConfiguration(receipt.installedPolicy, { ...receipt, application }, key);
  if (config.channel !== receipt.channel || (config.windowsAuthenticode === 'not-configured') !== noAuthenticode
    || (!noAuthenticode && receipt.platform === 'win32' && config.publisher !== receipt.platformProof.publisher)) throw new Error('Receipt and installed Authenticode policy differ');
  const bytes = Buffer.from(`${JSON.stringify(receipt.installedPolicy)}\n`);
  const path = receipt.platform === 'darwin' ? 'Contents/Resources/electron-update.json' : 'resources/electron-update.json';
  const matches = receipt.files?.filter(file => file.path === path);
  if (matches?.length !== 1 || matches[0].type !== 'file' || matches[0].size !== bytes.length || matches[0].sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Signed installed policy differs from the full receipt inventory');
  if (noAuthenticode) {
    validateSigningChanges(receipt.unsigned, receipt.files, 'win32');
    for (const original of receipt.unsigned.files) {
      if (!isDeepStrictEqual(original, receipt.files.find(file => file.path === original.path))) throw new Error(`Minisign-only packaging changed original bundle bytes: ${original.path}`);
    }
  }
}

export async function makeSignedReceipt({ bundle, unsigned, identity, platformProof, notarization, installedPolicy, key }) {
  const files = await bundleInventory(bundle);
  validateSigningChanges(unsigned, files, identity.platform, notarization);
  const noAuthenticode = platformProof?.authenticode === 'not-configured';
  if (!noAuthenticode && (platformProof?.verified !== true || platformProof.platform !== identity.platform || !Array.isArray(platformProof.binaries) || platformProof.binaries.length !== unsigned.binaries.length || unsigned.binaries.some(file => !platformProof.binaries.some(proof => proof.path === file)))) throw new Error('Every packaged executable requires platform signature proof');
  if (identity.platform === 'darwin' && (!notarization || notarization.status !== 'Accepted' || notarization.stapled !== true)) throw new Error('A signed macOS receipt requires accepted, stapled notarization');
  const application = identity.application ?? desktopEdition().application;
  if (candidateEdition(unsigned.source).application !== application) throw new Error('Unsigned candidate and receipt application differ');
  const receipt = { schemaVersion: 1, kind: 'signed-package-receipt', application, framework: 'electron', buildKind: 'signed-release',
    platform: identity.platform, arch: identity.arch, version: identity.version, channel: identity.channel,
    unsigned, files, platformProof, ...(installedPolicy ? { installedPolicy } : {}), ...(notarization ? { notarization } : {}), createdAt: new Date().toISOString() };
  validateReceiptPlatformProof(receipt, key, application);
  return receipt;
}

/** Cryptographic/file validation is mandatory in both Windows signing modes. */
export async function readSignedReceipt(receiptFile, key) {
  const contract = updaterContract(), bytes = await readFile(receiptFile), signature = (await readFile(`${receiptFile}.sig`, 'utf8')).trim();
  const trust = key ?? contract.parseMinisignKey(contract.KLAUS_UPDATE_PUBLIC_KEY);
  contract.verifyMinisign(bytes, signature, trust);
  return JSON.parse(bytes.toString('utf8'));
}

export async function verifyReceiptIntegrity(bundle, receiptFile, { application = desktopEdition().application, key } = {}) {
  const receipt = await readSignedReceipt(receiptFile, key);
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'signed-package-receipt' || receipt.application !== application || receipt.framework !== 'electron' || receipt.buildKind !== 'signed-release') throw new Error('Unknown signed package receipt');
  if (candidateEdition(receipt.unsigned?.source ?? {}).application !== application) throw new Error('Receipt candidate application mismatch');
  const files = await bundleInventory(bundle);
  if (!isDeepStrictEqual(receipt.files, files)) throw new Error('Signed application differs from its receipt');
  validateSigningChanges(receipt.unsigned, files, receipt.platform, receipt.notarization);
  validateReceiptPlatformProof(receipt, key, application);
  return receipt;
}
