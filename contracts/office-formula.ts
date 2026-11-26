import type { OfficeSpreadsheetCell, OfficeSpreadsheetPreview, OfficeSpreadsheetSheet } from './office-preview';

const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLS = 200;

export function columnLetters(index: number): string {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  }
  return result;
}

export const colIndexToLabel = columnLetters;

export function parseCellAddress(value = ''): [number, number] | undefined {
  const m = /^\$?([a-z]{1,3})\$?([1-9]\d{0,6})$/i.exec(value);
  if (!m) return undefined;
  const c = [...m[1]!.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const r = Number(m[2]);
  return r <= 1048576 && c <= 16384 ? [r - 1, c - 1] : undefined;
}

class FormulaError {
  constructor(readonly code: string) {}
}
type ScalarValue = number | string | boolean | null | FormulaError;
type Expr =
  | { kind: 'value'; value: ScalarValue }
  | { kind: 'ref'; sheet?: string; start: string; end?: string }
  | { kind: 'op'; op: string; left: Expr; right?: Expr }
  | { kind: 'call'; name: string; args: Expr[] };
type Token = { kind: string; value: string };

const err = (code = '#VALUE!') => new FormulaError(code);

function tokenizeFormula(source: string): Token[] {
  const out: Token[] = [];
  const pattern = /\s+|"(?:""|[^"])*"|'(?:''|[^'])*'!(?=\$?[A-Za-z]{1,3}\$?\d)|[A-Za-z0-9_.\u0080-\uffff]+!(?=\$?[A-Za-z]{1,3}\$?\d)|\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}|#[A-Z0-9/]+[!?]?|\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?|\.\d+(?:[Ee][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_.]*|<=|>=|<>|[+\-*/^&=<>(),:%]/gy;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const raw = pattern.exec(source)?.[0];
    if (!raw) throw err();
    index = pattern.lastIndex;
    if (!raw.trim()) continue;
    const kind = raw.startsWith('"') ? 'str'
      : raw.endsWith('!') ? 'sheet'
      : raw.startsWith('#') ? 'err'
      : /^[\d.]/.test(raw) ? 'num'
      : /^(TRUE|FALSE)$/i.test(raw) && source[index] !== '(' ? 'bool'
      : parseCellAddress(raw) && source[index] !== '(' ? 'cell'
      : /^[A-Za-z_]/.test(raw) ? 'id'
      : raw;
    out.push({ kind, value: raw });
  }
  return out;
}

