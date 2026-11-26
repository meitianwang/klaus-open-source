import type { OfficeCellStyle, OfficeSpreadsheetCell, OfficeSpreadsheetPreview, OfficeSpreadsheetSheet } from '../../../contracts/office-preview';
import { attrLocal as a, childByLocal as b, childrenByLocal as all, childElements, textContent as text, decodeEntities, decodeOoxmlEscapes as unescape, parseXml, OfficeParseError, parseThemeColors, normalizeHex6, applyExcelTint, readRelationships, type ZipArchive, type XmlElement } from './xml';

const ROWS = 1000, COLS = 80;
const positive = (v?: string) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };
const enabled = (v?: string) => v === '1' || v === 'true';
function address(value = ''): [number, number] | undefined {
  const m = /^\$?([a-z]{1,3})\$?([1-9]\d{0,6})$/i.exec(value);
  if (!m) return undefined;
  const c = [...m[1]!.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const r = Number(m[2]);
  return r <= 1048576 && c <= 16384 ? [r - 1, c - 1] : undefined;
}
const key = (r: number, c: number) => r * 16384 + c;
const richText = (node?: XmlElement) => unescape(childElements(node).map(n => n.local === 't' ? text(n) : n.local === 'r' ? text(b(n, 't')) : '').join(''));
const palette = ('000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff 000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff ' +
  '800000 008000 000080 808000 800080 008080 c0c0c0 808080 9999ff 993366 ffffcc ccffff 660066 ff8080 0066cc cccccc ' +
  '000080 ff00ff ffff00 00ffff 800080 800000 008080 0000ff 00ccff ccffff ccffcc ffff99 99ccff ff99cc cc99ff ffcc99 ' +
  '3366ff 33cccc 99cc00 ffcc00 ff9900 ff6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333').split(' ');
function readStyles(root: XmlElement | undefined, theme: Record<string, string>) {
  const formats = new Map(all(b(root, 'numFmts'), 'numFmt').map(n => [Number(a(n, 'numFmtId')), a(n, 'formatCode') ?? '']));
  const fonts = childElements(b(root, 'fonts')), fills = childElements(b(root, 'fills')), borders = childElements(b(root, 'borders'));
  const indices = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const colors = all(b(b(root, 'colors'), 'indexedColors'), 'rgbColor');
  const color = (n?: XmlElement) => {
    const i = Number(a(n, 'indexed')), hex = normalizeHex6(a(n, 'rgb') ?? theme[indices[Number(a(n, 'theme'))] ?? ''] ?? a(colors[i], 'rgb') ?? palette[i]);
    const tint = Number(a(n, 'tint'));
    return hex && Number.isFinite(tint) && tint ? applyExcelTint(hex, tint) : hex;
  };
  const styles: OfficeCellStyle[] = [], seen = new Map<string, number>();
  const xfs = all(b(root, 'cellXfs'), 'xf').map(xf => {
    const font = fonts[Number(a(xf, 'fontId'))], fill = b(fills[Number(a(xf, 'fillId'))], 'patternFill'), border = borders[Number(a(xf, 'borderId'))], alignment = b(xf, 'alignment');
    const flag = (n: string) => { const el = b(font, n); return el && !/^(0|false|none)$/.test(a(el, 'val') ?? '') ? true : undefined; };
    const align = a(alignment, 'horizontal'), valign = a(alignment, 'vertical');
    const edge = (side: string) => { const item = b(border, side), style = a(item, 'style'); return style && style !== 'none' ? `${/^(medium|thick|double)/.test(style) ? 2 : 1}px ${style === 'double' ? 'double' : /dash/i.test(style) ? 'dashed' : style === 'dotted' ? 'dotted' : 'solid'} ${color(b(item, 'color')) ?? '#000000'}` : undefined; };
    const style: OfficeCellStyle = { bold: flag('b'), italic: flag('i'), underline: flag('u'), strike: flag('strike'), color: color(b(font, 'color')), fontSize: positive(a(b(font, 'sz'), 'val')), bg: a(fill, 'patternType') === 'solid' ? color(b(fill, 'fgColor')) : undefined, align: align === 'left' || align === 'right' || align === 'center' ? align : undefined, valign: valign === 'center' ? 'middle' : valign === 'top' || valign === 'bottom' ? valign : undefined, wrap: enabled(a(alignment, 'wrapText')) || undefined, borderTop: edge('top'), borderRight: edge('right'), borderBottom: edge('bottom'), borderLeft: edge('left') };
    const signature = JSON.stringify(style);
    let s = seen.get(signature);
    if (s === undefined) { s = styles.length; styles.push(style); seen.set(signature, s); }
    const id = Number(a(xf, 'numFmtId') ?? '0');
    return { s, id, format: formats.get(id) };
  });
  return { styles, xfs };
}
const builtins: Record<number, string> = { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 5: '$#,##0', 6: '$#,##0', 7: '$#,##0.00', 8: '$#,##0.00', 9: '0%', 10: '0.00%', 14: 'm/d/yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0' };
function formatNumber(n: number, id: number, custom: string | undefined, mode1904: boolean): string {
  const sections = (custom ?? builtins[id] ?? ((id >= 27 && id <= 36 || id >= 50 && id <= 58) ? 'yyyy-mm-dd' : '')).match(/(?:"[^"]*"|\\.|[^;"\\])+/g) ?? [];
  const section = (n < 0 ? sections[1] : n === 0 ? sections[2] : undefined) ?? sections[0] ?? '';
  const signals = section.replace(/"[^"]*"|\\.|\[(?![hms]+\])[^\]]+\]/gi, '');
  if (/[ymdhs]|AM\/PM/i.test(signals) && /^(?:[ymdhs\[\] :./,0-]|AM\/PM)+$/i.test(signals)) {
    const days = Math.floor(n), ms = Math.round(n * 86400000);
    const date = new Date(Date.UTC(mode1904 ? 1904 : 1899, mode1904 ? 0 : 11, mode1904 ? 1 : 31) + ms - (!mode1904 && days >= 60 ? 86400000 : 0));
    if (!Number.isFinite(date.getTime())) return String(n);
    const leap = !mode1904 && days === 60;
    const month = leap ? 2 : date.getUTCMonth() + 1, day = leap ? 29 : date.getUTCDate(), h = date.getUTCHours();
    const twelve = /AM\/PM/i.test(section);
    const pad = (v: number, length: number) => String(v).padStart(length, '0');
    return section.replace(/"([^"]*)"|\\(.)|AM\/PM|\[[hms]+\]|y+|m+|d+|h+|s+|(?<=\.)0+/gi, (raw: string, quoted: string | undefined, literal: string | undefined, offset: number) => {
      if (quoted !== undefined || literal !== undefined) return quoted ?? literal ?? '';
      const t = raw.toLowerCase(), len = t.length;
      if (t === 'am/pm') return h >= 12 ? 'PM' : 'AM';
      if (t.startsWith('[')) return pad(Math.floor(Math.abs(n) * ({ h: 24, m: 1440, s: 86400 }[t[1]!] ?? 1) + 1e-8), len - 2);
      if (t[0] === 'y') return pad(len <= 2 ? date.getUTCFullYear() % 100 : date.getUTCFullYear(), len);
      if (t[0] === 'd') return len >= 3 ? date.toLocaleDateString('en-US', { weekday: len === 3 ? 'short' : 'long', timeZone: 'UTC' }) : pad(day, len);
      if (t[0] === 'h') return pad(twelve ? h % 12 || 12 : h, len);
      if (t[0] === 's') return pad(date.getUTCSeconds(), len);
      if (t[0] === '0') return pad(date.getUTCMilliseconds(), 3).slice(0, len).padEnd(len, '0');
      const minute = /(?:h+|\[h+\])\s*:\s*$/i.test(section.slice(0, offset)) || /^\s*:\s*s/i.test(section.slice(offset + len));
      if (len >= 3 && !minute) { const name = new Date(Date.UTC(2000, month - 1)).toLocaleDateString('en-US', { month: len === 3 ? 'short' : 'long', timeZone: 'UTC' }); return len === 5 ? name[0]! : name; }
      return pad(minute ? date.getUTCMinutes() : month, len);
    });
  }
  const prefixSuffix = (v: string) => v.replace(/"([^"]*)"|\\(.)|\[\$([^\]-]*)(?:-[^\]]+)?\]|\[[^\]]*\]|[_*]./g, (_, q, l, c) => q ?? l ?? c ?? '');
  const pattern = /[#0?][#,0?]*(?:\.[#0?]+)?/.exec(section);
  if (!pattern || /[Ee][+-]0/.test(signals)) return String(Number(n.toPrecision(15)));
  const decimals = pattern[0].split('.')[1] ?? '';
  const pct = [...signals].filter(ch => ch === '%').length;
  const scale = pattern[0].replace(/[^,]*$/, '').length - pattern[0].replace(/,+$/, '').replace(/[^,]*$/, '').length;
  const hasNegativeSection = n < 0 && sections.length > 1;
  const value = Math.abs(n) * 100 ** pct / 1000 ** scale;
  const formatted = new Intl.NumberFormat('en-US', { useGrouping: pattern[0].replace(/,+$/, '').split('.')[0]!.includes(','), minimumFractionDigits: Math.min(20, decimals.lastIndexOf('0') + 1), maximumFractionDigits: Math.min(20, decimals.length), minimumIntegerDigits: Math.max(1, Math.min(21, (pattern[0].split('.')[0]!.match(/0/g) ?? []).length)) }).format(value);
  return `${n < 0 && !hasNegativeSection ? '-' : ''}${prefixSuffix(section.slice(0, pattern.index))}${formatted}${prefixSuffix(section.slice(pattern.index + pattern[0].length))}`;
}

