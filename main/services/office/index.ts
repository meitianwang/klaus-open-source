import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseDelimitedSpreadsheet } from '../../../contracts/office-formula';
import { extOfPath, officePreviewFamily, type OfficeDocBlock, type OfficeDocumentPreview, type OfficeErrorPreview, type OfficePreviewKind, type OfficePreviewPayload, type OfficeSpreadsheetPreview } from '../../../contracts/office-preview';
import { parseDocxArchive } from './docx';
import { parseOdtArchive } from './document-writer';
import type { ExtractedOffice } from './office-worker';
import { parseOdpArchive, parsePptxArchive } from './pptx';
import { parseOdsArchive } from './spreadsheet-writer';
import { parseTextSpreadsheet, parseXlsxArchive } from './xlsx';
import { parseXmindArchive, summarizeMindMapTopic } from './xmind';
import { childElements, decodeEntities, OfficeParseError, openSafeZip, parseXml, textContent, type XmlElement } from './xml';

export { writeOfficeBuffer } from './office-writer';

export function decodeSpreadsheetText(bytes: Buffer): string {
  if (!bytes.length) return '';
  const bom2 = bytes.subarray(0, 2).toString('hex');
  if (bom2 === 'fffe') return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bom2 === 'feff') return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return bytes.toString('utf8');
    }
  }
}

export function parseCsvTsvBuffer(filePath: string, bytes: Buffer): { text: string; office: OfficeSpreadsheetPreview; truncated: boolean } {
  const text = decodeSpreadsheetText(bytes);
  const delimiter: ',' | '\t' = extOfPath(filePath) === 'tsv' ? '\t' : ',';
  const { preview, truncated } = parseDelimitedSpreadsheet(text, delimiter);
  return { text, office: preview, truncated };
}

function workerExtract(bytes: Buffer, mimeType: string): Promise<ExtractedOffice> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'office-worker.js'), { workerData: { bytes: new Uint8Array(bytes), mimeType }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new OfficeParseError('corrupted', 'Office extraction timed out')); }, 20_000);
    worker.once('message', (message: ExtractedOffice | { error: string }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if ('error' in message) reject(new OfficeParseError('corrupted', message.error)); else resolve(message);
    });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', () => { clearTimeout(timeout); reject(new OfficeParseError('corrupted', 'Office extraction stopped')); });
  });
}
const plainParagraph = (text: string): OfficeDocBlock => ({ kind: 'paragraph', runs: [{ text }] });
const pipeRows = (source: string) => source.split(/\r?\n/).filter(line => /^\s*\|.*\|\s*$/.test(line)).map(line => line.trim().slice(1, -1).split('|').map(cell => cell.trim())).filter(row => !row.every(cell => /^:?-{2,}:?$/.test(cell)));
const docTable = (rows: string[][]): OfficeDocBlock => ({ kind: 'table', rows: rows.map(row => ({ cells: row.map(text => ({ blocks: [plainParagraph(text)] })) })) });

