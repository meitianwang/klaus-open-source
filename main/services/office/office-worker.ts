import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ExtractedOffice {
  pageCount: number;
  content: string;
  tables: { rows: string[][]; markdown: string }[];
  pages: string[];
  metadata: { sheetNames: string[] };
  truncated: boolean;
}

async function extract(): Promise<ExtractedOffice> {
  const pkgJsPath = require.resolve('@kreuzberg/wasm/pkg/kreuzberg_wasm.js');
  const asset = pathToFileURL(join(dirname(pkgJsPath), 'kreuzberg_wasm_bg.wasm'));
  globalThis.fetch = async input => {
    if (String(input) !== asset.href) throw new Error('External resources are disabled');
    return new Response(await readFile(asset), { headers: { 'Content-Type': 'application/wasm' } });
  };
  const load = new Function('url', 'return import(url)') as (url: string) => Promise<{
    default?: () => Promise<unknown>;
    initialize_pdfium_render?: (pdfium: unknown, local: unknown, debug: boolean) => void;
    extractBytes(data: Uint8Array, mime: string, options: Record<string, unknown>): Promise<Record<string, unknown>>;
  }>;
  const wasm = await load(pathToFileURL(pkgJsPath).href);
  if (String(workerData.mimeType) === 'application/pdf' && typeof wasm.initialize_pdfium_render === 'function') {
    const module = await load(pathToFileURL(join(dirname(pkgJsPath), '..', 'pdfium.js')).href);
    const pdfium = typeof module.default === 'function' ? await module.default() : module;
    wasm.initialize_pdfium_render(pdfium, wasm, false);
  }
  const result = await wasm.extractBytes(workerData.bytes, String(workerData.mimeType), {
    disable_ocr: true, use_cache: false, max_archive_depth: 1, images: { extract_images: false },
    pages: { extract_pages: true },
  });
  let remaining = 4 * 1024 * 1024, truncated = false;
  const clean = (value: unknown) => {
    if (typeof value !== 'string') return '';
    const size = Buffer.byteLength(value);
    if (size <= remaining) { remaining -= size; return value; }
    truncated = true;
    const prefix = Buffer.from(value.slice(0, remaining)).subarray(0, remaining).toString('utf8').replace(/\uFFFD$/, '');
    remaining = 0;
    return prefix;
  };
  const array = (value: unknown, cap: number): unknown[] => {
    if (!Array.isArray(value)) return [];
    if (value.length > cap) truncated = true;
    return value.slice(0, cap);
  };
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const metadata = object(result.metadata);
  const sheetNames = array(metadata.sheetNames ?? metadata.sheet_names ?? result.sheetNames, 200).map(clean);
  const pages = array(result.pages, 200).map(page => clean(object(page).content));
  const tables = array(result.tables, 200).map(value => {
    const table = object(value);
    const rows = array(table.cells ?? table.rows, 2000).map(row => array(row, 256).map(clean));
    const headers = array(table.headers, 256).map(clean);
    if (!table.cells && headers.length) rows.unshift(headers);
    return { rows, markdown: rows.length ? '' : clean(table.markdown) };
  });
  const content = clean(result.content);
  return { pageCount: Array.isArray(result.pages) ? result.pages.length : pages.length, content, tables, pages, metadata: { sheetNames }, truncated };
}

if (parentPort) void extract().then(result => parentPort!.postMessage(result), () => parentPort!.postMessage({ error: 'Office extraction failed' }));