export function parseSpreadsheetFormula(source: string): Expr {
  const tokens = tokenizeFormula(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (kind?: string) => {
    const t = tokens[pos];
    if (!t || (kind && t.kind !== kind)) throw err();
    pos++;
    return t;
  };
  const prec: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  function parse(min = 0, depth = 0): Expr {
    if (depth > 48) throw err();
    let left = prefix(depth + 1);
    while (peek()?.kind === '%') { take(); left = { kind: 'op', op: '%', left }; }
    while (peek() && (prec[peek()!.kind] ?? -1) >= min) {
      const op = take().kind;
      left = { kind: 'op', op, left, right: parse(prec[op]! + (op === '^' ? 0 : 1), depth + 1) };
    }
    return left;
  }
  function prefix(depth: number): Expr {
    const t = take();
    if (t.kind === '+' || t.kind === '-') return { kind: 'op', op: t.kind, left: prefix(depth + 1) };
    if (t.kind === '(') { const inner = parse(0, depth + 1); take(')'); return inner; }
    if (t.kind === 'num') return { kind: 'value', value: Number(t.value) };
    if (t.kind === 'str') return { kind: 'value', value: t.value.slice(1, -1).replace(/""/g, '"') };
    if (t.kind === 'bool') return { kind: 'value', value: t.value.toUpperCase() === 'TRUE' };
    if (t.kind === 'err') return { kind: 'value', value: err(t.value) };
    if (t.kind === 'sheet' || t.kind === 'cell') {
      const sheet = t.kind === 'sheet' ? t.value.slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : undefined;
      const start = (t.kind === 'sheet' ? take('cell') : t).value;
      const end = peek()?.kind === ':' ? (take(), take('cell').value) : undefined;
      return { kind: 'ref', sheet, start, end };
    }
    if (t.kind === 'id') {
      take('(');
      const args: Expr[] = [];
      if (peek()?.kind !== ')') {
        args.push(parse(0, depth + 1));
        while (peek()?.kind === ',') { take(); args.push(parse(0, depth + 1)); }
      }
      take(')');
      return { kind: 'call', name: t.value.toUpperCase().replace(/^_XLFN\./, ''), args };
    }
    throw err('#NAME?');
  }
  const result = parse();
  if (pos !== tokens.length) throw err();
  return result;
}

const asScalar = (v: ScalarValue | ScalarValue[]): ScalarValue => {
  const item = Array.isArray(v) ? v[0] ?? null : v;
  if (item instanceof FormulaError) throw item;
  return item;
};
const asNumber = (v: ScalarValue): number => {
  if (v instanceof FormulaError) throw v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return Number(v);
  if (!v) return 0;
  const n = Number(v.trim());
  if (!Number.isFinite(n)) throw err();
  return n;
};
const asString = (v: ScalarValue): string => {
  if (v instanceof FormulaError) throw v;
  return v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
};
const compareScalars = (x: ScalarValue, y: ScalarValue): number => {
  const rank = (v: ScalarValue) => (typeof v === 'number' || v === null ? 0 : typeof v === 'string' ? 1 : 2);
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (typeof x === 'number' || x === null || typeof y === 'number' || y === null) return Number(x ?? 0) - Number(y ?? 0);
  if (typeof x === 'string' && typeof y === 'string') return x.toLowerCase().localeCompare(y.toLowerCase());
  return Number(x) - Number(y);
};
const testComparison = (op: string, cmp: number): boolean => (
  op === '=' ? cmp === 0 : op === '<>' ? cmp !== 0 : op === '<' ? cmp < 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : cmp >= 0
);
const matchesCriterion = (cell: ScalarValue, raw: ScalarValue): boolean => {
  if (typeof raw !== 'string') return compareScalars(cell, raw) === 0;
  const m = /^(<>|<=|>=|[=<>])(.*)$/.exec(raw);
  const op = m?.[1] ?? '=';
  const rhs = m ? m[2]! : raw;
  const n = rhs.trim() ? Number(rhs) : NaN;
  if (Number.isFinite(n)) return typeof cell === 'number' && testComparison(op, cell - n);
  if (op === '=' && /[*?]/.test(rhs)) {
    const re = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return re.test(asString(cell));
  }
  return testComparison(op, compareScalars(cell ?? '', rhs));
};

const cellKey = (r: number, c: number) => r * 16384 + c;

export function inferCellRawValue(cell: OfficeSpreadsheetCell): ScalarValue {
  if (cell.t === 'e' || cell.v.startsWith('#')) return new FormulaError(cell.v || '#VALUE!');
  if (cell.t === 'b' || /^(TRUE|FALSE)$/i.test(cell.v)) return cell.v.toUpperCase() === 'TRUE';
  if (cell.t === 'n') {
    const cleaned = cell.v.replace(/[$,%\s,]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return cell.v.endsWith('%') ? n / 100 : n;
  }
  if (!cell.t && cell.v.trim() !== '') {
    const trimmed = cell.v.trim();
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) && !(trimmed.length > 15 && /^\d+$/.test(trimmed))) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
  }
  return cell.v === '' ? null : cell.v;
}

/**
 * Re-evaluates all formula cells across all sheets in `preview`, updating `.v` and `.t`
 * in topological dependency order with cycle protection.
 */
