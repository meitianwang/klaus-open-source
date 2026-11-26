import { posix } from 'node:path';
import { colIndexToLabel, recalculateSpreadsheet, serializeDelimitedSpreadsheet } from '../../../contracts/office-formula';
import type { OfficeCellStyle, OfficeSpreadsheetCell, OfficeSpreadsheetPreview, OfficeSpreadsheetSheet } from '../../../contracts/office-preview';
import { attrLocal, childByLocal, childrenByLocal, escapeXml, escapeXmlAttr, findAllByLocal, OfficeParseError, parseXml, serializeXml, textContent, type XmlElement, type ZipArchive } from './xml';
import { buildZipBuffer, patchZipBuffer, readAllZipEntries } from './zip-writer';

function cellRef(r: number, c: number): string {
  return `${colIndexToLabel(c)}${r + 1}`;
}

function hex6NoHash(value?: string): string | undefined {
  const m = value?.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `FF${m[1]!.toUpperCase()}` : undefined;
}

function renderCellXml(cell: OfficeSpreadsheetCell, styleIdx?: string): string {
  const ref = cellRef(cell.r, cell.c);
  const sAttr = styleIdx !== undefined ? ` s="${escapeXmlAttr(styleIdx)}"` : '';
  const formula = cell.f?.trim().replace(/^=/, '');
  const val = cell.v ?? '';

  if (formula) {
    const trimmed = val.trim();
    if (/^#[A-Z0-9/!?]+$/i.test(trimmed) || cell.t === 'e') {
      return `<c r="${ref}"${sAttr} t="e"><f>${escapeXml(formula)}</f><v>${escapeXml(trimmed || '#VALUE!')}</v></c>`;
    }
    if (cell.t === 'b' || /^(TRUE|FALSE)$/i.test(trimmed)) {
      const boolVal = /^true$/i.test(trimmed) || trimmed === '1' ? '1' : '0';
      return `<c r="${ref}"${sAttr} t="b"><f>${escapeXml(formula)}</f><v>${boolVal}</v></c>`;
    }
    const num = Number(trimmed.replace(/,/g, ''));
    if (trimmed !== '' && Number.isFinite(num) && cell.t !== 's') {
      return `<c r="${ref}"${sAttr}><f>${escapeXml(formula)}</f><v>${num}</v></c>`;
    }
    return `<c r="${ref}"${sAttr} t="str"><f>${escapeXml(formula)}</f><v>${escapeXml(val)}</v></c>`;
  }

  if (val === '') {
    return styleIdx !== undefined ? `<c r="${ref}"${sAttr}/>` : '';
  }
  if (cell.t === 'e' || /^#[A-Z0-9/!?]+$/.test(val.trim())) {
    return `<c r="${ref}"${sAttr} t="e"><v>${escapeXml(val.trim())}</v></c>`;
  }
  if (cell.t === 'b') {
    const boolVal = /^(true|1)$/i.test(val.trim()) ? '1' : '0';
    return `<c r="${ref}"${sAttr} t="b"><v>${boolVal}</v></c>`;
  }
  const trimmed = val.trim();
  const numericCandidate = trimmed !== '' && !/^0\d+/.test(trimmed) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed);
  if (cell.t === 'n' || (cell.t === undefined && numericCandidate)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return `<c r="${ref}"${sAttr}><v>${num}</v></c>`;
    }
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(val)}</t></is></c>`;
}

function buildStylesXml(styles: OfficeCellStyle[]): string {
  const fonts: string[] = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fills: string[] = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  const borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];

  for (const style of styles) {
    const fontParts: string[] = ['<sz val="' + (style.fontSize && style.fontSize > 0 ? style.fontSize : 11) + '"/>', '<name val="Calibri"/>'];
    if (style.bold) fontParts.push('<b/>');
    if (style.italic) fontParts.push('<i/>');
    if (style.underline) fontParts.push('<u/>');
    if (style.strike) fontParts.push('<strike/>');
    const fg = hex6NoHash(style.color);
    if (fg) fontParts.push(`<color rgb="${fg}"/>`);
    const fontId = fonts.length;
    fonts.push(`<font>${fontParts.join('')}</font>`);

    let fillId = 0;
    const bg = hex6NoHash(style.bg);
    if (bg) {
      fillId = fills.length;
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor indexed="64"/></patternFill></fill>`);
    }

    const alignAttrs: string[] = [];
    if (style.align) alignAttrs.push(`horizontal="${style.align}"`);
    if (style.valign) alignAttrs.push(`vertical="${style.valign === 'middle' ? 'center' : style.valign}"`);
    if (style.wrap) alignAttrs.push('wrapText="1"');
    const alignXml = alignAttrs.length ? `<alignment ${alignAttrs.join(' ')}/>` : '';
    xfs.push(`<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1"${fillId ? ' applyFill="1"' : ''}${alignXml ? ' applyAlignment="1"' : ''}>${alignXml}</xf>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
    `<fills count="${fills.length}">${fills.join('')}</fills>` +
    `<borders count="${borders.length}">${borders.join('')}</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    `</styleSheet>`;
}

