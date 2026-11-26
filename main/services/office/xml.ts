import { posix } from 'node:path';
import * as yauzl from 'yauzl';
import type { OfficePreviewErrorCode } from '../../../contracts/office-preview';

export class OfficeParseError extends Error {
  constructor(readonly code: OfficePreviewErrorCode, message: string) { super(message); this.name = 'OfficeParseError'; }
}
export interface XmlElement { name: string; local: string; attrs: Record<string, string>; children: (XmlElement | string)[] }
const local = (name: string) => name.slice(name.lastIndexOf(':') + 1);
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, key: string) => {
    if (!key.startsWith('#')) return entities[key] ?? whole;
    const cp = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return cp <= 0x10ffff && cp > 0 && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
  });
}
export const decodeOoxmlEscapes = (text: string): string => text.replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '', local: '', attrs: Object.create(null), children: [] };
  const stack = [root];
  const tokens = /<!--[^]*?-->|<\?[^]*?\?>|<!\[CDATA\[[^]*?\]\]>|<\/?[\w:.-]+(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/gy;
  let offset = 0;
  const invalid = () => new OfficeParseError('corrupted', 'Invalid XML document');
  while (offset < xml.length) {
    const token = tokens.exec(xml)?.[0];
    if (!token) throw invalid();
    offset = tokens.lastIndex;
    const parent = stack[stack.length - 1]!;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { parent.children.push(token.slice(9, -3)); continue; }
    if (!token.startsWith('<')) { if (parent !== root || token.trim()) parent.children.push(decodeEntities(token)); continue; }
    if (token.startsWith('</')) {
      if (stack.length < 2 || parent.name !== token.slice(2, -1).trim()) throw invalid();
      stack.pop(); continue;
    }
    const name = /^<[\w:.-]+/.exec(token)![0].slice(1);
    const attrs: Record<string, string> = Object.create(null);
    const selfClosing = token.endsWith('/>');
    const source = token.slice(name.length + 1, selfClosing ? -2 : -1);
    const pattern = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let index = 0;
    while (source.slice(index).trim()) {
      const match = pattern.exec(source);
      if (!match || Object.hasOwn(attrs, match[1]!)) throw invalid();
      attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? ''); index = pattern.lastIndex;
    }
    const element = { name, local: local(name), attrs, children: [] } as XmlElement;
    parent.children.push(element);
    if (!selfClosing) { if (stack.length >= 256) throw new OfficeParseError('too_large', 'XML nesting exceeds the preview limit'); stack.push(element); }
  }
  const node = root.children[0];
  if (stack.length !== 1 || root.children.length !== 1 || !node || typeof node === 'string') throw invalid();
  return node;
}
export const childElements = (node?: XmlElement): XmlElement[] => node?.children.filter((item): item is XmlElement => typeof item !== 'string') ?? [];
export const childByLocal = (node: XmlElement | undefined, name: string): XmlElement | undefined => childElements(node).find(item => item.local === name);
export const childrenByLocal = (node: XmlElement | undefined, name: string): XmlElement[] => childElements(node).filter(item => item.local === name);
export function findAllByLocal(node: XmlElement | undefined, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  function visit(item: XmlElement) { if (item.local === name) found.push(item); for (const child of childElements(item)) visit(child); }
  if (node) visit(node);
  return found;
}
export const attrLocal = (node: XmlElement | undefined, name: string): string | undefined => node?.attrs[name] ?? (node && Object.entries(node.attrs).find(([key]) => !key.startsWith('xmlns:') && local(key) === name)?.[1]);
export const textContent = (node?: XmlElement): string => node?.children.map(item => typeof item === 'string' ? item : textContent(item)).join('') ?? '';
const MiB = 1024 * 1024;
export interface ZipArchive {
  read(path: string, maxBytes?: number): Promise<Buffer | undefined>;
  readXml(path: string): Promise<XmlElement | undefined>;
  readImageDataUrl(path: string): Promise<string | undefined>;
  close(): void;
}
export async function openSafeZip(bytes: Buffer): Promise<ZipArchive> {
  const zipError = (err?: unknown) => /encrypt/i.test(err instanceof Error ? err.message : String(err ?? ''))
    ? new OfficeParseError('encrypted', 'The archive contains an encrypted entry')
    : new OfficeParseError('corrupted', 'Invalid Office archive');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false }, (error, file) => error || !file ? reject(zipError(error)) : resolve(file)));
  const entries = new Map<string, yauzl.Entry>(), folded = new Map<string, yauzl.Entry | null>();
  let archiveError: Error | undefined;
  zip.on('error', error => { archiveError = zipError(error); });
  try {
    await new Promise<void>((resolve, reject) => {
      let count = 0;
      zip.once('error', error => reject(zipError(error)));
      zip.once('end', resolve);
      zip.on('entry', entry => {
        if (entry.generalPurposeBitFlag & 1) { reject(new OfficeParseError('encrypted', 'The archive contains an encrypted entry')); return; }
        if (++count > 5000 || entry.uncompressedSize > 32 * MiB) { reject(new OfficeParseError('too_large', 'Archive entry limits exceeded')); return; }
        if (entries.has(entry.fileName)) { reject(zipError()); return; }
        entries.set(entry.fileName, entry);
        const key = entry.fileName.toLowerCase(); folded.set(key, folded.has(key) ? null : entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
  } catch (error) { zip.close(); throw error; }
  let reserved = 0;
  async function read(path: string, maxBytes = 32 * MiB): Promise<Buffer | undefined> {
    if (archiveError) throw archiveError;
    const entry = entries.get(path) ?? folded.get(path.toLowerCase());
    if (!entry || entry.uncompressedSize > maxBytes) return undefined;
    reserved += entry.uncompressedSize;
    if (reserved > 96 * MiB) throw new OfficeParseError('too_large', 'Archive read limit exceeded');
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, value) => error || !value ? reject(zipError(error)) : resolve(value)));
    const chunks: Buffer[] = [];
    try { for await (const chunk of stream) chunks.push(Buffer.from(chunk)); } catch { throw zipError(); }
    return Buffer.concat(chunks);
  }
  return {
    read,
    async readXml(path) { const data = await read(path); return data && parseXml(data.toString('utf8')); },
    async readImageDataUrl(path) {
      const ext = posix.extname(path).toLowerCase().slice(1);
      if (!/^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext)) return undefined;
      const data = await read(path, 8 * MiB);
      if (!data) return undefined;
      if (ext === 'svg') {
        // Accept static vector geometry only; no active content or references.
        try {
          const svg = parseXml(data.toString('utf8'));
          const safe = (el: XmlElement): boolean => /^(svg|g|path|circle|ellipse|rect|line|polygon|polyline|text|tspan|title|desc)$/.test(el.local) && Object.entries(el.attrs).every(([key, value]) => !/^(on|style$|href$|src$)/i.test(local(key)) && !/javascript\s*:|url\s*\(/i.test(value)) && childElements(el).every(safe);
          if (svg.local !== 'svg' || !safe(svg)) return undefined;
        } catch { return undefined; }
      }
      const mime = ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext;
      return `data:image/${mime};base64,${data.toString('base64')}`;
    },
    close: () => zip.close(),
  };
}
export interface ZipRelationship { target: string; type: string; external: boolean }
export function resolveZipTarget(source: string, target: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return undefined; }
  if (!decoded || /[\\:\x00-\x1f]/.test(decoded) || decoded.startsWith('//')) return undefined;
  const path = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(source), decoded));
  return path === '..' || path.startsWith('../') || path === '.' ? undefined : path;
}
export async function readRelationships(zip: ZipArchive, source: string): Promise<Map<string, ZipRelationship>> {
  const root = await zip.readXml(posix.join(posix.dirname(source), '_rels', `${posix.basename(source)}.rels`));
  const result = new Map<string, ZipRelationship>();
  for (const node of childrenByLocal(root, 'Relationship')) {
    const id = attrLocal(node, 'Id'), target = attrLocal(node, 'Target');
    const external = attrLocal(node, 'TargetMode')?.toLowerCase() === 'external';
    const path = target && (external ? target : resolveZipTarget(source, target));
    if (id && path) result.set(id, { target: path, type: attrLocal(node, 'Type') ?? '', external });
  }
  return result;
}
export type ThemeColors = Record<string, string>;
export function normalizeHex6(value?: string): string | undefined {
  const hex = value?.replace(/^#/, '').toLowerCase();
  return hex && /^(?:[a-f\d]{2})?[a-f\d]{6}$/.test(hex) ? `#${hex.slice(-6)}` : undefined;
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const clamp = (n: number, max = 1) => Math.max(0, Math.min(max, n));
const hexRgb = (values: number[]) => '#' + values.map(v => Math.round(clamp(v, 255)).toString(16).padStart(2, '0')).join('');
function luminanceTransform(hex: string, transform: (l: number) => number): string {
  const values = rgb(hex).map(v => v / 255);
  const max = Math.max(...values), min = Math.min(...values), l = (max + min) / 2;
  const next = clamp(transform(l));
  const scale = l > 0 && l < 1 ? Math.min(next, 1 - next) / Math.min(l, 1 - l) : 0;
  return hexRgb(values.map(v => (next + (v - l) * scale) * 255));
}
export const applyExcelTint = (hex: string, tint: number): string => luminanceTransform(hex, l => tint < 0 ? l * (1 + tint) : l + (1 - l) * tint);
const preset: Record<string, string> = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', orange: 'ffa500', purple: '800080', cyan: '00ffff', magenta: 'ff00ff', dkBlue: '00008b', ltBlue: 'add8e6', navy: '000080', lime: '00ff00', silver: 'c0c0c0', teal: '008080', maroon: '800000', olive: '808000', aqua: '00ffff', fuchsia: 'ff00ff' };
export function resolveDrawingColor(node?: XmlElement, theme: ThemeColors = {}): string | undefined {
  const color = node && (/^(srgbClr|schemeClr|sysClr|prstClr)$/.test(node.local) ? node : childElements(node).find(n => /^(srgbClr|schemeClr|sysClr|prstClr)$/.test(n.local)));
  if (!color) return undefined;
  const val = attrLocal(color, 'val') ?? '';
  const aliases: Record<string, string> = { bg1: 'lt1', bg2: 'lt2', tx1: 'dk1', tx2: 'dk2' };
  let hex = normalizeHex6(color.local === 'schemeClr' ? theme[aliases[val] ?? val] : color.local === 'prstClr' ? preset[val] : color.local === 'sysClr' ? attrLocal(color, 'lastClr') : val);
  if (!hex) return undefined;
  let alpha = 1;
  for (const item of childElements(color)) {
    const amount = Number(attrLocal(item, 'val')) / 100000;
    if (!Number.isFinite(amount)) continue;
    switch (item.local) {
      case 'lumMod': hex = luminanceTransform(hex, l => l * amount); break;
      case 'lumOff': hex = luminanceTransform(hex, l => l + amount); break;
      case 'tint': hex = hexRgb(rgb(hex).map(v => 255 - (255 - v) * amount)); break;
      case 'shade': hex = hexRgb(rgb(hex).map(v => v * amount)); break;
      case 'alpha': alpha = clamp(amount); break;
    }
  }
  return alpha === 1 ? hex : `rgba(${rgb(hex).join(', ')}, ${alpha})`;
}
export function parseThemeColors(root?: XmlElement): ThemeColors {
  const result: ThemeColors = Object.create(null);
  for (const item of childElements(findAllByLocal(root, 'clrScheme')[0])) {
    const color = resolveDrawingColor(item); if (color) result[item.local] = color;
  }
  return result;
}
export function readableTextOnBackground(background: string): string {
  const channels = rgb(normalizeHex6(background) ?? '#ffffff').map(ch => { const n = ch / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722 > 0.179 ? '#000000' : '#ffffff';
}
