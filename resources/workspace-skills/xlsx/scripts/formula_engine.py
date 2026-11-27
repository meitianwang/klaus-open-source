"""Evaluate and audit workbook formulas without executing workbook code."""
import math
import re
import statistics
from datetime import datetime, timedelta

from openpyxl import load_workbook
from openpyxl.formula import Tokenizer
from openpyxl.formula.translate import Translator
from openpyxl.utils.cell import range_boundaries, get_column_letter
from openpyxl.utils.datetime import to_excel, from_excel

ERRORS = {'#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!'}


class FormulaError(Exception):
    pass


class Grid(list):
    pass


PRECEDENCE = {'=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '&': 2,
              '+': 3, '-': 3, '*': 4, '/': 4, '^': 5}


class Parser:
    def __init__(self, formula):
        raw = Tokenizer(formula).items
        self.tokens = []
        for i, token in enumerate(raw):
            if token.type != 'WHITE-SPACE':
                self.tokens.append(token)
            elif (0 < i < len(raw)-1 and raw[i-1].subtype == 'RANGE'
                  and raw[i+1].subtype == 'RANGE'):
                token.type, token.subtype, token.value = 'OPERATOR-INFIX', '', ' '
                self.tokens.append(token)
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def pop(self):
        token = self.peek()
        if token is None:
            raise FormulaError('#VALUE!')
        self.pos += 1
        return token

    def expression(self, minimum=0):
        token = self.pop()
        if token.type == 'OPERATOR-PREFIX':
            node = ('unary', token.value, self.expression(8))
        elif token.type == 'OPERAND':
            node = (token.subtype, token.value)
        elif token.type == 'PAREN' and token.subtype == 'OPEN':
            node = self.expression()
            if self.pop().subtype != 'CLOSE':
                raise FormulaError('#VALUE!')
        elif token.type == 'FUNC' and token.subtype == 'OPEN':
            args = []
            while self.peek() is not None:
                next_token = self.peek()
                if next_token.subtype == 'CLOSE':
                    if args:
                        args.append(('blank', None))
                    self.pop()
                    break
                args.append(('blank', None) if next_token.type == 'SEP' else self.expression())
                delimiter = self.pop()
                if delimiter.subtype == 'CLOSE':
                    break
                if delimiter.type != 'SEP':
                    raise FormulaError('#VALUE!')
            node = ('call', token.value[:-1].upper().removeprefix('_XLFN.').removeprefix('_XLWS.'), args)
        else:
            raise FormulaError('#VALUE!')
        while (token := self.peek()) is not None:
            if token.type == 'OPERATOR-POSTFIX' and minimum <= 7:
                self.pop()
                node = ('unary', '%', node)
            elif token.type == 'OPERATOR-INFIX' and (power := PRECEDENCE.get(token.value, 9)) >= minimum:
                self.pop()
                node = ('binary', token.value, node, self.expression(power + 1))
            else:
                break
        return node

    def parse(self):
        result = self.expression()
        if self.peek() is not None:
            raise FormulaError('#VALUE!')
        return result


def flat(values):
    for value in values:
        if isinstance(value, Grid):
            for row in value:
                yield from row
        else:
            yield value


def checked(value):
    if isinstance(value, FormulaError):
        raise value
    return value


def scalar(value):
    return checked(value[0][0] if isinstance(value, Grid) else value)


def number(value):
    value = scalar(value)
    if value is None:
        return 0
    if isinstance(value, datetime):
        return to_excel(value)
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (ValueError, TypeError):
        raise FormulaError('#VALUE!') from None


def text(value):
    value = scalar(value)
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def compare(a, b, op):
    a, b = scalar(a), scalar(b)
    if a is None:
        a = '' if isinstance(b, str) else 0
    if b is None:
        b = '' if isinstance(a, str) else 0
    def key(v):
        if isinstance(v, str):
            return 1, v.casefold()
        if isinstance(v, bool):
            return 2, v
        return 0, number(v)
    a, b = key(a), key(b)
    return {'=': a == b, '<>': a != b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b}[op]


def wildcard(value, pattern):
    parts = re.findall(r'~[~*?]|.', pattern, re.S)
    return isinstance(value, str) and re.fullmatch(''.join(
        '.*' if p == '*' else '.' if p == '?' else re.escape(p[-1]) for p in parts), value, re.I | re.S) is not None


