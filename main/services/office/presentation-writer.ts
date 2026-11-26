import { posix } from 'node:path';
import type { OfficePresentationPreview, OfficeSlide, OfficeSlideElement, OfficeSlideParagraph } from '../../../contracts/office-preview';
import { attrLocal, childByLocal, childrenByLocal, escapeXml, escapeXmlAttr, parseXml, serializeXml } from './xml';
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

function renderParagraphsXml(
  paragraphs: OfficeSlideParagraph[],
  allocHyperlink: (href: string) => string,
): string {
  const list = paragraphs.length ? paragraphs : [{ runs: [{ text: '' }] }];
  return list.map(p => {
    const pPrAttrs: string[] = [];
    if (p.align) pPrAttrs.push(`algn="${p.align === 'center' ? 'ctr' : p.align === 'right' ? 'r' : 'l'}"`);
    if (p.level && p.level > 0) pPrAttrs.push(`lvl="${Math.min(8, Math.trunc(p.level))}"`);
    const buXml = p.marker
      ? (/^\d/.test(p.marker) ? `<a:buAutoNum type="arabicPeriod"/>` : `<a:buChar char="${escapeXmlAttr(p.marker.slice(0, 2) || '•')}"/>`)
      : '';
    const pPr = pPrAttrs.length || buXml ? `<a:pPr${pPrAttrs.length ? ` ${pPrAttrs.join(' ')}` : ''}>${buXml}</a:pPr>` : '';
    const runs = (p.runs.length ? p.runs : [{ text: '' }]).map(run => {
      if (run.br) return '<a:br/>';
      const rPrAttrs: string[] = ['lang="en-US"', 'dirty="0"'];
      if (run.bold) rPrAttrs.push('b="1"');
      if (run.italic) rPrAttrs.push('i="1"');
      if (run.underline || run.href) rPrAttrs.push('u="sng"');
      if (run.strike) rPrAttrs.push('strike="sngStrike"');
      if (run.fontSize && run.fontSize > 0) rPrAttrs.push(`sz="${Math.round(run.fontSize * 100)}"`);
      const rPrChildren: string[] = [];
      const fg = hex6(run.color) ?? (run.href ? '0563C1' : undefined);
      if (fg) rPrChildren.push(`<a:solidFill><a:srgbClr val="${fg}"/></a:solidFill>`);
      if (run.fontFamily) rPrChildren.push(`<a:latin typeface="${escapeXmlAttr(run.fontFamily)}"/>`);
      if (run.href && /^(https?:|mailto:)/i.test(run.href)) {
        const rId = allocHyperlink(run.href);
        rPrChildren.push(`<a:hlinkClick r:id="${escapeXmlAttr(rId)}"/>`);
      }
      const rPr = rPrChildren.length ? `<a:rPr ${rPrAttrs.join(' ')}>${rPrChildren.join('')}</a:rPr>` : `<a:rPr ${rPrAttrs.join(' ')}/>`;
      return `<a:r>${rPr}<a:t>${escapeXml(run.text ?? '')}</a:t></a:r>`;
    }).join('');
    return `<a:p>${pPr}${runs}</a:p>`;
  }).join('');
}