export function recalculateSpreadsheet(preview: OfficeSpreadsheetPreview): OfficeSpreadsheetPreview {
  const sheetEntries = preview.sheets.map(sheet => {
    const map = new Map<number, OfficeSpreadsheetCell>();
    for (const cell of sheet.cells) map.set(cellKey(cell.r, cell.c), cell);
    return { sheet, map };
  });
  const byName = new Map(sheetEntries.map(s => [s.sheet.name.toLowerCase(), s]));
  const visiting = new Set<OfficeSpreadsheetCell>();
  const memo = new Map<OfficeSpreadsheetCell, ScalarValue>();

  function evalCell(entry: (typeof sheetEntries)[number], cell: OfficeSpreadsheetCell | undefined, depth: number, budget: { left: number }): ScalarValue {
    if (!cell) return null;
    if (!cell.f) return inferCellRawValue(cell);
    if (memo.has(cell)) return memo.get(cell)!;
    if (depth > 16 || visiting.has(cell) || budget.left <= 0) return err('#REF!');
    visiting.add(cell);
    try {
      const val = asScalar(evalExpr(parseSpreadsheetFormula(cell.f.replace(/^=/, '')), entry, depth, budget));
      memo.set(cell, val);
      return val;
    } catch (e) {
      const fe = e instanceof FormulaError ? e : err('#VALUE!');
      memo.set(cell, fe);
      return fe;
    } finally {
      visiting.delete(cell);
    }
  }

  function evalExpr(expr: Expr, entry: (typeof sheetEntries)[number], depth: number, budget: { left: number }): ScalarValue | ScalarValue[] {
    if (--budget.left < 0) throw err('#REF!');
    const run = (e: Expr) => evalExpr(e, entry, depth, budget);
    if (expr.kind === 'value') return expr.value;
    if (expr.kind === 'ref') {
      const target = expr.sheet === undefined ? entry : byName.get(expr.sheet.toLowerCase());
      if (!target) throw err('#REF!');
      const start = parseCellAddress(expr.start);
      if (!start) throw err('#REF!');
      const [r, c] = start;
      if (!expr.end) return evalCell(target, target.map.get(cellKey(r, c)), depth + 1, budget);
      const end = parseCellAddress(expr.end);
      if (!end) throw err('#REF!');
      const [r2, c2] = end;
      const size = (Math.abs(r2 - r) + 1) * (Math.abs(c2 - c) + 1);
      if (size > budget.left) throw err('#REF!');
      budget.left -= size;
      const values: ScalarValue[] = [];
      for (let row = Math.min(r, r2); row <= Math.max(r, r2); row++) {
        for (let col = Math.min(c, c2); col <= Math.max(c, c2); col++) {
          values.push(evalCell(target, target.map.get(cellKey(row, col)), depth + 1, budget));
        }
      }
      return values;
    }
    if (expr.kind === 'op') {
      const lhs = asScalar(run(expr.left));
      if (!expr.right) return expr.op === '%' ? asNumber(lhs) / 100 : expr.op === '-' ? -asNumber(lhs) : asNumber(lhs);
      const rhs = asScalar(run(expr.right));
      if (expr.op === '&') return asString(lhs) + asString(rhs);
      if (/[<>=]/.test(expr.op)) return testComparison(expr.op, compareScalars(lhs, rhs));
      const a = asNumber(lhs), b = asNumber(rhs);
      if (expr.op === '/' && b === 0) throw err('#DIV/0!');
      const res = expr.op === '+' ? a + b : expr.op === '-' ? a - b : expr.op === '*' ? a * b : expr.op === '/' ? a / b : a ** b;
      return Number.isFinite(res) ? res : err('#NUM!');
    }
    const at = (i: number) => expr.args[i] ? run(expr.args[i]!) : null;
    const sv = (i: number) => asScalar(at(i));
    if (expr.name === 'IF') return at(sv(0) ? 1 : 2);
    if (expr.name === 'IFERROR') { try { return asScalar(at(0)); } catch { return at(1); } }
    const array = (v: ScalarValue | ScalarValue[]) => Array.isArray(v) ? v : [v];
    if (expr.name === 'COUNTIF' || expr.name === 'SUMIF') {
      const range = array(at(0)), match = sv(1), values = expr.args.length > 2 ? array(at(2)) : range;
      return range.reduce<number>((sum, v, i) => {
        if (!matchesCriterion(asScalar(v), match)) return sum;
        const n = asScalar(values[i] ?? null);
        return sum + (expr.name === 'COUNTIF' ? 1 : typeof n === 'number' ? n : 0);
      }, 0);
    }
    const flat = () => expr.args.flatMap(v => array(run(v)));
    switch (expr.name) {
      case 'COUNT': return flat().filter(v => typeof v === 'number').length;
      case 'COUNTA': return flat().filter(v => v !== null).length;
      case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': {
        const nums = flat().map(asScalar).filter((v): v is number => typeof v === 'number');
        const sum = nums.reduce((a, b) => a + b, 0);
        return expr.name === 'SUM' ? sum : expr.name === 'AVERAGE' ? (nums.length ? sum / nums.length : err('#DIV/0!')) : !nums.length ? 0 : expr.name === 'MIN' ? Math.min(...nums) : Math.max(...nums);
      }
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
        const n = asNumber(sv(0)), p = Math.trunc(asNumber(sv(1))), factor = 10 ** p, mag = Math.abs(n) * factor;
        if (!factor || !Number.isFinite(mag) || !Number.isFinite(factor)) return err('#NUM!');
        const clean = Number(mag.toPrecision(15));
        return Math.sign(n) * (expr.name === 'ROUND' ? Math.round(clean) : expr.name === 'ROUNDUP' ? Math.ceil(clean) : Math.floor(clean)) / factor;
      }
      case 'ABS': return Math.abs(asNumber(sv(0)));
      case 'INT': return Math.floor(asNumber(sv(0)));
      case 'MOD': { const d = asNumber(sv(1)); if (!d) throw err('#DIV/0!'); return asNumber(sv(0)) - d * Math.floor(asNumber(sv(0)) / d); }
      case 'AND': return flat().every(v => Boolean(asScalar(v)));
      case 'OR': return flat().some(v => Boolean(asScalar(v)));
      case 'NOT': return !sv(0);
      case 'TRUE': return true;
      case 'FALSE': return false;
      case 'LEN': return [...asString(sv(0))].length;
      case 'LOWER': return asString(sv(0)).toLowerCase();
      case 'UPPER': return asString(sv(0)).toUpperCase();
      case 'TRIM': return asString(sv(0)).trim().replace(/ +/g, ' ');
      case 'LEFT': return [...asString(sv(0))].slice(0, Math.max(0, Math.trunc(expr.args[1] ? asNumber(sv(1)) : 1))).join('');
      case 'RIGHT': { const chars = [...asString(sv(0))], k = Math.max(0, Math.trunc(expr.args[1] ? asNumber(sv(1)) : 1)); return k ? chars.slice(-k).join('') : ''; }
      case 'MID': { const start = Math.trunc(asNumber(sv(1))), len = Math.trunc(asNumber(sv(2))); if (start < 1 || len < 0) throw err(); return [...asString(sv(0))].slice(start - 1, start - 1 + len).join(''); }
      case 'CONCAT': case 'CONCATENATE': return flat().map(v => asString(asScalar(v))).join('');
      default: throw err('#NAME?');
    }
  }

  for (const entry of sheetEntries) {
    for (const cell of entry.sheet.cells) {
      if (!cell.f) continue;
      const computed = evalCell(entry, cell, 0, { left: 4096 });
      if (computed instanceof FormulaError) {
        cell.v = computed.code;
        cell.t = 'e';
      } else if (typeof computed === 'number') {
        cell.v = Number.isInteger(computed) ? String(computed) : String(Number(computed.toPrecision(12)));
        cell.t = 'n';
      } else if (typeof computed === 'boolean') {
        cell.v = computed ? 'TRUE' : 'FALSE';
        cell.t = 'b';
      } else {
        cell.v = computed ?? '';
        cell.t = 's';
      }
    }
  }
  return preview;
}

