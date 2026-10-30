/** @typedef {{ type: string, fileName: string, code?: string }} BundleEntry */

/**
 * Keep renderer JavaScript within the build's default 500 kB chunk budget.
 * Large language data, binary resources and dedicated workers must be loaded
 * through their actual resource boundaries rather than compiled into the UI.
 * @param {Record<string, BundleEntry>} bundle
 */
export function assertFrontendChunkBudget(bundle) {
  const chunks = Object.values(bundle).filter(entry => entry.type === 'chunk');
  const measured = chunks.map(chunk => ({
    fileName: chunk.fileName,
    bytes: Buffer.byteLength(chunk.code ?? '', 'utf8'),
  }));
  const oversized = measured.filter(chunk => chunk.bytes > limit);
  if (oversized.length) {
    throw new Error('Renderer JavaScript exceeds the 500 kB chunk budget: '
      + oversized.map(chunk => `${chunk.fileName} (${chunk.bytes} bytes)`).join(', '));
  }
  return { chunks: chunks.length, largest: Math.max(0, ...measured.map(chunk => chunk.bytes)) };
}
import { readFileSync } from 'node:fs';

const { rendererJavaScriptBudgetBytes: limit } = JSON.parse(readFileSync(
  new URL('../contracts/vectors/editor-resource-loading.json', import.meta.url), 'utf8',
));