function renderSlideElementXml(
  el: OfficeSlideElement,
  idNum: number,
  widthEmu: number,
  heightEmu: number,
  allocImage: (src: string) => string | undefined,
  allocHyperlink: (href: string) => string,
): string {
  const x = Math.max(0, Math.round((el.x / 100) * widthEmu));
  const y = Math.max(0, Math.round((el.y / 100) * heightEmu));
  const cx = Math.max(12700, Math.round((el.w / 100) * widthEmu));
  const cy = Math.max(12700, Math.round((el.h / 100) * heightEmu));
  const rotAttr = el.rotation ? ` rot="${Math.round(el.rotation * 60000)}"` : '';
  const xfrm = `<a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;

  if (el.kind === 'image') {
    const rId = allocImage(el.src);
    if (!rId) return '';
    const cropXml = el.crop
      ? `<a:srcRect t="${Math.round(el.crop.top * 1000)}" r="${Math.round(el.crop.right * 1000)}" b="${Math.round(el.crop.bottom * 1000)}" l="${Math.round(el.crop.left * 1000)}"/>`
      : '';
    return `<p:pic>` +
      `<p:nvPicPr><p:cNvPr id="${idNum}" name="Picture ${idNum}" descr="${escapeXmlAttr(el.alt ?? '')}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${escapeXmlAttr(rId)}"/>${cropXml}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      `</p:pic>`;
  }

  if (el.kind === 'table') {
    const colCount = el.rows.reduce((m, row) => Math.max(m, row.cells.length), 1);
    const pcts = el.colWidthsPct && el.colWidthsPct.length === colCount
      ? el.colWidthsPct
      : Array.from({ length: colCount }, () => 100 / colCount);
    const gridCols = pcts.map(pct => `<a:gridCol w="${Math.max(12700, Math.round((cx * pct) / 100))}"/>`).join('');
    const rowH = Math.max(127000, Math.round(cy / Math.max(1, el.rows.length)));
    const rowsXml = el.rows.map(row => {
      const cellsXml = row.cells.map(cell => {
        const spanAttrs: string[] = [];
        if (cell.rowSpan && cell.rowSpan > 1) spanAttrs.push(`rowSpan="${cell.rowSpan}"`);
        if (cell.colSpan && cell.colSpan > 1) spanAttrs.push(`gridSpan="${cell.colSpan}"`);
        const tcPrAttrs = cell.valign ? ` anchor="${cell.valign === 'middle' ? 'ctr' : cell.valign === 'bottom' ? 'b' : 't'}"` : '';
        const bgHex = hex6(cell.bg);
        const tcPr = bgHex ? `<a:tcPr${tcPrAttrs}><a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill></a:tcPr>` : `<a:tcPr${tcPrAttrs}/>`;
        return `<a:tc${spanAttrs.length ? ` ${spanAttrs.join(' ')}` : ''}><a:txBody><a:bodyPr/><a:lstStyle/>${renderParagraphsXml(cell.paragraphs, allocHyperlink)}</a:txBody>${tcPr}</a:tc>`;
      }).join('');
      return `<a:tr h="${rowH}">${cellsXml}</a:tr>`;
    }).join('');
    return `<p:graphicFrame>` +
      `<p:nvGraphicFramePr><p:cNvPr id="${idNum}" name="Table ${idNum}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${gridCols}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic>` +
      `</p:graphicFrame>`;
  }

  const prst = el.geom === 'ellipse' || el.geom === 'roundRect' || el.geom === 'line' ? el.geom : 'rect';
  const fillHex = hex6(el.fill);
  const fillXml = fillHex ? `<a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>` : '<a:noFill/>';
  const strokeHex = hex6(el.stroke);
  const lnW = el.strokeWidthPt && el.strokeWidthPt > 0 ? ` w="${Math.round(el.strokeWidthPt * 12700)}"` : '';
  const lnXml = strokeHex ? `<a:ln${lnW}><a:solidFill><a:srgbClr val="${strokeHex}"/></a:solidFill></a:ln>` : '';
  const anchorAttr = el.valign ? ` anchor="${el.valign === 'middle' ? 'ctr' : el.valign === 'bottom' ? 'b' : 't'}"` : '';

  return `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${idNum}" name="Shape ${idNum}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fillXml}${lnXml}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"${anchorAttr}/><a:lstStyle/>${renderParagraphsXml(el.paragraphs, allocHyperlink)}</p:txBody>` +
    `</p:sp>`;
}

