import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook, load_workbook

HELPER = Path(__file__).resolve().parents[1] / 'resources/workspace-skills/xlsx/scripts/xlsx_tool.py'


class XlsxSkillTest(unittest.TestCase):
    def test_formulas_and_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.xlsx'
            book = Workbook()
            sheet = book.active
            for row in [('Item', 'Value'), ('A', 1), ('B', 2), ('Total', '=SUM(B2:B3)')]:
                sheet.append(row)
            book.save(path)

            def call(command, *args, code=0):
                result = subprocess.run([sys.executable, HELPER, command, path, *args], capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stderr or result.stdout)
                return json.loads(result.stdout)

            self.assertEqual(call('inspect')['sheets'][0]['formulaCount'], 1)
            self.assertEqual(call('read', '--range', 'B4:B4', '--formulas')['rows'][0][0]['formula'], '=SUM(B2:B3)')
            audit = call('audit')
            self.assertTrue(audit['valid'])
            self.assertEqual(audit['formulaCount'], 1)
            self.assertEqual(audit['errorCells'], [])
            sheet['B4'] = 3
            sheet['B5'] = '=#REF!'
            sheet['B6'] = '#DIV/0!'
            book.save(path)
            audit = call('audit', code=1)
            self.assertFalse(audit['valid'])
            self.assertEqual({cell['coordinate'] for cell in audit['errorCells']}, {'B5', 'B6'})
            self.assertEqual(audit['hardcodedTotalWarnings'][0]['coordinate'], 'B4')

    def test_model_and_errors(self):
        import pandas as pd
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'model.xlsx'
            with pd.ExcelWriter(path, engine='xlsxwriter') as writer:
                pd.DataFrame({'Name': ['Base', 'Extra'], 'Value': [100, 20]}).to_excel(writer, sheet_name='Assumptions', index=False)
            book = load_workbook(path)
            sheet = book.create_sheet('Income Statement')
            for row in [
                ['=Assumptions!B2', '=SUM(Assumptions!B2:B3)', '=SUMIF(Assumptions!A2:A3,"Extra",Assumptions!B2:B3)'],
                ['=IF(A1=100,1,0)', '=IFERROR(1/0,12)', '=INDEX(Assumptions!B2:B3,MATCH("Extra",Assumptions!A2:A3,0))'],
                ['=XLOOKUP("Base",Assumptions!A2:A3,Assumptions!B2:B3)', '=NPV(10%,121)', '=ROUND(IRR(A4:B4),4)'],
                [-100, 110],
            ]:
                sheet.append(row)
            book.save(path)

            def call(command, *options, code=0):
                out = subprocess.run([sys.executable, HELPER, command, path, *options], capture_output=True, text=True)
                self.assertEqual(out.returncode, code, out.stderr or out.stdout)
                return json.loads(out.stdout)

            options = ('--engine', 'python', '--strict')
            result = call('recalc', *options)
            self.assertEqual((result['status'], result['total_errors']), ('success', 0))
            for coordinate, value in zip(('A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'), (100, 120, 20, 1, 12, 20, 100, 110, .1)):
                self.assertAlmostEqual(result['evaluated_cells'][f'Income Statement!{coordinate}'], value)
            bad = book.create_sheet('Errors')
            sequences = ['=1/0', '=UNKNOWN()', '="text"+1', '=MATCH(3,Assumptions!B2:B3,0)', '=INDEX(Assumptions!B2:B3,9)', '=SQRT(-1)', '=A1:A2 C1:C2']
            for row, formula in enumerate(sequences, 1):
                bad[f'D{row}'] = formula
            bad['A1'], bad['B1'] = '=B1+1', '=A1+1'
            sheet.append(['Total', 110, '=A1*42'])
            book.save(path)
            result = call('recalc', *options, code=1)
            self.assertEqual(result['status'], 'errors_found')
            self.assertEqual(result['circular_references'], ['Errors!A1', 'Errors!B1'])
            for row, error in enumerate(('#DIV/0!', '#NAME?', '#VALUE!', '#N/A', '#REF!', '#NUM!', '#NULL!'), 1):
                self.assertIn(f'Errors!D{row}', result['error_summary'][error])
            audit = call('audit')
            self.assertIn('B5', {cell['coordinate'] for cell in audit['hardcodedTotalWarnings']})
            self.assertIn('C5', {cell['coordinate'] for cell in audit['hardcodedConstantWarnings']})


if __name__ == '__main__':
    unittest.main()