type Scalar = number | string | boolean | null;
class FormulaError { constructor(readonly value: string) {} }
const err = (value = '#VALUE!') => new FormulaError(value);
type Value = Scalar | FormulaError;
type Expr = { kind: 'value'; value: Value } | { kind: 'ref'; sheet?: string; start: string; end?: string } | { kind: 'op'; op: string; left: Expr; right?: Expr } | { kind: 'call'; name: string; args: Expr[] };
function parseFormula(raw: string): Expr {
  if (raw.length > 4096) throw err();
  const re = /\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|#[A-Z0-9/!?]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\$?[A-Za-z_][\w.$]*|<>|<=|>=|[-+*/^%&=<>!,():;])/iy;
  const tokens: string[] = [];
  for (let i = 0; i < raw.trimEnd().length;) { re.lastIndex = i; const m = re.exec(raw); if (!m || tokens.length >= 512) throw err(); tokens.push(m[1]!); i = re.lastIndex; }
  let i = 0;
  const take = (token: string) => tokens[i] === token && (++i > 0);
  const precedence: Record<string, number> = { '=': 1, '<>': 1, '>': 1, '<': 1, '>=': 1, '<=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  function expression(min = 0): Expr {
    const token = tokens[i++];
    if (!token) throw err();
    let left: Expr;
    if (token === '+' || token === '-') left = { kind: 'op', op: token, left: expression(6) };
    else if (token === '(') { left = expression(); if (!take(')')) throw err(); }
    else if (token.startsWith('"')) left = { kind: 'value', value: token.slice(1, -1).replace(/""/g, '"') };
    else if (token.startsWith('#')) left = { kind: 'value', value: err(token) };
    else if (/^(\d|\.)/.test(token)) left = { kind: 'value', value: Number(token) };
    else if (take('(')) {
      const args: Expr[] = [];
      if (!take(')')) { do { args.push(expression()); } while (take(',') || take(';')); if (!take(')')) throw err(); }
      left = { kind: 'call', name: token.toUpperCase().replace(/^_XLFN\./, ''), args };
    } else {
      const qualified = take('!');
      const start = qualified ? tokens[i++] ?? '' : token;
      if (!qualified && /^(true|false)$/i.test(token)) left = { kind: 'value', value: /^true$/i.test(token) };
      else {
        if (!address(start)) throw err('#NAME?');
        const end = take(':') ? tokens[i++] : undefined;
        if (tokens[i - 1] === ':' || (end && !address(end))) throw err('#REF!');
        left = { kind: 'ref', start, end, sheet: qualified ? token.replace(/^'|'$/g, '').replace(/''/g, "'") : undefined };
      }
    }
    while (take('%')) left = { kind: 'op', op: '%', left };
    while ((precedence[tokens[i] ?? ''] ?? -1) >= min) {
      const op = tokens[i++]!, level = precedence[op]!;
      left = { kind: 'op', op, left, right: expression(level + 1) };
    }
    return left;
  }
  const result = expression();
  if (i !== tokens.length) throw err();
  return result;
}
function scalar(value: Value | Value[]): Scalar {
  const v = Array.isArray(value) ? value[0] ?? null : value;
  if (v instanceof FormulaError) throw v;
  return v;
}
function number(value: Scalar): number {
  const n = Number(value); if (!Number.isFinite(n)) throw err(); return n;
}
const string = (value: Scalar) => value === null ? '' : typeof value === 'boolean' ? value ? 'TRUE' : 'FALSE' : String(value);
function compare(a: Scalar, b: Scalar): number {
  if (a == null) a = typeof b === 'string' ? '' : 0;
  if (b == null) b = typeof a === 'string' ? '' : 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const rank = (v: Scalar) => typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
  return rank(a) - rank(b) || string(a).toLowerCase().localeCompare(string(b).toLowerCase());
}
function testComparison(op: string, cmp: number): boolean {
  switch (op) { case '=': return cmp === 0; case '<>': return cmp !== 0; case '>': return cmp > 0; case '<': return cmp < 0; case '>=': return cmp >= 0; default: return cmp <= 0; }
}
function criterion(value: Scalar, condition: Scalar) {
  if (typeof condition !== 'string') return compare(value, condition) === 0;
  const [, op = '=', rhs = ''] = /^(<=|>=|<>|[=<>])?([^]*)$/.exec(condition)!;
  if ((op === '=' || op === '<>') && /[*?~]/.test(rhs)) {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Dynamic programming keeps wildcard matching bounded for document-controlled criteria.
    const pattern = [...rhs.matchAll(/~[~*?]|[^]/g)].map(m => m[0]);
    const input = string(value).toLowerCase();
    if (input.length * pattern.length > 100000) throw err();
    let row = new Uint8Array(input.length + 1); row[0] = 1;
    for (const p of pattern) {
      const next = new Uint8Array(input.length + 1); if (p === '*') next[0] = row[0]!;
      const literal = p.length === 2 ? p.slice(1).toLowerCase() : p.toLowerCase();
      for (let i = 1; i <= input.length; i++) next[i] = p === '*' ? (next[i - 1] || row[i])! : (p === '?' || input[i - 1] === literal) ? row[i - 1]! : 0;
      row = next;
    }
    return Boolean(row[input.length]) === (op === '=');
  }
  return testComparison(op, compare(value, rhs.trim() && Number.isFinite(Number(rhs)) ? Number(rhs) : rhs));
}
interface RawCell { cell: OfficeSpreadsheetCell; raw: Value; format: number; custom?: string; cached: boolean }
interface SheetData { sheet: OfficeSpreadsheetSheet; values: Map<number, RawCell> }
function evaluator(sheets: SheetData[]) {
  const names = new Map(sheets.map(s => [s.sheet.name.toLowerCase(), s]));
  const visiting = new Set<RawCell>();
  const memo = new Map<RawCell, Value>();
  function evaluateCell(sheet: SheetData, item: RawCell | undefined, depth: number, budget: { left: number }): Value {
    if (!item) return null;
    if (item.cached || !item.cell.f) return item.raw;
    if (memo.has(item)) return memo.get(item)!;
    if (depth > 16 || visiting.has(item) || budget.left <= 0) return err('#REF!');
    visiting.add(item);
    try {
      const value = scalar(evaluate(parseFormula(item.cell.f.replace(/^=/, '')), sheet, depth, budget));
      memo.set(item, value); return value;
    } catch (error) { return error instanceof FormulaError ? error : err(); }
    finally { visiting.delete(item); }
  }
  function evaluate(expr: Expr, sheet: SheetData, depth: number, budget: { left: number }): Value | Value[] {
    if (--budget.left < 0) throw err('#REF!');
    const run = (e: Expr) => evaluate(e, sheet, depth, budget);
    if (expr.kind === 'value') return expr.value;
    if (expr.kind === 'ref') {
      const target = expr.sheet === undefined ? sheet : names.get(expr.sheet.toLowerCase());
      if (!target) throw err('#REF!');
      const [r, c] = address(expr.start)!;
      if (!expr.end) return evaluateCell(target, target.values.get(key(r, c)), depth + 1, budget);
      const [r2, c2] = address(expr.end)!;
      const size = (Math.abs(r2 - r) + 1) * (Math.abs(c2 - c) + 1);
      if (size > budget.left) throw err('#REF!');
      budget.left -= size;
      const values: Value[] = [];
      for (let row = Math.min(r, r2); row <= Math.max(r, r2); row++) for (let col = Math.min(c, c2); col <= Math.max(c, c2); col++) values.push(evaluateCell(target, target.values.get(key(row, col)), depth + 1, budget));
      return values;
    }
    if (expr.kind === 'op') {
      const lhs = scalar(run(expr.left));
      if (!expr.right) return expr.op === '%' ? number(lhs) / 100 : expr.op === '-' ? -number(lhs) : number(lhs);
      const rhs = scalar(run(expr.right));
      if (expr.op === '&') return string(lhs) + string(rhs);
      if (/[<>=]/.test(expr.op)) return testComparison(expr.op, compare(lhs, rhs));
      const a = number(lhs), b = number(rhs);
      if (expr.op === '/' && b === 0) throw err('#DIV/0!');
      const result = expr.op === '+' ? a + b : expr.op === '-' ? a - b : expr.op === '*' ? a * b : expr.op === '/' ? a / b : a ** b;
      return Number.isFinite(result) ? result : err('#NUM!');
    }
    const at = (index: number) => expr.args[index] ? run(expr.args[index]!) : null;
    const sv = (index: number) => scalar(at(index));
    if (expr.name === 'IF') return at(sv(0) ? 1 : 2);
    if (expr.name === 'IFERROR') { try { return scalar(at(0)); } catch { return at(1); } }
    const array = (v: Value | Value[]) => Array.isArray(v) ? v : [v];
    if (expr.name === 'COUNTIF' || expr.name === 'SUMIF') {
      const range = array(at(0)), match = sv(1), values = expr.args.length > 2 ? array(at(2)) : range;
      return range.reduce<number>((sum, v, i) => { if (!criterion(scalar(v), match)) return sum; const n = scalar(values[i] ?? null); return sum + (expr.name === 'COUNTIF' ? 1 : typeof n === 'number' ? n : 0); }, 0);
    }
    const flat = () => expr.args.flatMap(v => array(run(v)));
    switch (expr.name) {
      case 'COUNT': return flat().filter(v => typeof v === 'number').length;
      case 'COUNTA': return flat().filter(v => v !== null).length;
      case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': {
        const values = flat().map(scalar).filter((v): v is number => typeof v === 'number');
        const sum = values.reduce((a, b) => a + b, 0);
        return expr.name === 'SUM' ? sum : expr.name === 'AVERAGE' ? values.length ? sum / values.length : err('#DIV/0!') : !values.length ? 0 : expr.name === 'MIN' ? Math.min(...values) : Math.max(...values);
      }
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
        const n = number(sv(0)), p = Math.trunc(number(sv(1))), factor = 10 ** p, mag = Math.abs(n) * factor;
        if (!factor || !Number.isFinite(mag) || !Number.isFinite(factor)) return err('#NUM!');
        const clean = Number(mag.toPrecision(15));
        return Math.sign(n) * (expr.name === 'ROUND' ? Math.round(clean) : expr.name === 'ROUNDUP' ? Math.ceil(clean) : Math.floor(clean)) / factor;
      }
      case 'INT': return Math.floor(number(sv(0)));
      case 'ABS': return Math.abs(number(sv(0)));
      case 'AND': return flat().map(scalar).every(Boolean);
      case 'OR': return flat().map(scalar).some(Boolean);
      case 'NOT': return !sv(0);
      case 'CONCAT': case 'CONCATENATE': { const parts = flat().map(v => string(scalar(v))); if (parts.reduce((n, part) => n + part.length, 0) > 32767) return err(); return parts.join(''); }
      case 'LEN': return string(sv(0)).length;
      case 'TRIM': return string(sv(0)).replace(/^ +| +$/g, '').replace(/ +/g, ' ');
      case 'LEFT': case 'RIGHT': { const s = string(sv(0)), n = expr.args[1] ? Math.trunc(number(sv(1))) : 1; return n < 0 ? err() : expr.name === 'LEFT' ? s.slice(0, n) : s.slice(Math.max(0, s.length - n)); }
      case 'MID': { const s = string(sv(0)), start = Math.trunc(number(sv(1))) - 1, n = Math.trunc(number(sv(2))); return start < 0 || n < 0 ? err() : s.slice(start, start + n); }
      default: return err('#NAME?');
    }
  }
  return (sheet: SheetData, cell: RawCell) => evaluateCell(sheet, cell, 0, { left: 16000 });
}
function sheetData(name: string, node?: XmlElement, hidden = false): SheetData {
  const sheet: OfficeSpreadsheetSheet = { name, hidden: hidden || undefined, totalRows: 0, totalCols: 0, renderedRows: 0, renderedCols: 0, cells: [] };
  const dimension = address(a(b(node, 'dimension'), 'ref')?.split(':').pop());
  if (dimension) { sheet.totalRows = dimension[0] + 1; sheet.totalCols = dimension[1] + 1; }
  const pane = b(b(b(node, 'sheetViews'), 'sheetView'), 'pane');
  if (/^frozen(?:Split)?$/.test(a(pane, 'state') ?? '')) { sheet.frozenRows = positive(a(pane, 'ySplit')); sheet.frozenCols = positive(a(pane, 'xSplit')); }
  return { sheet, values: new Map() };
}
function extend(sheet: OfficeSpreadsheetSheet, r: number, c: number) {
  sheet.totalRows = Math.max(sheet.totalRows, r + 1);
  sheet.totalCols = Math.max(sheet.totalCols, c + 1);
}
function finish(sheet: OfficeSpreadsheetSheet): boolean {
  sheet.renderedRows = Math.min(ROWS, sheet.totalRows); sheet.renderedCols = Math.min(COLS, sheet.totalCols);
  return sheet.renderedRows < sheet.totalRows || sheet.renderedCols < sheet.totalCols;
}
const numeric = (value?: string) => { const n = Number(value); return value && Number.isFinite(n) && n >= 0 ? n : undefined; };
export async function parseXlsxArchive(zip: ZipArchive): Promise<{ preview: OfficeSpreadsheetPreview; truncated: boolean }> {
  const source = 'xl/workbook.xml';
  const workbook = await zip.readXml(source);
  if (!workbook) throw new OfficeParseError('corrupted', 'Workbook metadata is missing');
  const rels = await readRelationships(zip, source);
  const theme = parseThemeColors(await zip.readXml('xl/theme/theme1.xml'));
  const { styles, xfs } = readStyles(await zip.readXml('xl/styles.xml'), theme);
  const shared = all(await zip.readXml('xl/sharedStrings.xml'), 'si').map(richText);
  const mode1904 = enabled(a(b(workbook, 'workbookPr'), 'date1904'));
  const sheets: SheetData[] = [];
  let truncated = false;
  for (const item of all(b(workbook, 'sheets'), 'sheet')) {
    const relation = rels.get(a(item, 'id') ?? '');
    const node = relation && !relation.external ? await zip.readXml(relation.target) : undefined;
    if (!node) throw new OfficeParseError('corrupted', 'A workbook sheet is missing');
    const data = sheetData(a(item, 'name') ?? `Sheet ${sheets.length + 1}`, node, /^(hidden|veryHidden)$/.test(a(item, 'state') ?? ''));
    const { sheet, values } = data;
    const colWidths: Array<number | null> = [], rowHeights: Array<number | null> = [];
    const hiddenCols = new Set<number>(), hiddenRows = new Set<number>();
    for (const col of all(b(node, 'cols'), 'col')) {
      const start = positive(a(col, 'min')), end = positive(a(col, 'max'));
      if (!start || !end) continue;
      for (let c = start - 1; c < Math.min(end, COLS); c++) {
        const width = numeric(a(col, 'width'));
        if (width !== undefined) colWidths[c] = width;
        if (enabled(a(col, 'hidden'))) hiddenCols.add(c);
      }
    }
    let ri = -1;
    for (const row of all(b(node, 'sheetData'), 'row')) {
      ri = (positive(a(row, 'r')) ?? ri + 2) - 1;
      if (ri >= 1048576) continue;
      sheet.totalRows = Math.max(sheet.totalRows, ri + 1);
      if (ri < ROWS) {
        const height = numeric(a(row, 'ht'));
        if (height !== undefined) rowHeights[ri] = height;
        if (enabled(a(row, 'hidden'))) hiddenRows.add(ri);
      }
      let ci = -1;
      for (const el of all(row, 'c')) {
        const [r, c] = address(a(el, 'r')) ?? [ri, ci + 1]; ci = c;
        if (c >= 16384) continue;
        extend(sheet, r, c);
        const value = b(el, 'v'), str = text(value), type = a(el, 't');
        const raw: Value = type === 's' ? shared[Number(str)] ?? '' : type === 'str' ? unescape(str) : type === 'inlineStr' ? richText(b(el, 'is')) : type === 'b' ? enabled(str) : type === 'e' ? err(str) : type === 'd' ? str : str.trim() && Number.isFinite(Number(str)) ? Number(str) : null;
        const xf = xfs[Number(a(el, 's') ?? '0')], f = text(b(el, 'f')) || undefined;
        values.set(key(r, c), { cell: { r, c, v: '', s: xf?.s, f }, raw, cached: !!value && (str !== '' || type === 'str'), format: xf?.id ?? 0, custom: xf?.format });
      }
    }
    for (const merge of all(b(node, 'mergeCells'), 'mergeCell')) {
      const [first, last] = (a(merge, 'ref') ?? '').split(':');
      const start = address(first), end = address(last);
      if (!start || !end) continue;
      const [r, c] = start, [r2, c2] = end;
      if (r2 < r || c2 < c) continue;
      extend(sheet, r2, c2);
      if (r >= ROWS || c >= COLS) continue;
      const k = key(r, c), item = values.get(k) ?? { cell: { r, c, v: '' }, raw: null, cached: false, format: 0 };
      item.cell.rs = Math.min(r2 + 1, ROWS) - r; item.cell.cs = Math.min(c2 + 1, COLS) - c;
      values.set(k, item);
    }
    if (colWidths.length) sheet.colWidths = Array.from(colWidths, v => v ?? null);
    if (rowHeights.length) sheet.rowHeights = Array.from(rowHeights, v => v ?? null);
    if (hiddenCols.size) sheet.hiddenCols = [...hiddenCols].sort((a, b) => a - b);
    if (hiddenRows.size) sheet.hiddenRows = [...hiddenRows].sort((a, b) => a - b);
    truncated = finish(sheet) || truncated;
    sheets.push(data);
  }
  if (!sheets.length) throw new OfficeParseError('empty', 'The workbook contains no sheets');
  const evaluate = evaluator(sheets);
  for (const data of sheets) {
    for (const item of data.values.values()) {
      const { cell } = item;
      if (cell.r >= ROWS || cell.c >= COLS) continue;
      const value = evaluate(data, item);
      cell.t = value instanceof FormulaError ? 'e' : typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's';
      cell.v = value instanceof FormulaError ? value.value : typeof value === 'number' ? formatNumber(value, item.format, item.custom, mode1904) : string(value);
      data.sheet.cells.push(cell);
    }
    data.sheet.cells.sort((a, b) => a.r - b.r || a.c - b.c);
  }
  const active = Number(a(b(b(workbook, 'bookViews'), 'workbookView'), 'activeTab'));
  return { preview: { kind: 'spreadsheet', styles, activeSheet: Number.isSafeInteger(active) && active >= 0 && active < sheets.length ? active : 0, sheets: sheets.map(s => s.sheet) }, truncated };
}
export function parseTextSpreadsheet(rawText: string, defaultSheetName = 'Sheet 1'): { preview: OfficeSpreadsheetPreview; truncated: boolean } | null {
  const sheets: OfficeSpreadsheetSheet[] = [];
  const newSheet = (name: string) => { const { sheet } = sheetData(name); sheets.push(sheet); return sheet; };
  function add(sheet: OfficeSpreadsheetSheet, r: number, c: number, v: string, rs: number, cs: number, t: OfficeSpreadsheetCell['t'] = 's', f?: string) {
    extend(sheet, r + rs - 1, c + cs - 1);
    if (r < ROWS && c < COLS) sheet.cells.push({ r, c, v, t, f, rs: rs > 1 ? Math.min(rs, ROWS - r) : undefined, cs: cs > 1 ? Math.min(cs, COLS - c) : undefined });
  }
  if (/<(?:[\w.-]+:)?Workbook\b/.test(rawText)) {
    const root = parseXml(rawText);
    for (const ws of all(root, 'Worksheet')) {
      const sheet = newSheet(a(ws, 'Name') ?? defaultSheetName), table = b(ws, 'Table');
      sheet.totalRows = positive(a(table, 'ExpandedRowCount')) ?? 0;
      sheet.totalCols = positive(a(table, 'ExpandedColumnCount')) ?? 0;
      let r = 0;
      for (const row of all(table, 'Row')) {
        r = (positive(a(row, 'Index')) ?? r + 1) - 1;
        let c = 0;
        for (const cell of all(row, 'Cell')) {
          c = (positive(a(cell, 'Index')) ?? c + 1) - 1;
          const data = b(cell, 'Data'), type = a(data, 'Type'), value = text(data), rs = 1 + (positive(a(cell, 'MergeDown')) ?? 0), cs = 1 + (positive(a(cell, 'MergeAcross')) ?? 0);
          add(sheet, r, c, type === 'Boolean' ? enabled(value) ? 'TRUE' : 'FALSE' : unescape(value), rs, cs, type === 'Number' ? 'n' : type === 'Boolean' ? 'b' : type === 'Error' ? 'e' : 's', a(cell, 'Formula'));
          c += cs;
        }
        r++;
      }
    }
  } else {
    const cleaned = rawText.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    for (const table of cleaned.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
      const sheet = newSheet(sheets.length ? `${defaultSheetName} (${sheets.length + 1})` : defaultSheetName);
      const occupied = new Map<number, number>();
      let r = 0;
      for (const row of table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tr\s*>|$)/gi)) {
        let c = 0;
        for (const cell of row[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/t[dh]\s*>|$)/gi)) {
          while ((occupied.get(c) ?? 0) > r) c++;
          const span = (attr: string, max: number) => Math.min(max, positive(new RegExp(`\\b${attr}\\s*=\\s*["']?(\\d+)`, 'i').exec(cell[1]!)?.[1]) ?? 1);
          const rs = span('rowspan', 1048576), cs = span('colspan', 16384);
          const v = decodeEntities(cell[2]!.replace(/<br\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, '\u00a0')).trim();
          add(sheet, r, c, v, rs, cs);
          if (rs > 1) for (let i = c; i < Math.min(c + cs, COLS); i++) occupied.set(i, r + rs);
          c += cs;
        }
        r++;
      }
    }
  }
  if (!sheets.length) return null;
  let truncated = false;
  for (const sheet of sheets) truncated = finish(sheet) || truncated;
  return { preview: { kind: 'spreadsheet', styles: [], activeSheet: 0, sheets }, truncated };
}