function extractedPreview(data: ExtractedOffice, family: OfficePreviewKind): OfficePreviewPayload {
  const tables = data.tables.map(table => table.rows.length ? table.rows : pipeRows(table.markdown)).filter(table => table.length);
  if (family === 'spreadsheet') {
    const fallbackRows = pipeRows(data.content);
    const groups = tables.length ? tables : [fallbackRows.length ? fallbackRows : data.content.split(/\r?\n/).map(line => line.split('\t'))];
    const preview: OfficeSpreadsheetPreview = { kind: 'spreadsheet', activeSheet: 0, styles: [], sheets: groups.map((rows, index) => {
      const totalCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
      return { name: data.metadata.sheetNames[index] || `Sheet ${index + 1}`, totalRows: rows.length, renderedRows: rows.length, totalCols, renderedCols: totalCols, cells: rows.flatMap((row, r) => row.flatMap((v, c) => v ? [{ r, c, v, t: 's' as const }] : [])) };
    }) };
    return preview;
  }
  if (family === 'presentation') {
    const pages = data.pages.some(Boolean) ? data.pages : data.content.split(/\f|<!--\s*PAGE[^>]*-->|(?=^#{1,3}\s+Slide\s+\d+\b)/mi).filter(page => page.trim());
    return { kind: 'presentation', widthPt: 960, heightPt: 540, truncated: data.truncated || pages.length > 200, slides: pages.slice(0, 200).map((page, index) => ({ index: index + 1, elements: [{ kind: 'shape', x: 5, y: 5, w: 90, h: 90, paragraphs: page.trim().split(/\r?\n/).map(text => ({ runs: [{ text: text.replace(/^#{1,6}\s+/, '') }] })) }] })) };
  }
  const blocks: OfficeDocBlock[] = [];
  let pending: string[] = [];
  const flush = () => { if (pending.length) { blocks.push(docTable(pipeRows(pending.join('\n')))); pending = []; } };
  for (const line of data.content.split(/\r?\n/)) {
    if (/^\s*\|.*\|\s*$/.test(line)) { pending.push(line); continue; }
    flush();
    const heading = line.match(/^(#{1,6})\s+(.+)/), item = line.match(/^(\s*)([-*+]\s|\d+[.)]\s)(.+)/);
    if (heading) blocks.push({ kind: 'paragraph', heading: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, runs: [{ text: heading[2]! }] });
    else if (item) blocks.push({ kind: 'paragraph', list: { ordered: /^\d/.test(item[2]!), marker: item[2]!.trim(), level: Math.min(8, Math.floor(item[1]!.length / 2)) }, runs: [{ text: item[3]! }] });
    else if (line.trim()) blocks.push(plainParagraph(line));
  }
  flush();
  if (!blocks.some(block => block.kind === 'table')) blocks.push(...tables.map(docTable));
  return { kind: 'document', blocks };
}

function markupDocument(source: string): OfficeDocumentPreview {
  const blocks: OfficeDocBlock[] = [];
  const walk = (node: XmlElement) => {
    const name = node.local.toLowerCase();
    if (['head', 'script', 'style'].includes(name)) return;
    if (name === 'table') {
      const rows: string[][] = [];
      const collect = (item: XmlElement) => {
        if (item.local.toLowerCase() === 'tr') rows.push(childElements(item).filter(cell => /^(td|th)$/i.test(cell.local)).map(cell => textContent(cell).trim()));
        else if (item === node || /^(thead|tbody|tfoot)$/i.test(item.local)) childElements(item).forEach(collect);
      };
      collect(node);
      if (rows.length) { blocks.push(docTable(rows)); return; }
    }
    if (/^(p|li|div|paragraph|h[1-6])$/.test(name) && !childElements(node).some(child => /^(p|div|table|ul|ol|h[1-6])$/i.test(child.local))) {
      const text = textContent(node).trim();
      if (text) blocks.push({ kind: 'paragraph', heading: /^h[1-6]$/.test(name) ? Number(name[1]) as 1 | 2 | 3 | 4 | 5 | 6 : undefined, list: name === 'li' ? { ordered: false, level: 0, marker: '•' } : undefined, runs: [{ text }] });
      return;
    }
    for (const child of node.children) typeof child === 'string' ? child.trim() && blocks.push(plainParagraph(child.trim())) : walk(child);
  };
  try { walk(parseXml(source)); } catch (error) {
    if (error instanceof OfficeParseError && error.code !== 'corrupted') throw error;
    for (const line of source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<\/?(?:p|div|li|br|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').split('\n')) {
      const text = decodeEntities(line).trim();
      if (text) blocks.push(plainParagraph(text));
    }
  }
  return { kind: 'document', blocks };
}

export function summarizeOfficePayload(office: OfficePreviewPayload): { plainText: string; truncated: boolean } {
  let remaining = 256 * 1024, truncated = false;
  const parts: string[] = [];
  const append = (text: string) => {
    if (!text) return;
    const length = Buffer.byteLength(text);
    if (length <= remaining) { parts.push(text); remaining -= length; return; }
    parts.push(Buffer.from(text.slice(0, remaining)).subarray(0, remaining).toString('utf8').replace(/\uFFFD$/, ''));
    remaining = 0;
    truncated = true;
  };
  const blocks = (items: OfficeDocBlock[]) => {
    for (const block of items) {
      if (truncated) break;
      if (block.kind === 'paragraph') { for (const run of block.runs) append(run.br ? '\n' : run.text); append('\n'); }
      else if (block.kind === 'table') for (const row of block.rows) { for (const cell of row.cells) { blocks(cell.blocks); append('\t'); } append('\n'); }
    }
  };
  if (office.kind === 'pdf') for (const page of office.pages) { append(`Page ${page.index}\n`); blocks(page.blocks); }
  else if (office.kind === 'document') blocks(office.blocks);
  else if (office.kind === 'spreadsheet') for (const sheet of office.sheets) {
    append(`${sheet.name}\n`);
    let row = -1, col = 0;
    for (const cell of [...sheet.cells].sort((a, b) => a.r - b.r || a.c - b.c)) {
      if (truncated) break;
      if (cell.r !== row) { if (row !== -1) append('\n'); row = cell.r; col = cell.c === 0 ? 0 : 1; }
      append('\t'.repeat(Math.max(0, Math.min(256 * 1024, cell.c - col))));
      append(cell.v);
      col = cell.c;
    }
    append('\n');
  } else if (office.kind === 'presentation') for (const slide of office.slides) {
    append(`Slide ${slide.index}\n`);
    for (const element of slide.elements) {
      if (truncated) break;
      const paragraphs = element.kind === 'shape' ? element.paragraphs : element.kind === 'table' ? element.rows.flatMap(row => row.cells.flatMap(cell => cell.paragraphs)) : [];
      for (const paragraph of paragraphs) { for (const run of paragraph.runs) append(run.br ? '\n' : run.text); append('\n'); }
    }
    if (slide.notes) append(`${slide.notes}\n`);
  } else if (office.kind === 'mindmap') {
    for (const sheet of office.sheets) {
      if (truncated) break;
      append(`${sheet.title}\n`);
      for (const line of summarizeMindMapTopic(sheet.rootTopic)) {
        if (truncated) break;
        append(`${line}\n`);
      }
    }
  }
  return { plainText: parts.join('').trimEnd(), truncated };
}

export async function parseOfficeBuffer(filePath: string, bytes: Buffer): Promise<{ office: OfficePreviewPayload; plainText: string; truncated: boolean }> {
  const family = officePreviewFamily(filePath) ?? 'document';
  const failure = (code: OfficeErrorPreview['code'], detail?: string) => ({ office: { kind: 'error' as const, family, code, ...(detail ? { detail } : {}) }, plainText: '', truncated: false });
  if (!bytes.length) return failure('empty');
  const fallback = async (mime: string, kind: OfficePreviewKind = family) => {
    const output = await workerExtract(bytes, mime);
    const preview = extractedPreview(output, kind);
    return { preview, truncated: output.truncated || ('truncated' in preview && preview.truncated === true) };
  };
  const parse = async (): Promise<{ preview: OfficePreviewPayload; truncated: boolean } | undefined> => {
    const magic = bytes.subarray(0, 4).toString('hex');
    if (magic === '504b0304' || magic === '504b0506') {
      const zip = await openSafeZip(bytes);
      try {
        if (await zip.read('content.json')) return await parseXmindArchive(zip);
        if (await zip.readXml('xl/workbook.xml')) return await parseXlsxArchive(zip);
        if (await zip.readXml('word/document.xml')) return await parseDocxArchive(zip);
        if (await zip.readXml('ppt/presentation.xml')) return await parsePptxArchive(zip);
        const contentRoot = await zip.readXml('content.xml');
        if (contentRoot) {
          if (contentRoot.local === 'xmap-content' || family === 'mindmap') return await parseXmindArchive(zip);
          const mime = (await zip.read('mimetype', 256))?.toString('utf8').trim();
          if (family === 'presentation' || mime === 'application/vnd.oasis.opendocument.presentation') return await parseOdpArchive(zip);
          const spreadsheet = mime === 'application/vnd.oasis.opendocument.spreadsheet' || family === 'spreadsheet';
          if (spreadsheet) {
            try { return await parseOdsArchive(zip); } catch { return await fallback('application/vnd.oasis.opendocument.spreadsheet', 'spreadsheet'); }
          }
          try { return await parseOdtArchive(zip); } catch { return await fallback('application/vnd.oasis.opendocument.text', 'document'); }
        }
        throw new OfficeParseError('unsupported', 'Unrecognized Office archive');
      } finally { zip.close(); }
    }
    if (bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') {
      if (bytes.includes(Buffer.from('EncryptedPackage')) || bytes.includes(Buffer.from('EncryptedPackage', 'utf16le'))) {
        throw new OfficeParseError('encrypted', 'Encrypted Office package');
      }
      if (family === 'mindmap') throw new OfficeParseError('corrupted', 'Invalid XMind archive');
      const oleMime = family === 'spreadsheet'
        ? 'application/vnd.ms-excel'
        : family === 'presentation'
          ? 'application/vnd.ms-powerpoint'
          : 'application/msword';
      return fallback(oleMime);
    }
    if (bytes.subarray(0, 5).toString() === '{\\rtf') return fallback('application/rtf', 'document');
    const decoded = decodeSpreadsheetText(bytes).trimStart();
    if (decoded.startsWith('<')) {
      if (family === 'spreadsheet') return parseTextSpreadsheet(decoded) ?? undefined;
      if (family === 'document') return { preview: markupDocument(decoded), truncated: false };
      return undefined;
    }
    if (family === 'spreadsheet' && !decoded.includes('\0') && decoded.includes('\t')) {
      return parseDelimitedSpreadsheet(decoded, '\t');
    }
    return undefined;
  };
  try {
    const parsed = await parse();
    if (!parsed) return failure('corrupted');
    const summary = summarizeOfficePayload(parsed.preview);
    return { office: parsed.preview, plainText: summary.plainText, truncated: parsed.truncated };
  } catch (error) {
    return error instanceof OfficeParseError ? failure(error.code, error.message) : failure('corrupted');
  }
}

export function inspectPdfHeader(bytes: Buffer): OfficeErrorPreview | undefined {
  if (!bytes.length) return { kind: 'error', family: 'pdf', code: 'empty' };
  if (!bytes.subarray(0, 1024).includes('%PDF-')) return { kind: 'error', family: 'pdf', code: 'corrupted' };
}

export async function parsePdfBuffer(bytes: Buffer): Promise<{ office: OfficePreviewPayload; plainText: string; truncated: boolean }> {
  const header = inspectPdfHeader(bytes);
  if (header) return { office: header, plainText: '', truncated: false };
  try {
    const data = await workerExtract(bytes, 'application/pdf');
    const sources = data.pages.length ? data.pages : data.content ? [data.content] : [];
    const pages = sources.slice(0, 200).map((source, index) => {
      const blocks: OfficeDocBlock[] = [];
      let pending: string[] = [];
      const flush = () => {
        const rows = pipeRows(pending.join('\n'));
        if (rows.length) blocks.push(docTable(rows));
        pending = [];
      };
      for (const line of source.split(/\r?\n/)) {
        if (/^\s*\|.*\|\s*$/.test(line)) pending.push(line);
        else { flush(); if (line.trim()) blocks.push(plainParagraph(line)); }
      }
      flush();
      return { index: index + 1, blocks };
    });
    if (pages.length && !pages.some(page => page.blocks.some(block => block.kind === 'table'))) {
      for (const table of data.tables) {
        const rows = table.rows.length ? table.rows : pipeRows(table.markdown);
        if (rows.length) pages[0]!.blocks.push(docTable(rows));
      }
    }
    const truncated = data.truncated || sources.length > 200;
    const office: OfficePreviewPayload = { kind: 'pdf', pageCount: Math.max(data.pageCount, sources.length), pages, truncated };
    const summary = summarizeOfficePayload(office);
    return { office, plainText: summary.plainText, truncated: truncated || summary.truncated };
  } catch {
    return { office: { kind: 'error', family: 'pdf', code: bytes.includes('/Encrypt') ? 'encrypted' : 'corrupted' }, plainText: '', truncated: false };
  }
}
