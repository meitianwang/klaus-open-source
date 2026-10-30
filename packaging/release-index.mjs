import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import { plainFile } from './release-io.mjs';
import { updaterContract } from './release-signatures.mjs';
import { validateReceiptPlatformProof } from './release-receipt.mjs';
import { DEFAULT_DESKTOP_EDITION, candidateEdition, desktopEdition, indexEdition } from './desktop-edition.mjs';

export const releaseTargets = ['darwin-arm64', 'win32-x64'];
const readableReleaseTargets = [...releaseTargets, 'darwin-x64'];
export const receiptName = (channel, target, version, edition = DEFAULT_DESKTOP_EDITION) => `${desktopEdition(edition).artifactPrefix}-${version}-${channel}-${target}.receipt.json`;
export const bytesProof = (file, bytes) => ({ file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') });

export function indexEntries(index, allowedTargets = releaseTargets) {
  const edition = indexEdition(index);
  if (index?.schemaVersion !== 2 || index.framework !== 'electron' || !index.channels || typeof index.channels !== 'object' || Array.isArray(index.channels)) throw new Error('Expected an Electron schemaVersion 2 release index');
  const entries = [];
  for (const [channel, group] of Object.entries(index.channels)) {
    if (!['stable', 'preview'].includes(channel) || !group?.platforms || typeof group.platforms !== 'object' || Array.isArray(group.platforms)) throw new Error('Invalid Electron release channel');
    for (const [target, entry] of Object.entries(group.platforms)) {
      if (!allowedTargets.includes(target) || semver.valid(entry?.version) !== entry?.version || (channel === 'stable' && semver.prerelease(entry.version))) throw new Error('Invalid Electron release target or version');
      const download = entry.download;
      plainFile(entry.envelopeFile); plainFile(download?.file);
      if (!/^[a-f0-9]{64}$/.test(entry.envelopeSha256 ?? '') || !/^[a-f0-9]{64}$/.test(download?.sha256 ?? '') || !Number.isSafeInteger(download?.size) || download.size <= 0 || download.size > 2 * 1024 ** 3 || download.kind !== (target.startsWith('darwin-') ? 'dmg' : 'nsis')) throw new Error('Invalid Electron download or envelope proof');
      const suffix = target.startsWith('darwin-') ? '.dmg' : '-setup.exe';
      if (download.file !== `${edition.artifactPrefix}-${entry.version}-${target}${suffix}`) throw new Error('Manual download filename differs from its version and target');
      if (!new RegExp(`^${edition.artifactPrefix}-${entry.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${channel}-${target}-[a-f0-9]{16}\\.update\\.json$`).test(entry.envelopeFile)) throw new Error('Envelope filename differs from its version and target');
      entries.push({ channel, target, entry });
    }
  }
  return entries;
}

export function mergeReleaseIndexes(local, remote, requiredTargets = []) {
  indexEntries(local);
  const edition = indexEdition(local);
  if (remote && indexEdition(remote).id !== edition.id) throw new Error('Cannot merge release indexes from different desktop editions');
  const result = remote ? structuredClone(remote) : { schemaVersion: 2, framework: 'electron', edition: edition.id, application: edition.application, channels: {} };
  if (local.edition !== undefined || remote?.edition !== undefined) Object.assign(result, { edition: edition.id, application: edition.application });
  indexEntries(result, readableReleaseTargets);
  for (const group of Object.values(result.channels)) delete group.platforms['darwin-x64'];
  indexEntries(result);
  for (const { channel, target, entry } of indexEntries(local)) {
    const previous = result.channels[channel]?.platforms[target];
    if (previous && (semver.lt(entry.version, previous.version) || (entry.version === previous.version && !isDeepStrictEqual(entry.download, previous.download)))) throw new Error('Cannot downgrade or change bytes of a published Electron version');
    result.channels[channel] ??= { platforms: {} };
    result.channels[channel].platforms[target] = structuredClone(entry);
  }
  for (const target of requiredTargets) {
    if (!releaseTargets.includes(target) || !indexEntries(result).some(item => item.channel === 'stable' && item.target === target)) throw new Error(`Manifest missing platform keys: ${target}`);
  }
  if (!indexEntries(result).length) throw new Error('Release index contains no platforms');
  return result;
}

export function parseRemoteIndex(bytes) {
  if (!bytes?.length) return undefined;
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schemaVersion === 2) { indexEntries(value, readableReleaseTargets); return value; }
  // The first Electron publication retires the old index without importing its
  // updater entries. Existing artifact files remain untouched on the server.
  if (!value.framework && semver.valid(value.version) && value.updater && typeof value.updater === 'object' && !Array.isArray(value.updater)) return undefined;
  throw new Error('Remote release index is malformed or has an unknown schema');
}

/** Readers can be local files or an authenticated, bounded SSH snapshot. */
export async function verifyReleaseEntry({ channel, target, entry, read, proof, localPath, key, edition: id = DEFAULT_DESKTOP_EDITION, requireFresh = true, now = Date.now() }) {
  const edition = desktopEdition(id);
  const contract = updaterContract();
  const trust = key ?? contract.parseMinisignKey(contract.KLAUS_UPDATE_PUBLIC_KEY);
  const records = new Map();
  async function metadata(name) {
    plainFile(name); const bytes = await read(name);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 32 * 1024 ** 2) throw new Error(`Missing or oversized release metadata: ${name}`);
    records.set(name, bytesProof(name, bytes)); return bytes;
  }
  const envelopeBytes = await metadata(entry.envelopeFile);
  if (records.get(entry.envelopeFile).sha256 !== entry.envelopeSha256) throw new Error('Release envelope hash differs from the index');
  const envelope = JSON.parse(envelopeBytes);
  const payload = JSON.parse(contract.strictBase64(envelope.payload, 96 * 1024).toString('utf8'));
  const [platform, arch] = target.split('-');
  const policy = { application: edition.application, platform, arch, channel, currentVersion: '0.0.0-0', feedUrl: 'https://release-verification.invalid/', key: trust };
  const verificationTime = requireFresh ? now : Math.min(now, Date.parse(payload.expiresAt) - 1);
  const verified = contract.parseReleaseEnvelope(envelope, policy, verificationTime);
  const release = verified.release;
  if (release.version !== entry.version || !entry.envelopeFile.endsWith(`-${verified.digest.slice(0, 16)}.update.json`)) throw new Error('Release envelope identity differs from the index');
  if (Date.parse(release.publishedAt) > now + 5 * 60_000) throw new Error('Release metadata is dated in the future');
  const receiptFile = receiptName(channel, target, entry.version, edition.id), receiptBytes = await metadata(receiptFile);
  const receiptSignature = (await metadata(`${receiptFile}.sig`)).toString('utf8').trim();
  contract.verifyMinisign(receiptBytes, receiptSignature, trust);
  const receipt = JSON.parse(receiptBytes);
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'signed-package-receipt' || receipt.application !== edition.application || receipt.framework !== 'electron' || receipt.buildKind !== 'signed-release' || receipt.platform !== platform || receipt.arch !== arch || receipt.version !== entry.version || receipt.channel !== channel) throw new Error('Missing signed platform release receipt');
  validateReceiptPlatformProof(receipt, trust, edition.application);
  const source = receipt.unsigned?.source;
  candidateEdition(source ?? {}, edition.id);
  if (source?.clientTreeDirty !== false || !/^[a-f0-9]{40}$/.test(source.clientCommit ?? '') || !/^[a-f0-9]{40}$/.test(source.engineCommit ?? '') || source.recordedEngineCommit !== source.engineCommit || source.version !== entry.version || source.target !== target || source.buildKind !== 'local-unsigned') throw new Error('Signed receipt has no clean candidate provenance');
  if (platform === 'darwin' && (receipt.notarization?.status !== 'Accepted' || receipt.notarization.stapled !== true || receipt.notarization.dmg?.status !== 'Accepted' || receipt.notarization.dmg.stapled !== true)) throw new Error('macOS release receipt has incomplete notarization');
  const update = receipt.artifacts?.update, download = receipt.artifacts?.download;
  const updateName = plainFile(new URL(release.artifact.url).pathname.split('/').at(-1));
  if (update?.file !== updateName || update?.size !== release.artifact.size || update?.sha256 !== release.artifact.sha256 || update?.sha512 !== release.artifact.sha512 || update?.signature !== release.artifact.signature || download?.file !== entry.download.file || download?.size !== entry.download.size || download?.sha256 !== entry.download.sha256) throw new Error('Signed receipt does not bind the update and manual download');
  for (const artifact of [update, download]) {
    plainFile(artifact.file);
    const signature = (await metadata(`${artifact.file}.sig`)).toString('utf8').trim();
    if (signature !== artifact.signature) throw new Error('Artifact signature differs from the signed receipt');
    const actual = await proof(artifact.file);
    if (!actual || actual.size !== artifact.size || actual.sha256 !== artifact.sha256 || actual.sha512 !== artifact.sha512) throw new Error(`Release artifact checksum mismatch: ${artifact.file}`);
    const file = localPath?.(artifact.file);
    if (file) await contract.verifyMinisignFile(file, signature, trust, artifact);
    // Remote SHA-256/SHA-512 are compared with an authenticated receipt; its
    // signature also binds the exact artifact signature stored alongside it.
    records.set(artifact.file, actual);
  }
  return { release, receipt, envelope, records: [...records.values()] };
}