function buildWorksheetXml(
  sheet: OfficeSpreadsheetSheet,
  styleResolver: (cell: OfficeSpreadsheetCell) => string | undefined,
  existingRoot?: XmlElement,
): string {
  const sorted = [...sheet.cells].sort((a, b) => a.r - b.r || a.c - b.c);
  let maxR = Math.max(0, (sheet.totalRows || 1) - 1);
  let maxC = Math.max(0, (sheet.totalCols || 1) - 1);
  const byRow = new Map<number, string[]>();
  const merges: string[] = [];

  for (const cell of sorted) {
    if (cell.r < 0 || cell.c < 0) continue;
    maxR = Math.max(maxR, cell.r + (cell.rs && cell.rs > 1 ? cell.rs - 1 : 0));
    maxC = Math.max(maxC, cell.c + (cell.cs && cell.cs > 1 ? cell.cs - 1 : 0));
    const xml = renderCellXml(cell, styleResolver(cell));
    if (xml) {
      let rowList = byRow.get(cell.r);
      if (!rowList) { rowList = []; byRow.set(cell.r, rowList); }
      rowList.push(xml);
    }
    if ((cell.rs && cell.rs > 1) || (cell.cs && cell.cs > 1)) {
      const endR = cell.r + Math.max(1, cell.rs ?? 1) - 1;
      const endC = cell.c + Math.max(1, cell.cs ?? 1) - 1;
      merges.push(`<mergeCell ref="${cellRef(cell.r, cell.c)}:${cellRef(endR, endC)}"/>`);
    }
  }

  const rowXml: string[] = [];
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    const cellsXml = byRow.get(r)!;
    const height = sheet.rowHeights?.[r];
    const htAttr = height && height > 0 ? ` ht="${(height * 0.75).toFixed(2)}" customHeight="1"` : '';
    const hiddenAttr = sheet.hiddenRows?.includes(r) ? ' hidden="1"' : '';
    rowXml.push(`<row r="${r + 1}"${htAttr}${hiddenAttr}>${cellsXml.join('')}</row>`);
  }

  const dimRef = `A1:${cellRef(maxR, maxC)}`;
  if (existingRoot) {
    const newSheetData = parseXml(`<sheetData>${rowXml.join('')}</sheetData>`);
    const nextChildren: (XmlElement | string)[] = [];
    let replacedSheetData = false;
    let replacedDimension = false;
    let replacedMerges = false;
    for (const child of existingRoot.children) {
      if (typeof child === 'string') continue;
      if (child.local === 'dimension') {
        nextChildren.push({ ...child, attrs: { ...child.attrs, ref: dimRef } });
        replacedDimension = true;
      } else if (child.local === 'sheetData') {
        newSheetData.name = child.name;
        nextChildren.push(newSheetData);
        replacedSheetData = true;
        if (merges.length) {
          const prefix = child.name.includes(':') ? child.name.slice(0, child.name.indexOf(':') + 1) : '';
          nextChildren.push(parseXml(`<${prefix}mergeCells count="${merges.length}">${merges.map(m => m.replace('<mergeCell ', `<${prefix}mergeCell `)).join('')}</${prefix}mergeCells>`));
          replacedMerges = true;
        }
      } else if (child.local === 'mergeCells') {
        replacedMerges = true;
      } else {
        nextChildren.push(child);
      }
    }
    if (!replacedDimension) {
      nextChildren.unshift({ name: 'dimension', local: 'dimension', attrs: { ref: dimRef }, children: [] });
    }
    if (!replacedSheetData) {
      nextChildren.push(newSheetData);
    }
    if (merges.length && !replacedMerges) {
      nextChildren.push(parseXml(`<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>`));
    }
    return serializeXml({ ...existingRoot, children: nextChildren });
  }

  const colsXml: string[] = [];
  if (sheet.colWidths?.length) {
    sheet.colWidths.forEach((px, idx) => {
      if (px && px > 0) {
        const widthChars = Math.max(2, Number((px / 7).toFixed(2)));
        colsXml.push(`<col min="${idx + 1}" max="${idx + 1}" width="${widthChars}" customWidth="1"/>`);
      }
    });
  }
  const paneXml = sheet.frozenRows || sheet.frozenCols
    ? `<sheetViews><sheetView workbookViewId="0"><pane${sheet.frozenCols ? ` xSplit="${sheet.frozenCols}"` : ''}${sheet.frozenRows ? ` ySplit="${sheet.frozenRows}"` : ''} topLeftCell="${cellRef(sheet.frozenRows ?? 0, sheet.frozenCols ?? 0)}" state="frozen"/></sheetView></sheetViews>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="${dimRef}"/>` +
    paneXml +
    (colsXml.length ? `<cols>${colsXml.join('')}</cols>` : '') +
    `<sheetData>${rowXml.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '') +
    `</worksheet>`;
}

export async function writeXlsxBuffer(preview: OfficeSpreadsheetPreview, existingBytes?: Buffer): Promise<Buffer> {
  const recalculated = recalculateSpreadsheet(preview);
  const sheets = recalculated.sheets.length
    ? recalculated.sheets
    : [{ name: 'Sheet 1', totalRows: 1, totalCols: 1, renderedRows: 1, renderedCols: 1, cells: [] }];

  let existingEntries: Map<string, Buffer> | undefined;
  if (existingBytes && existingBytes.length >= 4 && existingBytes.readUInt32LE(0) === 0x04034b50) {
    try {
      const entries = await readAllZipEntries(existingBytes);
      if (entries.has('xl/workbook.xml')) existingEntries = entries;
    } catch { existingEntries = undefined; }
  }

  if (existingEntries) {
    try {
      const wbXml = parseXml(existingEntries.get('xl/workbook.xml')!.toString('utf8'));
      const relsPath = 'xl/_rels/workbook.xml.rels';
      const relsXml = existingEntries.has(relsPath) ? parseXml(existingEntries.get(relsPath)!.toString('utf8')) : undefined;
      const oldSheetNodes = childrenByLocal(childByLocal(wbXml, 'sheets'), 'sheet');
      const relMap = new Map<string, string>();
      for (const rel of childrenByLocal(relsXml, 'Relationship')) {
        const id = attrLocal(rel, 'Id'), target = attrLocal(rel, 'Target');
        if (id && target) relMap.set(id, posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target)));
      }

      if (oldSheetNodes.length === sheets.length && relsXml) {
        const updates: Record<string, string | Buffer | null> = {};
        for (let i = 0; i < sheets.length; i++) {
          const sheetNode = oldSheetNodes[i]!;
          sheetNode.attrs.name = sheets[i]!.name || `Sheet ${i + 1}`;
          if (sheets[i]!.hidden) sheetNode.attrs.state = 'hidden';
          else delete sheetNode.attrs.state;
          const rId = sheetNode.attrs['r:id'] ?? Object.entries(sheetNode.attrs).find(([k]) => k.endsWith(':id'))?.[1] ?? '';
          const targetPath = relMap.get(rId);
          if (!targetPath || !existingEntries.has(targetPath)) throw new Error('Sheet target missing');
          const oldSheetXml = parseXml(existingEntries.get(targetPath)!.toString('utf8'));
          const origStyleByRef = new Map<string, string>();
          for (const cNode of findAllByLocal(childByLocal(oldSheetXml, 'sheetData'), 'c')) {
            const ref = attrLocal(cNode, 'r'), s = attrLocal(cNode, 's');
            if (ref && s !== undefined) origStyleByRef.set(ref.toUpperCase(), s);
          }
          updates[targetPath] = buildWorksheetXml(
            sheets[i]!,
            cell => origStyleByRef.get(cellRef(cell.r, cell.c)),
            oldSheetXml,
          );
        }
        const bookViews = childByLocal(wbXml, 'bookViews');
        const wbView = childByLocal(bookViews, 'workbookView');
        if (wbView) wbView.attrs.activeTab = String(Math.max(0, Math.min(sheets.length - 1, recalculated.activeSheet || 0)));
        updates['xl/workbook.xml'] = serializeXml(wbXml);
        return patchZipBuffer(existingBytes!, updates);
      }
    } catch {
      // Fall back to clean workbook generation when structure changed (added/removed sheets).
    }
  }

  const entries: Array<[string, string | Buffer]> = [];
  const overrides: string[] = [
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
  ];
  const wbRels: string[] = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  ];
  const wbSheets: string[] = [];

  sheets.forEach((sheet, idx) => {
    const num = idx + 1;
    const rId = `rIdSheet${num}`;
    overrides.push(`<Override PartName="/xl/worksheets/sheet${num}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbRels.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${num}.xml"/>`);
    wbSheets.push(`<sheet name="${escapeXmlAttr(sheet.name || `Sheet ${num}`)}" sheetId="${num}"${sheet.hidden ? ' state="hidden"' : ''} r:id="${rId}"/>`);
    entries.push([
      `xl/worksheets/sheet${num}.xml`,
      buildWorksheetXml(sheet, cell => (cell.s !== undefined ? String(cell.s + 1) : undefined)),
    ]);
  });

  const activeTab = Math.max(0, Math.min(sheets.length - 1, recalculated.activeSheet || 0));
  entries.unshift(
    ['[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      overrides.join('') +
      `</Types>`],
    ['_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`],
    ['xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<bookViews><workbookView activeTab="${activeTab}"/></bookViews>` +
      `<sheets>${wbSheets.join('')}</sheets>` +
      `</workbook>`],
    ['xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join('')}</Relationships>`],
    ['xl/styles.xml', buildStylesXml(recalculated.styles ?? [])],
  );
  return buildZipBuffer(entries);
}