/**
 * RFC 4180 compliant CSV / TSV parser supporting quoted fields, escaped quotes,
 * embedded newlines, and live formula evaluation.
 */
export function parseDelimitedRows(source: string, delimiter: ',' | '\t'): string[][] {
  const text = source.replace(/^\ufeff/, '');
  if (!text) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') {
    rows.pop();
  }
  return rows;
}

export function parseDelimitedSpreadsheet(source: string, delimiter: ',' | '\t', sheetName = 'Sheet1'): { preview: OfficeSpreadsheetPreview; truncated: boolean } {
  const allRows = parseDelimitedRows(source, delimiter);
  const totalRows = allRows.length;
  const totalCols = allRows.reduce((max, r) => Math.max(max, r.length), 0);
  const renderedRows = Math.min(totalRows, MAX_SHEET_ROWS);
  const renderedCols = Math.min(totalCols, MAX_SHEET_COLS);
  const cells: OfficeSpreadsheetCell[] = [];
  let hasFormulas = false;
  for (let r = 0; r < renderedRows; r++) {
    const line = allRows[r]!;
    for (let c = 0; c < Math.min(line.length, renderedCols); c++) {
      const raw = line[c] ?? '';
      if (!raw) continue;
      if (raw.startsWith('=') && raw.length > 1) {
        hasFormulas = true;
        cells.push({ r, c, v: raw, f: raw.slice(1), t: 's' });
      } else if (/^(TRUE|FALSE)$/i.test(raw)) {
        cells.push({ r, c, v: raw.toUpperCase(), t: 'b' });
      } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) && !(/^0\d+/.test(raw.trim()) && !raw.includes('.')) && !(raw.trim().length > 15 && /^\d+$/.test(raw.trim()))) {
        cells.push({ r, c, v: raw.trim(), t: 'n' });
      } else {
        cells.push({ r, c, v: raw, t: 's' });
      }
    }
  }
  const sheet: OfficeSpreadsheetSheet = {
    name: sheetName,
    totalRows,
    totalCols,
    renderedRows,
    renderedCols,
    cells,
  };
  const preview: OfficeSpreadsheetPreview = {
    kind: 'spreadsheet',
    activeSheet: 0,
    styles: [],
    sheets: [sheet],
    delimiter,
  };
  if (hasFormulas) recalculateSpreadsheet(preview);
  return { preview, truncated: totalRows > renderedRows || totalCols > renderedCols };
}

