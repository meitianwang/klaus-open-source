import type { OfficeDocBlock, OfficeDocumentPreview, OfficeEmbeddedImage, OfficeInlineRun } from '../../../contracts/office-preview';
import { attrLocal, childByLocal, childrenByLocal, childElements, escapeXml, escapeXmlAttr, OfficeParseError, parseXml, serializeXml, textContent, type XmlElement, type ZipArchive } from './xml';
import { buildZipBuffer, patchZipBuffer, readAllZipEntries } from './zip-writer';

function hex6(value?: string): string | undefined {
  const m = value?.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? m[1]!.toUpperCase() : undefined;
}

function parseDataUrlImage(src: string): { ext: string; mime: string; bytes: Buffer } | undefined {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (!m) return undefined;
  const sub = m[1]!.toLowerCase();
  const ext = sub === 'svg+xml' ? 'svg' : sub === 'jpeg' ? 'jpg' : sub;
  const mime = sub === 'jpg' ? 'image/jpeg' : `image/${sub}`;
  return { ext, mime, bytes: Buffer.from(m[2]!, 'base64') };
}

interface DocxWriteContext {
  prefix: string;
  relPrefix: string;
  allocHyperlinkRel(href: string): string;
  allocImageRel(image: OfficeEmbeddedImage): { rId: string; cx: number; cy: number } | undefined;
}

function renderRunXml(run: OfficeInlineRun, ctx: DocxWriteContext): string {
  const w = ctx.prefix;
  if (run.br) return `<${w}r><${w}br/></${w}r>`;
  const rPr: string[] = [];
  if (run.code) rPr.push(`<${w}rFonts ${w}ascii="Consolas" ${w}hAnsi="Consolas"/>`);
  if (run.bold) rPr.push(`<${w}b/>`);
  if (run.italic) rPr.push(`<${w}i/>`);
  if (run.underline || run.href) rPr.push(`<${w}u ${w}val="single"/>`);
  if (run.strike) rPr.push(`<${w}strike/>`);
  if (run.sup) rPr.push(`<${w}vertAlign ${w}val="superscript"/>`);
  if (run.sub) rPr.push(`<${w}vertAlign ${w}val="subscript"/>`);
  const color = hex6(run.color) ?? (run.href ? '0563C1' : undefined);
  if (color) rPr.push(`<${w}color ${w}val="${color}"/>`);
  const shd = hex6(run.highlight);
  if (shd) rPr.push(`<${w}shd ${w}val="clear" ${w}color="auto" ${w}fill="${shd}"/>`);
  if (run.fontSize && run.fontSize > 0) {
    const halfPts = Math.round(run.fontSize * 2);
    rPr.push(`<${w}sz ${w}val="${halfPts}"/><${w}szCs ${w}val="${halfPts}"/>`);
  }
  const rPrXml = rPr.length ? `<${w}rPr>${rPr.join('')}</${w}rPr>` : '';
  const parts = (run.text ?? '').split('\n');
  const inner = parts.map((seg, idx) => `${idx > 0 ? `<${w}br/>` : ''}<${w}t xml:space="preserve">${escapeXml(seg)}</${w}t>`).join('');
  const runNode = `<${w}r>${rPrXml}${inner}</${w}r>`;
  if (run.href && /^(https?:|mailto:)/i.test(run.href)) {
    const rId = ctx.allocHyperlinkRel(run.href);
    return `<${w}hyperlink ${ctx.relPrefix}id="${escapeXmlAttr(rId)}">${runNode}</${w}hyperlink>`;
  }
  return runNode;
}

function renderImageDrawingXml(img: OfficeEmbeddedImage, ctx: DocxWriteContext, docPrId: number): string {
  const allocated = ctx.allocImageRel(img);
  if (!allocated) return '';
  const w = ctx.prefix;
  return `<${w}r><${w}drawing>` +
    `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${allocated.cx}" cy="${allocated.cy}"/>` +
    `<wp:docPr id="${docPrId}" name="${escapeXmlAttr(img.alt || `Picture ${docPrId}`)}" descr="${escapeXmlAttr(img.alt || '')}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXmlAttr(img.alt || `Picture ${docPrId}`)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip ${ctx.relPrefix}embed="${escapeXmlAttr(allocated.rId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${allocated.cx}" cy="${allocated.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></${w}drawing></${w}r>`;
}

