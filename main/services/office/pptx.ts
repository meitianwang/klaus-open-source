import type { OfficePresentationPreview, OfficeSlide, OfficeSlideElement, OfficeSlideParagraph } from '../../../contracts/office-preview';
import { attrLocal as a, childByLocal as c, childElements as children, childrenByLocal as all, findAllByLocal as find, parseThemeColors, readRelationships, resolveDrawingColor, resolveZipTarget, textContent as text, OfficeParseError, type XmlElement, type ZipArchive, type ZipRelationship, type ThemeColors } from './xml';

const num = (node: XmlElement | undefined, key: string, fallback = 0) => {
  const value = Number(a(node, key) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
};
const related = (rels: Map<string, ZipRelationship>, kind: string) => [...rels.values()].find(r => !r.external && r.type.endsWith(`/${kind}`))?.target;
const align = (v?: string) => v === 'ctr' ? 'center' as const : v === 'r' ? 'right' as const : v === 'l' ? 'left' as const : undefined;
const valign = (v?: string) => v === 'ctr' ? 'middle' as const : v === 'b' ? 'bottom' as const : v === 't' ? 'top' as const : undefined;
const enabled = (v?: string) => v === '1' || v === 'true';
const placeholder = (node: XmlElement) => children(node).map(n => c(c(n, 'nvPr'), 'ph')).find(Boolean);
const transform = (node: XmlElement) => c(c(node, 'spPr'), 'xfrm') ?? c(node, 'xfrm');
const solid = (node: XmlElement | undefined, theme: ThemeColors) => resolveDrawingColor(c(node, 'solidFill'), theme);

export async function parsePptxArchive(zip: ZipArchive): Promise<{ preview: OfficePresentationPreview; truncated: boolean }> {
  const path = 'ppt/presentation.xml';
  const root = await zip.readXml(path);
  if (!root) throw new OfficeParseError('corrupted', 'Missing presentation');
  const theme = parseThemeColors(await zip.readXml('ppt/theme/theme1.xml'));
  const rels = await readRelationships(zip, path);
  const size = c(root, 'sldSz');
  const width = num(size, 'cx') > 0 ? num(size, 'cx') : 960 * 12700;
  const height = num(size, 'cy') > 0 ? num(size, 'cy') : 540 * 12700;
  const slides: OfficeSlide[] = [];
  const ids = all(c(root, 'sldIdLst'), 'sldId');
  const cache = new Map<string, Promise<{ root?: XmlElement; rels: Map<string, ZipRelationship> }>>();
  const load = (name?: string) => {
    if (!name) return Promise.resolve({ root: undefined, rels: new Map<string, ZipRelationship>() });
    let part = cache.get(name);
    if (!part) {
      part = Promise.all([zip.readXml(name), readRelationships(zip, name)]).then(([root, rels]) => ({ root, rels }));
      cache.set(name, part);
    }
    return part;
  };
  for (const [index, id] of ids.slice(0, 200).entries()) {
    const target = rels.get(id.attrs['r:id'] ?? Object.entries(id.attrs).find(([key]) => key.endsWith(':id'))?.[1] ?? '');
    if (!target || target.external) continue;
    const slide = await load(target.target);
    const layout = await load(related(slide.rels, 'slideLayout'));
    const master = await load(related(layout.rels, 'slideMaster'));
    const themePath = related(master.rels, 'theme');
    const colors = themePath ? { ...theme, ...parseThemeColors((await load(themePath)).root) } : theme;
    const record: OfficeSlide = { index: index + 1, elements: [], hidden: a(slide.root, 'show') === '0' };
    const image = async (node: XmlElement | undefined, relationships = slide.rels) => {
      const link = relationships.get(a(c(node, 'blip'), 'embed') ?? '');
      return link && !link.external ? zip.readImageDataUrl(link.target) : undefined;
    };
    for (const part of [slide, layout, master]) {
      const bg = c(c(c(part.root, 'cSld'), 'bg'), 'bgPr');
      if (!bg) continue;
      record.background = solid(bg, colors);
      const gradient = c(bg, 'gradFill');
      if (c(gradient, 'lin')) {
        const stops = all(c(gradient, 'gsLst'), 'gs').map(stop => {
          const color = resolveDrawingColor(stop, colors);
          return color && `${color} ${Math.max(0, Math.min(100, num(stop, 'pos') / 1000))}%`;
        }).filter(Boolean);
        if (stops.length > 1) record.background = `linear-gradient(${num(c(gradient, 'lin'), 'ang') / 60000 + 90}deg, ${stops.join(', ')})`;
      }
      record.backgroundImage = await image(c(bg, 'blipFill'), part.rels);
      break;
    }
    const paragraphs = (body?: XmlElement): OfficeSlideParagraph[] => all(body, 'p').map(p => {
      const props = c(p, 'pPr');
      const level = Math.max(0, num(props, 'lvl'));
      const auto = c(props, 'buAutoNum');
      const defaults = c(props, 'defRPr');
      return { align: align(a(props, 'algn')), level, marker: a(c(props, 'buChar'), 'char') ?? (auto ? `${num(auto, 'startAt', 1)}.` : undefined), runs: children(p).flatMap<OfficeSlideParagraph['runs'][number]>(run => {
        if (run.local === 'br') return [{ text: '', br: true }];
        if (run.local !== 'r' && run.local !== 'fld') return [];
        const style = c(run, 'rPr');
        const value = (key: string) => a(style, key) ?? a(defaults, key);
        const link = slide.rels.get(a(c(style, 'hlinkClick'), 'id') ?? '');
        return [{ text: text(c(run, 't')), bold: enabled(value('b')), italic: enabled(value('i')), underline: !!value('u') && value('u') !== 'none', strike: !!value('strike') && value('strike') !== 'noStrike', color: solid(style, colors) ?? solid(defaults, colors), fontSize: Number(value('sz')) / 100 || undefined, href: link?.external && /^(https?:|mailto:)/i.test(link.target) ? link.target : undefined }];
      }) };
    });
    type PointMap = (x: number, y: number) => [number, number];
    const walk = async (tree: XmlElement | undefined, map: PointMap): Promise<void> => {
      for (const node of children(tree)) {
        if (node.local === 'grpSp') {
          const xf = c(c(node, 'grpSpPr'), 'xfrm');
          const off = c(xf, 'off'), ext = c(xf, 'ext'), chOff = c(xf, 'chOff'), chExt = c(xf, 'chExt');
          await walk(node, xf ? (x, y) => map(num(off, 'x') + (x - num(chOff, 'x')) * (num(ext, 'cx') / num(chExt, 'cx') || 1), num(off, 'y') + (y - num(chOff, 'y')) * (num(ext, 'cy') / num(chExt, 'cy') || 1)) : map);
          continue;
        }
        const ph = placeholder(node);
        const type = a(ph, 'type') ?? 'obj';
        let xf = transform(node);
        if (!xf && ph) for (const part of [layout, master]) {
          const candidates = children(c(c(part.root, 'cSld'), 'spTree')).filter(n => placeholder(n));
          const idx = a(ph, 'idx');
          const match = (idx !== undefined ? candidates.find(n => a(placeholder(n), 'idx') === idx) : undefined) ?? candidates.find(n => (a(placeholder(n), 'type') ?? 'obj') === type);
          xf = match && transform(match);
          if (xf) break;
        }
        const off = c(xf, 'off'), ext = c(xf, 'ext');
        const [x, y] = map(num(off, 'x', ph ? width * .08 : 0), num(off, 'y', ph ? height * (/title/i.test(type) && type !== 'subTitle' ? .06 : type === 'subTitle' ? .25 : .29) : 0));
        const [right, bottom] = map(num(off, 'x', ph ? width * .08 : 0) + num(ext, 'cx', ph ? width * .84 : 0), num(off, 'y', ph ? height * (/title/i.test(type) && type !== 'subTitle' ? .06 : type === 'subTitle' ? .25 : .29) : 0) + num(ext, 'cy', ph ? height * (/title/i.test(type) ? .17 : .62) : 0));
        const bounds = { x: x / width * 100, y: y / height * 100, w: (right - x) / width * 100, h: (bottom - y) / height * 100, rotation: num(xf, 'rot') / 60000 || undefined };
        if (node.local === 'sp' || node.local === 'cxnSp') {
          const props = c(node, 'spPr'), line = c(props, 'ln'), body = c(node, 'txBody');
          const preset = a(c(props, 'prstGeom'), 'prst');
          const geom = node.local === 'cxnSp' || preset === 'line' ? 'line' : preset === 'ellipse' || preset === 'roundRect' ? preset : 'rect';
          record.elements.push({ ...bounds, kind: 'shape', geom, fill: solid(props, colors), stroke: solid(line, colors), strokeWidthPt: num(line, 'w') / 12700 || undefined, valign: valign(a(c(body, 'bodyPr'), 'anchor')), paragraphs: paragraphs(body) });
        } else if (node.local === 'pic') {
          const fill = c(node, 'blipFill'), src = await image(fill), crop = c(fill, 'srcRect');
          if (src) record.elements.push({ ...bounds, kind: 'image', src, alt: a(c(c(node, 'nvPicPr'), 'cNvPr'), 'descr'), crop: crop && { top: num(crop, 't') / 1000, right: num(crop, 'r') / 1000, bottom: num(crop, 'b') / 1000, left: num(crop, 'l') / 1000 } });
        } else if (node.local === 'graphicFrame') {
          const table = c(c(c(node, 'graphic'), 'graphicData'), 'tbl');
          if (!table) continue;
          const widths = all(c(table, 'tblGrid'), 'gridCol').map(n => num(n, 'w'));
          const total = widths.reduce((sum, w) => sum + w, 0);
          record.elements.push({ ...bounds, kind: 'table', colWidthsPct: total > 0 ? widths.map(w => w / total * 100) : undefined, rows: all(table, 'tr').map(row => ({ cells: all(row, 'tc').filter(cell => !enabled(a(cell, 'vMerge')) && !enabled(a(cell, 'hMerge'))).map(cell => ({ rowSpan: num(cell, 'rowSpan', 1), colSpan: num(cell, 'gridSpan', 1), bg: solid(c(cell, 'tcPr'), colors), valign: valign(a(c(cell, 'tcPr'), 'anchor')), paragraphs: paragraphs(c(cell, 'txBody')) })) })) });
        }
      }
    };
    await walk(c(c(slide.root, 'cSld'), 'spTree'), (x, y) => [x, y]);
    const notes = await load(related(slide.rels, 'notesSlide'));
    record.notes = find(notes.root, 'sp').filter(n => !['sldNum', 'sldImg', 'hdr', 'ftr', 'dt'].includes(a(placeholder(n), 'type') ?? '')).flatMap(n => all(c(n, 'txBody'), 'p').map(p => find(p, 't').map(text).join(''))).filter(Boolean).join('\n') || undefined;
    slides.push(record);
  }
  const truncated = ids.length > 200;
  return { preview: { kind: 'presentation', widthPt: width / 12700, heightPt: height / 12700, slides, truncated }, truncated };
}

function points(value?: string): number | undefined {
  const match = value?.match(/^(-?\d+(?:\.\d+)?)(cm|mm|in|pt)$/);
  if (!match) return undefined;
  return Number(match[1]) * ({ cm: 72 / 2.54, mm: 72 / 25.4, in: 72, pt: 1 }[match[2]!] ?? 1);
}
const odpParagraphs = (node?: XmlElement): OfficeSlideParagraph[] => [...find(node, 'p'), ...find(node, 'h')].map(p => ({ runs: [{ text: text(p) }] }));

export async function parseOdpArchive(zip: ZipArchive): Promise<{ preview: OfficePresentationPreview; truncated: boolean }> {
  const root = await zip.readXml('content.xml');
  if (!root) throw new OfficeParseError('corrupted', 'Missing presentation content');
  const styles = await zip.readXml('styles.xml');
  const presentation = c(c(root, 'body'), 'presentation');
  if (!presentation) throw new OfficeParseError('corrupted', 'Missing presentation body');
  const pages = all(presentation, 'page');
  const master = find(styles, 'master-page').find(n => a(n, 'name') === a(pages[0], 'master-page-name'));
  const layouts = [...find(styles, 'page-layout'), ...find(root, 'page-layout')];
  const layout = c(layouts.find(n => a(n, 'name') === a(master, 'page-layout-name')) ?? layouts[0], 'page-layout-properties');
  const widthPt = Math.max(1, points(a(layout, 'page-width')) ?? 960), heightPt = Math.max(1, points(a(layout, 'page-height')) ?? 540);
  const slides: OfficeSlide[] = [];
  for (const [index, page] of pages.slice(0, 200).entries()) {
    const elements: OfficeSlideElement[] = [];
    const frames = (node: XmlElement): XmlElement[] => children(node).flatMap(n => n.local === 'frame' ? [n] : n.local === 'g' ? frames(n) : []);
    for (const frame of frames(page)) {
      const bounds = { x: (points(a(frame, 'x')) ?? 0) / widthPt * 100, y: (points(a(frame, 'y')) ?? 0) / heightPt * 100, w: (points(a(frame, 'width')) ?? widthPt) / widthPt * 100, h: (points(a(frame, 'height')) ?? heightPt) / heightPt * 100 };
      const box = c(frame, 'text-box'), img = c(frame, 'image'), table = c(frame, 'table');
      if (box) elements.push({ ...bounds, kind: 'shape', paragraphs: odpParagraphs(box) });
      if (img) {
        const path = resolveZipTarget('content.xml', a(img, 'href') ?? '');
        const src = path?.startsWith('Pictures/') ? await zip.readImageDataUrl(path) : undefined;
        if (src) elements.push({ ...bounds, kind: 'image', src, alt: text(c(frame, 'title')) || undefined });
      }
      if (table) elements.push({ ...bounds, kind: 'table', rows: find(table, 'table-row').map(row => ({ cells: all(row, 'table-cell').map(cell => ({ rowSpan: num(cell, 'number-rows-spanned', 1), colSpan: num(cell, 'number-columns-spanned', 1), paragraphs: odpParagraphs(cell) })) })) });
    }
    slides.push({ index: index + 1, elements, notes: odpParagraphs(c(page, 'notes')).map(p => p.runs.map(r => r.text).join('')).join('\n') || undefined });
  }
  const truncated = pages.length > 200;
  return { preview: { kind: 'presentation', widthPt, heightPt, slides, truncated }, truncated };
}
