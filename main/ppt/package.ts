import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inside, readBounded, record } from '../visuals/data';

/** Refuse an incomplete editor package before opening a native presentation view. */
export function verifyPptRuntime(root: string): void {
  const manifest = record(JSON.parse(readBounded(join(root, 'runtime-manifest.json'))));
  if (manifest.bridgeVersion !== 2 || typeof manifest.version !== 'string' || !Array.isArray(manifest.assets)) throw new Error('The PPT runtime manifest is invalid.');
  const files = record(manifest.files), assets = manifest.assets;
  for (const required of ['dist/index.html', 'dist/artifact-type/app.js', 'dist/artifact-type/app.css', 'shell/frame-shell.html', 'shell/shell-manifest.json']) {
    if (!assets.includes(required)) throw new Error(`The PPT runtime is missing ${required}.`);
  }
  if (new Set(assets).size !== assets.length || assets.length > 1000) throw new Error('The PPT runtime inventory is invalid.');
  for (const asset of assets) {
    if (typeof asset !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(asset) || asset.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid PPT runtime asset path.');
    const path = realpathSync(join(root, asset)), expected = record(files[asset]), stat = statSync(path);
    if (!inside(root, path) || !stat.isFile() || stat.size !== expected.bytes) throw new Error(`The PPT runtime asset is incomplete: ${asset}.`);
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected.sha256) throw new Error(`The PPT runtime asset changed: ${asset}.`);
  }
}