export function serializeDelimitedSpreadsheet(preview: OfficeSpreadsheetPreview, delimiter: ',' | '\t' = preview.delimiter ?? ','): string {
  const sheet = preview.sheets[preview.activeSheet] ?? preview.sheets[0];
  if (!sheet || !sheet.cells.length) return '';
  let maxR = -1;
  let maxC = -1;
  const map = new Map<number, OfficeSpreadsheetCell>();
  for (const cell of sheet.cells) {
    const val = cell.f ? `=${cell.f.replace(/^=/, '')}` : cell.v;
    if (val === '') continue;
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c > maxC) maxC = cell.c;
    map.set(cellKey(cell.r, cell.c), cell);
  }
  if (maxR < 0 || maxC < 0) return '';
  const lines: string[] = [];
  for (let r = 0; r <= maxR; r++) {
    const fields: string[] = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = map.get(cellKey(r, c));
      const raw = cell ? (cell.f ? `=${cell.f.replace(/^=/, '')}` : cell.v) : '';
      if (raw.includes('"') || raw.includes('\n') || raw.includes('\r') || raw.includes(delimiter)) {
        fields.push(`"${raw.replace(/"/g, '""')}"`);
      } else {
        fields.push(raw);
      }
    }
    lines.push(fields.join(delimiter));
  }
  return lines.join('\n') + '\n';
}