function buildNotesSlideXml(notesText: string): string {
  const paras = notesText.split(/\r?\n/).map(line => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:notes>`;
}

export async function writePptxBuffer(preview: OfficePresentationPreview, existingBytes?: Buffer): Promise<Buffer> {
  const widthEmu = Math.round(Math.max(100, preview.widthPt || 960) * 12700);
  const heightEmu = Math.round(Math.max(100, preview.heightPt || 540) * 12700);
  const slides: OfficeSlide[] = preview.slides.length
    ? preview.slides
    : [{ index: 1, elements: [{ kind: 'shape', x: 8, y: 12, w: 84, h: 20, paragraphs: [{ runs: [{ text: '' }] }] }] }];

  let existingEntries: Map<string, Buffer> | undefined;
  if (existingBytes && existingBytes.length >= 4 && existingBytes.readUInt32LE(0) === 0x04034b50) {
    try {
      const entries = await readAllZipEntries(existingBytes);
      if (entries.has('ppt/presentation.xml')) existingEntries = entries;
    } catch { existingEntries = undefined; }
  }

  let defaultLayoutTarget = '../slideLayouts/slideLayout1.xml';
  const existingSlideBgXml = new Map<number, string>();
  const existingSlideLayoutTarget = new Map<number, string>();
  if (existingEntries) {
    try {
      const presRoot = parseXml(existingEntries.get('ppt/presentation.xml')!.toString('utf8'));
      const presRels = existingEntries.has('ppt/_rels/presentation.xml.rels')
        ? parseXml(existingEntries.get('ppt/_rels/presentation.xml.rels')!.toString('utf8'))
        : undefined;
      const relTargets = new Map<string, string>();
      for (const r of childrenByLocal(presRels, 'Relationship')) {
        const id = attrLocal(r, 'Id'), target = attrLocal(r, 'Target');
        if (id && target) relTargets.set(id, posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('ppt', target)));
      }
      const sldIds = childrenByLocal(childByLocal(presRoot, 'sldIdLst'), 'sldId');
      sldIds.forEach((sldId, idx) => {
        const rId = sldId.attrs['r:id'] ?? Object.entries(sldId.attrs).find(([k]) => k.endsWith(':id'))?.[1] ?? '';
        const slidePath = relTargets.get(rId);
        if (!slidePath || !existingEntries!.has(slidePath)) return;
        try {
          const sldXml = parseXml(existingEntries!.get(slidePath)!.toString('utf8'));
          const bg = childByLocal(childByLocal(sldXml, 'cSld'), 'bg');
          if (bg) existingSlideBgXml.set(idx, serializeXml(bg, false));
          const sldRelsPath = posix.join(posix.dirname(slidePath), '_rels', `${posix.basename(slidePath)}.rels`);
          if (existingEntries!.has(sldRelsPath)) {
            const sldRels = parseXml(existingEntries!.get(sldRelsPath)!.toString('utf8'));
            const layoutRel = childrenByLocal(sldRels, 'Relationship').find(r => (attrLocal(r, 'Type') ?? '').endsWith('/slideLayout'));
            const target = attrLocal(layoutRel, 'Target');
            if (target) {
              existingSlideLayoutTarget.set(idx, target);
              if (idx === 0) defaultLayoutTarget = target;
            }
          }
        } catch { /* ignore malformed slide */ }
      });
    } catch { /* ignore */ }
  }

  const updates: Record<string, string | Buffer | null> = {};
  if (existingEntries) {
    for (const key of existingEntries.keys()) {
      if (/^ppt\/(?:slides|notesSlides)\/(?:_rels\/)?[^/]+\.xml(?:\.rels)?$/i.test(key)) {
        updates[key] = null;
      }
    }
  }

  const mediaFiles = new Map<string, { ext: string; mime: string; bytes: Buffer }>();
  let mediaCounter = 1;
  const slideRIds: Array<{ idx: number; rId: string; sldId: number; hasNotes: boolean }> = [];

  slides.forEach((slide, idx) => {
    const num = idx + 1;
    const rels: Array<{ id: string; type: string; target: string; external?: boolean }> = [];
    const layoutTarget = existingSlideLayoutTarget.get(idx) ?? defaultLayoutTarget;
    if (!existingEntries || existingEntries.has(posix.normalize(posix.join('ppt/slides', layoutTarget)))) {
      rels.push({
        id: 'rIdLayout',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
        target: layoutTarget,
      });
    }
    let relSeq = 1;
    const allocImage = (src: string): string | undefined => {
      const parsed = parseDataUrlImage(src);
      if (!parsed) return undefined;
      while (existingEntries?.has(`ppt/media/klaus_slide_img_${mediaCounter}.${parsed.ext}`)) mediaCounter += 1;
      const fileName = `klaus_slide_img_${mediaCounter++}.${parsed.ext}`;
      mediaFiles.set(`ppt/media/${fileName}`, parsed);
      const id = `rIdImg${relSeq++}`;
      rels.push({
        id,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
        target: `../media/${fileName}`,
      });
      return id;
    };
    const allocHyperlink = (href: string): string => {
      const id = `rIdLink${relSeq++}`;
      rels.push({
        id,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
        target: href,
        external: true,
      });
      return id;
    };

    const bgHex = hex6(slide.background);
    const bgXml = bgHex
      ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
      : (existingSlideBgXml.get(idx) ?? '');
    const elementsXml = slide.elements.map((el, eIdx) => renderSlideElementXml(el, eIdx + 2, widthEmu, heightEmu, allocImage, allocHyperlink)).join('');
    const showAttr = slide.hidden ? ' show="0"' : '';
    const slideXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"${showAttr}>` +
      `<p:cSld>${bgXml}<p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      elementsXml +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

    const hasNotes = Boolean(slide.notes && slide.notes.trim().length > 0);
    if (hasNotes) {
      rels.push({
        id: 'rIdNotes',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
        target: `../notesSlides/notesSlide${num}.xml`,
      });
      updates[`ppt/notesSlides/notesSlide${num}.xml`] = buildNotesSlideXml(slide.notes!.trim());
      updates[`ppt/notesSlides/_rels/notesSlide${num}.xml.rels`] =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdSlide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${num}.xml"/>` +
        `</Relationships>`;
    }

    updates[`ppt/slides/slide${num}.xml`] = slideXml;
    updates[`ppt/slides/_rels/slide${num}.xml.rels`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      rels.map(r => `<Relationship Id="${escapeXmlAttr(r.id)}" Type="${escapeXmlAttr(r.type)}" Target="${escapeXmlAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
      `</Relationships>`;
    slideRIds.push({ idx: num, rId: `rIdSlide${num}`, sldId: 255 + num, hasNotes });
  });

  for (const [mediaPath, media] of mediaFiles) updates[mediaPath] = media.bytes;

  if (existingEntries) {
    const keptPresRels: Array<{ id: string; type: string; target: string }> = [];
    if (existingEntries.has('ppt/_rels/presentation.xml.rels')) {
      try {
        const presRels = parseXml(existingEntries.get('ppt/_rels/presentation.xml.rels')!.toString('utf8'));
        for (const r of childrenByLocal(presRels, 'Relationship')) {
          const id = attrLocal(r, 'Id'), type = attrLocal(r, 'Type'), target = attrLocal(r, 'Target');
          if (id && type && target && !type.endsWith('/slide')) {
            keptPresRels.push({ id, type, target });
          }
        }
      } catch { /* rebuild */ }
    }
    updates['ppt/_rels/presentation.xml.rels'] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      keptPresRels.map(r => `<Relationship Id="${escapeXmlAttr(r.id)}" Type="${escapeXmlAttr(r.type)}" Target="${escapeXmlAttr(r.target)}"/>`).join('') +
      slideRIds.map(s => `<Relationship Id="${s.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${s.idx}.xml"/>`).join('') +
      `</Relationships>`;

    const sldIdLstXml = `<p:sldIdLst>${slideRIds.map(s => `<p:sldId id="${s.sldId}" r:id="${s.rId}"/>`).join('')}</p:sldIdLst>`;
    updates['ppt/presentation.xml'] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      (keptPresRels.some(r => r.type.endsWith('/slideMaster'))
        ? `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="${escapeXmlAttr(keptPresRels.find(r => r.type.endsWith('/slideMaster'))!.id)}"/></p:sldMasterIdLst>`
        : '') +
      sldIdLstXml +
      `<p:sldSz cx="${widthEmu}" cy="${heightEmu}"/>` +
      `<p:notesSz cx="${heightEmu}" cy="${widthEmu}"/>` +
      `</p:presentation>`;

    if (existingEntries.has('[Content_Types].xml')) {
      try {
        const ct = parseXml(existingEntries.get('[Content_Types].xml')!.toString('utf8'));
        ct.children = ct.children.filter(c => typeof c !== 'string' && !(c.local === 'Override' && /^\/ppt\/(?:slides|notesSlides)\//.test(attrLocal(c, 'PartName') ?? '')));
        const knownExts = new Set(childrenByLocal(ct, 'Default').map(d => attrLocal(d, 'Extension')?.toLowerCase()));
        for (const media of mediaFiles.values()) {
          if (!knownExts.has(media.ext)) {
            knownExts.add(media.ext);
            ct.children.push({ name: 'Default', local: 'Default', attrs: { Extension: media.ext, ContentType: media.mime }, children: [] });
          }
        }
        for (const s of slideRIds) {
          ct.children.push({
            name: 'Override',
            local: 'Override',
            attrs: { PartName: `/ppt/slides/slide${s.idx}.xml`, ContentType: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml' },
            children: [],
          });
          if (s.hasNotes) {
            ct.children.push({
              name: 'Override',
              local: 'Override',
              attrs: { PartName: `/ppt/notesSlides/notesSlide${s.idx}.xml`, ContentType: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml' },
              children: [],
            });
          }
        }
        updates['[Content_Types].xml'] = serializeXml(ct);
      } catch { /* keep existing */ }
    }
    return patchZipBuffer(existingBytes!, updates);
  }

  const mediaDefaults = new Map<string, string>();
  for (const media of mediaFiles.values()) mediaDefaults.set(media.ext, media.mime);
  const entries: Array<[string, string | Buffer]> = [
    ['[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      [...mediaDefaults.entries()].map(([ext, mime]) => `<Default Extension="${ext}" ContentType="${mime}"/>`).join('') +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      slideRIds.map(s =>
        `<Override PartName="/ppt/slides/slide${s.idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
        (s.hasNotes ? `<Override PartName="/ppt/notesSlides/notesSlide${s.idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>` : '')
      ).join('') +
      `</Types>`],
    ['_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `</Relationships>`],
    ['ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideRIds.map(s => `<p:sldId id="${s.sldId}" r:id="${s.rId}"/>`).join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${widthEmu}" cy="${heightEmu}"/>` +
      `<p:notesSz cx="${heightEmu}" cy="${widthEmu}"/>` +
      `</p:presentation>`],
    ['ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      `<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
      slideRIds.map(s => `<Relationship Id="${s.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${s.idx}.xml"/>`).join('') +
      `</Relationships>`],
    ['ppt/slideMasters/slideMaster1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout1"/></p:sldLayoutIdLst>` +
      `</p:sldMaster>`],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`],
    ['ppt/slideLayouts/slideLayout1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">` +
      `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
      `</p:sldLayout>`],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
      `</Relationships>`],
    ['ppt/theme/theme1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">` +
      `<a:themeElements>` +
      `<a:clrScheme name="Office">` +
      `<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
      `<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>` +
      `<a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>` +
      `<a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>` +
      `<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>` +
      `<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>` +
      `</a:clrScheme>` +
      `<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
      `<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
      `</a:themeElements></a:theme>`],
  ];
  for (const [path, val] of Object.entries(updates)) {
    if (val !== null) entries.push([path, val]);
  }
  return buildZipBuffer(entries);
}

export async function writeOdpBuffer(preview: OfficePresentationPreview): Promise<Buffer> {
  const mimetype = 'application/vnd.oasis.opendocument.presentation';
  const widthPt = Math.max(100, preview.widthPt || 960);
  const heightPt = Math.max(100, preview.heightPt || 540);
  const pictures: Array<[string, Buffer, string]> = [];
  let picSeq = 1;

  const pagesXml = preview.slides.map((slide, idx) => {
    const framesXml = slide.elements.map(el => {
      const x = ((el.x / 100) * widthPt).toFixed(2);
      const y = ((el.y / 100) * heightPt).toFixed(2);
      const w = ((el.w / 100) * widthPt).toFixed(2);
      const h = ((el.h / 100) * heightPt).toFixed(2);
      const frameAttrs = `svg:x="${x}pt" svg:y="${y}pt" svg:width="${w}pt" svg:height="${h}pt"`;
      if (el.kind === 'image') {
        const parsed = parseDataUrlImage(el.src);
        if (!parsed) return '';
        const picPath = `Pictures/image${picSeq++}.${parsed.ext}`;
        pictures.push([picPath, parsed.bytes, parsed.mime]);
        return `<draw:frame ${frameAttrs}><draw:image xlink:href="${picPath}"/>${el.alt ? `<svg:title>${escapeXml(el.alt)}</svg:title>` : ''}</draw:frame>`;
      }
      if (el.kind === 'table') {
        const rows = el.rows.map(r => `<table:table-row>${r.cells.map(c => `<table:table-cell>${c.paragraphs.map(p => `<text:p>${escapeXml(p.runs.map(rn => rn.text).join(''))}</text:p>`).join('')}</table:table-cell>`).join('')}</table:table-row>`).join('');
        return `<draw:frame ${frameAttrs}><table:table>${rows}</table:table></draw:frame>`;
      }
      const paras = el.paragraphs.map(p => `<text:p>${escapeXml(p.runs.map(rn => (rn.br ? '\n' : rn.text)).join(''))}</text:p>`).join('');
      return `<draw:frame ${frameAttrs}><draw:text-box>${paras}</draw:text-box></draw:frame>`;
    }).join('');
    const notesXml = slide.notes?.trim()
      ? `<presentation:notes>${slide.notes.trim().split(/\r?\n/).map(line => `<text:p>${escapeXml(line)}</text:p>`).join('')}</presentation:notes>`
      : '';
    return `<draw:page draw:name="Slide ${idx + 1}" draw:master-page-name="Default">${framesXml}${notesXml}</draw:page>`;
  }).join('');

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">` +
    `<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="${widthPt}pt" fo:page-height="${heightPt}pt"/></style:page-layout></office:automatic-styles>` +
    `<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>` +
    `</office:document-styles>`;
  const contentXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">` +
    `<office:body><office:presentation>${pagesXml}</office:presentation></office:body>` +
    `</office:document-content>`;
  const manifestXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
    `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>` +
    `<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>` +
    `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
    pictures.map(([p, , mime]) => `<manifest:file-entry manifest:full-path="${escapeXmlAttr(p)}" manifest:media-type="${mime}"/>`).join('') +
    `</manifest:manifest>`;

  return buildZipBuffer([
    ['mimetype', mimetype],
    ['styles.xml', stylesXml],
    ['content.xml', contentXml],
    ['META-INF/manifest.xml', manifestXml],
    ...pictures.map(([p, b]): [string, Buffer] => [p, b]),
  ], { storedFirstEntry: 'mimetype' });
}
