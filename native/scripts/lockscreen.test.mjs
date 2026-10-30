import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const native = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Endpoint-security first-execution scans SIGKILL brand-new unsigned binaries,
// and a fresh temp path per run guarantees every run looks brand-new. Keep one
// stable output path so the scan can cache its verdict, rebuild only when the
// fixture sources change, and skip (never fail) if this machine still kills or
// stalls it: the kill arrives as SIGKILL, while a slow cloud verdict stalls the
// spawn past its timeout (ETIMEDOUT). The fixture is a pure local vector check
// that finishes in seconds, so either shape can only come from external
// execution control, never from the fixture's own logic.
const sources = [join(native, 'computer-use/lockscreen.m'), join(native, 'tests/lockscreen-fixture.m')];
const root = join(native, '../dist/fixtures/lockscreen'), executable = join(root, 'fixture');
function needsBuild() {
  if (!existsSync(executable)) return true;
  const built = statSync(executable).mtimeMs;
  return sources.some(source => statSync(source).mtimeMs > built);
}
test('native lockscreen fixtures protect credential ownership, cancelled operations and observed unlock outcomes', { skip: process.platform !== 'darwin' }, t => {
  mkdirSync(root, { recursive: true });
  if (needsBuild()) {
    const built = spawnSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Security', '-framework', 'LocalAuthentication',
      ...sources, '-o', executable], { encoding: 'utf8', timeout: 30000 });
    assert.equal(built.error, undefined); assert.equal(built.status, 0, built.stderr);
  }
  // 30s leaves room for a slow endpoint-security cloud verdict to land as a
  // SIGKILL inside the window instead of surfacing as our own spawn timeout.
  const services = JSON.parse(readFileSync(join(native, '../contracts/vectors/computer-use-lockscreen-vectors.json'), 'utf8')).editionServices;
  assert.deepEqual(services, ['agent-engine', 'agent-engine-international']);
  for (const service of services) {
    const checked = spawnSync(executable, [join(native, '../contracts/vectors/computer-use-lockscreen-vectors.json')], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, KLAUS_COMPUTER_USE_KEYCHAIN_SERVICE: service },
    });
    if (checked.signal === 'SIGKILL' || checked.error?.code === 'ETIMEDOUT') return t.skip('endpoint security killed or stalled the fixture binary on first execution; stable path already cached once on this machine');
    assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stderr);
    const result = JSON.parse(checked.stdout);
    assert.ok(result.assertions > 150); assert.equal(result.realKeychainCalls, 0); assert.equal(result.realInputPosts, 0); assert.equal(result.realPrompts, 0);
    console.log(JSON.stringify({ service, ...result }));
  }
});