function renderBlocksXml(blocks: OfficeDocBlock[], ctx: DocxWriteContext, counter: { picId: number; hasLists: boolean }): string {
  const w = ctx.prefix;
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'hr') {
      out.push(`<${w}p><${w}pPr><${w}pBdr><${w}bottom ${w}val="single" ${w}sz="6" ${w}space="1" ${w}color="D0D7DE"/></${w}pBdr></${w}pPr></${w}p>`);
      continue;
    }
    if (block.kind === 'paragraph') {
      const pPr: string[] = [];
      if (block.role === 'title') pPr.push(`<${w}pStyle ${w}val="Title"/>`);
      else if (block.role === 'subtitle') pPr.push(`<${w}pStyle ${w}val="Subtitle"/>`);
      else if (block.role === 'quote') pPr.push(`<${w}pStyle ${w}val="Quote"/>`);
      else if (block.heading && block.heading >= 1 && block.heading <= 6) pPr.push(`<${w}pStyle ${w}val="Heading${block.heading}"/>`);
      if (block.list) {
        counter.hasLists = true;
        const lvl = Math.max(0, Math.min(8, Math.trunc(block.list.level || 0)));
        const numId = block.list.ordered ? '2' : '1';
        pPr.push(`<${w}numPr><${w}ilvl ${w}val="${lvl}"/><${w}numId ${w}val="${numId}"/></${w}numPr>`);
      }
      if (block.align) pPr.push(`<${w}jc ${w}val="${block.align}"/>`);
      if (block.indentPt && block.indentPt > 0) pPr.push(`<${w}ind ${w}left="${Math.round(block.indentPt * 20)}"/>`);
      const bg = hex6(block.bg);
      if (bg) pPr.push(`<${w}shd ${w}val="clear" ${w}color="auto" ${w}fill="${bg}"/>`);
      const runsXml = block.runs.map(r => renderRunXml(r, ctx)).join('');
      const imgsXml = (block.images ?? []).map(img => renderImageDrawingXml(img, ctx, ++counter.picId)).join('');
      out.push(`<${w}p>${pPr.length ? `<${w}pPr>${pPr.join('')}</${w}pPr>` : ''}${runsXml}${imgsXml}</${w}p>`);
      continue;
    }
    if (block.kind === 'table') {
      const colCount = block.rows.reduce((max, row) => Math.max(max, row.cells.reduce((s, cell) => s + Math.max(1, cell.colSpan ?? 1), 0)), 1);
      const totalDxa = 9000;
      const pcts = block.colWidthsPct && block.colWidthsPct.length === colCount
        ? block.colWidthsPct
        : Array.from({ length: colCount }, () => 100 / colCount);
      const gridCols = pcts.map(pct => `<${w}gridCol ${w}w="${Math.max(360, Math.round(totalDxa * pct / 100))}"/>`).join('');

      const activeRowSpans = new Array<{ remaining: number; colSpan: number } | null>(colCount).fill(null);
      const rowsXml = block.rows.map(row => {
        const cellsXml: string[] = [];
        let colCursor = 0;
        let cellIdx = 0;
        while (colCursor < colCount || cellIdx < row.cells.length) {
          const active = activeRowSpans[colCursor];
          if (active && active.remaining > 0) {
            const spanXml = active.colSpan > 1 ? `<${w}gridSpan ${w}val="${active.colSpan}"/>` : '';
            cellsXml.push(`<${w}tc><${w}tcPr>${spanXml}<${w}vMerge/></${w}tcPr><${w}p/></${w}tc>`);
            active.remaining -= 1;
            if (active.remaining <= 0) activeRowSpans[colCursor] = null;
            colCursor += active.colSpan;
            continue;
          }
          const cell = row.cells[cellIdx++];
          if (!cell) break;
          const cs = Math.max(1, cell.colSpan ?? 1);
          const rs = Math.max(1, cell.rowSpan ?? 1);
          const tcPr: string[] = [];
          if (cs > 1) tcPr.push(`<${w}gridSpan ${w}val="${cs}"/>`);
          if (rs > 1) {
            tcPr.push(`<${w}vMerge ${w}val="restart"/>`);
            activeRowSpans[colCursor] = { remaining: rs - 1, colSpan: cs };
          }
          const cellBg = hex6(cell.bg);
          if (cellBg) tcPr.push(`<${w}shd ${w}val="clear" ${w}color="auto" ${w}fill="${cellBg}"/>`);
          if (cell.valign) tcPr.push(`<${w}vAlign ${w}val="${cell.valign === 'middle' ? 'center' : cell.valign}"/>`);
          const innerBlocks = cell.blocks.length ? renderBlocksXml(cell.blocks, ctx, counter) : `<${w}p/>`;
          cellsXml.push(`<${w}tc>${tcPr.length ? `<${w}tcPr>${tcPr.join('')}</${w}tcPr>` : ''}${innerBlocks}</${w}tc>`);
          colCursor += cs;
        }
        const trPr = row.header ? `<${w}trPr><${w}tblHeader/></${w}trPr>` : '';
        return `<${w}tr>${trPr}${cellsXml.join('')}</${w}tr>`;
      }).join('');

      const tblBorders = `<${w}tblBorders>` +
        (['top', 'left', 'bottom', 'right', 'insideH', 'insideV'] as const)
          .map(edge => `<${w}${edge} ${w}val="single" ${w}sz="4" ${w}space="0" ${w}color="D0D7DE"/>`)
          .join('') +
        `</${w}tblBorders>`;
      out.push(`<${w}tbl><${w}tblPr><${w}tblW ${w}w="5000" ${w}type="pct"/>${tblBorders}</${w}tblPr><${w}tblGrid>${gridCols}</${w}tblGrid>${rowsXml}</${w}tbl>`);
    }
  }
  return out.join('');
}

