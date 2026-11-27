import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

HELPER = Path(__file__).resolve().parents[1] / 'resources/workspace-skills/docx/scripts/docx_tool.py'
sys.path.insert(0, str(HELPER.parent))

from docx import Document
from ooxml_engine import DocxPackage, W, W15, parse, unpack_docx, validate_docx, visible


class DocxSkillTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / 'input.docx'
        self.directory = self.root / 'unpacked'
        doc = Document()
        p = doc.add_paragraph()
        p.add_run('The old')
        p.add_run(' wording remains.')
        doc.add_paragraph('Separate note.')
        doc.sections[0].header.paragraphs[0].text = 'Header'
        doc.save(self.source)

    def cli(self, *args, status=0):
        output = subprocess.run([sys.executable, str(HELPER), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(output.returncode, status, output.stdout + output.stderr)
        return json.loads(output.stdout)

    def test_inspect_and_text(self):
        self.assertEqual(self.cli('inspect', self.source)['paragraphCount'], 2)
        self.assertEqual(self.cli('text', self.source)['paragraphs'][0]['text'], 'The old wording remains.')

    def test_review_and_round_trip(self):
        self.cli('unpack', self.source, self.directory)
        edit = DocxPackage(self.directory)
        self.assertEqual(len(edit.find_paragraphs(index=0).findall(W + 'r')), 1)
        edit.propose_replace('old wording', 'new wording')
        edit.insert_paragraph_tracked('Additional text.', after=0)
        cid = edit.add_comment('Separate', 'Check this.')
        edit.reply_comment(cid, 'Checked.')
        edit.save()
        extended = parse((self.directory / 'word/commentsExtended.xml').read_bytes())
        self.assertEqual(extended[1].get(W15 + 'paraIdParent'), extended[0].get(W15 + 'paraId'))
        self.assertTrue(self.cli('validate', self.directory, '--original', self.source)['valid'])
        output = self.root / 'output.docx'
        self.cli('pack', self.directory, output, '--validate', '--original', self.source)
        text = self.cli('text', output, '--include-comments', '--include-revisions')
        self.assertIn('{-old wording-}{+new wording+}', text['paragraphs'][0]['text'])
        self.assertEqual([item['text'] for item in text['comments']], ['Check this.', 'Checked.'])
        edit.reject_revisions(author='Klaus')
        self.assertEqual([visible(p) for p in edit.find_paragraphs()], ['The old wording remains.', 'Separate note.'])

    def test_delete_and_accept(self):
        unpack_docx(self.source, self.directory)
        edit = DocxPackage(self.directory)
        edit.delete_paragraph_tracked(0)
        edit.save()
        self.assertTrue(validate_docx(self.directory, self.source)['valid'])
        edit.accept_revisions()
        self.assertEqual([visible(p) for p in edit.find_paragraphs()], ['Separate note.'])

    def test_validation_failures(self):
        unpack_docx(self.source, self.directory)
        for part, old, new, diagnostic in (
            ('word/header1.xml', 'Header', 'Changed', 'untracked text edits'),
            ('word/_rels/document.xml.rels', 'header1.xml', 'missing.xml', 'unresolved internal target'),
            ('word/document.xml', 'xml:space="preserve"', '', 'missing xml:space'),
        ):
            with self.subTest(part=part):
                path = self.directory / part
                original = path.read_text()
                self.assertIn(old, original)
                path.write_text(original.replace(old, new))
                result = self.cli('validate', self.directory, '--original', self.source, status=1)
                self.assertIn(diagnostic, ' '.join(result['errors']))
                path.write_text(original)

    def test_unsafe_archive(self):
        with ZipFile(self.source, 'a') as archive:
            archive.writestr('../escape.xml', '<x/>')
        with self.assertRaisesRegex(ValueError, 'Unsafe package path'):
            unpack_docx(self.source, self.directory)
        self.assertFalse(self.directory.exists())

    @unittest.skipUnless(os.environ.get('KLAUS_TEST_NODE_PATH'), 'Managed Node path not supplied')
    def test_node_generation(self):
        script = '''
const fs = require('node:fs');
const path = require('node:path');
const entry = require.resolve('docx');
const manifest = path.join(path.dirname(entry), '..', 'package.json');
if (JSON.parse(fs.readFileSync(manifest)).version !== '9.16.0') throw Error('Unexpected docx version');
const { Document, Packer, Paragraph } = require('docx');
Packer.toBuffer(new Document({sections: [{children: [new Paragraph('Generated text')]}]}))
  .then(buffer => fs.writeFileSync(process.argv[1], buffer)).catch(error => { console.error(error); process.exitCode = 1; });
'''
        generated = self.root / 'generated.docx'
        subprocess.run([os.environ['KLAUS_TEST_NODE_PATH'], '-e', script, str(generated)], check=True)
        self.assertEqual(self.cli('text', generated)['paragraphs'][0]['text'], 'Generated text')
        self.assertTrue(self.cli('validate', generated)['valid'])


if __name__ == '__main__':
    unittest.main()
