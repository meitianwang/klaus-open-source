import { createHash } from 'node:crypto';
import { join } from 'node:path';
import semver from 'semver';
import { fileProof, plainFile, writeImmutable } from './release-io.mjs';
import { updaterContract } from './release-signatures.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition, editionForApplication } from './desktop-edition.mjs';

export function releaseIdentity({ platform, arch, version, channel, origin, edition: id = DEFAULT_DESKTOP_EDITION }) {
  const edition = desktopEdition(id);
  const contract = updaterContract();
  const base = new URL(origin ?? edition.serverUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Release origin must be an HTTPS origin without a path or credentials');
  const feedUrl = `${base.origin}/releases/electron/${channel}/${platform}/${arch}/${version}`;
  contract.productionPolicy({ application: edition.application, platform, arch, currentVersion: version, channel, feedUrl });
  if (channel === 'stable' && semver.prerelease(version)) throw new Error('Stable releases cannot have a prerelease version');
  return { schemaVersion: 1, application: edition.application, framework: 'electron', platform, arch, version, channel, feedUrl };
}

export async function signedJson(file, value, signer) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeImmutable(file, bytes, 0o600);
  const signature = await signer.sign(file);
  updaterContract().verifyMinisign(bytes, signature, signer.key);
  await writeImmutable(`${file}.sig`, `${signature}\n`);
  return { envelope: { payload: bytes.toString('base64'), signature }, payloadSha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function createInstalledPolicy({ identity, teamId, publisher, windowsAuthenticode, directory, resources, signer }) {
  const { feedUrl, ...fields } = identity;
  const value = { ...fields, kind: 'installed-update-policy', installer: fields.platform === 'darwin' ? 'mac-zip' : 'nsis', feedUrl,
    ...(fields.platform === 'darwin' ? { teamId } : windowsAuthenticode === undefined ? { publisher } : { windowsAuthenticode, ...(publisher === undefined ? {} : { publisher }) }) };
  const result = await signedJson(join(directory, 'installed-policy.json'), value, signer);
  updaterContract().parseInstalledUpdateConfiguration(result.envelope, identity, signer.key);
  await writeImmutable(join(resources, 'electron-update.json'), `${JSON.stringify(result.envelope)}\n`);
  return result.envelope;
}

export async function createReleaseMetadata({ identity, artifact, download, directory, signer, artifactSignatures, publishedAt = new Date(), lifetimeDays = 30 }) {
  if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 31) throw new Error('Release metadata lifetime must be 1 to 31 days');
  const update = await fileProof(artifact), manual = await fileProof(download);
  plainFile(update.file); plainFile(manual.file);
  const signature = artifactSignatures?.update ?? await signer.sign(artifact);
  await updaterContract().verifyMinisignFile(artifact, signature, signer.key, update);
  await writeImmutable(`${artifact}.sig`, `${signature}\n`);
  if (download !== artifact) {
    const manualSignature = artifactSignatures?.download ?? await signer.sign(download);
    await updaterContract().verifyMinisignFile(download, manualSignature, signer.key, manual);
    await writeImmutable(`${download}.sig`, `${manualSignature}\n`);
  }
  const { feedUrl, ...fields } = identity;
  const value = { ...fields, kind: 'release', publishedAt: publishedAt.toISOString(), expiresAt: new Date(publishedAt.getTime() + lifetimeDays * 86_400_000).toISOString(),
    artifact: { kind: fields.platform === 'darwin' ? 'mac-zip' : 'nsis', url: `${new URL(feedUrl).origin}/releases/desktop/artifact/${update.file}`, size: update.size, sha256: update.sha256, sha512: update.sha512, signature } };
  const edition = editionForApplication(identity.application);
  const metadataName = `${edition.artifactPrefix}-${fields.version}-${fields.channel}-${fields.platform}-${fields.arch}`;
  const result = await signedJson(join(directory, `${metadataName}.release.json`), value, signer);
  // Validate against an explicit earlier version, using the same parser as the installed app.
  const previous = '0.0.0-0';
  if (!semver.gt(fields.version, previous)) throw new Error('Release version must be newer than 0.0.0-0');
  updaterContract().parseReleaseEnvelope(result.envelope, { ...identity, currentVersion: previous, key: signer.key }, publishedAt.getTime());
  const envelopeFile = `${metadataName}-${result.payloadSha256.slice(0, 16)}.update.json`;
  await writeImmutable(join(directory, envelopeFile), `${JSON.stringify(result.envelope)}\n`);
  const envelope = await fileProof(join(directory, envelopeFile));
  const entry = { version: fields.version, envelopeFile, envelopeSha256: envelope.sha256,
    download: { file: manual.file, kind: fields.platform === 'darwin' ? 'dmg' : 'nsis', size: manual.size, sha256: manual.sha256 } };
  return { manifest: { schemaVersion: 2, framework: 'electron', edition: edition.id, application: edition.application, channels: { [fields.channel]: { platforms: { [`${fields.platform}-${fields.arch}`]: entry } } } }, release: value, entry };
}
