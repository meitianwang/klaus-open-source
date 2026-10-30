import { copyFileSync, constants, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Replace native code with a new inode so macOS never reuses the old code-signing cache. */
export function publishNativeArtifact(source, target, manifest) {
  const staging = mkdtempSync(join(dirname(target), `.${basename(target)}-publish-`));
  try {
    const binary = join(staging, 'addon.node');
    copyFileSync(source, binary, constants.COPYFILE_EXCL);
    const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
    const metadata = join(staging, 'addon.node.json');
    writeFileSync(metadata, `${JSON.stringify({ ...manifest, sha256 }, null, 2)}\n`, { flag: 'wx' });
    renameSync(binary, target);
    // Consumers validate this hash before loading; an interrupted pair fails closed.
    renameSync(metadata, `${target}.json`);
    return sha256;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