function buildDefaultStylesXml(): string {
  const heading = (n: number, szHalfPt: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:qFormat/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${szHalfPt}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:qFormat/><w:rPr><w:color w:val="5A5A5A"/><w:sz w:val="30"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:qFormat/><w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>` +
    heading(1, 44) + heading(2, 36) + heading(3, 28) + heading(4, 24) + heading(5, 22) + heading(6, 20) +
    `</w:styles>`;
}

function buildDefaultNumberingXml(): string {
  const bulletLvls = Array.from({ length: 9 }, (_, i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="${(i + 1) * 720}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const orderedLvls = Array.from({ length: 9 }, (_, i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:pPr><w:ind w:left="${(i + 1) * 720}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:abstractNum w:abstractNumId="1">${bulletLvls}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="2">${orderedLvls}</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>` +
    `</w:numbering>`;
}

export async function writeDocxBuffer(preview: OfficeDocumentPreview, existingBytes?: Buffer): Promise<Buffer> {
  let existingEntries: Map<string, Buffer> | undefined;
  if (existingBytes && existingBytes.length >= 4 && existingBytes.readUInt32LE(0) === 0x04034b50) {
    try {
      const entries = await readAllZipEntries(existingBytes);
      if (entries.has('word/document.xml')) existingEntries = entries;
    } catch { existingEntries = undefined; }
  }

  let existingDocRoot: XmlElement | undefined;
  let sectPrXml = '';
  let prefix = 'w:';
  let relPrefix = 'r:';
  if (existingEntries?.has('word/document.xml')) {
    try {
      existingDocRoot = parseXml(existingEntries.get('word/document.xml')!.toString('utf8'));
      prefix = existingDocRoot.name.includes(':') ? existingDocRoot.name.slice(0, existingDocRoot.name.indexOf(':') + 1) : '';
      const hasRNs = Object.keys(existingDocRoot.attrs).some(k => k === 'xmlns:r');
      if (!hasRNs) existingDocRoot.attrs['xmlns:r'] = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
      const body = childByLocal(existingDocRoot, 'body');
      const sectPr = childByLocal(body, 'sectPr');
      if (sectPr) sectPrXml = serializeXml(sectPr, false);
    } catch { existingDocRoot = undefined; }
  }

  const relEntries: Array<{ id: string; type: string; target: string; external?: boolean }> = [];
  const usedIds = new Set<string>();
  if (existingEntries?.has('word/_rels/document.xml.rels')) {
    try {
      const relRoot = parseXml(existingEntries.get('word/_rels/document.xml.rels')!.toString('utf8'));
      for (const rNode of childrenByLocal(relRoot, 'Relationship')) {
        const id = attrLocal(rNode, 'Id'), type = attrLocal(rNode, 'Type'), target = attrLocal(rNode, 'Target');
        const external = attrLocal(rNode, 'TargetMode')?.toLowerCase() === 'external';
        if (id && type && target) {
          usedIds.add(id);
          if (!type.endsWith('/hyperlink') && !type.endsWith('/image')) {
            relEntries.push({ id, type, target, external });
          }
        }
      }
    } catch { /* rebuild rels */ }
  }

  let nextRelCounter = 1;
  const allocRelId = () => {
    while (usedIds.has(`rIdEdit${nextRelCounter}`)) nextRelCounter += 1;
    const id = `rIdEdit${nextRelCounter++}`;
    usedIds.add(id);
    return id;
  };
  const mediaFiles = new Map<string, { ext: string; mime: string; bytes: Buffer }>();
  let mediaCounter = 1;

  const ctx: DocxWriteContext = {
    prefix,
    relPrefix,
    allocHyperlinkRel(href) {
      const existing = relEntries.find(r => r.external && r.target === href && r.type.endsWith('/hyperlink'));
      if (existing) return existing.id;
      const id = allocRelId();
      relEntries.push({
        id,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
        target: href,
        external: true,
      });
      return id;
    },
    allocImageRel(img) {
      const parsed = parseDataUrlImage(img.src);
      if (!parsed) return undefined;
      while (existingEntries?.has(`word/media/klaus_img_${mediaCounter}.${parsed.ext}`)) mediaCounter += 1;
      const relTarget = `media/klaus_img_${mediaCounter++}.${parsed.ext}`;
      mediaFiles.set(`word/${relTarget}`, parsed);
      const id = allocRelId();
      relEntries.push({
        id,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
        target: relTarget,
      });
      const cx = Math.round(Math.max(48, img.widthPx || 360) * 9525);
      const cy = Math.round(Math.max(36, img.heightPx || 240) * 9525);
      return { rId: id, cx, cy };
    },
  };

  const counter = { picId: 1, hasLists: false };
  const blocksToWrite = preview.blocks.length ? preview.blocks : [{ kind: 'paragraph' as const, runs: [{ text: '' }] }];
  const bodyInnerXml = renderBlocksXml(blocksToWrite, ctx, counter) + sectPrXml;

  if (counter.hasLists && !relEntries.some(r => r.type.endsWith('/numbering'))) {
    relEntries.push({
      id: allocRelId(),
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
      target: 'numbering.xml',
    });
  }
  if (!existingEntries && !relEntries.some(r => r.type.endsWith('/styles'))) {
    relEntries.push({
      id: allocRelId(),
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
      target: 'styles.xml',
    });
  }

  const rootAttrs = existingDocRoot
    ? Object.entries(existingDocRoot.attrs).map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`).join('')
    : ` xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const docTag = existingDocRoot ? existingDocRoot.name : 'w:document';
  const bodyTag = `${prefix}body`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${docTag}${rootAttrs}><${bodyTag}>${bodyInnerXml}</${bodyTag}></${docTag}>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    relEntries.map(r => `<Relationship Id="${escapeXmlAttr(r.id)}" Type="${escapeXmlAttr(r.type)}" Target="${escapeXmlAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
    `</Relationships>`;

  if (existingEntries) {
    const updates: Record<string, string | Buffer | null> = {
      'word/document.xml': documentXml,
      'word/_rels/document.xml.rels': relsXml,
    };
    if (counter.hasLists && !existingEntries.has('word/numbering.xml')) {
      updates['word/numbering.xml'] = buildDefaultNumberingXml();
    }
    for (const [mediaPath, media] of mediaFiles) {
      updates[mediaPath] = media.bytes;
    }
    if ((mediaFiles.size || (counter.hasLists && !existingEntries.has('word/numbering.xml'))) && existingEntries.has('[Content_Types].xml')) {
      try {
        const ct = parseXml(existingEntries.get('[Content_Types].xml')!.toString('utf8'));
        const knownExts = new Set(childrenByLocal(ct, 'Default').map(d => attrLocal(d, 'Extension')?.toLowerCase()));
        for (const media of mediaFiles.values()) {
          if (!knownExts.has(media.ext)) {
            knownExts.add(media.ext);
            ct.children.push({ name: 'Default', local: 'Default', attrs: { Extension: media.ext, ContentType: media.mime }, children: [] });
          }
        }
        if (counter.hasLists && !childrenByLocal(ct, 'Override').some(o => attrLocal(o, 'PartName') === '/word/numbering.xml')) {
          ct.children.push({
            name: 'Override',
            local: 'Override',
            attrs: { PartName: '/word/numbering.xml', ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml' },
            children: [],
          });
        }
        updates['[Content_Types].xml'] = serializeXml(ct);
      } catch { /* keep existing content types */ }
    }
    return patchZipBuffer(existingBytes!, updates);
  }

  const mediaDefaults = new Map<string, string>();
  for (const media of mediaFiles.values()) mediaDefaults.set(media.ext, media.mime);
  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    [...mediaDefaults.entries()].map(([ext, mime]) => `<Default Extension="${ext}" ContentType="${mime}"/>`).join('') +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    (counter.hasLists ? `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` : '') +
    `</Types>`;

  const entries: Array<[string, string | Buffer]> = [
    ['[Content_Types].xml', contentTypesXml],
    ['_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`],
    ['word/document.xml', documentXml],
    ['word/_rels/document.xml.rels', relsXml],
    ['word/styles.xml', buildDefaultStylesXml()],
  ];
  if (counter.hasLists) entries.push(['word/numbering.xml', buildDefaultNumberingXml()]);
  for (const [mediaPath, media] of mediaFiles) entries.push([mediaPath, media.bytes]);
  return buildZipBuffer(entries);
}

