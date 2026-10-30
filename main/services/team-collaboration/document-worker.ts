import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { fromBuffer } from 'yauzl';

async function validateArchive(bytes: Buffer): Promise<void> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
  await new Promise<void>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('Invalid document archive')); return; }
      let count = 0, expanded = 0;
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        count++; expanded += entry.uncompressedSize;
        if (count > 5000 || expanded > 64 * 1024 * 1024 || entry.uncompressedSize > 32 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) {
          zip.close(); reject(new Error('The document archive is encrypted or exceeds extraction limits')); return;
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
async function extract(): Promise<void> {
  const bytes = Buffer.from(workerData.bytes as Uint8Array);
  await validateArchive(bytes);
  const asset = pathToFileURL(require.resolve('@kreuzberg/wasm/pkg/kreuzberg_wasm_bg.wasm'));
  // The WASM binding loads its one packaged asset via fetch. No document can
  // cause a remote request, external image fetch, OCR download, or file read.
  globalThis.fetch = async input => {
    if (String(input) !== asset.href) throw new Error('Network access is disabled for draft document extraction');
    return new Response(await readFile(asset), { headers: { 'Content-Type': 'application/wasm' } });
  };
  const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<{
    extractBytes(bytes: Uint8Array, mime: string, config: Record<string, unknown>): Promise<{ content: string }>;
  }>;
  const wasm = await importModule(pathToFileURL(require.resolve('@kreuzberg/wasm/pkg/kreuzberg_wasm.js')).href);
  const result = await wasm.extractBytes(bytes, String(workerData.mimeType), {
    disable_ocr: true, use_cache: false, output_format: 'plain', max_archive_depth: 1,
    images: { extract_images: false },
  });
  if (typeof result.content !== 'string' || !result.content.trim()) throw new Error('The document contains no extractable text');
  if (Buffer.byteLength(result.content) > 512 * 1024) throw new Error('The extracted document exceeds the draft context limit');
  parentPort?.postMessage({ content: result.content });
}
if (parentPort) void extract().catch(() => parentPort!.postMessage({ error: 'The document could not be safely extracted. It may be encrypted, damaged, image-only, or too large.' }));
