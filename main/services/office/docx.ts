import type { OfficeDocBlock, OfficeDocCell, OfficeDocumentPreview, OfficeEmbeddedImage, OfficeInlineRun } from '../../../contracts/office-preview';
import { attrLocal as a, childByLocal as b, childrenByLocal as all, childElements as children, findAllByLocal as find, textContent as text, decodeOoxmlEscapes, normalizeHex6, applyExcelTint, parseThemeColors, readRelationships, OfficeParseError, type XmlElement, type ZipArchive } from './xml';

type Paragraph = Extract<OfficeDocBlock, { kind: 'paragraph' }>;
type Table = Extract<OfficeDocBlock, { kind: 'table' }>;
const val = (node?: XmlElement) => a(node, 'val');
const readNum = (s?: string): number | undefined => s && Number.isFinite(Number(s)) ? Number(s) : undefined;
const flag = (node?: XmlElement): boolean | undefined => node ? !/^(0|false|off|none)$/i.test(val(node) ?? '') : undefined;
const first = (node: XmlElement | undefined, name: string) => find(node, name)[0];
const highlightColors: Record<string, string> = { black: '000000', blue: '0000ff', cyan: '00ffff', green: '00ff00', magenta: 'ff00ff', red: 'ff0000', yellow: 'ffff00', white: 'ffffff', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'c0c0c0' };
function safeLink(target?: string): string | undefined {
  if (!target || /[\x00-\x20\x7f]/.test(target)) return undefined;
  try { const url = new URL(target); return /^(https?:|mailto:)$/.test(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
const align = (value?: string): Paragraph['align'] => value === 'start' ? 'left' : value === 'end' ? 'right' : value === 'left' || value === 'center' || value === 'right' ? value : undefined;
const valign = (value?: string): OfficeDocCell['valign'] => value === 'center' ? 'middle' : value === 'top' || value === 'bottom' ? value : undefined;
function numberLabel(value: number, format: string): string {
  if (/^(lower|upper)Letter$/.test(format) && value > 0 && value < 100000) {
    const letter = String.fromCharCode(97 + (value - 1) % 26).repeat(Math.floor((value - 1) / 26) + 1);
    return format === 'upperLetter' ? letter.toUpperCase() : letter;
  }
  if (/^(lower|upper)Roman$/.test(format) && value > 0 && value < 4000) {
    let roman = '';
    for (const [n, token] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const) { while (value >= n) { roman += token; value -= n; } }
    return format === 'lowerRoman' ? roman.toLowerCase() : roman;
  }
  return format === 'decimalZero' ? String(value).padStart(2, '0') : String(value);
}
export async function parseDocxArchive(zip: ZipArchive): Promise<{ preview: OfficeDocumentPreview; truncated: boolean }> {
  const source = 'word/document.xml', doc = await zip.readXml(source), body = b(doc, 'body');
  if (!body) throw new OfficeParseError('corrupted', 'The document body is missing');
  const theme = parseThemeColors(await zip.readXml('word/theme/theme1.xml'));
  const stylesRoot = await zip.readXml('word/styles.xml');
  const numbering = await zip.readXml('word/numbering.xml');
  const defaults = b(stylesRoot, 'docDefaults');
  const styles = new Map(all(stylesRoot, 'style').map(style => [a(style, 'styleId'), style]));
  const defaultParagraph = all(stylesRoot, 'style').find(s => a(s, 'type') === 'paragraph' && /^(1|true)$/.test(a(s, 'default') ?? ''));
  const abstracts = new Map(all(numbering, 'abstractNum').map(item => [a(item, 'abstractNumId'), item]));
  const lists = new Map(all(numbering, 'num').map(item => [a(item, 'numId'), item]));
  const counters = new Map<string, Array<number | undefined>>();
  const aliases: Record<string, string> = { dark1: 'dk1', dark2: 'dk2', light1: 'lt1', light2: 'lt2', text1: 'dk1', text2: 'dk2', background1: 'lt1', background2: 'lt2', hyperlink: 'hlink', followedHyperlink: 'folHlink' };
  let count = 0, truncated = false;
  function reserve() { if (count >= 2500) { truncated = true; return false; } count++; return true; }
  function chain(id?: string): XmlElement[] {
    const stack: XmlElement[] = [], seen = new Set<string>();
    while (id && !seen.has(id) && stack.length < 32) {
      const style = styles.get(id); if (!style) break;
      seen.add(id); stack.push(style); id = val(b(style, 'basedOn'));
    }
    return stack;
  }
  function property(nodes: (XmlElement | undefined)[], name: string): XmlElement | undefined {
    for (const node of nodes) { const child = b(node, name); if (child) return child; }
    return undefined;
  }
  function color(node?: XmlElement, fill = false): string | undefined {
    const key = a(node, fill ? 'themeFill' : 'themeColor');
    let result = (key && theme[aliases[key] ?? key]) || normalizeHex6(a(node, fill ? 'fill' : 'val'));
    if (result && key) {
      const tint = a(node, fill ? 'themeFillTint' : 'themeTint'), shade = a(node, fill ? 'themeFillShade' : 'themeShade');
      if (tint && /^[\da-f]{2}$/i.test(tint)) result = applyExcelTint(result, 1 - parseInt(tint, 16) / 255);
      if (shade && /^[\da-f]{2}$/i.test(shade)) result = applyExcelTint(result, parseInt(shade, 16) / 255 - 1);
    }
    return result || undefined;
  }
  function listMarker(nodes: (XmlElement | undefined)[]): Paragraph['list'] {
    const props = nodes.map(n => b(n, 'numPr'));
    const id = val(property(props, 'numId')), level = Math.trunc(readNum(val(property(props, 'ilvl'))) ?? 0);
    if (!id || id === '0' || level < 0 || level > 8) return undefined;
    const list = lists.get(id), abstract = abstracts.get(val(b(list, 'abstractNumId')));
    const definitions = (i: number) => {
      const override = all(list, 'lvlOverride').find(n => Number(a(n, 'ilvl')) === i);
      const base = all(abstract, 'lvl').find(n => Number(a(n, 'ilvl')) === i);
      return { override, props: [b(override, 'lvl'), base] };
    };
    const { override, props: current } = definitions(level);
    const format = val(property(current, 'numFmt')) ?? 'bullet';
    const pattern = val(property(current, 'lvlText')) ?? (format === 'bullet' ? '•' : `%${level + 1}.`);
    if (format === 'bullet' || format === 'none') return { ordered: false, level, marker: format === 'none' ? '' : /^[\ue000-\uf8ff]$/.test(pattern) ? '•' : pattern };
    const values = counters.get(id) ?? [];
    counters.set(id, values);
    const start = (ov: XmlElement | undefined, props: (XmlElement | undefined)[]) => Math.trunc(readNum(val(b(ov, 'startOverride')) ?? val(property(props, 'start'))) ?? 1);
    values[level] = values[level] === undefined ? start(override, current) : values[level]! + 1;
    for (let i = level + 1; i < values.length; i++) {
      const restart = readNum(val(property(definitions(i).props, 'lvlRestart')));
      if (restart !== 0 && level <= (restart ?? i) - 1) values[i] = undefined;
    }
    return { ordered: true, level, marker: pattern.replace(/%([1-9])/g, (_, digit: string) => {
      const i = Number(digit) - 1, def = definitions(i);
      return numberLabel(values[i] ?? start(def.override, def.props), val(property(def.props, 'numFmt')) ?? 'decimal');
    }) };
  }
  const imagesByPath = new Map<string, string | undefined>();
  type Rels = Awaited<ReturnType<typeof readRelationships>>;
  async function blocks(node: XmlElement, relations: Rels): Promise<OfficeDocBlock[]> {
    const result: OfficeDocBlock[] = [];
    for (const item of children(node)) {
      if (item.local === 'p') { if (!reserve()) break; result.push(await paragraph(item, relations));
        const style = b(item, 'pPr'); const bottom = b(b(style, 'pBdr'), 'bottom');
        if (bottom && !/^(none|nil)$/.test(val(bottom) ?? '') && reserve()) result.push({ kind: 'hr' });
      } else if (item.local === 'tbl') { if (!reserve()) break; result.push(await table(item, relations)); }
      else if (item.local === 'sdt' || item.local === 'sdtContent' || item.local === 'customXml' || item.local === 'ins') result.push(...await blocks(item, relations));
      if (truncated) break;
    }
    return result;
  }
  async function paragraph(node: XmlElement, relations: Rels): Promise<Paragraph> {
    const pPr = b(node, 'pPr');
    const hierarchy = chain(val(b(pPr, 'pStyle')) ?? a(defaultParagraph, 'styleId'));
    const pProps = [pPr, ...hierarchy.map(style => b(style, 'pPr')), b(b(defaults, 'pPrDefault'), 'pPr')];
    const names = hierarchy.flatMap(s => [val(b(s, 'name')), a(s, 'styleId')]).filter((n): n is string => !!n).map(n => n.toLowerCase().replace(/[ _-]/g, ''));
    const headingMatch = names.map(n => /^heading([1-6])$/.exec(n)).find(Boolean);
    const outline = readNum(val(property(pProps, 'outlineLvl')));
    const level = headingMatch ? Number(headingMatch[1]) : outline === undefined ? 0 : outline + 1;
    const role = names.find(n => n === 'title' || n === 'subtitle' || n === 'quote' || n === 'intensequote');
    const ind = property(pProps, 'ind');
    const indent = readNum(a(ind, 'start') ?? a(ind, 'left'));
    const runs: OfficeInlineRun[] = [], images: OfficeEmbeddedImage[] = [];
    const result: Paragraph = { kind: 'paragraph', heading: (Number.isInteger(level) && level >= 1 && level <= 6 ? level : undefined) as Paragraph['heading'], role: role === 'intensequote' ? 'quote' : role as Paragraph['role'], align: align(val(property(pProps, 'jc'))), indentPt: indent === undefined ? undefined : indent / 20, bg: color(property(pProps, 'shd'), true), runs, list: listMarker(pProps) };
    async function inline(parent: XmlElement, href?: string): Promise<void> {
      for (const child of children(parent)) {
        if (child.local === 'hyperlink') {
          const rel = relations.get(a(child, 'id') ?? '');
          await inline(child, rel?.external ? safeLink(rel.target) : undefined);
        } else if (child.local === 'r') {
          const direct = b(child, 'rPr'), runChain = chain(val(b(direct, 'rStyle')));
          const props = [direct, ...runChain.map(style => b(style, 'rPr')), ...hierarchy.map(style => b(style, 'rPr')), b(b(defaults, 'rPrDefault'), 'rPr')];
          const get = (name: string) => property(props, name);
          const vertical = val(get('vertAlign')), fonts = get('rFonts');
          const font = a(fonts, 'ascii') ?? a(fonts, 'hAnsi') ?? '';
          const sz = readNum(val(get('sz')));
          const style: Omit<OfficeInlineRun, 'text'> = { bold: flag(get('b')), italic: flag(get('i')), underline: flag(get('u')), strike: flag(get('strike') ?? get('dstrike')), sup: vertical === 'superscript' || undefined, sub: vertical === 'subscript' || undefined, color: color(get('color')), highlight: normalizeHex6(highlightColors[val(get('highlight')) ?? '']) ?? color(get('shd'), true), code: /mono|courier|consolas|menlo|fixedsys/i.test(font) || undefined, fontSize: sz !== undefined && sz > 0 ? sz / 2 : undefined, href };
          for (const part of children(child)) {
            if (part.local === 't') runs.push({ ...style, text: decodeOoxmlEscapes(text(part)) });
            else if (part.local === 'tab') runs.push({ ...style, text: '\t' });
            else if (part.local === 'br' || part.local === 'cr') runs.push({ ...style, text: '', br: true });
            else if (part.local === 'noBreakHyphen') runs.push({ ...style, text: '\u2011' });
            else if (part.local === 'footnoteReference' || part.local === 'endnoteReference') {
              const id = a(part, 'id'); if (id) runs.push({ ...style, text: id, sup: true });
            } else if (part.local === 'drawing') {
              const rel = relations.get(a(first(part, 'blip'), 'embed') ?? '');
              if (!rel || rel.external || !/^word\/media\//i.test(rel.target)) continue;
              if (!imagesByPath.has(rel.target)) imagesByPath.set(rel.target, await zip.readImageDataUrl(rel.target));
              const src = imagesByPath.get(rel.target);
              if (!src) continue;
              const extent = first(part, 'extent'), info = first(part, 'docPr');
              const width = readNum(a(extent, 'cx')), height = readNum(a(extent, 'cy'));
              images.push({ src, alt: a(info, 'descr') ?? a(info, 'title') ?? a(info, 'name'), widthPx: width && width > 0 ? width / 9525 : undefined, heightPx: height && height > 0 ? height / 9525 : undefined });
            }
          }
        } else if (/^(smartTag|customXml|sdt|sdtContent|ins|fldSimple|moveTo)$/.test(child.local)) await inline(child, href);
      }
    }
    await inline(node);
    if (images.length) result.images = images;
    return result;
  }
  async function table(node: XmlElement, relations: Rels): Promise<Table> {
    const widths = all(b(node, 'tblGrid'), 'gridCol').map(col => Math.max(0, readNum(a(col, 'w')) ?? 0));
    const widthSum = widths.reduce((sum, width) => sum + width, 0);
    const rows: Table['rows'] = [];
    let previous = new Map<number, OfficeDocCell>();
    for (const tr of all(node, 'tr')) {
      const props = b(tr, 'trPr');
      const cells: OfficeDocCell[] = [];
      const current = new Map<number, OfficeDocCell>();
      let col = Math.max(0, Math.trunc(readNum(val(b(props, 'gridBefore'))) ?? 0));
      for (const tc of all(tr, 'tc')) {
        const tcPr = b(tc, 'tcPr'), span = Math.min(16384, Math.max(1, Math.trunc(readNum(val(b(tcPr, 'gridSpan'))) ?? 1)));
        const merge = b(tcPr, 'vMerge');
        const origin = merge && (val(merge) ?? 'continue') === 'continue' ? previous.get(col) : undefined;
        if (origin && (origin.colSpan ?? 1) === span) {
          origin.rowSpan = (origin.rowSpan ?? 1) + 1; current.set(col, origin);
        } else {
          const cellBlocks = await blocks(tc, relations);
          const cell: OfficeDocCell = { colSpan: span > 1 ? span : undefined, bg: color(b(tcPr, 'shd'), true), valign: valign(val(b(tcPr, 'vAlign'))), blocks: cellBlocks };
          cells.push(cell);
          if (merge) current.set(col, cell);
        }
        col += span;
        if (truncated) break;
      }
      rows.push({ header: flag(b(props, 'tblHeader')), cells });
      previous = current;
      if (truncated) break;
    }
    return { kind: 'table', colWidthsPct: widthSum > 0 ? widths.map(w => w / widthSum * 100) : undefined, rows };
  }
  const mainRels = await readRelationships(zip, source);
  const documentBlocks = await blocks(body, mainRels);
  const footnotes: NonNullable<OfficeDocumentPreview['footnotes']> = [];
  for (const type of ['footnote', 'endnote'] as const) {
    if (truncated) break;
    const path = `word/${type}s.xml`, notes = await zip.readXml(path);
    if (!notes) continue;
    const relations = await readRelationships(zip, path);
    for (const note of all(notes, type)) {
      const id = a(note, 'id');
      if (!id || Number(id) < 0 || (a(note, 'type') && a(note, 'type') !== 'normal')) continue;
      const content = await blocks(note, relations);
      if (content.length) footnotes.push({ id: type === 'endnote' ? `endnote:${id}` : id, blocks: content });
      if (truncated) break;
    }
  }
  const titleBlock = documentBlocks.find((block): block is Paragraph => block.kind === 'paragraph' && block.role === 'title');
  const title = titleBlock?.runs.map(run => run.text).join('').trim() || undefined;
  return { preview: { kind: 'document', title, blocks: documentBlocks, footnotes: footnotes.length ? footnotes : undefined, truncated: truncated || undefined }, truncated };
}