export async function parseOdtArchive(zip: ZipArchive): Promise<{ preview: OfficeDocumentPreview; truncated: boolean }> {
  const root = await zip.readXml('content.xml');
  if (!root) throw new OfficeParseError('corrupted', 'Missing document content');
  const body = childByLocal(childByLocal(root, 'body'), 'text');
  if (!body) throw new OfficeParseError('corrupted', 'Missing document text body');
  const blocks: OfficeDocBlock[] = [];
  let truncated = false;
  const collectRuns = (node: XmlElement): OfficeInlineRun[] => {
    const runs: OfficeInlineRun[] = [];
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child) runs.push({ text: child });
      } else if (child.local === 'line-break') {
        runs.push({ text: '', br: true });
      } else if (child.local === 's') {
        const count = Math.max(1, Number(attrLocal(child, 'c') ?? '1') || 1);
        runs.push({ text: ' '.repeat(Math.min(128, count)) });
      } else if (child.local === 'tab') {
        runs.push({ text: '\t' });
      } else if (child.local === 'a') {
        const href = attrLocal(child, 'href');
        const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
        runs.push({ text: textContent(child), ...(safe ? { href: safe, underline: true } : {}) });
      } else {
        runs.push(...collectRuns(child));
      }
    }
    return runs.length ? runs : [{ text: textContent(node) }];
  };
  const walkList = (listNode: XmlElement, level: number) => {
    for (const item of childrenByLocal(listNode, 'list-item')) {
      for (const child of childElements(item)) {
        if (child.local === 'p' || child.local === 'h') {
          if (blocks.length >= 2500) { truncated = true; return; }
          blocks.push({ kind: 'paragraph', list: { ordered: false, level: Math.min(8, level), marker: '•' }, runs: collectRuns(child) });
        } else if (child.local === 'list') {
          walkList(child, level + 1);
        }
      }
    }
  };
  for (const el of childElements(body)) {
    if (blocks.length >= 2500) { truncated = true; break; }
    if (el.local === 'h') {
      const outline = Math.max(1, Math.min(6, Number(attrLocal(el, 'outline-level') ?? '1') || 1)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'paragraph', heading: outline, runs: collectRuns(el) });
    } else if (el.local === 'p') {
      blocks.push({ kind: 'paragraph', runs: collectRuns(el) });
    } else if (el.local === 'list') {
      walkList(el, 0);
    } else if (el.local === 'table') {
      const rows = childrenByLocal(el, 'table-row').map(tr => ({
        cells: childrenByLocal(tr, 'table-cell').map(tc => ({
          rowSpan: Number(attrLocal(tc, 'number-rows-spanned') ?? '1') || 1,
          colSpan: Number(attrLocal(tc, 'number-columns-spanned') ?? '1') || 1,
          blocks: childrenByLocal(tc, 'p').map(p => ({ kind: 'paragraph' as const, runs: collectRuns(p) })),
        })),
      }));
      if (rows.length) blocks.push({ kind: 'table', rows });
    }
  }
  return { preview: { kind: 'document', blocks, truncated }, truncated };
}

