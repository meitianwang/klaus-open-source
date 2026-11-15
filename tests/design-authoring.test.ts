import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { designAuthoringResult, designAuthoringValidator } from '../main/design/authoring';
import { Harness, assert, assertEqual } from './harness';

const h = new Harness();
const logs = resolve(__dirname, '../dist/design-authoring-logs');
mkdirSync(logs, { recursive: true });

void (async () => {
  const fakePlugin = mkdtempSync(join(tmpdir(), 'klaus-design-auth-test-'));
  try {
    mkdirSync(join(fakePlugin, 'authoring'), { recursive: true });
    writeFileSync(
      join(fakePlugin, 'authoring/validate.cjs'),
      `module.exports = {
        validateFiles(candidate) {
          const hasCanvas = candidate.files.some(f => f.path === 'project/canvas.json');
          return {
            valid: hasCanvas,
            errors: hasCanvas ? [] : [{ path: 'project/canvas.json', message: 'Missing index', line: 1, col: 1 }],
            warnings: [],
            artboards: [{ id: 'Main.dc.html', path: 'project/Main.dc.html', valid: true }],
            contentHash: 'abc123',
          };
        }
      };\n`,
    );
    await h.test('designAuthoringValidator loads validateFiles from the plugin package and normalizes diagnostics', () => {
      const validate = designAuthoringValidator(fakePlugin);
      assert(typeof validate === 'function', 'validator loaded');
      const bad = designAuthoringResult(validate!({ files: [] }));
      assertEqual(bad.valid, false, 'missing index fails');
      assertEqual(bad.errors.length, 1, 'error preserved');
      const good = designAuthoringResult(validate!({ files: [{ path: 'project/canvas.json', contentType: 'application/json', size: 2, sha256: '0'.repeat(64) }] }));
      assertEqual(good.valid, true, 'valid snapshot passes');
      assertEqual(good.contentHash, 'abc123', 'contentHash preserved');
    });
  } finally {
    rmSync(fakePlugin, { recursive: true, force: true });
    process.exitCode = await h.finish(resolve(logs, 'result.json'), 'design-authoring');
  }
})();