def criterion(value, spec):
    if isinstance(value, FormulaError):
        return False
    if not isinstance(spec, str):
        return compare(value, spec, '=')
    op, wanted = re.fullmatch(r'(<=|>=|<>|[=<>])?(.*)', spec, re.S).groups()
    op = op or '='
    if op in ('=', '<>') and any(c in wanted for c in '*?~'):
        return wildcard(value, wanted) == (op == '=')
    try:
        wanted = float(wanted)
    except ValueError:
        pass
    return compare(value, wanted, op)


def lookup(needle, values, mode, reverse=False, wildcard_mode=False):
    best = None
    for index in (range(len(values)-1, -1, -1) if reverse else range(len(values))):
        value = values[index]
        if wildcard(value, needle) if wildcard_mode and isinstance(needle, str) else compare(value, needle, '='):
            return index
        if mode and compare(value, needle, '<' if mode == -1 else '>'):
            if best is None or compare(value, values[best], '>' if mode == -1 else '<'):
                best = index
    if best is None:
        raise FormulaError('#N/A')
    return best


def financial(name, args):
    if name == 'NPV':
        rate = number(args[0])
        return sum(number(v)/(1+rate)**i for i, v in enumerate(flat(args[1:]), 1))
    if name == 'IRR':
        values = [number(v) for v in flat(args[:1]) if v is not None]
        rate = number(args[1]) if len(args) > 1 else .1
        if not values or min(values) >= 0 or max(values) <= 0:
            raise FormulaError('#NUM!')
        try:
            for _ in range(100):
                if rate <= -1:
                    break
                residual = sum(v/(1+rate)**i for i, v in enumerate(values))
                if abs(residual) <= sum(map(abs, values))*1e-12:
                    return rate
                slope = -sum(i*v/(1+rate)**(i+1) for i, v in enumerate(values) if i)
                rate -= residual/slope
        except (OverflowError, ZeroDivisionError):
            pass
        raise FormulaError('#NUM!')
    rate, periods, third = map(number, args[:3])
    fourth = number(args[3]) if len(args) > 3 else 0
    timing = number(args[4]) if len(args) > 4 else 0
    growth = (1+rate)**periods
    annuity = periods if rate == 0 else (growth-1)/rate*(1+rate*timing)
    if name == 'PMT':
        return -(third*growth+fourth)/annuity
    if name == 'PV':
        return -(third*annuity+fourth)/growth
    return -(third*annuity+fourth*growth)