export async function writeOdtBuffer(preview: OfficeDocumentPreview): Promise<Buffer> {
  const mimetype = 'application/vnd.oasis.opendocument.text';
  const renderRuns = (runs: OfficeInlineRun[]) => runs.map(r => {
    if (r.br) return '<text:line-break/>';
    const escaped = escapeXml(r.text ?? '');
    if (r.href && /^(https?:|mailto:)/i.test(r.href)) {
      return `<text:a xlink:type="simple" xlink:href="${escapeXmlAttr(r.href)}">${escaped}</text:a>`;
    }
    return escaped;
  }).join('');

  const renderOdtBlocks = (blocks: OfficeDocBlock[]): string => blocks.map(b => {
    if (b.kind === 'hr') return '<text:p>────────────────────</text:p>';
    if (b.kind === 'paragraph') {
      const content = renderRuns(b.runs);
      if (b.heading) return `<text:h text:outline-level="${b.heading}">${content}</text:h>`;
      if (b.list) return `<text:list><text:list-item><text:p>${content}</text:p></text:list-item></text:list>`;
      return `<text:p>${content}</text:p>`;
    }
    const rowsXml = b.rows.map(row => `<table:table-row>${row.cells.map(cell => {
      const cs = cell.colSpan && cell.colSpan > 1 ? ` table:number-columns-spanned="${cell.colSpan}"` : '';
      const rs = cell.rowSpan && cell.rowSpan > 1 ? ` table:number-rows-spanned="${cell.rowSpan}"` : '';
      return `<table:table-cell${cs}${rs}>${renderOdtBlocks(cell.blocks.length ? cell.blocks : [{ kind: 'paragraph', runs: [{ text: '' }] }])}</table:table-cell>`;
    }).join('')}</table:table-row>`).join('');
    return `<table:table>${rowsXml}</table:table>`;
  }).join('');

  const contentXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">` +
    `<office:body><office:text>${renderOdtBlocks(preview.blocks)}</office:text></office:body>` +
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
