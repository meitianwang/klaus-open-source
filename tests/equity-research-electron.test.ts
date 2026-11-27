import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, assertEqual, Harness } from './harness';

const desktop = resolve(__dirname, '../..');
const logs = join(desktop, 'dist/equity-research-logs');
const h = new Harness();

h.test('equity research opens, publishes, saves, previews, and exports a workspace', async () => {
  mkdirSync(logs, { recursive: true });
  const realDocument = process.env.KLAUS_EQUITY_FIXTURE_DOC_PATH;
  for (const documentPath of realDocument ? ['', realDocument] : ['']) {
    const profile = mkdtempSync(join(logs, 'fixture-profile-'));
    try {
      const { ELECTRON_RUN_AS_NODE: _dropNodeMode, ...cleanEnv } = process.env;
      const nodeExecutable = process.versions.electron ? 'node' : process.execPath;
      const result = spawnSync(nodeExecutable, ['scripts/run-electron-test.mjs', 'dist/tests/equity-research-fixture.js'], {
        cwd: desktop,
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...cleanEnv, KLAUS_EQUITY_FIXTURE_DOC_PATH: documentPath, KLAUS_EQUITY_RESEARCH_FIXTURE_PROFILE: profile },
      });
      assert(!result.error, String(result.error));
      assertEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(readFileSync(join(logs, 'equity-research-fixture-result.json'), 'utf8'));
      assertEqual(report.failed, 0, 'all equity research Electron integration cases pass');
      assert(report.passed >= 4, 'all four workspace integration cases ran');
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }
});

void h.finish(join(logs, 'electron-launcher-result.json'), 'equity-research-electron').then(code => { process.exitCode = code; });
