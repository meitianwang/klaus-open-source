import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { indexEntries, mergeReleaseIndexes, receiptName, verifyReleaseEntry } from './release-index.mjs';
import { fileProof, writeImmutable } from './release-io.mjs';
import { createReleaseMetadata, releaseIdentity } from './release-metadata.mjs';
import { createProductionSigner } from './release-signatures.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition, indexEdition } from './desktop-edition.mjs';

/** Renew the offer without rebuilding, re-signing or replacing installed bytes. */
export async function renewReleaseMetadata({ directory, out, signing, lifetimeDays = 30, edition: id = DEFAULT_DESKTOP_EDITION }, dependencies = {}) {
  const edition = desktopEdition(id);
  const source = resolve(directory), output = resolve(out), signer = dependencies.signer ?? createProductionSigner(signing);
  const verify = dependencies.verify ?? verifyReleaseEntry;
  const index = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')), entries = indexEntries(index);
  if (indexEdition(index).id !== edition.id) throw new Error('Metadata renewal desktop edition mismatch');
  if (!entries.length) throw new Error('No signed releases to renew');
  const verified = [];
  for (const item of entries) verified.push(await verify({ ...item, edition: edition.id, read: name => readFile(join(source, name)), proof: name => fileProof(join(source, name)), localPath: name => join(source, name), requireFresh: false }));
  await signer.preflight();
  await mkdir(resolve(output, '..'), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  let manifest;
  for (const { release, receipt, records } of verified) {
    const target = `${release.platform}-${release.arch}`, receiptFile = receiptName(release.channel, target, release.version, edition.id);
    const names = new Set([receiptFile, `${receiptFile}.sig`, receipt.artifacts.update.file, receipt.artifacts.download.file]);
    for (const name of names) await copyFile(join(source, name), join(output, name), constants.COPYFILE_EXCL);
    const identity = releaseIdentity({ ...release, edition: edition.id, origin: new URL(release.artifact.url).origin });
    const result = await createReleaseMetadata({ identity, directory: output, artifact: join(output, receipt.artifacts.update.file), download: join(output, receipt.artifacts.download.file), signer,
      artifactSignatures: { update: receipt.artifacts.update.signature, download: receipt.artifacts.download.signature }, lifetimeDays });
    // Existing canonical signature attachments and receipt bytes must survive
    // unchanged, or immutable-file publication will reject the renewal.
    for (const name of new Set([...names, `${receipt.artifacts.update.file}.sig`, `${receipt.artifacts.download.file}.sig`])) {
      const previous = records.find(record => record.file === name), actual = await fileProof(join(output, name));
      if (!previous || previous.size !== actual.size || previous.sha256 !== actual.sha256) throw new Error('Metadata renewal changed an immutable release attachment');
    }
    manifest = mergeReleaseIndexes(result.manifest, manifest);
  }
  await writeImmutable(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { output, manifest, metadataRenewed: true, artifactsChanged: false, published: false };
}