export function writeDelimitedBuffer(preview: OfficeSpreadsheetPreview, delimiter: ',' | '\t'): Buffer {
  const recalculated = recalculateSpreadsheet(preview);
  return Buffer.from(serializeDelimitedSpreadsheet(recalculated, delimiter), 'utf8');
}

export async function parseOdsArchive(zip: ZipArchive): Promise<{ preview: OfficeSpreadsheetPreview; truncated: boolean }> {
  const root = await zip.readXml('content.xml');
  if (!root) throw new OfficeParseError('corrupted', 'Missing spreadsheet content');
  const spreadsheet = childByLocal(childByLocal(root, 'body'), 'spreadsheet');
  if (!spreadsheet) throw new OfficeParseError('corrupted', 'Missing spreadsheet body');
  const tables = childrenByLocal(spreadsheet, 'table');
  let truncated = false;
  const sheets: OfficeSpreadsheetSheet[] = tables.map((tbl, idx) => {
    const name = attrLocal(tbl, 'name') || `Sheet ${idx + 1}`;
    const rows = childrenByLocal(tbl, 'table-row');
    const cells: OfficeSpreadsheetCell[] = [];
    let r = 0;
    for (const rowNode of rows) {
      const rowRepeat = Math.max(1, Math.min(1000, Number(attrLocal(rowNode, 'number-rows-repeated') ?? '1') || 1));
      const rowCells = childrenByLocal(rowNode, 'table-cell');
      let c = 0;
      const populatedCols: Array<Omit<OfficeSpreadsheetCell, 'r'>> = [];
      for (const cellNode of rowCells) {
        const colRepeat = Math.max(1, Math.min(256, Number(attrLocal(cellNode, 'number-columns-repeated') ?? '1') || 1));
        const paragraphs = childrenByLocal(cellNode, 'p');
        const val = paragraphs.map(p => textContent(p)).join('\n');
        const rawFormula = attrLocal(cellNode, 'formula')?.replace(/^of:=/i, '').replace(/^=/, '').replace(/\[\.([A-Z]+\d+)\]/gi, '$1').replace(/\[\.([A-Z]+\d+):\.([A-Z]+\d+)\]/gi, '$1:$2');
        const vType = attrLocal(cellNode, 'value-type');
        const rs = Number(attrLocal(cellNode, 'number-rows-spanned') ?? '1') || 1;
        const cs = Number(attrLocal(cellNode, 'number-columns-spanned') ?? '1') || 1;
        if (val || rawFormula) {
          for (let rep = 0; rep < colRepeat && c + rep < 80; rep++) {
            populatedCols.push({
              c: c + rep,
              v: val || attrLocal(cellNode, 'value') || '',
              ...(rawFormula ? { f: rawFormula } : {}),
              t: vType === 'float' || vType === 'currency' || vType === 'percentage' ? 'n' : vType === 'boolean' ? 'b' : 's',
              ...(rs > 1 ? { rs } : {}),
              ...(cs > 1 ? { cs } : {}),
            });
          }
        }
        c += colRepeat;
      }
      if (populatedCols.length) {
        for (let rr = 0; rr < rowRepeat; rr++) {
          if (r + rr >= 1000) { truncated = true; break; }
          for (const item of populatedCols) cells.push({ r: r + rr, ...item });
        }
      }
      r += rowRepeat;
      if (r >= 1000) { if (rows.indexOf(rowNode) < rows.length - 1) truncated = true; break; }
    }
    const maxR = cells.reduce((m, cell) => Math.max(m, cell.r + 1), 0);
    const maxC = cells.reduce((m, cell) => Math.max(m, cell.c + 1), 0);
    return { name, totalRows: maxR, totalCols: maxC, renderedRows: maxR, renderedCols: maxC, cells };
  });
  return { preview: recalculateSpreadsheet({ kind: 'spreadsheet', activeSheet: 0, styles: [], sheets }), truncated };
}