def function(name, args, epoch):
    if name in {'NPV', 'IRR', 'PMT', 'PV', 'FV'}:
        return financial(name, args)
    if name in {'SUM', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN', 'COUNT', 'COUNTA', 'COUNTBLANK', 'AND', 'OR'}:
        values = list(flat(args))
        if name == 'COUNTA':
            return sum(v is not None for v in values)
        if name == 'COUNTBLANK':
            return sum(v is None or v == '' for v in values)
        if name == 'COUNT':
            return sum(type(v) in (int, float, datetime) for v in values)
        values = [checked(v) for v in values]
        nums = [number(v) for v in values if type(v) in (int, float, datetime, bool)]
        if name in ('AND', 'OR') and not nums:
            raise FormulaError('#VALUE!')
        if name == 'AVERAGE' and not nums:
            raise FormulaError('#DIV/0!')
        if name == 'MEDIAN' and not nums:
            raise FormulaError('#NUM!')
        return {'SUM': sum, 'AVERAGE': statistics.mean, 'MIN': lambda v: min(v, default=0),
                'MAX': lambda v: max(v, default=0), 'MEDIAN': statistics.median,
                'AND': all, 'OR': any}[name](nums)
    if name == 'SUMPRODUCT':
        vectors = [list(flat([a])) for a in args]
        if not vectors or len({len(v) for v in vectors}) != 1:
            raise FormulaError('#VALUE!')
        return sum(math.prod(v if isinstance(checked(v), (int, float)) else 0 for v in row)
                   for row in zip(*vectors))
    if name in {'SUMIF', 'SUMIFS', 'COUNTIF', 'COUNTIFS', 'AVERAGEIF'}:
        single = not name.endswith('IFS')
        count = name.startswith('COUNT')
        data = None if count else args[2] if single and len(args) > 2 else args[0]
        pairs = args[:2] if single else args if count else args[1:]
        vectors = [list(flat([a])) for a in pairs[::2]]
        specs = [scalar(a) for a in pairs[1::2]]
        output = list(flat([data])) if not count else [1]*len(vectors[0])
        if len(specs) != len(vectors) or len({len(output), *map(len, vectors)}) != 1:
            raise FormulaError('#VALUE!')
        selected = [checked(v) for v, cells in zip(output, zip(*vectors))
                    if all(criterion(c, s) for c, s in zip(cells, specs))]
        if count:
            return len(selected)
        nums = [v for v in selected if type(v) in (int, float)]
        if name == 'AVERAGEIF':
            if not nums:
                raise FormulaError('#DIV/0!')
            return statistics.mean(nums)
        return sum(nums)
    if name in {'INDEX', 'MATCH', 'VLOOKUP', 'HLOOKUP', 'XLOOKUP'}:
        if name == 'INDEX':
            grid = args[0] if isinstance(args[0], Grid) else [[args[0]]]
            row = int(number(args[1]))
            col = int(number(args[2])) if len(args) > 2 else 1
            if len(grid) == 1 and len(args) == 2:
                row, col = 1, row
            if not 1 <= row <= len(grid) or not 1 <= col <= len(grid[row-1]):
                raise FormulaError('#REF!')
            return checked(grid[row-1][col-1])
        needle = scalar(args[0])
        if name == 'MATCH':
            mode = number(args[2]) if len(args) > 2 else 1
            return lookup(needle, list(flat(args[1:2])), -int(mode), wildcard_mode=mode == 0)+1
        if name == 'XLOOKUP':
            mode = number(args[4]) if len(args) > 4 else 0
            search = number(args[5]) if len(args) > 5 else 1
            values, results = list(flat(args[1:2])), list(flat(args[2:3]))
            if len(values) != len(results) or mode not in (-1, 0, 1, 2) or search not in (-2, -1, 1, 2):
                raise FormulaError('#VALUE!')
            try:
                index = lookup(needle, values, 0 if mode == 2 else mode, search < 0, mode == 2)
            except FormulaError as exc:
                if str(exc) == '#N/A' and len(args) > 3:
                    return scalar(args[3])
                raise
            return checked(results[index])
        grid = args[1] if isinstance(args[1], Grid) else [[args[1]]]
        if name == 'HLOOKUP':
            grid = list(zip(*grid))
        offset = int(number(args[2]))-1
        if offset < 0:
            raise FormulaError('#VALUE!')
        if offset >= len(grid[0]):
            raise FormulaError('#REF!')
        approx = len(args) < 4 or bool(number(args[3]))
        return checked(grid[lookup(needle, [r[0] for r in grid], -int(approx), wildcard_mode=not approx)][offset])
    if name in {'CONCAT', 'CONCATENATE'}:
        return ''.join(map(text, flat(args)))
    if name in {'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'UPPER', 'LOWER'}:
        value = text(args[0])
        if name in ('LEFT', 'RIGHT', 'MID'):
            start = int(number(args[1])) - 1 if name == 'MID' else 0
            length = int(number(args[2 if name == 'MID' else 1])) if len(args) > 1 else 1
            if start < 0 or length < 0:
                raise FormulaError('#VALUE!')
            return (value[-length:] if length else '') if name == 'RIGHT' else value[start:start+length]
        return {'LEN': len, 'TRIM': lambda s: re.sub(' +', ' ', s.strip(' ')),
                'UPPER': str.upper, 'LOWER': str.lower}[name](value)
    if name in {'DATE', 'YEAR', 'MONTH', 'DAY'}:
        if name == 'DATE':
            y, m, d = [int(number(v)) for v in args]
            if 0 <= y < 1900:
                y += 1900
            y, m = y + (m-1)//12, (m-1)%12+1
            return to_excel(datetime(y, m, 1)+timedelta(days=d-1), epoch)
        value = scalar(args[0])
        if not isinstance(value, datetime):
            value = from_excel(number(value), epoch)
        return getattr(value, name.lower(), {'YEAR': 1900, 'MONTH': 1, 'DAY': 0}[name])
    unary = {'NOT': lambda v: not v, 'INT': math.floor, 'ABS': abs, 'SQRT': math.sqrt, 'LN': math.log, 'EXP': math.exp}
    if name in unary:
        value = number(args[0])
        if name == 'SQRT' and value < 0 or name == 'LN' and value <= 0:
            raise FormulaError('#NUM!')
        return unary[name](value)
    if name in {'POWER', 'MOD'}:
        a, b = map(number, args)
        return a**b if name == 'POWER' else a%b
    if name in {'ROUND', 'ROUNDUP', 'ROUNDDOWN'}:
        from decimal import Decimal, ROUND_HALF_UP, ROUND_UP, ROUND_DOWN
        mode = {'ROUND': ROUND_HALF_UP, 'ROUNDUP': ROUND_UP, 'ROUNDDOWN': ROUND_DOWN}[name]
        return float(Decimal(str(number(args[0]))).quantize(Decimal(1).scaleb(-int(number(args[1]))), rounding=mode))
    raise FormulaError('#NAME?')


class Evaluator:
    def __init__(self, book):
        self.book = book
        self.sheets = {s.title.casefold(): s for s in book.worksheets}
        self.cache = {}
        self.active = {}
        self.cycles = set()

    def cell(self, sheet, address):
        key = sheet.title, address
        if key in self.cache:
            return self.cache[key]
        if key in self.active:
            self.cycles.update(list(self.active)[self.active[key]:])
            raise FormulaError('#REF!')
        self.active[key] = len(self.active)
        try:
            cell = sheet[address]
            value = cell.value
            if cell.data_type == 'e':
                raise FormulaError(value)
            if cell.data_type == 'f':
                value = scalar(self.node(Parser(value).parse(), sheet)) if isinstance(value, str) else FormulaError('#VALUE!')
                if value is None:
                    value = 0
                if isinstance(value, complex) or isinstance(value, float) and not math.isfinite(value):
                    raise FormulaError('#NUM!')
        except FormulaError as exc:
            value = exc
        except ZeroDivisionError:
            value = FormulaError('#DIV/0!')
        except (OverflowError, ArithmeticError, RecursionError):
            value = FormulaError('#NUM!')
        except (ValueError, TypeError, IndexError):
            value = FormulaError('#VALUE!')
        finally:
            del self.active[key]
        if key in self.cycles:
            value = FormulaError('#REF!')
        self.cache[key] = value
        return value

    def bounds(self, raw, sheet):
        if '!' in raw:
            name, raw = raw.rsplit('!', 1)
            if name.startswith("'") and name.endswith("'"):
                name = name[1:-1].replace("''", "'")
            sheet = self.sheets.get(name.casefold())
            if sheet is None:
                raise FormulaError('#REF!')
        try:
            x1, y1, x2, y2 = range_boundaries(raw)
        except ValueError:
            raise FormulaError('#NAME?') from None
        if not all((x1, y1, x2, y2)):
            raise FormulaError('#NAME?')
        if not (x1 <= x2 <= 16384 and y1 <= y2 <= 1048576) or (x2-x1+1)*(y2-y1+1) > 1_000_000:
            raise FormulaError('#REF!')
        return sheet, x1, y1, x2, y2

    def reference(self, sheet, x1, y1, x2, y2, ranged):
        if not ranged:
            return checked(self.cell(sheet, f'{get_column_letter(x1)}{y1}'))
        return Grid([[self.cell(sheet, f'{get_column_letter(c)}{r}') for c in range(x1, x2+1)]
                     for r in range(y1, y2+1)])

    def node(self, node, sheet):
        kind, op, *rest = node
        def sub(n):
            return self.node(n, sheet)
        if kind == 'RANGE':
            return self.reference(*self.bounds(op, sheet), ':' in op)
        if kind == 'NUMBER':
            return float(op)
        if kind == 'TEXT':
            return op[1:-1].replace('""', '"')
        if kind == 'LOGICAL':
            return op == 'TRUE'
        if kind == 'ERROR':
            raise FormulaError(op)
        if kind == 'blank':
            return None
        if kind == 'unary':
            v = number(sub(rest[0]))
            return -v if op == '-' else v/100 if op == '%' else v
        if kind == 'binary':
            if op == ' ':
                a, b = (self.bounds(n[1], sheet) for n in rest)
                x1, y1, x2, y2 = max(a[1], b[1]), max(a[2], b[2]), min(a[3], b[3]), min(a[4], b[4])
                if a[0] != b[0] or x1 > x2 or y1 > y2:
                    raise FormulaError('#NULL!')
                return self.reference(a[0], x1, y1, x2, y2, True)
            a, b = map(sub, rest)
            if PRECEDENCE[op] == 1:
                return compare(a, b, op)
            if op == '&':
                return text(a)+text(b)
            a, b = number(a), number(b)
            return {'+': lambda: a+b, '-': lambda: a-b, '*': lambda: a*b,
                    '/': lambda: a/b, '^': lambda: a**b}[op]()
        args = rest[0]
        if op == 'IF':
            return sub(args[1]) if number(sub(args[0])) else sub(args[2]) if len(args) > 2 else False
        if op == 'IFS':
            for test, result in zip(args[::2], args[1::2]):
                if number(sub(test)):
                    return sub(result)
            raise FormulaError('#N/A')
        if op in ('IFERROR', 'IFNA'):
            try:
                return scalar(sub(args[0]))
            except (FormulaError, ZeroDivisionError, ValueError, ArithmeticError) as exc:
                if op == 'IFERROR' or str(exc) == '#N/A':
                    return sub(args[1])
                raise
        if op == 'CHOOSE':
            index = int(number(sub(args[0])))
            if not 1 <= index < len(args):
                raise FormulaError('#VALUE!')
            return sub(args[index])
        values = []
        for arg in args:
            try:
                values.append(sub(arg))
            except FormulaError as exc:
                values.append(exc)
        return function(op, values, self.book.epoch)


def report(values, formulas, cycles, engine):
    errors = {}
    evaluated = {}
    for (sheet, cell), value in values.items():
        location = f'{sheet}!{cell}'
        if isinstance(value, FormulaError):
            errors.setdefault(str(value), []).append(location)
            value = str(value)
        if (sheet, cell) in formulas:
            evaluated[location] = value
    return dict(status='errors_found' if errors or cycles else 'success', engine=engine,
                total_formulas=len(formulas), total_errors=sum(map(len, errors.values())),
                circular_references=[f'{s}!{c}' for s, c in sorted(cycles)],
                error_summary=errors, evaluated_cells=evaluated)


def workbook_cells(book):
    return ((s, c) for s in book.worksheets for c in list(s._cells.values()) if c.data_type in ('f', 'e'))


def evaluate_workbook_formulas(path):
    book = load_workbook(path, keep_links=False)
    try:
        evaluator = Evaluator(book)
        formulas, values = set(), {}
        for s, c in workbook_cells(book):
            key = s.title, c.coordinate
            if c.data_type == 'f':
                formulas.add(key)
            values[key] = evaluator.cell(s, c.coordinate)
        return report(values, formulas, evaluator.cycles, 'python-evaluator')
    finally:
        book.close()


def find_soffice(explicit=None):
    import os
    import shutil
    from pathlib import Path
    candidates = [explicit] if explicit else [os.environ.get('KLAUS_SOFFICE_PATH'),
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        'C:/Program Files/LibreOffice/program/soffice.exe',
        'C:/Program Files (x86)/LibreOffice/program/soffice.exe', 'soffice']
    for candidate in candidates:
        if candidate and (found := shutil.which(candidate)):
            return str(Path(found).resolve())
    if explicit:
        raise ValueError('The specified soffice executable is unavailable.')
    return None


def run_soffice(executable, profile, timeout, *args):
    import subprocess
    result = subprocess.run([executable, '-env:UserInstallation='+profile.as_uri(),
                             '--headless', '--norestore', *args],
                            timeout=timeout, capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f'Headless conversion failed (exit {result.returncode}): {result.stderr.strip()}')


def install_macro(profile):
    from xml.sax.saxutils import escape
    basic = profile / 'user' / 'basic'
    standard = basic / 'Standard'
    standard.mkdir(parents=True)
    ns = 'xmlns:library="http://openoffice.org/2000/library"'
    for filename, element in [('script.xlb', '<library:element library:name="Module1"/>'), ('dialog.xlb', '')]:
        (standard / filename).write_text(f'<library:library {ns} library:name="Standard" library:readonly="false" library:passwordprotected="false">{element}</library:library>', encoding='utf-8')
    for filename, index in [('script.xlc', 'script.xlb'), ('dialog.xlc', 'dialog.xlb')]:
        (basic / filename).write_text(f'<library:libraries {ns} xmlns:xlink="http://www.w3.org/1999/xlink"><library:library library:name="Standard" xlink:href="$(USER)/basic/Standard/{index}/" xlink:type="simple" library:link="false"/></library:libraries>', encoding='utf-8')
    source = '''Sub RecalculateAndSave(targetUrl As String)
Dim options(2) As New com.sun.star.beans.PropertyValue
options(0).Name = "Hidden"
options(0).Value = True
options(1).Name = "MacroExecutionMode"
options(1).Value = 0
options(2).Name = "UpdateDocMode"
options(2).Value = 0
Dim doc As Object
doc = StarDesktop.loadComponentFromURL(targetUrl, "_blank", 0, options())
doc.calculateAll()
doc.store()
doc.close(True)
Dim marker As Integer
marker = FreeFile
Open ConvertFromURL(targetUrl) & ".done" For Output As #marker
Print #marker, "ok"
Close #marker
End Sub'''
    (standard / 'Module1.xba').write_text('<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">'+escape(source)+'</script:module>', encoding='utf-8')


def recalc_with_soffice(path, soffice=None, timeout=30):
    from pathlib import Path
    from shutil import copyfile
    from tempfile import TemporaryDirectory
    executable = find_soffice(soffice)
    if not executable:
        raise ValueError('LibreOffice is unavailable; install it or use --engine python.')
    with TemporaryDirectory() as temp:
        root = Path(temp).resolve()
        profile = root / 'profile'
        target = root / 'workbook.xlsx'
        copyfile(path, target)
        install_macro(profile)
        run_soffice(executable, profile, timeout,
                    f'macro:///Standard.Module1.RecalculateAndSave({target.as_uri()})')
        if not target.with_suffix('.xlsx.done').is_file():
            raise ValueError('LibreOffice did not complete workbook recalculation.')
        original = load_workbook(path, keep_links=False)
        cached = load_workbook(target, data_only=True, keep_links=False)
        try:
            formulas, values = set(), {}
            for sheet, cell in workbook_cells(original):
                key = sheet.title, cell.coordinate
                actual = cached[sheet.title][cell.coordinate]
                if cell.data_type == 'f':
                    formulas.add(key)
                values[key] = FormulaError(actual.value) if actual.data_type == 'e' else actual.value
            cycles = set()
            if any(isinstance(v, FormulaError) and str(v) in ('#REF!', 'Err:522') for v in values.values()):
                python_result = evaluate_workbook_formulas(path)
                cycles = {tuple(loc.rsplit('!', 1)) for loc in python_result['circular_references']}
                for key in cycles:
                    values[key] = FormulaError('#REF!')
            return report(values, formulas, cycles, 'libreoffice')
        finally:
            original.close()
            cached.close()


def audit_workbook(path):
    book = load_workbook(path, keep_links=False)
    cached = load_workbook(path, data_only=True, keep_links=False)
    try:
        errors, constants, breaks, totals = [], [], [], []
        formula_count = 0
        for sheet in book.worksheets:
            rows = {}
            for cell in list(sheet._cells.values()):
                if cell.value is not None:
                    rows.setdefault(cell.row, []).append(cell)
            for row in rows.values():
                row.sort(key=lambda c: c.column)
                signatures = {}
                summary = isinstance(row[0].value, str) and bool(re.search(r'\b(total|subtotal|summary|net income|gross profit|net profit)\b', row[0].value, re.I))
                for cell in row:
                    location = dict(sheet=sheet.title, coordinate=cell.coordinate)
                    actual = cached[sheet.title][cell.coordinate]
                    if actual.data_type == 'e':
                        errors.append(dict(**location, error=actual.value))
                    if summary and type(cell.value) in (int, float):
                        totals.append(dict(**location, value=cell.value))
                    if cell.data_type != 'f':
                        continue
                    formula_count += 1
                    if not isinstance(cell.value, str):
                        continue
                    try:
                        tokens = [t for t in Tokenizer(cell.value).items if t.type != 'WHITE-SPACE']
                        for token in tokens:
                            if token.subtype == 'ERROR' and actual.data_type != 'e':
                                errors.append(dict(**location, error=token.value))
                        numbers = [float(t.value) for t in tokens if t.subtype == 'NUMBER']
                        if len(tokens) > 2 and (flagged := sorted(set(numbers) - {0, 1, 12, 100, 365})):
                            constants.append(dict(**location, constants=flagged, formula=cell.value))
                        if cell.column < 16384:
                            destination = f'{get_column_letter(cell.column + 1)}{cell.row}'
                            expected = Translator(cell.value, origin=cell.coordinate).translate_formula(destination)
                            signatures[cell.column] = (cell, expected)
                        elif cell.column - 1 in signatures:
                            signatures[cell.column] = (cell, None)
                    except (ValueError, ArithmeticError):
                        continue
                for col, (cell, expected) in signatures.items():
                    subsequent = signatures.get(col+1)
                    if subsequent and subsequent[0].value != expected:
                        breaks.append(dict(sheet=sheet.title, coordinate=subsequent[0].coordinate, expected=expected))
        return dict(valid=not errors, formulaCount=formula_count, errorCells=errors,
                    hardcodedConstantWarnings=constants, formulaConsistencyWarnings=breaks,
                    hardcodedTotalWarnings=totals)
    finally:
        book.close()
        cached.close()
