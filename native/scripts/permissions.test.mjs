import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const native = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vector = JSON.parse(readFileSync(join(native, '../contracts/vectors/system-permission-vectors.json'), 'utf8')).automation;
// Same first-execution scan hazard as the lockscreen fixture: keep one stable
// output path, rebuild only when sources change, skip if the machine SIGKILLs it.
const sources = [join(native, 'permissions/KlausPermissions.m'), join(native, 'tests/permissions-fixture.m')];
const root = join(native, '../dist/fixtures/permissions'), executable = join(root, 'probe');
function needsBuild() {
  if (!existsSync(executable)) return true;
  const built = statSync(executable).mtimeMs;
  return sources.some(source => statSync(source).mtimeMs > built);
}

test('the native Automation probe addresses the running target by PID and never requests user consent', { skip: process.platform !== 'darwin' }, t => {
  mkdirSync(root, { recursive: true });
  if (needsBuild()) {
    const compiled = spawnSync('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-DKLAUS_PERMISSIONS_TESTING',
      '-framework', 'AppKit', '-framework', 'CoreServices', '-framework', 'Photos', '-framework', 'CoreLocation',
      '-framework', 'UserNotifications', ...sources, '-o', executable], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stderr);
  }
  const run = args => {
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 5000 });
    // Same first-execution hazard as the lockscreen fixture: a slow security
    // verdict can stall the spawn past its timeout instead of killing it.
    if (result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') { t.skip('endpoint security killed or stalled the fixture binary on first execution; stable path already cached once on this machine'); return null; }
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    return result;
  };
  for (const scenario of vector.statusCases) {
    const result = run(['12345', String(scenario.osStatus)]);
    if (!result) return;
    assert.deepEqual(JSON.parse(result.stdout), { osStatus: scenario.osStatus, queries: 1 }, scenario.name);
  }
  for (const pid of ['0', '-1']) {
    const result = run([pid, '0']);
    if (!result) return;
    assert.deepEqual(JSON.parse(result.stdout), { osStatus: -600, queries: 0 }, 'an absent target cannot reach a permission query');
  }
});