export async function writeOdsBuffer(preview: OfficeSpreadsheetPreview): Promise<Buffer> {
  const recalculated = recalculateSpreadsheet(preview);
  const mimetype = 'application/vnd.oasis.opendocument.spreadsheet';
  const tablesXml = (recalculated.sheets.length ? recalculated.sheets : [{ name: 'Sheet 1', totalRows: 1, totalCols: 1, renderedRows: 1, renderedCols: 1, cells: [] }]).map(sheet => {
    const maxR = sheet.cells.reduce((m, c) => Math.max(m, c.r), Math.max(0, (sheet.totalRows || 1) - 1));
    const maxC = sheet.cells.reduce((m, c) => Math.max(m, c.c), Math.max(0, (sheet.totalCols || 1) - 1));
    const cellMap = new Map<string, OfficeSpreadsheetCell>();
    for (const c of sheet.cells) cellMap.set(`${c.r}:${c.c}`, c);
    const rowsXml: string[] = [];
    for (let r = 0; r <= maxR; r++) {
      const cellsXml: string[] = [];
      for (let c = 0; c <= maxC; c++) {
        const cell = cellMap.get(`${r}:${c}`);
        if (!cell || (!cell.v && !cell.f)) {
          cellsXml.push('<table:table-cell/>');
          continue;
        }
        const fAttr = cell.f ? ` table:formula="of:=${escapeXmlAttr(cell.f.replace(/^=/, ''))}"` : '';
        const isNum = cell.t === 'n' || (cell.t === undefined && cell.v.trim() !== '' && Number.isFinite(Number(cell.v)));
        const tAttr = isNum ? ` office:value-type="float" office:value="${escapeXmlAttr(String(Number(cell.v)))}"` : ` office:value-type="string"`;
        cellsXml.push(`<table:table-cell${fAttr}${tAttr}><text:p>${escapeXml(cell.v)}</text:p></table:table-cell>`);
      }
      rowsXml.push(`<table:table-row>${cellsXml.join('')}</table:table-row>`);
    }
    return `<table:table table:name="${escapeXmlAttr(sheet.name || 'Sheet 1')}">${rowsXml.join('')}</table:table>`;
  }).join('');

  const contentXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">` +
    `<office:body><office:spreadsheet>${tablesXml}</office:spreadsheet></office:body>` +
    `</office:document-content>`;
  const manifestXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
    `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>` +
    `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
    `</manifest:manifest>`;
  return buildZipBuffer([
    ['mimetype', mimetype],
    ['content.xml', contentXml],
    ['META-INF/manifest.xml', manifestXml],
  ], { storedFirstEntry: 'mimetype' });
}
