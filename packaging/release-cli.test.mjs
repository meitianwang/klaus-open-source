import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('release CLI preserves failure through the real builder temporary-directory exit hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-release-cli-'));
  const script = new URL('../scripts/release-desktop.mjs', import.meta.url);
  try {
    for (const args of [['--verify-only', '--bundle', join(root, 'missing.app'), '--receipt', join(root, 'missing.receipt.json')], ['--help']]) {
      const program = `
        import { createRequire } from 'node:module';
        const require = createRequire(${JSON.stringify(import.meta.url)});
        const { TmpDir } = require('temp-file');
        const directory = await new TmpDir('release-exit-regression').createTempDir();
        console.log(JSON.stringify({ builderTemporaryDirectory: directory }));
      `;
      const preload = `data:text/javascript;base64,${Buffer.from(program).toString('base64')}`;
      const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(script), ...args], {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, APP_BUILDER_TMP_DIR: root, TMP_DIR_MANAGER_ENSURE_REMOVED_ON_EXIT: 'true' },
      });
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /builderTemporaryDirectory/);
      const failure = args[0] === '--verify-only';
      if (failure) assert.match(result.stderr, /\[release\].*ENOENT/);
      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      assert.deepEqual(await readdir(root), [], 'Builder asynchronous cleanup must still complete');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
