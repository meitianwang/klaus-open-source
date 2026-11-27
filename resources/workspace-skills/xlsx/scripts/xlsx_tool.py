#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import openpyxl
import xlrd
from defusedxml import ElementTree as ET
from openpyxl.utils import get_column_letter, range_boundaries

INPUT_BYTES_LIMIT = 100 * 1024 * 1024
from formula_engine import (audit_workbook, evaluate_workbook_formulas, find_soffice,
                            recalc_with_soffice, run_soffice)


class XlsxError(Exception):
    pass


def check_input(path):
    if path.stat().st_size > INPUT_BYTES_LIMIT:
        raise XlsxError('Input exceeds 100 MiB.')
    with path.open('rb') as handle:
        if handle.read(8) == bytes.fromhex('d0cf11e0a1b11ae1'):
            return 'xls'
    with ZipFile(path) as archive:
        if sum(item.file_size for item in archive.infolist()) > 5 * INPUT_BYTES_LIMIT:
            raise XlsxError('Workbook exceeds the expanded size limit.')
        bad = archive.testzip()
        if bad:
            raise XlsxError(f'CRC check failed: {bad}')
        for item in archive.infolist():
            if item.filename.endswith(('.xml', '.rels')):
                try:
                    ET.fromstring(archive.read(item))
                except Exception as exc:
                    raise XlsxError(f'{item.filename}: {exc}') from exc
    return 'xlsx'


def sparse_rows(sheet):
    rows = {}
    for (row, col), cell in sheet._cells.items():
        if cell.value is not None:
            rows.setdefault(row, {})[col] = cell
    return rows


def stats(sheet, legacy, rows=None):
    if legacy:
        return dict(name=sheet.name, maxRow=sheet.nrows, maxCol=sheet.ncols,
                    nonEmptyCells=sum(cell.ctype not in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK) for row in sheet.get_rows() for cell in row),
                    formulaCount=None, cachedErrorCount=sum(c.ctype == xlrd.XL_CELL_ERROR for row in sheet.get_rows() for c in row),
                    charts=[], mergedRangesCount=len(sheet.merged_cells))
    cells = [cell for row in rows.values() for cell in row.values()]
    return dict(name=sheet.title, maxRow=sheet.max_row, maxCol=sheet.max_column,
                nonEmptyCells=len(cells), formulaCount=sum(cell.data_type == 'f' for cell in cells),
                charts=[type(chart).__name__ for chart in sheet._charts],
                mergedRangesCount=len(sheet.merged_cells.ranges))


def read_sheet(args, book, legacy, cached):
    warnings = ["BIFF .xls exposes cached values only; raw formulas are unavailable."] if legacy and args.formulas else []
    sheet = (book.sheet_by_name(args.sheet) if args.sheet else book.sheet_by_index(0)) if legacy else (book[args.sheet] if args.sheet else book.worksheets[0])
    last_row, last_col = (sheet.nrows, sheet.ncols) if legacy else (sheet.max_row, sheet.max_column)
    left, top, right, bottom = range_boundaries(args.range) if args.range else (1, 1, last_col, last_row)
    if not all(isinstance(n, int) for n in (left, top, right, bottom)) or not (1 <= left <= right <= 16384 and 1 <= top <= bottom <= 1048576):
        if not args.range and not (last_col and last_row):
            return dict(sheet=sheet.name if legacy else sheet.title, rows=[], truncated=False, warnings=warnings)
        raise XlsxError('Use a valid cell range, for example A1:H50.')
    row_end = min(bottom, top + args.max_rows - 1)
    col_end = min(right, left + 199)
    result = []
    truncated = row_end < bottom or col_end < right
    for row in range(top, row_end + 1):
        cells = []
        for col in range(left, col_end + 1):
            entry = dict(coordinate=f'{get_column_letter(col)}{row}')
            if legacy:
                cell = sheet.cell(row - 1, col - 1) if row <= last_row and col <= last_col else None
                value = cell.value if cell and cell.ctype not in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK) else None
                if cell and cell.ctype == xlrd.XL_CELL_ERROR:
                    value = xlrd.error_text_from_code.get(value, value)
            else:
                cell = sheet._cells.get((row, col))
                value = cell.value if cell else None
                if cell and cell.data_type == 'f':
                    if args.formulas:
                        entry['formula'] = getattr(value, 'text', value)
                    actual = cached[sheet.title]._cells.get((row, col))
                    value = actual.value if actual else None
            for key, text in [('value', value), *entry.items()]:
                if isinstance(text, str) and len(text) > 1000:
                    text = text[:1000]
                    truncated = True
                entry[key] = text
            cells.append(entry)
        result.append(cells)
    return dict(sheet=sheet.name if legacy else sheet.title, rows=result, truncated=truncated, warnings=warnings)


