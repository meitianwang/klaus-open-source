import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authoringResult, authoringValidator } from '../main/ppt/authoring';
import { Harness, assert, assertEqual } from './harness';

const h = new Harness();
const logs = resolve(__dirname, '../dist/ppt-authoring-logs'); mkdirSync(logs, { recursive: true });
const owner = 'authoring-fixture';
const candidate = { files: [{ path: 'project/slides/slide-a.html', content: '<section id="slide-a"><p>Text</p></section>', contentType: 'text/html', size: 52, sha256: 'a'.repeat(64) }] };
function plugin(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-ppt-authoring-'));
  mkdirSync(join(root, 'authoring'));
  writeFileSync(join(root, 'authoring/validate.cjs'), source);
  return root;
}

void (async () => {
  try {
    await h.test('the plugin authoring module is loaded by absolute path and results are normalized', () => {
      const root = plugin("exports.validateFiles = input => ({ valid: true, errors: [], warnings: [{ message: 'note', path: 'project/slides/slide-a.html', line: 2 }], slides: [{ id: 'slide-a' }], contentHash: 'hash-' + input.files.length });");
      try {
        const validate = authoringValidator(root);
        assert(validate, 'validator was not loaded');
        const result = authoringResult(validate(candidate));
        assertEqual(result.valid, true, 'valid result');
        assertEqual(result.warnings.length, 1, 'warning count');
        assertEqual(result.warnings[0]!.line, 2, 'warning line');
        assertEqual(result.contentHash, 'hash-1', 'content hash');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    await h.test('a changed plugin generation replaces the cached validator', () => {
      const root = plugin('exports.validateFiles = () => ({ valid: true, errors: [], warnings: [] });');
      try {
        const first = authoringValidator(root);
        assert(first, 'first validator');
        assertEqual(authoringResult(first(candidate)).valid, true, 'first result');
        const file = join(root, 'authoring/validate.cjs'), changed = new Date(Date.now() + 5_000);
        writeFileSync(file, "exports.validateFiles = () => ({ valid: false, errors: [{ path: 'project/slides/slide-a.html', line: 3, col: 7, message: 'bad tag' }], warnings: [] });");
        utimesSync(file, changed, changed);
        const second = authoringValidator(root);
        assert(second, 'second validator');
        const result = authoringResult(second(candidate));
        assertEqual(result.valid, false, 'changed result');
        assertEqual(result.errors[0]!.message, 'bad tag', 'changed error');
        assertEqual(result.errors[0]!.line, 3, 'changed line');
        assertEqual(result.errors[0]!.col, 7, 'changed column');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    await h.test('a missing or malformed plugin validator is reported instead of silently guessing', () => {
      const root = mkdtempSync(join(tmpdir(), 'klaus-ppt-authoring-'));
      try {
        assertEqual(authoringValidator(root), undefined, 'missing module');
        assertEqual(authoringValidator(undefined), undefined, 'missing plugin root');
        mkdirSync(join(root, 'authoring'));
        writeFileSync(join(root, 'authoring/validate.cjs'), 'exports.other = () => ({ valid: true });');
        let message = '';
        try { authoringValidator(root); } catch (error) { message = String(error); }
        assert(message.includes('validateFiles'), 'missing export is named');
        let invalid = false;
        try { authoringResult({ errors: [] }); } catch { invalid = true; }
        assertEqual(invalid, true, 'missing valid flag is rejected');
        const contradictory = authoringResult({ valid: true, errors: ['plain message'], warnings: [] });
        assertEqual(contradictory.errors[0]!.message, 'plain message', 'string issues are normalized');
        assertEqual(contradictory.valid, false, 'errors force an invalid result even when the plugin says valid');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    h.info('workspace', owner);
  } finally {
    process.exitCode = await h.finish(join(logs, 'result.json'), 'ppt-authoring');
  }
})();
