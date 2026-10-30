import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Integration fixtures may execute the identical, verified producer artifact. */
export function resolveFixtureEngineBinary(options: {
  stagedBinary: string; fixtureBinary?: string; testMode: boolean; packaged: boolean;
}): string {
  const { stagedBinary, fixtureBinary, testMode, packaged } = options;
  if (fixtureBinary === undefined) return stagedBinary;
  if (testMode !== true || packaged !== false) throw new Error('An engine fixture is restricted to unpackaged integration tests');
  for (const file of [stagedBinary, fixtureBinary]) {
    if (!isAbsolute(file) || !lstatSync(file).isFile() || realpathSync(file) !== resolve(file)) {
      throw new Error('An engine fixture must name a literal absolute regular file');
    }
  }
  const manifest = JSON.parse(readFileSync(join(dirname(stagedBinary), 'manifest.json'), 'utf8'));
  const binary = process.platform === 'win32' ? 'klaus-agent-stdio.exe' : 'klaus-agent-stdio';
  if (manifest.engineTreeDirty !== false || typeof manifest.engineCommit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.engineCommit)
    || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) || manifest.platform !== process.platform
    || manifest.arch !== process.arch || manifest.binary !== binary
    || basename(stagedBinary) !== binary || basename(fixtureBinary) !== binary) {
    throw new Error('An engine fixture requires the clean staged manifest for this platform');
  }
  for (const file of [stagedBinary, fixtureBinary]) {
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (sha256 !== manifest.sha256) throw new Error('An engine fixture must contain exactly the staged engine bytes');
  }
  return fixtureBinary;
}