def render(args):
    import re
    import pypdfium2 as pdfium
    executable = find_soffice(args.soffice)
    if not executable:
        raise XlsxError('Rendering requires LibreOffice.')
    if not 1 <= args.dpi <= 600:
        raise XlsxError('Use a DPI from 1 to 600.')
    with TemporaryDirectory() as temp:
        root = Path(temp).resolve()
        run_soffice(executable, root / 'profile', 60, '--convert-to', 'pdf:calc_pdf_Export',
                    '--outdir', str(root), str(args.input.resolve()))
        pdf_path = root / (args.input.stem + '.pdf')
        if not pdf_path.is_file():
            raise XlsxError('LibreOffice did not produce a PDF.')
        with pdfium.PdfDocument(pdf_path) as pdf:
            start, end = 1, len(pdf)
            if args.pages:
                match = re.fullmatch(r'(\d+)(?:-(\d+))?', args.pages)
                if not match:
                    raise XlsxError('Use a page or inclusive range, for example 1-3.')
                start, end = int(match[1]), int(match[2] or match[1])
            if not 1 <= start <= end <= len(pdf):
                raise XlsxError(f'Page range must be within 1-{len(pdf)}.')
            args.output_dir.mkdir(parents=True, exist_ok=True)
            paths = []
            for page_number in range(start, end+1):
                path = args.output_dir / f'page-{page_number}.png'
                with pdf[page_number] as page:
                    bitmap = page.render(scale=args.dpi/72)
                    try:
                        bitmap.to_pil().save(path)
                    finally:
                        bitmap.close()
                paths.append(str(path.resolve()))
        return dict(status='success', pages=paths)


def run(args):
    kind = check_input(args.input)
    legacy = kind == 'xls'
    if args.command in ('audit', 'recalc', 'render') and (legacy or args.input.suffix.lower() != '.xlsx'):
        raise XlsxError(f'{args.command} requires an .xlsx workbook; convert the input to .xlsx first.')
    if args.command == 'audit':
        return audit_workbook(args.input)
    if args.command == 'render':
        return render(args)
    if args.command == 'recalc':
        if args.timeout <= 0:
            raise XlsxError('Timeout must be positive.')
        if args.engine != 'python':
            executable = find_soffice(args.soffice)
            if executable or args.engine == 'libreoffice':
                return recalc_with_soffice(args.input, executable, args.timeout)
        return evaluate_workbook_formulas(args.input)
    book = xlrd.open_workbook(args.input, formatting_info=True) if legacy else openpyxl.load_workbook(args.input, keep_links=False)
    cached = None
    try:
        if not legacy:
            cached = openpyxl.load_workbook(args.input, data_only=True, keep_links=False)
        if args.command == 'read':
            return read_sheet(args, book, legacy, cached)
        sheets = book.sheets() if legacy else book.worksheets
        summaries = [stats(sheet, legacy, None if legacy else sparse_rows(sheet)) for sheet in sheets]
        if cached is not None:
            for sheet in summaries:
                sheet['cachedErrorCount'] = sum(c.data_type == 'e' for c in cached[sheet['name']]._cells.values())
                sheet['definedNames'] = list(book[sheet['name']].defined_names)
        return dict(file=str(args.input), bytes=args.input.stat().st_size, format=kind,
                    sheetCount=len(sheets), sheets=summaries,
                    definedNames=sorted(book.name_map if legacy else book.defined_names))
    finally:
        book.release_resources() if legacy else book.close()
        if cached is not None:
            cached.close()


def main():
    parser = argparse.ArgumentParser(description='Inspect, evaluate, audit, and render spreadsheet files.')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('inspect', 'read', 'recalc', 'audit', 'render'):
        command = commands.add_parser(name)
        command.add_argument('input', type=Path)
        if name == 'read':
            command.add_argument('--sheet')
            command.add_argument('--range')
            command.add_argument('--max-rows', type=int, default=200, choices=range(1, 201), metavar='1..200')
            command.add_argument('--formulas', action='store_true')
        if name in ('recalc', 'render'):
            command.add_argument('--soffice')
        if name == 'recalc':
            command.add_argument('--timeout', type=int, default=30)
            command.add_argument('--engine', choices=('auto', 'libreoffice', 'python'), default='auto')
            command.add_argument('--strict', action='store_true')
        if name == 'render':
            command.add_argument('--output-dir', type=Path, required=True)
            command.add_argument('--pages')
            command.add_argument('--dpi', type=int, default=150)
    args = parser.parse_args()
    try:
        result = run(args)
    except Exception as exc:
        print(json.dumps({'status': 'error', 'error': str(exc)}))
        return 1
    print(json.dumps(result, default=str, allow_nan=False))
    return int(not result.get('valid', True) or
               (getattr(args, 'strict', False) and result.get('status') == 'errors_found'))


if __name__ == '__main__':
    sys.exit(main())
