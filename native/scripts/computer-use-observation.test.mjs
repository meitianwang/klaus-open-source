import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const native = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('native desktop selection and key identities preserve observation ownership', { skip: process.platform !== 'darwin' }, () => {
  const artifacts = join(native, '../dist/fixtures/computer-use-observation'); mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, 'run-'));
  const executable = join(root, 'fixture');
  const built = spawnSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
    ...['AppKit', 'ApplicationServices', 'Carbon', 'ScreenCaptureKit', 'CoreImage', 'CoreMedia', 'CoreVideo', 'Security', 'LocalAuthentication'].flatMap(name => ['-framework', name]),
    join(native, 'tests/computer-use-observation-fixture.m'), join(native, 'computer-use/lockscreen.m'), '-o', executable], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(built.error, undefined); assert.equal(built.status, 0, `${built.signal ?? ''} ${built.stderr}`);
  const signed = spawnSync('codesign', ['--force', '--sign', '-', '--timestamp=none', executable], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(signed.error, undefined); assert.equal(signed.status, 0, signed.stderr);
  const verified = spawnSync('codesign', ['--verify', '--strict', executable], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(verified.status, 0, verified.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(checked.error, undefined); assert.equal(checked.status, 0, `${checked.signal ?? ''} ${checked.stderr}`);
  const result = JSON.parse(checked.stdout); assert.ok(result.assertions >= 25);
  assert.equal(result.realInputPosts, 0); assert.equal(result.realPrompts, 0); console.log(checked.stdout.trim());
});
